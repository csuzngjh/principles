/**
 * Codex transcript locator — moved to host-runtime in Slice D (PRI-625):
 * the §15 health surface must compute per-rollout lag with the SAME locator
 * the catch-up path uses (one truth for "where is this rollout's transcript"),
 * and host-runtime cannot import codex-adapter. The adapter re-exports it.
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

export type CodexTranscriptLookup =
  | { ok: true; transcriptPath: string; /** file size in bytes at lookup time (null when stat fails); lets health compute lag without its own stat call */ sizeBytes: number | null }
  | { ok: false; reason: 'catch_up_rollout_identity_invalid' | 'catch_up_sessions_root_missing' | 'catch_up_transcript_missing' | 'catch_up_transcript_ambiguous' | 'catch_up_lookup_exhausted'; nextAction: string };

/** Bounded walk: hard cap on visited directory entries so a pathological sessions tree cannot stall the worker. */
const MAX_LOOKUP_ENTRIES = 5000;

const ROLLOUT_IDENTITY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UUID_HEX = /^[0-9a-fA-F]+$/;

function isHex(value: string): boolean {
  return UUID_HEX.test(value);
}

/** rollout-<timestamp>-<uuid>.jsonl — returns the rollout uuid, or null when the name is off-contract. */
export function parseRolloutFileName(fileName: string): string | null {
  if (!fileName.startsWith('rollout-') || !fileName.endsWith('.jsonl')) return null;
  const stem = fileName.slice('rollout-'.length, -'.jsonl'.length);
  const parts = stem.split('-');
  if (parts.length < 6) return null; // at least one timestamp segment + the five uuid groups
  const [a, b, c, d, e] = parts.slice(-5);
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) return null;
  if (a.length !== 8 || b.length !== 4 || c.length !== 4 || d.length !== 4 || e.length !== 12) return null;
  if (!isHex(a) || !isHex(b) || !isHex(c) || !isHex(d) || !isHex(e)) return null;
  return parts.slice(-5).join('-').toLowerCase();
}

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
  const transcriptPath = matches[0] as string;
  let sizeBytes;
  try {
    sizeBytes = fs.statSync(transcriptPath).size;
  } catch {
    sizeBytes = null;
  }
  return { ok: true, transcriptPath, sizeBytes };
}
