import { describe, expect, it } from 'vitest';
import type { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { PD_TASK_STATUSES, PDTaskStatusSchema, isPDTaskStatus } from '../task-status.js';
import { PRINCIPLE_STATUSES, PrincipleStatusSchema } from '../types/principle-enums.js';
import type { PrincipleStatus } from '../types/principle-enums.js';
import type { EvolutionPrincipleStatus } from '../evolution/evolution-types.js';
import { EvolutionQueueItemMigrator } from '../store/task-migration.js';

/** Minimal TypeBox value acceptance check (Value.Check without importing value package). */
function TypeSystemAccepts(schema: ReturnType<typeof Type.Union>, value: unknown): boolean {
  const union = schema as unknown as { anyOf?: readonly { const?: unknown }[] };
  if (!union.anyOf) return false;
  return union.anyOf.some((entry) => entry.const === value);
}

/**
 * PRI-612 — canonical status contract tests.
 *
 * PRINCIPLE_STATUSES and PD_TASK_STATUSES are the single authorities; every
 * other representation derives. These tests lock:
 * - schema⇄const parity (the derived TypeBox schemas enumerate exactly the
 *   canonical values — no more, no fewer)
 * - alias assignability (EvolutionPrincipleStatus IS PrincipleStatus)
 * - the legacy QueueStatus → PDTaskStatus lossy mapping is explicit and
 *   exhaustive, including the lossy cases (canceled→failed, in_progress→leased)
 */

describe('PRI-612 PrincipleStatus canonical contract', () => {
  it('PRINCIPLE_STATUSES is the documented 5-state lifecycle', () => {
    expect([...PRINCIPLE_STATUSES]).toEqual(['candidate', 'active', 'archived', 'deprecated', 'probation']);
  });

  it('PrincipleStatusSchema enumerates exactly the canonical values (schema⇄const parity)', () => {
    for (const status of PRINCIPLE_STATUSES) {
      expect(TypeSystemAccepts(PrincipleStatusSchema, status)).toBe(true);
    }
    // No extra values validate
    for (const invalid of ['', ' Candidate', 'retired', 'needs_human_review', 'pending']) {
      expect(TypeSystemAccepts(PrincipleStatusSchema, invalid)).toBe(false);
    }
  });

  it('Static<typeof PrincipleStatusSchema> is mutually assignable with PrincipleStatus (compile parity)', () => {
    // Two-way assignability: if either side drifts, tsc fails on these lines.
    const fromConst: PrincipleStatus = 'candidate';
    const fromSchema: Static<typeof PrincipleStatusSchema> = fromConst;
    const roundTrip: PrincipleStatus = fromSchema;
    expect(roundTrip).toBe('candidate');
  });

  it('EvolutionPrincipleStatus is a pure alias of the canonical PrincipleStatus', () => {
    const evolution: EvolutionPrincipleStatus = 'probation';
    const canonical: PrincipleStatus = evolution;
    expect(canonical).toBe('probation');
  });
});

describe('PRI-612 PDTaskStatus canonical contract', () => {
  it('PD_TASK_STATUSES is the documented 6-state lifecycle incl. needs_human_review', () => {
    expect([...PD_TASK_STATUSES]).toEqual([
      'pending',
      'leased',
      'succeeded',
      'retry_wait',
      'failed',
      'needs_human_review',
    ]);
  });

  it('PDTaskStatusSchema enumerates exactly the canonical values (schema⇄const parity)', () => {
    for (const status of PD_TASK_STATUSES) {
      expect(TypeSystemAccepts(PDTaskStatusSchema, status)).toBe(true);
    }
    for (const invalid of ['in_progress', 'completed', 'canceled', 'needs-revision', '']) {
      expect(TypeSystemAccepts(PDTaskStatusSchema, invalid)).toBe(false);
    }
  });

  it('isPDTaskStatus guards untrusted values without accepting legacy QueueStatus members', () => {
    for (const status of PD_TASK_STATUSES) {
      expect(isPDTaskStatus(status)).toBe(true);
    }
    // Legacy queue statuses must NOT silently pass as canonical statuses.
    expect(isPDTaskStatus('in_progress')).toBe(false);
    expect(isPDTaskStatus('completed')).toBe(false);
    expect(isPDTaskStatus('canceled')).toBe(false);
    expect(isPDTaskStatus(undefined)).toBe(false);
    expect(isPDTaskStatus(null)).toBe(false);
    expect(isPDTaskStatus(42)).toBe(false);
  });
});

describe('PRI-612 legacy QueueStatus → PDTaskStatus explicit mapping (lossy, exhaustive)', () => {
  it('maps every documented legacy status exactly once', () => {
    // Documented in store/task-migration.ts header — the mapping is the
    // single authority for crossing the legacy boundary.
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('pending')).toBe('pending');
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('in_progress')).toBe('leased');
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('completed')).toBe('succeeded');
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('failed')).toBe('failed');
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('canceled')).toBe('failed');
  });

  it('unknown legacy statuses are refused (null), never guessed', () => {
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('')).toBeNull();
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('needs_human_review')).toBeNull();
    expect(EvolutionQueueItemMigrator.mapLegacyStatus('SUCCEEDED')).toBeNull();
  });

  it('no legacy status can map to needs_human_review — owner-attention state is never fabricated', () => {
    // needs_human_review means a human gate fired; a legacy queue item that
    // never had that concept must not silently acquire it (or lose it — the
    // inverse direction simply does not exist in this mapping).
    for (const legacy of ['pending', 'in_progress', 'completed', 'failed', 'canceled']) {
      const mapped = EvolutionQueueItemMigrator.mapLegacyStatus(legacy);
      expect(mapped).not.toBe('needs_human_review');
      expect(mapped).not.toBeNull();
    }
  });
});

