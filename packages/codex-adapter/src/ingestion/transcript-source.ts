/**
 * Codex transcript source adapter for the host-neutral conversation-ingestion
 * seam (PRI-1171 P1; SPEC v0.2 §4.1/§4.4).
 *
 * Everything Codex-specific about LOCATING and DECODING a rollout lives here:
 *   - locate: Codex home resolution + `validateCodexTranscriptPath`
 *     containment and pre-open identity capture (SPEC §9 — never scan for
 *     another file);
 *   - decodeWindow: the rollout record projection (transcript-decoder.ts)
 *     plus the supported-version guard, expressed as the seam's data-shaped
 *     `guard` verdict so the pipeline can refuse a delta without ingesting
 *     or advancing the checkpoint;
 *   - rollout lineage (root session / parent / agent / depth / cliVersion)
 *     resolved with the committed checkpoint as fallback, exactly as the
 *     pre-seam orchestrator did (behavior lock).
 *
 * The seam (host-runtime/conversation-ingestion) stays format-agnostic; this
 * is the per-host thin half of "one decoder per host".
 */
import type {
  GovernanceCheckpointRecord,
  HookHints,
  SessionRef,
  TranscriptDelta,
  TranscriptLocator,
  TranscriptSourceAdapter,
  TranscriptWindow,
} from '@principles/host-runtime';
import { resolveCodexHome } from './codex-home.js';
import { validateCodexTranscriptPath } from './transcript-path.js';
import { classifyCodexVersion, CODEX_VERSION_NEXT_ACTION } from './codex-version.js';
import { decodeTranscriptWindow } from './transcript-decoder.js';

export interface CodexTranscriptSourceContext {
  readonly env: { CODEX_HOME?: string | undefined };
  /** Hook-payload session id — the last-ditch root-session fallback (G1 §4). */
  readonly fallbackRootSessionId: string;
  readonly now: Date;
}

export function createCodexTranscriptSource(context: CodexTranscriptSourceContext): TranscriptSourceAdapter {
  return {
    hostKind: 'codex',

    locate(_session: SessionRef, hints: HookHints): TranscriptLocator {
      const home = resolveCodexHome(context.env);
      if (!home.ok) return { status: 'degraded', reason: home.reason, nextAction: home.nextAction };
      if (typeof hints.transcriptPath !== 'string' || hints.transcriptPath.length === 0) {
        // SPEC §9: never scan for another file; keep a neutral degraded result.
        return { status: 'degraded', reason: 'transcript_unavailable', nextAction: 'Codex supplied no transcript for this event; nothing is read or fabricated.' };
      }
      const validated = validateCodexTranscriptPath(hints.transcriptPath, home.home);
      if (!validated.ok) return { status: 'degraded', reason: validated.reason, nextAction: validated.nextAction };
      return {
        status: 'ok',
        filePath: validated.canonicalPath,
        expectedIdentity: validated.identity,
        sessionIdentity: validated.rolloutIdentity,
      };
    },

    decodeWindow(
      locator: TranscriptLocator & { status: 'ok' },
      window: TranscriptWindow,
      checkpoint: GovernanceCheckpointRecord | null,
    ): TranscriptDelta {
      const decoded = decodeTranscriptWindow({
        bytes: window.bytes,
        fileOffset: window.fileOffset,
        byteBoundReached: window.byteBoundReached,
        rolloutIdentity: locator.sessionIdentity,
        fallbackRootSessionId: checkpoint !== null ? checkpoint.rootSessionId : context.fallbackRootSessionId,
        nowIso: context.now.toISOString(),
      });

      // Supported-version guard (SPEC §9): the version signal lives in the
      // transcript session_meta (or the committed checkpoint after the first
      // batch). Anything below the verified floor or above the verified
      // ceiling refuses the delta — never guess record fields of an unknown
      // contract.
      const cliVersion = decoded.rolloutMeta.cliVersion ?? checkpoint?.cliVersion ?? null;
      const version = classifyCodexVersion(cliVersion);
      const guard = version.status === 'supported'
        ? null
        : { reason: `${version.reason}:${cliVersion ?? 'unknown'}`, nextAction: CODEX_VERSION_NEXT_ACTION };

      return {
        observations: decoded.observations,
        rollout: {
          rootSessionId: decoded.rolloutMeta.rootSessionId ?? checkpoint?.rootSessionId ?? context.fallbackRootSessionId,
          ...(cliVersion !== null ? { cliVersion } : {}),
          ...(decoded.rolloutMeta.parentRolloutIdentity !== null ? { parentRolloutIdentity: decoded.rolloutMeta.parentRolloutIdentity } : {}),
          ...(decoded.rolloutMeta.agentIdentity !== null ? { agentIdentity: decoded.rolloutMeta.agentIdentity } : {}),
          ...(decoded.rolloutMeta.agentDepth !== null ? { agentDepth: decoded.rolloutMeta.agentDepth } : {}),
        },
        guard,
        compactionTimestamp: decoded.compactionTimestamp,
        rollbackTurns: decoded.rollbackTurns,
        stop: decoded.stop,
        nextByteOffset: decoded.nextByteOffset,
        lastOrdinal: decoded.lastOrdinal,
        warnings: decoded.warnings,
        fileSize: window.fileSize,
      };
    },
  };
}
