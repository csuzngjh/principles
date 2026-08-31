/**
 * Codex ingestion catch-up (PRI-624 Slice C; SPEC §13/§15).
 *
 * Bounded non-destructive catch-up of transcript lag for rollouts the
 * authenticated Workspace hook already delivered: every checkpoint in the
 * workspace trajectory database names a rollout that once arrived with an
 * authenticated transcript_path. For each (bounded) checkpoint we resolve the
 * rollout's transcript by EXACT uuid (never a session scan), re-authorize the
 * path through the same validator the hook uses, run the same bounded
 * incremental delta from the checkpoint, and feed any admission candidates
 * through the same Slice B admission/continuation pass the hook runs.
 *
 * Gated by `codex_conversation_ingestion`: flag-off performs ZERO transcript
 * filesystem I/O — no checkpoint-to-path resolution, no sessions-tree lookup,
 * no reads (SPEC §10 hard privacy invariant; the port spy test covers the
 * lookup path too).
 */
import { computeFeatureFlagsFromConfig } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin, listGovernanceCheckpoints, type GovernanceCheckpointRecord } from '@principles/host-runtime';
import { resolveCodexHome } from './codex-home.js';
import { locateCodexTranscriptByRolloutIdentity } from './transcript-locate.js';
import { ingestCodexTranscriptFromPath, type CodexIngestionOutcome } from './ingestion.js';
import type { TranscriptPort } from './transcript-decoder.js';
import { runGovernanceAdmission } from './admission.js';

export interface CodexCatchUpOptions {
  readonly workspaceDir: string;
  readonly env?: { CODEX_HOME?: string | undefined };
  readonly now?: Date;
  readonly port?: TranscriptPort;
  /** Bounded per invocation (default 8 rollouts × the 1 MiB batch bound). */
  readonly maxRollouts?: number;
}

export interface CodexCatchUpRolloutResult {
  readonly rolloutIdentity: string;
  readonly outcome: CodexIngestionOutcome;
  /** Admission degradations from this rollout's candidates (bounded by runGovernanceAdmission). */
  readonly admissionDegradations: readonly { reason: string; nextAction: string }[];
}

export type CodexCatchUpResult =
  | { status: 'skipped'; reason: string; nextAction: string }
  | {
    status: 'ok' | 'degraded';
    /** Rollouts processed this invocation (bounded). */
    readonly rollouts: readonly CodexCatchUpRolloutResult[];
    /** Processed rollouts that still carry lag (degraded or lagBytes > 0). */
    readonly remainingLagRollouts: readonly string[];
    /** Checkpoints not examined this invocation because of the bound (rotation converges them over repeated passes). */
    readonly unexaminedRollouts: readonly string[];
  };

const DEFAULT_MAX_ROLLOUTS = 8;

export const CODEX_CATCH_UP_NEXT_ACTION = 'Set features.codex_conversation_ingestion.enabled=true in the selected Workspace .pd/config.yaml to enable bounded conversation ingestion.';

/**
 * Perform one bounded catch-up pass. `remainingLagRollouts` is derived from
 * each processed rollout's reported lag plus the checkpoints left unprocessed
 * by the bound — callers (worker cycle / CLI) repeat passes to converge.
 */
export async function catchUpCodexIngestion(options: CodexCatchUpOptions): Promise<CodexCatchUpResult> {
  const { workspaceDir } = options;
  // Flag gate FIRST — before resolveCodexHome, checkpoint listing, any FS I/O.
  const config = loadPdConfigForPlugin(workspaceDir);
  if (!config.ok) {
    const [first] = config.errors;
    return { status: 'skipped', reason: `pd_config_invalid:${first?.reason ?? 'unknown'}`, nextAction: first?.nextAction ?? 'Repair .pd/config.yaml.' };
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.codex']?.enabled !== true) {
    return { status: 'skipped', reason: 'host.codex_disabled', nextAction: 'Set features.host.codex.enabled=true in the selected Workspace to enable PD.' };
  }
  if (flags.codex_conversation_ingestion?.enabled !== true) {
    return { status: 'skipped', reason: 'feature_disabled', nextAction: CODEX_CATCH_UP_NEXT_ACTION };
  }

  const home = resolveCodexHome(options.env);
  if (!home.ok) return { status: 'skipped', reason: home.reason, nextAction: home.nextAction };

  const listed = listGovernanceCheckpoints({ workspaceDir, hostKind: 'codex' });
  if (!listed.ok) return { status: 'skipped', reason: listed.reason, nextAction: listed.nextAction };

  const maxRollouts = Math.max(1, Math.min(options.maxRollouts ?? DEFAULT_MAX_ROLLOUTS, 32));
  const checkpoints: GovernanceCheckpointRecord[] = listed.checkpoints.slice(0, maxRollouts);
  const unprocessed = listed.checkpoints.slice(maxRollouts);

  const rollouts: CodexCatchUpRolloutResult[] = [];
  const remainingLagRollouts: string[] = [];
  for (const checkpoint of checkpoints) {
    const located = locateCodexTranscriptByRolloutIdentity(home.home, checkpoint.rolloutIdentity);
    if (!located.ok) {
      remainingLagRollouts.push(checkpoint.rolloutIdentity);
      rollouts.push({
        rolloutIdentity: checkpoint.rolloutIdentity,
        outcome: { status: 'degraded', reason: located.reason, nextAction: located.nextAction, warnings: [] },
        admissionDegradations: [],
      });
      continue;
    }
    const outcome = ingestCodexTranscriptFromPath({
      workspaceDir,
      transcriptPath: located.transcriptPath,
      fallbackRootSessionId: checkpoint.rootSessionId,
      env: options.env,
      now: options.now,
      port: options.port,
    });
    let admissionDegradations: { reason: string; nextAction: string }[] = [];
    if (outcome.status === 'ok' && outcome.admissionCandidates.length > 0) {
      const admission = await runGovernanceAdmission({ workspaceDir, candidates: outcome.admissionCandidates });
      admissionDegradations = [...admission.degradations];
    }
    if (outcome.status !== 'ok' || outcome.lagBytes > 0) {
      remainingLagRollouts.push(checkpoint.rolloutIdentity);
    }
    rollouts.push({ rolloutIdentity: checkpoint.rolloutIdentity, outcome, admissionDegradations });
  }
  const unexaminedRollouts = unprocessed.map((leftover) => leftover.rolloutIdentity);

  const anyDegraded = rollouts.some((entry) => entry.outcome.status === 'degraded' || entry.admissionDegradations.length > 0);
  return {
    status: anyDegraded ? 'degraded' : 'ok',
    rollouts,
    remainingLagRollouts,
    unexaminedRollouts,
  };
}
