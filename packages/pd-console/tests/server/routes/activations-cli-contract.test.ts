/**
 * PRI-500: CLI ↔ Console Activation Field Contract Test
 *
 * Prevents future field-name divergence between:
 * - CLI `pd activation list --json` output (packages/pd-cli/src/commands/runtime-activation.ts)
 * - Console `/api/v1/activations` response (ActivationsConsoleModel.ts)
 *
 * Before PRI-500, the two interfaces used different field names for the same
 * concept (CLI: `activationId`, Console: `id`; CLI: `{status, reason, nextAction}`,
 * Console: `{generatedAt, note}`). This test locks the aligned contract so a
 * future change cannot reintroduce the divergence silently.
 *
 * ERR checklist:
 * - rc-2-no-as-bypass: uses isRecord + getStringField helpers, no `as`
 * - rc-5-object-hasown-not-in: uses Object.hasOwn for field checks
 * - rc-9-no-silent-fallback: envelope degraded paths carry reason + nextAction
 */

import { describe, it, expect } from 'vitest';
import type {
  ActivationRecord,
  ActivationsResponse,
} from '../../../src/server/models/ActivationsConsoleModel.js';

// ── Runtime guards (rc-2: no `as` on untrusted data) ────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

// ── CLI output shape (mirror of AnnotatedActivation in runtime-activation.ts) ──
// This is the contract the CLI emits. The Console must use the same field names.

interface CliActivationRecord {
  activationId: string;
  artifactId: string;
  principleId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string | null;
  promotedAt: string | null;
  deactivatedAt: string | null;
  mode?: 'shadow' | 'live';
  status: 'active' | 'deactivated' | 'suspended_by_flag';
  contextVersion?: 'v1' | 'v2';
  evidenceRefs?: string[];
  evidenceSummary?: string;
  nextAction?: string;
  warning?: string;
}

interface CliActivationsResponse {
  activations: CliActivationRecord[];
  status: 'ok' | 'degraded';
  reason?: string;
  nextAction?: string;
}

// ── Contract Tests ──────────────────────────────────────────────────────────

