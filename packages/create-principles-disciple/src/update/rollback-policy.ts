/**
 * Host coordination and automatic-rollback policy (SPEC §9).
 *
 * One global active release per installation. Only hosts that were RUNNING
 * before activation must restart and complete the handshake — hosts that
 * were already stopped are not failures. If any previously-running host
 * cannot start the same release, every affected host returns to the prior
 * release: a split-brain component mix must never become active.
 *
 * Attribution rules:
 * - Deterministic failures attributable to the new release (entrypoint load,
 *   handshake mismatch, startup crash) qualify for automatic rollback.
 * - Network unavailability, empty business data, and unrelated
 *   external-service failures do NOT — they would roll back a healthy
 *   release for environmental noise.
 *
 * At most ONE automatic rollback per transaction. A second deterministic
 * failure opens the circuit breaker: the last confirmed release stays
 * active and an explicit Owner action is required.
 */

export type HostHandshakeOutcome =
  | { readonly kind: 'passed' }
  | { readonly kind: 'not_restarted' }
  | { readonly kind: 'failed'; readonly failureClass: HostFailureClass; readonly detail: string };

export type HostFailureClass =
  | 'deterministic_start_failure'
  | 'handshake_mismatch'
  | 'network_unavailable'
  | 'external_service_unavailable'
  | 'unknown';

export interface HostObservation {
  readonly hostId: string;
  readonly wasRunningBeforeActivation: boolean;
  readonly outcome: HostHandshakeOutcome;
}

export type RollbackDecision =
  | { readonly action: 'confirm'; readonly reason: string }
  | { readonly action: 'retry_handshake'; readonly reason: string; readonly nextAction: string }
  | { readonly action: 'auto_rollback'; readonly reason: string; readonly hosts: readonly string[] }
  | { readonly action: 'circuit_breaker_open'; readonly reason: string; readonly nextAction: string };

const DETERMINISTIC_CLASSES: ReadonlySet<HostFailureClass> = new Set(['deterministic_start_failure', 'handshake_mismatch']);

export function decideHostCoordination(input: {
  observations: readonly HostObservation[];
  autoRollbackAlreadyUsed: boolean;
}): RollbackDecision {
  const { observations, autoRollbackAlreadyUsed } = input;
  if (observations.length === 0) {
    return { action: 'confirm', reason: 'no hosts required coordination' };
  }

  const mustRestart = observations.filter((observation) => observation.wasRunningBeforeActivation);
  if (mustRestart.length === 0) {
    return { action: 'confirm', reason: 'no hosts were running before activation; nothing to restart' };
  }

  const deterministicFailures = mustRestart.filter((observation) => observation.outcome.kind === 'failed'
    && DETERMINISTIC_CLASSES.has(observation.outcome.failureClass));
  const environmentalFailures = mustRestart.filter((observation) => observation.outcome.kind === 'failed'
    && !DETERMINISTIC_CLASSES.has(observation.outcome.failureClass));
  const pending = mustRestart.filter((observation) => observation.outcome.kind === 'not_restarted');

  if (deterministicFailures.length > 0) {
    const failingHosts = deterministicFailures.map((observation) => observation.hostId);
    if (autoRollbackAlreadyUsed) {
      return {
        action: 'circuit_breaker_open',
        reason: `A second deterministic failure followed the transaction's single automatic rollback (hosts: ${failingHosts.join(', ')}).`,
        nextAction: 'The last confirmed release remains active. Inspect the failing host logs under ~/.pd/logs, fix the cause, and run an explicit update or rollback operation.',
      };
    }
    return {
      action: 'auto_rollback',
      reason: `Deterministic startup failures attributable to the new release (hosts: ${failingHosts.join(', ')}); all affected hosts return to the previous confirmed release to avoid split brain.`,
      hosts: failingHosts,
    };
  }

  if (environmentalFailures.length > 0 || pending.length > 0) {
    const affected = [...environmentalFailures, ...pending].map((observation) => observation.hostId);
    return {
      action: 'retry_handshake',
      reason: `Non-deterministic conditions (network / external service / still restarting) on hosts: ${affected.join(', ')}. These do not qualify for automatic rollback.`,
      nextAction: 'Retry the release handshake for the affected hosts. The release stays activated-but-unconfirmed until every previously running host passes or a deterministic failure appears.',
    };
  }

  return { action: 'confirm', reason: 'every previously running host completed the release handshake' };
}
