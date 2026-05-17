import type { IdleTriggerInput, IdleTriggerResult } from './idle-trigger-types.js';

export function computeJitterMs(seed: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  h = h ^ (h >>> 16);
  h = Math.imul(h, 0x45d9f3b);
  h = h ^ (h >>> 16);
  const abs = Math.abs(h);
  return abs % (maxMs + 1);
}

export function evaluateIdleTrigger(input: IdleTriggerInput): IdleTriggerResult {
  const { config, queue, jitterSeed, now } = input;
  const jitterMs = computeJitterMs(jitterSeed, config.jitterMaxMs);

  const nowMs = new Date(now).getTime();
  const lastActivityMs = input.lastActivityAt
    ? new Date(input.lastActivityAt).getTime()
    : 0;
  const idleForMs = nowMs - lastActivityMs;

  if (!config.enabled) {
    return {
      decision: 'skip',
      reason: 'disabled',
      idleForMs,
      jitterMs,
      nextEligibleAt: now,
      queue,
    };
  }

  if (queue.readyCount === 0 && queue.retryWaitCount > 0) {
    return {
      decision: 'skip',
      reason: 'retry_wait_pending',
      idleForMs,
      jitterMs,
      nextEligibleAt: new Date(nowMs + config.idleThresholdMs).toISOString(),
      queue,
    };
  }

  if (queue.readyCount === 0) {
    return {
      decision: 'skip',
      reason: 'no_ready_tasks',
      idleForMs,
      jitterMs,
      nextEligibleAt: now,
      queue,
    };
  }

  if (input.lastActivityAt && idleForMs < config.activityCooldownMs) {
    return {
      decision: 'skip',
      reason: 'not_idle_enough',
      idleForMs,
      jitterMs,
      nextEligibleAt: new Date(lastActivityMs + config.activityCooldownMs).toISOString(),
      queue,
    };
  }

  if (idleForMs < config.idleThresholdMs) {
    return {
      decision: 'skip',
      reason: 'not_idle_enough',
      idleForMs,
      jitterMs,
      nextEligibleAt: new Date(lastActivityMs + config.idleThresholdMs + jitterMs).toISOString(),
      queue,
    };
  }

  return {
    decision: 'trigger',
    reason: 'idle_threshold_met',
    idleForMs,
    jitterMs,
    nextEligibleAt: new Date(nowMs + config.idleThresholdMs + jitterMs).toISOString(),
    queue,
  };
}
