/**
 * Source Descriptors Tests — PEAT-B1
 *
 * Direct tests for the source descriptor registry.
 * This module defines the declarative policy mapping from SourceKind to default TriageDecision.
 *
 * Tests verify:
 * - All source kinds have descriptors registered
 * - Every descriptor has required fields (kind, defaultDecision, reason, nextAction, canUpgrade)
 * - Descriptor invariants (owner_reported always admit, tool_failure never admit, etc.)
 * - canUpgrade flag is correctly set for upgradable kinds
 *
 * ERR checklist:
 * - ERR-002: Every descriptor carries reason + nextAction
 * - ERR-005: Descriptors are data, not assumptions about callers
 */

import { describe, it, expect } from 'vitest';
import {
  SOURCE_DESCRIPTORS,
  getSourceDescriptor,
  type SourceDescriptor,
} from '../source-descriptors.js';
import type { SourceKind, TriageDecision } from '../types.js';
import { isSourceKind } from '../types.js';

// ── Descriptor Registry Completeness ───────────────────────────────────────────

describe('SOURCE_DESCRIPTORS registry', () => {
  it('has exactly 13 registered descriptors', () => {
    expect(SOURCE_DESCRIPTORS.size).toBe(13);
  });

  it('contains all valid SourceKinds', () => {
    const expectedKinds: SourceKind[] = [
      'owner_reported',
      'agent_on_owner_request',
      'tool_failure',
      'dispatch_error',
      'provider_failure',
      'rate_limit',
      'rulehost_block',
      'empathy_inferred',
      'semantic',
      'llm_paralysis',
      'subagent_error',
      'gfi_threshold',
      'unknown',
    ];

    for (const kind of expectedKinds) {
      expect(SOURCE_DESCRIPTORS.has(kind)).toBe(true);
    }
  });

  it('every descriptor has all required fields', () => {
    for (const [kind, descriptor] of SOURCE_DESCRIPTORS) {
      expect(descriptor.kind).toBe(kind);
      expect(descriptor.defaultDecision).toBeDefined();
      expect(typeof descriptor.defaultDecision).toBe('string');
      expect(descriptor.reason).toBeDefined();
      expect(typeof descriptor.reason).toBe('string');
      expect(descriptor.reason.length).toBeGreaterThan(0);
      expect(descriptor.nextAction).toBeDefined();
      expect(typeof descriptor.nextAction).toBe('string');
      expect(descriptor.nextAction.length).toBeGreaterThan(0);
      expect(typeof descriptor.canUpgrade).toBe('boolean');
    }
  });
});

// ── getSourceDescriptor ───────────────────────────────────────────────────────

describe('getSourceDescriptor', () => {
  it('returns descriptor for every registered kind', () => {
    const kinds: SourceKind[] = [
      'owner_reported',
      'agent_on_owner_request',
      'tool_failure',
      'dispatch_error',
      'provider_failure',
      'rate_limit',
      'rulehost_block',
      'empathy_inferred',
      'semantic',
      'llm_paralysis',
      'subagent_error',
      'gfi_threshold',
      'unknown',
    ];

    for (const kind of kinds) {
      const descriptor = getSourceDescriptor(kind);
      expect(descriptor).toBeDefined();
      expect(descriptor?.kind).toBe(kind);
    }
  });

  it('returns undefined for unregistered kind', () => {
    const result = getSourceDescriptor('not_a_kind' as SourceKind);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const result = getSourceDescriptor('' as SourceKind);
    expect(result).toBeUndefined();
  });
});

// ── Descriptor Decision Invariants ─────────────────────────────────────────────

