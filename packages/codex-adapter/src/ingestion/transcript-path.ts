/**
 * Codex transcript path authorization (Codex Governance Closure SPEC rev 2
 * §9; Slice A SPEC §11).
 *
 * The ONLY valid transcript source is the path explicitly supplied by the
 * authenticated Codex hook — never a scan of `$CODEX_HOME/sessions`, never a
 * "latest session" guess. Validation covers the real repository/OS path
 * model: absolute path, `..` traversal rejection, canonical (realpath)
 * normalization, containment under the resolved Codex home's `sessions`
 * root at segment boundaries, symlink/junction escape rejection (realpath
 * collapses them; containment is checked on the canonical form), and a
 * regular-file requirement. The rollout identity — one physical transcript,
 * distinct from the root session id (G1 §4 subagent/fork traps) — is the
 * uuid embedded in the Codex rollout file name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './codex-home.js';

/**
 * File identity captured at validation time. The open/read seam re-proves
 * the opened object still has this identity BEFORE any byte is read — the
 * G1 §7 / SPEC §9 post-open revalidation that closes the validate→open
 * TOCTOU window (path replacement, symlink swap).
 */
export interface TranscriptFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export type TranscriptPathValidation =
  | { ok: true; canonicalPath: string; rolloutIdentity: string; identity: TranscriptFileIdentity }
  | { ok: false; reason: 'transcript_path_invalid' | 'transcript_path_outside_codex_home'; nextAction: string };

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

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateCodexTranscriptPath(transcriptPath: string, codexHome: string): TranscriptPathValidation {
  if (!isAbsolutePath(transcriptPath) || hasParentTraversal(transcriptPath)) {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'Codex must supply an absolute transcript_path without traversal segments.' };
  }
  const fileName = path.basename(transcriptPath);
  const rolloutIdentity = parseRolloutFileName(fileName);
  if (rolloutIdentity === null) {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'the transcript file name does not match the Codex rollout contract (rollout-<timestamp>-<uuid>.jsonl).' };
  }

  let canonicalHome: string;
  let canonicalPath: string;
  try {
    // Canonicalize both sides to the final long form: Node's JS realpath
    // preserves 8.3 short-name segments while payloads carry long forms.
    canonicalHome = canonicalizePath(codexHome);
    canonicalPath = canonicalizePath(transcriptPath);
  } catch {
    return { ok: false, reason: 'transcript_path_invalid', nextAction: 'the transcript path (or the Codex home) does not resolve to an existing location.' };
  }
  // realpath collapses symlinks/junctions; checking containment on the
  // canonical form rejects escapes that traverse links out of the sessions root.
  if (!isContained(path.join(canonicalHome, 'sessions'), canonicalPath)) {
    return { ok: false, reason: 'transcript_path_outside_codex_home', nextAction: 'the transcript is not inside the resolved CODEX_HOME sessions root; refusing to read outside the authenticated Codex home.' };
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
  const identity: TranscriptFileIdentity = { dev: stats.dev, ino: Number(stats.ino), size: stats.size, mtimeMs: stats.mtimeMs };
  return { ok: true, canonicalPath, rolloutIdentity: rolloutIdentity.toLowerCase(), identity };
}
