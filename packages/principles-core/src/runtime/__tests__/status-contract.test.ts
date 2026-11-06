import { describe, expect, it } from 'vitest';
import type { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { PD_TASK_STATUSES, PDTaskStatusSchema, isPDTaskStatus } from '../task-status.js';
import { PRINCIPLE_STATUSES, PrincipleStatusSchema } from '../types/principle-enums.js';
import type { PrincipleStatus } from '../types/principle-enums.js';
import type { EvolutionPrincipleStatus } from '../evolution/evolution-types.js';

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

