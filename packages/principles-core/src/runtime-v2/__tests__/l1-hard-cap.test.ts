import { describe, it, expect } from 'vitest';
import {
  enforceL1HardCap,
  validateL1CapConfig,
  DEFAULT_L1_HARD_CAP,
  MAX_L1_HARD_CAP,
} from '../l1-hard-cap.js';
import type { L1EvictionCandidate } from '../l1-hard-cap.js';

function makeCandidate(
  id: string,
  opts: {
    lastTriggeredAt?: string;
    status?: L1EvictionCandidate['status'];
  } = {},
): L1EvictionCandidate {
  return {
    id,
    lastTriggeredAt: opts.lastTriggeredAt ?? '2026-01-01T00:00:00.000Z',
    status: opts.status ?? 'active',
  };
}

describe('validateL1CapConfig', () => {
  it('accepts valid config with cap <= 12', () => {
    expect(() => validateL1CapConfig({ hardCap: 12 })).not.toThrow();
    expect(() => validateL1CapConfig({ hardCap: 5 })).not.toThrow();
    expect(() => validateL1CapConfig({ hardCap: 1 })).not.toThrow();
  });

  it('rejects config with cap > 12', () => {
    expect(() => validateL1CapConfig({ hardCap: 13 })).toThrow(/cap.*12/i);
    expect(() => validateL1CapConfig({ hardCap: 100 })).toThrow(/cap.*12/i);
  });

  it('rejects config with cap <= 0', () => {
    expect(() => validateL1CapConfig({ hardCap: 0 })).toThrow(/cap/i);
    expect(() => validateL1CapConfig({ hardCap: -1 })).toThrow(/cap/i);
  });

  it('rejects config with NaN', () => {
    expect(() => validateL1CapConfig({ hardCap: NaN })).toThrow(/finite integer/i);
  });

  it('rejects config with non-integer', () => {
    expect(() => validateL1CapConfig({ hardCap: 1.5 })).toThrow(/finite integer/i);
  });

  it('rejects config with Infinity', () => {
    expect(() => validateL1CapConfig({ hardCap: Infinity })).toThrow(/finite integer/i);
  });
});

