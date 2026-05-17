import type { PrincipleStatus } from './pruning-read-model.js';

export const DEFAULT_L1_HARD_CAP = 12;
export const MAX_L1_HARD_CAP = 12;

export interface L1CapConfig {
  hardCap: number;
}

export interface L1EvictionCandidate {
  id: string;
  lastTriggeredAt: string;
  status: PrincipleStatus;
}

export interface L1EvictionResult {
  beforeCount: number;
  afterCount: number;
  evictedIds: string[];
  reason: string;
  cap: number;
}

export function validateL1CapConfig(config: L1CapConfig): void {
  if (config.hardCap > MAX_L1_HARD_CAP) {
    throw new Error(`L1 hard cap ${config.hardCap} exceeds maximum allowed cap of ${MAX_L1_HARD_CAP}. Config may lower but not raise the cap above ${MAX_L1_HARD_CAP}.`);
  }
  if (config.hardCap <= 0) {
    throw new Error(`L1 hard cap must be a positive integer, got ${config.hardCap}.`);
  }
}

export function enforceL1HardCap(
  candidates: L1EvictionCandidate[],
  config: L1CapConfig,
): L1EvictionResult {
  validateL1CapConfig(config);

  const active = candidates.filter((c) => c.status === 'active');
  const beforeCount = active.length;

  if (beforeCount <= config.hardCap) {
    return {
      beforeCount,
      afterCount: beforeCount,
      evictedIds: [],
      reason: '',
      cap: config.hardCap,
    };
  }

  const sorted = [...active].sort((a, b) => {
    const timeA = Date.parse(a.lastTriggeredAt);
    const timeB = Date.parse(b.lastTriggeredAt);
    if (timeA !== timeB) return timeA - timeB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const evictCount = beforeCount - config.hardCap;
  const evictedIds = sorted.slice(0, evictCount).map((c) => c.id);

  return {
    beforeCount,
    afterCount: config.hardCap,
    evictedIds,
    reason: `l1-hard-cap: ${beforeCount} active L1 principles exceeded cap of ${config.hardCap}, evicted ${evictCount} least-recently-triggered`,
    cap: config.hardCap,
  };
}
