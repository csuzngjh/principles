/**
 * OpenClaw live user-turn capture for exact target-turn evidence.
 *
 * The worker/read-back path consumes the host-neutral governance observation
 * store, while OpenClaw's ordinary interaction row lives in user_turns. This
 * is the connection between those existing mechanisms: when the real prompt
 * hook persists a user interaction and the workspace has granted OpenClaw
 * conversation-ingestion consent, the SAME admitted utterance is appended as
 * one live governance observation keyed by the host's exact message id.
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
  readonly text: string;
  readonly logger?: Partial<PluginLogger>;
  readonly now?: Date;
}): void {
  if (!usableHostId(input.sessionId) || !usableHostId(input.hostTurnId) || input.text.length === 0) return;
  const authorization = readSourceMaterialAuthorization({ workspaceDir: input.workspaceDir, hostKind: 'openclaw' });
  if (authorization.status === 'blocked') return;
  try {
    const result = ingestGovernanceObservations({
      workspaceDir: input.workspaceDir,
      observations: [{
        hostKind: 'openclaw',
        rolloutIdentity: input.sessionId,
        rootSessionId: input.sessionId,
        hostTurnId: input.hostTurnId,
        kind: 'user_turn',
        logicalObservationKey: `openclaw|${input.sessionId}|${input.hostTurnId}|user`,
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