describe('enforceL1HardCap', () => {
  it('active count <= cap does nothing', () => {
    const candidates = [
      makeCandidate('p1', { lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
      makeCandidate('p2', { lastTriggeredAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const result = enforceL1HardCap(candidates, { hardCap: 12 });
    expect(result.beforeCount).toBe(2);
    expect(result.afterCount).toBe(2);
    expect(result.evictedIds).toEqual([]);
    expect(result.reason).toBe('');
  });

  it('active count > cap evicts oldest lastTriggeredAt', () => {
    const candidates = [
      makeCandidate('p_old', { lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
      makeCandidate('p_mid', { lastTriggeredAt: '2026-03-01T00:00:00.000Z' }),
      makeCandidate('p_new', { lastTriggeredAt: '2026-06-01T00:00:00.000Z' }),
    ];
    const result = enforceL1HardCap(candidates, { hardCap: 2 });
    expect(result.beforeCount).toBe(3);
    expect(result.afterCount).toBe(2);
    expect(result.evictedIds).toEqual(['p_old']);
    expect(result.reason).toContain('l1-hard-cap');
  });

  it('evicts multiple when active count far exceeds cap', () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(`p_${String(i).padStart(2, '0')}`, {
        lastTriggeredAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const result = enforceL1HardCap(candidates, { hardCap: 12 });
    expect(result.beforeCount).toBe(15);
    expect(result.afterCount).toBe(12);
    expect(result.evictedIds).toHaveLength(3);
    expect(result.evictedIds[0]).toBe('p_00');
    expect(result.evictedIds[1]).toBe('p_01');
    expect(result.evictedIds[2]).toBe('p_02');
  });

  it('tie-break: same lastTriggeredAt → sort by id (deterministic)', () => {
    const sameTime = '2026-01-01T00:00:00.000Z';
    const candidates = [
      makeCandidate('p_charlie', { lastTriggeredAt: sameTime }),
      makeCandidate('p_alpha', { lastTriggeredAt: sameTime }),
      makeCandidate('p_bravo', { lastTriggeredAt: sameTime }),
    ];
    const result = enforceL1HardCap(candidates, { hardCap: 2 });
    expect(result.evictedIds).toHaveLength(1);
    expect(result.evictedIds[0]).toBe('p_alpha');
  });

  it('only active principles considered; archived/candidate/deprecated/probation ignored', () => {
    const candidates = [
      makeCandidate('p_active_1', { status: 'active', lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
      makeCandidate('p_active_2', { status: 'active', lastTriggeredAt: '2026-02-01T00:00:00.000Z' }),
      makeCandidate('p_archived', { status: 'archived', lastTriggeredAt: '2025-01-01T00:00:00.000Z' }),
      makeCandidate('p_candidate', { status: 'candidate', lastTriggeredAt: '2025-06-01T00:00:00.000Z' }),
      makeCandidate('p_deprecated', { status: 'deprecated', lastTriggeredAt: '2025-03-01T00:00:00.000Z' }),
      makeCandidate('p_probation', { status: 'probation', lastTriggeredAt: '2025-09-01T00:00:00.000Z' }),
    ];
    const result = enforceL1HardCap(candidates, { hardCap: 12 });
    expect(result.beforeCount).toBe(2);
    expect(result.afterCount).toBe(2);
    expect(result.evictedIds).toEqual([]);
  });

  it('non-active principles are not evicted even when cap is exceeded', () => {
    const candidates = [
      makeCandidate('p_active_old', { status: 'active', lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
      makeCandidate('p_active_new', { status: 'active', lastTriggeredAt: '2026-06-01T00:00:00.000Z' }),
      makeCandidate('p_archived', { status: 'archived', lastTriggeredAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const result = enforceL1HardCap(candidates, { hardCap: 1 });
    expect(result.beforeCount).toBe(2);
    expect(result.afterCount).toBe(1);
    expect(result.evictedIds).toEqual(['p_active_old']);
  });

  it('idempotent: calling twice with same input produces same result', () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(`p_${i}`, {
        lastTriggeredAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const result1 = enforceL1HardCap(candidates, { hardCap: 12 });
    const result2 = enforceL1HardCap(candidates, { hardCap: 12 });
    expect(result1).toEqual(result2);
  });

  it('observable result includes beforeCount, afterCount, evictedIds, reason, cap', () => {
    const candidates = [
      makeCandidate('p1', { lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
      makeCandidate('p2', { lastTriggeredAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const result = enforceL1HardCap(candidates, { hardCap: 1 });
    expect(result).toHaveProperty('beforeCount');
    expect(result).toHaveProperty('afterCount');
    expect(result).toHaveProperty('evictedIds');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('cap');
    expect(result.cap).toBe(1);
    expect(result.reason).toBeTruthy();
  });

  it('empty candidates returns zero result', () => {
    const result = enforceL1HardCap([], { hardCap: 12 });
    expect(result.beforeCount).toBe(0);
    expect(result.afterCount).toBe(0);
    expect(result.evictedIds).toEqual([]);
  });

  it('throws on invalid lastTriggeredAt timestamp', () => {
    const candidates = [
      makeCandidate('p1', { lastTriggeredAt: 'not-a-date' }),
      makeCandidate('p2', { lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(() => enforceL1HardCap(candidates, { hardCap: 1 })).toThrow(/Invalid lastTriggeredAt/);
  });

  it('throws on empty string lastTriggeredAt', () => {
    const candidates = [
      makeCandidate('p1', { lastTriggeredAt: '' }),
      makeCandidate('p2', { lastTriggeredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(() => enforceL1HardCap(candidates, { hardCap: 1 })).toThrow(/Invalid lastTriggeredAt/);
  });
});

describe('DEFAULT_L1_HARD_CAP and MAX_L1_HARD_CAP', () => {
  it('DEFAULT_L1_HARD_CAP is 12', () => {
    expect(DEFAULT_L1_HARD_CAP).toBe(12);
  });

  it('MAX_L1_HARD_CAP is 12', () => {
    expect(MAX_L1_HARD_CAP).toBe(12);
  });
});