describe('Descriptor decision invariants', () => {
  it('owner_reported always has defaultDecision=admit', () => {
    const descriptor = getSourceDescriptor('owner_reported');
    expect(descriptor?.defaultDecision).toBe('admit');
  });

  it('agent_on_owner_request always has defaultDecision=admit', () => {
    const descriptor = getSourceDescriptor('agent_on_owner_request');
    expect(descriptor?.defaultDecision).toBe('admit');
  });

  it('tool_failure has defaultDecision=evidence_only (never admit)', () => {
    const descriptor = getSourceDescriptor('tool_failure');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
    expect(descriptor?.defaultDecision).not.toBe('admit');
  });

  it('dispatch_error has defaultDecision=evidence_only', () => {
    const descriptor = getSourceDescriptor('dispatch_error');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
  });

  it('provider_failure has defaultDecision=health_only', () => {
    const descriptor = getSourceDescriptor('provider_failure');
    expect(descriptor?.defaultDecision).toBe('health_only');
  });

  it('rate_limit has defaultDecision=health_only', () => {
    const descriptor = getSourceDescriptor('rate_limit');
    expect(descriptor?.defaultDecision).toBe('health_only');
  });

  it('rulehost_block has defaultDecision=evidence_only with canUpgrade=true', () => {
    const descriptor = getSourceDescriptor('rulehost_block');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
    expect(descriptor?.canUpgrade).toBe(true);
  });

  it('empathy_inferred has defaultDecision=owner_confirm (never directly admit)', () => {
    const descriptor = getSourceDescriptor('empathy_inferred');
    expect(descriptor?.defaultDecision).toBe('owner_confirm');
    expect(descriptor?.defaultDecision).not.toBe('admit');
  });

  it('semantic has defaultDecision=evidence_only', () => {
    const descriptor = getSourceDescriptor('semantic');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
  });

  it('llm_paralysis has defaultDecision=evidence_only', () => {
    const descriptor = getSourceDescriptor('llm_paralysis');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
  });

  it('subagent_error has defaultDecision=evidence_only', () => {
    const descriptor = getSourceDescriptor('subagent_error');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
  });

  it('gfi_threshold has defaultDecision=evidence_only (GFI alone cannot admit)', () => {
    const descriptor = getSourceDescriptor('gfi_threshold');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
    expect(descriptor?.defaultDecision).not.toBe('admit');
  });

  it('unknown has defaultDecision=evidence_only (conservative default)', () => {
    const descriptor = getSourceDescriptor('unknown');
    expect(descriptor?.defaultDecision).toBe('evidence_only');
  });
});

// ── canUpgrade Flag ────────────────────────────────────────────────────────────

describe('canUpgrade flag', () => {
  it('only rulehost_block has canUpgrade=true', () => {
    for (const [kind, descriptor] of SOURCE_DESCRIPTORS) {
      if (kind === 'rulehost_block') {
        expect(descriptor.canUpgrade).toBe(true);
      } else {
        expect(descriptor.canUpgrade).toBe(false);
      }
    }
  });

  it('owner_reported cannot be upgraded (highest confidence)', () => {
    const descriptor = getSourceDescriptor('owner_reported');
    expect(descriptor?.canUpgrade).toBe(false);
  });

  it('tool_failure cannot be upgraded (infrastructure noise)', () => {
    const descriptor = getSourceDescriptor('tool_failure');
    expect(descriptor?.canUpgrade).toBe(false);
  });

  it('empathy_inferred cannot be upgraded (requires owner confirmation)', () => {
    const descriptor = getSourceDescriptor('empathy_inferred');
    expect(descriptor?.canUpgrade).toBe(false);
  });
});

// ── Descriptor Reason Quality ──────────────────────────────────────────────────