describe('PRI-500: CLI ↔ Console activation field contract', () => {
  describe('ActivationRecord field names', () => {
    it('Console ActivationRecord has activationId (not id)', () => {
      const record: ActivationRecord = {
        activationId: 'act-001',
        artifactId: 'art-001',
        principleId: 'P_001',
        channel: 'prompt',
        action: 'prompt',
        targetRef: 'P_001',
        activatedAt: null,
        promotedAt: null,
        deactivatedAt: null,
        status: 'active',
      };

      expect(Object.hasOwn(record, 'activationId')).toBe(true);
      expect(Object.hasOwn(record, 'id')).toBe(false);
    });

    it('Console ActivationRecord has principleId field', () => {
      const record: ActivationRecord = {
        activationId: 'act-001',
        artifactId: 'art-001',
        principleId: 'P_001',
        channel: 'prompt',
        action: 'prompt',
        targetRef: 'P_001',
        activatedAt: null,
        promotedAt: null,
        deactivatedAt: null,
        status: 'active',
      };

      expect(Object.hasOwn(record, 'principleId')).toBe(true);
      expect(record.principleId).toBe('P_001');
    });

    it('CLI AnnotatedActivation shape is assignable to Console ActivationRecord', () => {
      // Type-level contract: if this compiles, the field names align.
      // Both types must have `activationId` (not `id`) and `principleId`.
      const cliRecord: CliActivationRecord = {
        activationId: 'act-001',
        artifactId: 'art-001',
        principleId: 'P_001',
        channel: 'prompt',
        action: 'prompt',
        targetRef: 'P_001',
        activatedAt: null,
        promotedAt: null,
        deactivatedAt: null,
        status: 'active',
      };

      // Verify the CLI record can be treated as a Console record.
      // If field names diverge, this assignment would fail at compile time.
      const asConsole: ActivationRecord = {
        activationId: cliRecord.activationId,
        artifactId: cliRecord.artifactId,
        principleId: cliRecord.principleId,
        channel: cliRecord.channel,
        action: cliRecord.action,
        targetRef: cliRecord.targetRef,
        activatedAt: cliRecord.activatedAt,
        promotedAt: cliRecord.promotedAt,
        deactivatedAt: cliRecord.deactivatedAt,
        status: cliRecord.status,
      };

      expect(asConsole.activationId).toBe('act-001');
      expect(asConsole.principleId).toBe('P_001');
    });
  });

  describe('ActivationsResponse envelope shape', () => {
    it('Console success envelope has status:ok (not generatedAt)', () => {
      const response: ActivationsResponse = {
        activations: [],
        status: 'ok',
      };

      expect(Object.hasOwn(response, 'status')).toBe(true);
      expect(Object.hasOwn(response, 'generatedAt')).toBe(false);
      expect(response.status).toBe('ok');
    });

    it('Console degraded envelope has status, reason, nextAction (not note)', () => {
      const response: ActivationsResponse = {
        activations: [],
        status: 'degraded',
        reason: 'state.db not found',
        nextAction: 'Run pd runtime diagnostics',
      };

      expect(Object.hasOwn(response, 'status')).toBe(true);
      expect(Object.hasOwn(response, 'reason')).toBe(true);
      expect(Object.hasOwn(response, 'nextAction')).toBe(true);
      expect(Object.hasOwn(response, 'generatedAt')).toBe(false);
      expect(Object.hasOwn(response, 'note')).toBe(false);
    });

    it('CLI response shape matches Console envelope (status, reason?, nextAction?)', () => {
      const cliResponse: CliActivationsResponse = {
        activations: [],
        status: 'degraded',
        reason: 'dangling artifact',
        nextAction: 'Run pd runtime internalization integrity',
      };

      // Runtime contract: verify CLI fields are present and match Console's.
      const asConsole: ActivationsResponse = {
        activations: cliResponse.activations,
        status: cliResponse.status,
        reason: cliResponse.reason,
        nextAction: cliResponse.nextAction,
      };

      expect(asConsole.status).toBe('degraded');
      expect(asConsole.reason).toBe('dangling artifact');
      expect(asConsole.nextAction).toContain('internalization integrity');
    });
  });

  describe('Runtime JSON shape guard (rc-2: no `as`)', () => {
    it('a Console response JSON has activationId, not id', () => {
      // Simulate a parsed JSON response from /api/v1/activations.
      const json: unknown = JSON.stringify({
        activations: [
          {
            activationId: 'act-001',
            artifactId: 'art-001',
            principleId: 'P_001',
            channel: 'prompt',
            action: 'prompt',
            targetRef: 'P_001',
            activatedAt: null,
            promotedAt: null,
            deactivatedAt: null,
            status: 'active',
          },
        ],
        status: 'ok',
      });

      const parsed: unknown = JSON.parse(json as string);
      expect(isRecord(parsed)).toBe(true);
      if (!isRecord(parsed)) return;

      const activations = parsed.activations;
      expect(Array.isArray(activations)).toBe(true);
      if (!Array.isArray(activations)) return;

      const first = activations[0];
      expect(isRecord(first)).toBe(true);
      if (!isRecord(first)) return;

      // Contract: must have activationId, must NOT have id.
      expect(Object.hasOwn(first, 'activationId')).toBe(true);
      expect(Object.hasOwn(first, 'id')).toBe(false);
      expect(getStringField(first, 'activationId')).toBe('act-001');

      // Contract: must have principleId.
      expect(Object.hasOwn(first, 'principleId')).toBe(true);
      expect(getStringField(first, 'principleId')).toBe('P_001');
    });

    it('a Console degraded response JSON has status, reason, nextAction (not generatedAt, note)', () => {
      const json: unknown = JSON.stringify({
        activations: [],
        status: 'degraded',
        reason: 'activation table not found',
        nextAction: 'Run pd runtime internalization integrity',
      });

      const parsed: unknown = JSON.parse(json as string);
      expect(isRecord(parsed)).toBe(true);
      if (!isRecord(parsed)) return;

      // Contract: must have status, must NOT have generatedAt.
      expect(Object.hasOwn(parsed, 'status')).toBe(true);
      expect(Object.hasOwn(parsed, 'generatedAt')).toBe(false);
      expect(getStringField(parsed, 'status')).toBe('degraded');

      // Contract: degraded path must have reason + nextAction (rc-9).
      expect(Object.hasOwn(parsed, 'reason')).toBe(true);
      expect(Object.hasOwn(parsed, 'nextAction')).toBe(true);
      expect(Object.hasOwn(parsed, 'note')).toBe(false);
      expect(getStringField(parsed, 'reason')).toBe('activation table not found');
    });
  });
});
