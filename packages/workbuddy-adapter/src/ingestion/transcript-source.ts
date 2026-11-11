/**
 * WorkBuddy transcript source adapter for the host-neutral
 * conversation-ingestion seam (PRI-1171 P2; SPEC v0.2 §4.1/§4.4, tech
 * design §5).
 *
 * Everything WorkBuddy-specific about LOCATING and DECODING a session
 * transcript lives here (the seam stays format-agnostic):
 *   - locate: hook-payload paths first (empty strings skipped —
 *     InstructionsLoaded carries `""`, forensics §6.2), then the
 *     deterministic `<home>/.workbuddy/projects/<encodeCwd(cwd)>/
 * <sessionId>.jsonl` derivation. No directory scan, no "latest" guess;
 *   - decodeWindow: the flat-record projection (transcript-decoder.ts) with
 *     synthesized ordinals seeded from the committed checkpoint;
 *   - no host contract guard (the WorkBuddy engine auto-updates and the
 *     record contract is tolerated, not version-pinned — new variants are
 *     visible as `wb_unknown_record_type` warnings, never guessed);
 *   - compactionTimestamp is ALWAYS null: WorkBuddy compaction only appends
 *     a summary record (history stays valid), and the store treats that
 *     parameter as an active tombstone (tech design §5.4);
 *   - single-session size alert: a transcript over 50MB reports
 *     `wb_transcript_oversized:<bytes>` (tech design §12) — batched
 *     catch-up keeps ingesting, the health surface shows the lag.
 */
import fs from 'node:fs';
import os from 'node:os';
import type {
  GovernanceCheckpointRecord,
  HookHints,
  SessionRef,
  TranscriptDelta,
  TranscriptLocator,
  TranscriptSourceAdapter,
  TranscriptWindow,
} from '@principles/host-runtime';
import { deriveWorkbuddyTranscriptPath, validateWorkbuddyTranscriptPath, workbuddyProjectsRoot } from './transcript-path.js';
import { decodeWorkbuddyTranscriptWindow } from './transcript-decoder.js';

/** Single-session alert threshold (tech design §12). */
export const WORKBUDDY_SINGLE_SESSION_ALERT_BYTES = 50 * 1024 * 1024;

export interface WorkbuddyTranscriptSourceContext {
  /** `now` for fallback observedAt stamps (tests inject a fixed clock). */
  readonly now: Date;
  /** Home override for tests; production falls back to the OS home directory. */
  readonly home?: string | undefined;
}

function nonEmptyHint(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function existsFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

export function createWorkbuddyTranscriptSource(context: WorkbuddyTranscriptSourceContext): TranscriptSourceAdapter {
  return {
    hostKind: 'workbuddy',

    locate(session: SessionRef, hints: HookHints, env: { home?: string }): TranscriptLocator {
      const home = env.home ?? context.home ?? os.homedir();
      const projectsRoot = workbuddyProjectsRoot(home);

      // 1. Hook-payload paths, empty strings skipped (forensics §6.2).
      const hinted = nonEmptyHint(hints.transcriptPath) ?? nonEmptyHint(hints.agentTranscriptPath);
      if (hinted !== null) {
        const validated = validateWorkbuddyTranscriptPath(hinted, projectsRoot);
        if (!validated.ok) return { status: 'degraded', reason: validated.reason, nextAction: validated.nextAction };
        // Session binding (P2 review): a contract-shaped path inside the
        // projects root can still belong to ANOTHER session. Reading it would
        // file that session's evidence under this hook's rollout identity, so
        // the path's identity must equal the host session identity. The check
        // compares the PARSED identity, never just the file name shape.
        const hookSessionId = session.sessionId.trim().toLowerCase();
        if (hookSessionId.length === 0) {
          return {
            status: 'degraded',
            reason: 'transcript_session_unverified',
            nextAction: 'the hook payload has no session_id, so the transcript path cannot be bound to this session; nothing is read.',
          };
        }
        if (validated.sessionIdentity !== hookSessionId) {
          return {
            status: 'degraded',
            reason: 'transcript_session_mismatch',
            nextAction: `the hinted transcript belongs to session ${validated.sessionIdentity}, not ${hookSessionId}; PD refuses to read another session's evidence.`,
          };
        }
        return { status: 'ok', filePath: validated.canonicalPath, expectedIdentity: validated.identity, sessionIdentity: validated.sessionIdentity };
      }

      // 2. Deterministic derivation from the session identity + cwd.
      const derived = deriveWorkbuddyTranscriptPath({ home, cwd: session.cwd ?? '', sessionId: session.sessionId });
      if (derived === null) {
        return { status: 'degraded', reason: 'transcript_unavailable', nextAction: 'no hook transcript path and no derivable session transcript; nothing is read or fabricated.' };
      }
      const validated = validateWorkbuddyTranscriptPath(derived, projectsRoot);
      if (!validated.ok && validated.reason === 'transcript_path_invalid' && !existsFile(derived)) {
        // The derived session file simply does not exist yet — neutral
        // unavailability, not an invalid payload.
        return { status: 'degraded', reason: 'transcript_unavailable', nextAction: 'no WorkBuddy transcript exists yet for this session; nothing is read or fabricated.' };
      }
      if (!validated.ok) return { status: 'degraded', reason: validated.reason, nextAction: validated.nextAction };
      return { status: 'ok', filePath: validated.canonicalPath, expectedIdentity: validated.identity, sessionIdentity: validated.sessionIdentity };
    },

    decodeWindow(
      locator: TranscriptLocator & { status: 'ok' },
      window: TranscriptWindow,
      checkpoint: GovernanceCheckpointRecord | null,
    ): TranscriptDelta {
      const decoded = decodeWorkbuddyTranscriptWindow({
        bytes: window.bytes,
        fileOffset: window.fileOffset,
        byteBoundReached: window.byteBoundReached,
        sessionIdentity: locator.sessionIdentity,
        startOrdinal: checkpoint !== null ? checkpoint.lastOrdinal + 1 : 0,
        nowIso: context.now.toISOString(),
      });

      const warnings = [...decoded.warnings];
      if (window.fileSize > WORKBUDDY_SINGLE_SESSION_ALERT_BYTES) {
        warnings.push(`wb_transcript_oversized:${window.fileSize}`);
      }

      return {
        observations: decoded.observations,
        rollout: {
          rootSessionId: checkpoint?.rootSessionId ?? locator.sessionIdentity,
        },
        guard: null,
        // §5.4 hard guardrail: NEVER pass a compaction tombstone for
        // WorkBuddy — jsonl history stays valid after compaction.
        compactionTimestamp: null,
        rollbackTurns: [],
        stop: decoded.stop,
        nextByteOffset: decoded.nextByteOffset,
        lastOrdinal: decoded.lastOrdinal,
        warnings,
        fileSize: window.fileSize,
      };
    },
  };
}
