/**
 * Codex transcript locator for catch-up (PRI-624 Slice C).
 *
 * The durable checkpoint stores only the rollout uuid (SPEC §18 scenario 9
 * forbids raw paths in the DB), so catch-up must resolve a checkpointed
 * rollout back to its transcript file. This is NOT session discovery: the
 * lookup searches for the EXACT rollout uuid of a rollout the authenticated
 * Workspace hook previously delivered (only hooks write checkpoints). It
 * never guesses a "latest session", never returns a partial match, and
 * refuses ambiguities (ADR-0020 §11.2 / SPEC §9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseRolloutFileName } from './transcript-path.js';

export type CodexTranscriptLookup =
  | { ok: true; transcriptPath: string }
  | { ok: false; reason: 'catch_up_rollout_identity_invalid' | 'catch_up_sessions_root_missing' | 'catch_up_transcript_missing' | 'catch_up_transcript_ambiguous' | 'catch_up_lookup_exhausted'; nextAction: string };

/** Bounded walk: hard cap on visited directory entries so a pathological sessions tree cannot stall the worker. */
const MAX_LOOKUP_ENTRIES = 5000;

const ROLLOUT_IDENTITY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolve one previously-authenticated rollout identity to its transcript
 * path by exact-uuid filename match under `<codexHome>/sessions`.
 */
export function locateCodexTranscriptByRolloutIdentity(codexHome: string, rolloutIdentity: string): CodexTranscriptLookup {
  if (!ROLLOUT_IDENTITY_PATTERN.test(rolloutIdentity)) {
    return { ok: false, reason: 'catch_up_rollout_identity_invalid', nextAction: 'the checkpointed rollout identity is not a rollout uuid; inspect the workspace trajectory database.' };
  }
  const sessionsRoot = path.join(codexHome, 'sessions');
  let rootStats: fs.Stats;
  try {
    rootStats = fs.statSync(sessionsRoot);
  } catch {
    return { ok: false, reason: 'catch_up_sessions_root_missing', nextAction: 'the configured CODEX_HOME has no sessions root; verify the Codex home used by the hook and by catch-up matches.' };
  }
  if (!rootStats.isDirectory()) {
    return { ok: false, reason: 'catch_up_sessions_root_missing', nextAction: 'the configured CODEX_HOME sessions path is not a directory; verify the Codex home configuration.' };
  }

  const matches: string[] = [];
  let visited = 0;
  const stack: string[] = [sessionsRoot];
  while (stack.length > 0 && matches.length < 2) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subtree — other subtrees may still hold the rollout
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_LOOKUP_ENTRIES) {
        return { ok: false, reason: 'catch_up_lookup_exhausted', nextAction: 'the sessions tree exceeded the bounded catch-up lookup; keep CODEX_HOME/sessions pruned or catch up rollouts manually.' };
      }
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (parseRolloutFileName(entry.name) === rolloutIdentity) {
          matches.push(path.join(dir, entry.name));
          if (matches.length >= 2) break;
        }
      }
    }
  }

  if (matches.length === 0) {
    return { ok: false, reason: 'catch_up_transcript_missing', nextAction: 'the checkpointed rollout has no transcript under the Codex sessions root (rotated or cleaned by Codex); its committed observations remain, the pending lag cannot be recovered.' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'catch_up_transcript_ambiguous', nextAction: 'multiple transcripts match the rollout identity; refuse to guess — inspect the Codex sessions tree.' };
  }
  return { ok: true, transcriptPath: matches[0] as string };
}
