export interface IdleTriggerConfig {
  enabled: boolean;
  idleThresholdMs: number;
  jitterMaxMs: number;
  activityCooldownMs: number;
}

export interface IdleTriggerQueueSnapshot {
  readyCount: number;
  pendingCount: number;
  retryWaitCount: number;
}

export interface IdleTriggerInput {
  lastActivityAt: string | null;
  queue: IdleTriggerQueueSnapshot;
  config: IdleTriggerConfig;
  jitterSeed: string;
  now: string;
}

export interface IdleTriggerResult {
  decision: 'trigger' | 'skip';
  reason: string;
  idleForMs: number;
  jitterMs: number;
  nextEligibleAt: string;
  queue: IdleTriggerQueueSnapshot;
}

export const DEFAULT_IDLE_TRIGGER_CONFIG: IdleTriggerConfig = {
  enabled: true,
  idleThresholdMs: 300_000,
  jitterMaxMs: 30_000,
  activityCooldownMs: 60_000,
};

export function resolveIdleTriggerConfig(partial?: Partial<IdleTriggerConfig>): IdleTriggerConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_IDLE_TRIGGER_CONFIG.enabled,
    idleThresholdMs: partial?.idleThresholdMs ?? DEFAULT_IDLE_TRIGGER_CONFIG.idleThresholdMs,
    jitterMaxMs: partial?.jitterMaxMs ?? DEFAULT_IDLE_TRIGGER_CONFIG.jitterMaxMs,
    activityCooldownMs: partial?.activityCooldownMs ?? DEFAULT_IDLE_TRIGGER_CONFIG.activityCooldownMs,
  };
}
