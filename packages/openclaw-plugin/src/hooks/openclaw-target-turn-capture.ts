/**
 * OpenClaw live user-turn capture for exact target-turn evidence.
 *
 * The worker/read-back path consumes the host-neutral governance observation
 * store, while OpenClaw's ordinary interaction row lives in user_turns. This
 * is the connection between those existing mechanisms: when the real prompt
 * hook persists a user interaction and the workspace has granted OpenClaw
 * conversation-ingestion consent, the SAME admitted utterance is appended as
 * one live governance observation keyed by the host's exact turn identity:
 * the native message id when OpenClaw supplies one, otherwise the per-session
 * user-turn index already persisted with that same interaction. The fallback
 * is therefore a host-persisted exact identity, never a nearby-turn guess.
 *
 * No transcript scan, no retry queue, no second evidence authority: the write
 * is idempotent on the logical observation key and missing/revoked consent is
 * an ordinary no-write. Capture failures are observable and never block the
 * prompt path.
 */
import { ingestGovernanceObservations, readSourceMaterialAuthorization } from '@principles/host-runtime';
import type { PluginLogger } from '../openclaw-sdk.js';

function usableHostId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() === value && value.length <= 200;
}

function bounded(value: string): string {
  return Array.from(value).slice(0, 120).join('');
}

export function captureOpenclawUserTurnForTargetEvidence(input: {
  readonly workspaceDir: string;
  readonly sessionId: string;
  readonly hostTurnId: unknown;
  /** Exact persisted per-session user-turn index used when the embedded
   * OpenClaw entry supplies no native message id. */
  readonly fallbackHostTurnId?: string;
  readonly text: string;
  readonly logger?: Partial<PluginLogger>;
  readonly now?: Date;
}): void {
  const hostTurnId = usableHostId(input.hostTurnId) ? input.hostTurnId : input.fallbackHostTurnId;
  if (!usableHostId(input.sessionId) || !usableHostId(hostTurnId) || input.text.length === 0) return;
  const authorization = readSourceMaterialAuthorization({ workspaceDir: input.workspaceDir, hostKind: 'openclaw' });
  if (authorization.status === 'blocked') return;
  try {
    const result = ingestGovernanceObservations({
      workspaceDir: input.workspaceDir,
      observations: [{
        hostKind: 'openclaw',
        rolloutIdentity: input.sessionId,
        rootSessionId: input.sessionId,
        hostTurnId,
        kind: 'user_turn',
        logicalObservationKey: `openclaw|${input.sessionId}|${hostTurnId}|user`,
        visibleText: input.text,
        source: 'live_hook',
        completeness: 'complete',
        observedAt: (input.now ?? new Date()).toISOString(),
      }],
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (!result.ok) {
      input.logger?.warn?.(`[PD:Prompt] target-turn governance capture failed: ${bounded(result.reason ?? 'unknown')}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.logger?.warn?.(`[PD:Prompt] target-turn governance capture error: ${bounded(detail)}`);
  }
}
