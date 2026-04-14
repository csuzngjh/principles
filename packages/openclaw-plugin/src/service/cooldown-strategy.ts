/**
 * Cooldown Strategy -- Tiered escalation for persistent task failures
 * ===========================================================
 *
 * Manages cooldown escalation state persisted to nocturnal-runtime.json.
 * When the failure classifier (failure-classifier.ts) detects persistent
 * failure (3+ consecutive failures), this module applies escalating
 * cooldowns: 30min -> 4h -> 24h (cap).
 *
 * State is stored in NocturnalRuntimeState.taskFailureState, keyed by
 * taskKind string. Uses exported readState/writeState from
 * nocturnal-runtime.ts for atomic file access with locking.
 */

import { readState as readStateAsync, readStateSync, writeState } from './nocturnal-runtime.js';
import type { CooldownEscalationConfig } from './nocturnal-config.js';
import { loadCooldownEscalationConfig } from './nocturnal-config.js';
import type { ClassifiableTaskKind } from './failure-classifier.js';

/**
 * Record a persistent failure and escalate the cooldown tier.
 * Called when the failure classifier detects persistent failure pattern.
 *
 * State transitions:
 *   No state -> Tier 1 (30min cooldown)
 *   Tier 1 -> Tier 2 (4h cooldown)
 *   Tier 2 -> Tier 3 (24h cooldown)
 *   Tier 3 -> Tier 3 (24h cooldown, capped)
 */
export async function recordPersistentFailure(
    stateDir: string,
    taskKind: ClassifiableTaskKind,
    config?: CooldownEscalationConfig,
): Promise<void> {
    const resolvedConfig = config ?? loadCooldownEscalationConfig(stateDir);

    const state = await readStateAsync(stateDir);
    if (!state.taskFailureState) state.taskFailureState = {};

    const current = state.taskFailureState[taskKind] ?? {
        consecutiveFailures: 0,
        escalationTier: 0,
    };

    current.consecutiveFailures++;
    current.escalationTier = Math.min(current.escalationTier + 1, 3);

    const tierKey = Math.min(current.escalationTier, 3) as 1 | 2 | 3;
    const durationMs = resolvedConfig[`tier${tierKey}_ms` as keyof CooldownEscalationConfig] as number;
    current.cooldownUntil = new Date(Date.now() + durationMs).toISOString();

    state.taskFailureState[taskKind] = current;
    await writeState(stateDir, state);
}

/**
 * Reset failure state for a task kind on successful completion.
 * Resets both consecutiveFailures and escalationTier to 0.
 */
export async function resetFailureState(
    stateDir: string,
    taskKind: ClassifiableTaskKind,
): Promise<void> {
    const state = await readStateAsync(stateDir);
    if (!state.taskFailureState?.[taskKind]) return; // No state to reset

    state.taskFailureState[taskKind] = {
        consecutiveFailures: 0,
        escalationTier: 0,
    };
    await writeState(stateDir, state);
}

/**
 * Check if a task kind is currently in cooldown.
 * Returns remaining cooldown duration or 0 if not in cooldown.
 */
export function isTaskKindInCooldown(
    stateDir: string,
    taskKind: ClassifiableTaskKind,
): { inCooldown: boolean; remainingMs: number; cooldownUntil: string | null } {
    const state = readStateSync(stateDir);

    const failureState = state.taskFailureState?.[taskKind];
    if (!failureState?.cooldownUntil) {
        return { inCooldown: false, remainingMs: 0, cooldownUntil: null };
    }

    const cooldownEnd = new Date(failureState.cooldownUntil).getTime();
    const remaining = cooldownEnd - Date.now();
    if (remaining <= 0) {
        return { inCooldown: false, remainingMs: 0, cooldownUntil: null };
    }

    return { inCooldown: true, remainingMs: remaining, cooldownUntil: failureState.cooldownUntil };
}
