/**
 * WorkBuddy transcript path authorization (PRI-1171 P2; SPEC v0.2 §4.4,
 * tech design §5.1 — deterministic locate, never a directory scan).
 *
 * The ONLY accepted transcript sources are, in order:
 *   1. a hook-payload path (`transcript_path` from
 *      UserPromptSubmit/SessionStart/SessionEnd; `agent_transcript_path`
 *      from Stop — capability-matrix Table A), empty strings skipped
 *      (InstructionsLoaded carries `""`, workbuddy-session-transcript-access
 *      §6.2);
 *   2. the deterministic derivation
 *      `<home>/.workbuddy/projects/<encodeCwd(cwd)>/<sessionId>.jsonl`.
 *
 * Validation mirrors the Codex locator model: absolute path, `..` traversal
 * rejection, native canonicalization (symlink/junction escape), containment
 * under the projects root, the main-session file-name contract
 * (`<uuid>.jsonl` DIRECTLY inside a project directory — subagent files
 * under `<parent>/subagents/agent-*.jsonl` are P3 scope and rejected here),
 * and a regular-file requirement with pre-open identity capture for the
 * port's post-open TOCTOU revalidation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeWorkbuddyCwd } from './encode-cwd.js';

/** File identity captured at validation; the seam port re-proves it post-open. */
export interface WorkbuddyTranscriptFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export type WorkbuddyTranscriptPathValidation =
  | { ok: true; canonicalPath: string; sessionIdentity: string; identity: WorkbuddyTranscriptFileIdentity }
  | {
    ok: false;
    reason: 'transcript_path_invalid' | 'transcript_path_outside_projects_root' | 'transcript_path_not_main_session';
    nextAction: string;
  };

const SESSION_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** Canonicalize to the final long form (native realpath first; 8.3-safe, mirrors the Codex locator). */
function canonicalizePath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return fs.realpathSync(target);
  }
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

/** Projects root: `<home>/.workbuddy/projects` (engine-side join, forensics §2.2). */
export function workbuddyProjectsRoot(home: string): string {
  return path.join(home, '.workbuddy', 'projects');
}

/**
 * Authorize one transcript path against the WorkBuddy projects root.
 *
 * Rejects non-absolute input, `..` segments, non-`<uuid>.jsonl` names, paths
 * whose native canonical form escapes the root, non-regular files and
 * subagent-nested files. On success returns the native canonical path, the
 * parsed session identity and the pre-open file identity.
 */
export function validateWorkbuddyTranscriptPath(transcriptPath: string, projectsRoot: string): WorkbuddyTranscriptPathValidation {
  if (!path.isAbsolute(transcriptPath) || hasParentTraversal(transcriptPath)) {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'WorkBuddy must supply an absolute transcript path without traversal segments.' };
  }
  if (!SESSION_FILE_NAME.test(path.basename(transcriptPath))) {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'the transcript file name does not match the WorkBuddy main-session contract (<sessionId>.jsonl).' };
  }

  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = canonicalizePath(projectsRoot);
    canonicalPath = canonicalizePath(transcriptPath);
  } catch {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'the transcript path (or the WorkBuddy projects root) does not resolve to an existing location.' };
  }
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'transcript_path_outside_projects_root', nextAction: 'the transcript is not inside the WorkBuddy projects root; refusing to read outside the host transcript store.' };
  }
  // Main sessions sit DIRECTLY inside a project directory; anything deeper
  // (subagents/agent-*.jsonl, P3 scope) is not a P2 ingestion source.
  if (relative.split(/[\\/]+/).length !== 2) {
    return { ok: false, reason: 'transcript_path_not_main_session', nextAction: 'only main-session transcripts are ingested in P2; subagent transcripts are follow-up scope.' };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(canonicalPath);
  } catch {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'the transcript file disappeared during validation.' };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'the transcript path is not a regular file.' };
  }
  const sessionIdentity = path.basename(canonicalPath, '.jsonl').toLowerCase();
  return {
    ok: true,
    canonicalPath,
    sessionIdentity,
    identity: { dev: stats.dev, ino: Number(stats.ino), size: stats.size, mtimeMs: stats.mtimeMs },
  };
}

/** Encode a cwd into ONE safe path segment; null when the result is empty or NUL-bearing. */
function encodeCwdSafe(cwd: string): string | null {
  const encoded = encodeWorkbuddyCwd(cwd);
  // An encoded cwd becomes ONE path segment; separators were collapsed, so
  // only a NUL or an all-separator input could still threaten the join.
  if (encoded.length === 0 || encoded.includes('\0')) return null;
  return encoded;
}

/**
 * Deterministic derivation (fallback when no hook payload path exists):
 * `<home>/.workbuddy/projects/<encodeCwd(cwd)>/<sessionId>.jsonl`. Returns
 * null when the session identity or cwd cannot produce a contract-shaped
 * path — the caller degrades, it never scans for a "latest" file.
 */
export function deriveWorkbuddyTranscriptPath(input: { home: string; cwd: string; sessionId: string }): string | null {
  if (input.sessionId.length === 0 || input.cwd.length === 0) return null;
  if (!SESSION_FILE_NAME.test(`${input.sessionId.toLowerCase()}.jsonl`)) return null;
  const encoded = encodeCwdSafe(input.cwd);
  if (encoded === null) return null;
  return path.join(workbuddyProjectsRoot(input.home), encoded, `${input.sessionId.toLowerCase()}.jsonl`);
}