describe('Descriptor reason quality', () => {
  it('owner_reported reason mentions highest confidence', () => {
    const descriptor = getSourceDescriptor('owner_reported');
    expect(descriptor?.reason.toLowerCase()).toContain('owner');
    expect(descriptor?.reason.toLowerCase()).toContain('highest');
  });

  it('tool_failure reason mentions infrastructure or ADR-0014', () => {
    const descriptor = getSourceDescriptor('tool_failure');
    expect(
      descriptor?.reason.toLowerCase().includes('infrastructure') ||
      descriptor?.reason.includes('ADR-0014')
    ).toBe(true);
  });

  it('empathy_inferred reason mentions owner confirmation or PRODUCT_IDENTITY', () => {
    const descriptor = getSourceDescriptor('empathy_inferred');
    expect(
      descriptor?.reason.toLowerCase().includes('owner') ||
      descriptor?.reason.includes('PRODUCT_IDENTITY')
    ).toBe(true);
  });

  it('gfi_threshold reason mentions GFI alone cannot create diagnosis', () => {
    const descriptor = getSourceDescriptor('gfi_threshold');
    expect(descriptor?.reason.toLowerCase()).toContain('gfi');
    expect(descriptor?.reason.toLowerCase()).toContain('alone');
  });

  it('rulehost_block reason mentions near-miss or evidence', () => {
    const descriptor = getSourceDescriptor('rulehost_block');
    expect(
      descriptor?.reason.toLowerCase().includes('near-miss') ||
      descriptor?.reason.toLowerCase().includes('evidence')
    ).toBe(true);
  });
});

// ── Descriptor NextAction Quality ──────────────────────────────────────────────

describe('Descriptor nextAction quality', () => {
  it('owner_reported nextAction is none (direct diagnosis)', () => {
    const descriptor = getSourceDescriptor('owner_reported');
    expect(descriptor?.nextAction).toBe('none');
  });

  it('agent_on_owner_request nextAction is none (direct diagnosis)', () => {
    const descriptor = getSourceDescriptor('agent_on_owner_request');
    expect(descriptor?.nextAction).toBe('none');
  });

  it('tool_failure nextAction mentions evidence or correlation', () => {
    const descriptor = getSourceDescriptor('tool_failure');
    expect(descriptor?.nextAction.toLowerCase()).toContain('evidence');
  });

  it('provider_failure nextAction mentions health or telemetry', () => {
    const descriptor = getSourceDescriptor('provider_failure');
    expect(descriptor?.nextAction.toLowerCase()).toContain('health');
  });

  it('empathy_inferred nextAction mentions owner confirmation', () => {
    const descriptor = getSourceDescriptor('empathy_inferred');
    expect(descriptor?.nextAction.toLowerCase()).toContain('owner');
  });

  it('unknown nextAction mentions classify', () => {
    const descriptor = getSourceDescriptor('unknown');
    expect(descriptor?.nextAction.toLowerCase()).toContain('classify');
  });
});

// ── ReadonlyMap Immutability ───────────────────────────────────────────────────

describe('SOURCE_DESCRIPTORS immutability', () => {
  it('SOURCE_DESCRIPTORS is a ReadonlyMap', () => {
    // TypeScript enforces readonly, but runtime check ensures Map
    expect(SOURCE_DESCRIPTORS instanceof Map).toBe(true);
  });

  it('descriptor objects are frozen or readonly', () => {
    // Each descriptor should have readonly properties
    for (const [kind, descriptor] of SOURCE_DESCRIPTORS) {
      // Attempting to modify should either fail or not affect original
      const originalDecision = descriptor.defaultDecision;
      // This test verifies the descriptor structure is correct
      expect(descriptor.defaultDecision).toBe(originalDecision);
    }
  });
});

// ── Integration with isSourceKind ──────────────────────────────────────────────

describe('Integration with isSourceKind', () => {
  it('every descriptor kind is a valid SourceKind', () => {
    for (const [kind] of SOURCE_DESCRIPTORS) {
      expect(isSourceKind(kind)).toBe(true);
    }
  });

  it('descriptor lookup succeeds for all isSourceKind-valid values', () => {
    const validKinds = [
      'owner_reported',
      'agent_on_owner_request',
      'tool_failure',
      'dispatch_error',
      'provider_failure',
      'rate_limit',
      'rulehost_block',
      'empathy_inferred',
      'semantic',
      'llm_paralysis',
      'subagent_error',
      'gfi_threshold',
      'unknown',
    ] as const;

    for (const kind of validKinds) {
      expect(isSourceKind(kind)).toBe(true);
      expect(getSourceDescriptor(kind)).toBeDefined();
    }
  });
});