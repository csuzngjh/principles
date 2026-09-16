/**
 * PRI-798 — governance timestamp schema must be typebox-instance-agnostic.
 *
 * Field incident: the contracts registered a custom FormatRegistry format
 * (`governance-iso-utc`) scoped to whichever @sinclair/typebox copy loaded
 * the module. The installed runtime layout ships two copies (core + console);
 * the collector's Value.Check ran under the console copy whose registry never
 * saw the registration, so 100% of governance projections failed contract
 * validation. These tests pin the registry-independence: validation must pass
 * even with the custom format deliberately wiped from the registry.
 */
import { describe, it, expect } from 'vitest';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { GovernanceTimestampSchema, ISO_8601_UTC_SHAPE_PATTERN } from '../governance-timestamp-schema.js';
import {
  GovernanceFactsSchema,
  PrincipleFactSchema,
} from '../governance-projection-contract.js';
import type { GovernanceFacts } from '../governance-projection-contract.js';

function wipeLegacyFormat(): void {
  // Remove the pre-PRI-798 registration if some module still performs it —
  // validation must not depend on registry state in either direction.
  if (FormatRegistry.Has('governance-iso-utc')) {
    FormatRegistry.Delete('governance-iso-utc');
  }
}

describe('GovernanceTimestampSchema (PRI-798 registry-independence)', () => {
  it('validates well-formed UTC timestamps with the legacy format wiped from the registry', () => {
    wipeLegacyFormat();
    expect(Value.Check(GovernanceTimestampSchema, '2026-09-15T00:26:04.685Z')).toBe(true);
    expect(Value.Check(GovernanceTimestampSchema, '2026-09-15T00:26:04Z')).toBe(true);
  });

  it('rejects out-of-range and non-UTC shapes', () => {
    wipeLegacyFormat();
    expect(Value.Check(GovernanceTimestampSchema, '2026-13-01T00:00:00Z')).toBe(false);
    // Calendar-rollover dates (e.g. 09-31) pass by design — producers gate
    // timestamps semantically upstream; this schema is shape-level defense.
    expect(Value.Check(GovernanceTimestampSchema, '2026-09-31T00:00:00Z')).toBe(true);
    expect(Value.Check(GovernanceTimestampSchema, '2026-09-15T24:00:00Z')).toBe(false);
    expect(Value.Check(GovernanceTimestampSchema, '2026-09-15T08:00:00+08:00')).toBe(false);
    expect(Value.Check(GovernanceTimestampSchema, '2026-09-15 00:00:00Z')).toBe(false);
    expect(Value.Check(GovernanceTimestampSchema, 'not-a-timestamp')).toBe(false);
  });

  it('pattern enforces field ranges (defense-in-depth parity with the old format)', () => {
    expect(ISO_8601_UTC_SHAPE_PATTERN).toContain('(?:0[1-9]|1[0-2])');
    expect(ISO_8601_UTC_SHAPE_PATTERN).toContain('(?:[01]\\d|2[0-3])');
  });

  it('full GovernanceFacts round-trip passes without the legacy format registered', () => {
    wipeLegacyFormat();
    const principle = {
      schemaVersion: '1' as const,
      sourceRef: { type: 'principle' as const, id: 'principle-1' },
      principleId: 'principle-1',
      lineageConfidence: 'unknown' as const,
      recordedAt: '2026-09-15T00:00:00.000Z',
      family: 'principle' as const,
      state: 'candidate' as const,
    };
    expect(Value.Check(PrincipleFactSchema, principle)).toBe(true);

    const facts: GovernanceFacts = {
      schemaVersion: '1',
      principleId: 'principle-1',
      asOf: '2026-09-15T00:00:00.000Z',
      lineage: {
        principleId: 'principle-1',
        artifactIds: [],
        taskIds: [],
        revisionIdentities: [{ kind: 'none' }],
        confidence: 'unknown',
        sourceRefs: [{ type: 'principle', id: 'principle-1' }],
      },
      principle,
      tasks: [],
      runnerVerdicts: [],
      derivedRelations: [],
      approvals: [],
      activations: [],
      timelineEvents: [],
      collectionIssues: [],
    };
    expect(Value.Check(GovernanceFactsSchema, facts)).toBe(true);
  });
});
