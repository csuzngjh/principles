/**
 * Principle Context Reader (SPEC v1.1 §4/§4.7, Technical Design v0.3 §3).
 *
 * host-runtime PRIVATE implementation: this module is deliberately NOT
 * re-exported from the package barrel and forms no public Context API. All
 * three hosts reach it through the shared adaptive provider only.
 *
 * Contract summary (TD §3.2/§3.3 is the authority):
 * - The single data source is `<workspaceDir>/memory/okr/CURRENT_FOCUS.md`,
 *   the Owner-maintained Principle Context file. The whole file is the
 *   context; no Markdown region parsing, no new PRINCIPLE_CONTEXT.md.
 * - Read-only forever: no create, no repair, no backup, no mkdir. The Owner's
 *   bytes are never modified (normalization works on an in-memory copy).
 * - Path safety: canonical workspace root (realpath), then a per-level lstat
 *   walk (memory → memory/okr → the file) rejecting symlinks / Windows
 *   junction-reparse entries, plus a realpath containment check at each level.
 *   Only after that is a FileHandle opened, and only that handle is read.
 *   `fstat` does NOT return a path — containment comes from the root + the
 *   lstat/realpath walk; the handle stat only proves "regular file + identity
 *   + size" (do not claim fstat proves path location).
 * - Identity: the identity measured for the target during path validation is
 *   compared with the identity of the OBJECT the handle actually opened
 *   (`handle.stat()`). POSIX compares dev+ino (reliable same-object identity
 *   within a run). Windows has no usable inode semantics in Node's Stats, so
 *   only a best-effort WEAK fingerprint (birthtimeMs + size) is compared: a
 *   mismatch is a replacement signal (fail-closed), but a match does NOT prove
 *   the file was not replaced. The resolved path cannot participate in that
 *   comparison: `fstat` returns no path, and the path the handle was opened
 *   from is exactly the path validated in step 2. TOCTOU residual risk is NOT
 *   eliminated and is not claimed to be (no platform-native extensions).
 * - All failures fail closed into the seven-value reason enum below; the
 *   reader never throws into the host prompt path and never returns raw OS
 *   errors, absolute paths, or context text in its diagnostics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Fixed relative target (SPEC §4.7: never composed from Context content). */
export const PRINCIPLE_CONTEXT_SEGMENTS = ['memory', 'okr', 'CURRENT_FOCUS.md'] as const;

export const PRINCIPLE_CONTEXT_LIMITS = {
  /** Raw file ceiling checked BEFORE reading (SPEC §4.4). */
  maxRawFileBytes: 65_536,
  /** Read buffer bound: one byte past the ceiling detects post-stat growth. */
  maxReadBytes: 65_537,
  /** Normalized context ceiling in JavaScript UTF-16 code units (no truncation). */
  maxContextChars: 4_000,
} as const;

/**
 * The ONLY reason-code standard (SPEC §4.7 / TD §3.2). The four-value status
 * below is a display grouping; `invalid` is a status, never a reason code.
 */
export type PrincipleContextReason =
  | 'file_missing'
  | 'unreadable'
  | 'unsafe_path'
  | 'too_large'
  | 'read_failed'
  | 'empty_content'
  | 'normalize_failed';

export type PrincipleContextRead =
  | {readonly status: 'available'; readonly text: string}
  | {readonly status: 'missing'; readonly reason: 'file_missing' | 'empty_content'}
  | {readonly status: 'invalid'; readonly reason: 'unsafe_path' | 'too_large' | 'normalize_failed'}
  | {readonly status: 'unreadable'; readonly reason: 'unreadable' | 'read_failed'};

type LevelIdentity = {readonly dev: number; readonly ino: number; readonly birthtimeMs: number; readonly size: number};

interface ErrnoLikeError extends Error {
  readonly code?: unknown;
}

function isErrnoException(value: unknown): value is ErrnoLikeError {
  return value instanceof Error && typeof (value as ErrnoLikeError).code === 'string';
}

/**
 * Cross-platform containment via path.relative — NEVER a string-prefix test.
 * `startsWith(root + sep)` misjudges drive/slash boundaries (e.g. `C:\\abc`
 * vs `C:\\abc-def`, mixed separators) and POSIX root. path.relative returns:
 * - `''`            → candidate IS root (equal);
 * - a relative path → candidate is inside root;
 * - an absolute path or one starting with `..` → outside.
 * Separator normalization keeps mixed-separator strings (Windows APIs may
 * return either) from producing a false `..` escape.
 *
 * Exported for in-package test surface only (this module is deliberately not
 * on the package barrel): the containment predicate's boundary behavior is
 * part of the security contract and is asserted directly.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  const normalized = rel.split(path.sep).join('/');
  return !normalized.startsWith('../') && normalized !== '..' && !path.isAbsolute(normalized);
}

/**
 * Windows junctions / reparse points surface through Node's lstat as symbolic
 * links on modern Node, so one predicate covers both platforms. Anything that
 * is not a plain directory/file (FIFO, device, socket) is rejected as well.
 */
function isForbiddenEntry(stats: fs.Stats, expect: 'directory' | 'file'): boolean {
  if (stats.isSymbolicLink()) return true;
  return expect === 'directory' ? !stats.isDirectory() : !stats.isFile();
}

function identityOf(stats: fs.Stats): LevelIdentity {
  return {dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs, size: stats.size};
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Same-object comparison, used both for "validated target vs opened handle"
 * (the TOCTOU closure) and "opened vs post-read" (mid-read replacement).
 * POSIX: dev+ino is a reliable identity within this run. Windows: best-effort
 * weak fingerprint — a MISMATCH proves replacement (fail-closed), but a MATCH
 * does NOT prove the file is unchanged (two different files can share size and
 * birth time). Never present this as inode-equivalent proof.
 */
function identityMatches(opened: LevelIdentity, current: LevelIdentity): boolean {
  if (!IS_WINDOWS) return opened.dev === current.dev && opened.ino === current.ino;
  // Weak fingerprint only (documented best-effort, not an identity proof).
  return opened.birthtimeMs === current.birthtimeMs && opened.size === current.size;
}

const UTF8_FATAL = new TextDecoder('utf-8', {fatal: true});

/**
 * Deterministic in-memory normalization (SPEC §4.3): strict UTF-8 decode →
 * strip BOM → CRLF to LF → trim outer whitespace. No truncation, no semantic
 * rewriting, no folding of internal Markdown structure.
 */
export function normalizePrincipleContextText(raw: Buffer):
  | {readonly ok: true; readonly text: string}
  | {readonly ok: false; readonly reason: 'normalize_failed' | 'empty_content'} {
  let text: string;
  try {
    text = UTF8_FATAL.decode(raw);
  } catch {
    return {ok: false, reason: 'normalize_failed'};
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/gu, '\n');
  text = text.trim();
  if (text.length === 0) return {ok: false, reason: 'empty_content'};
  if (text.length > PRINCIPLE_CONTEXT_LIMITS.maxContextChars) {
    // Over the ceiling is invalid — never truncate to fit.
    return {ok: false, reason: 'normalize_failed'};
  }
  return {ok: true, text};
}

function isAbsoluteRegularPath(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

async function resolveCanonicalRoot(workspaceDir: string): Promise<string | null> {
  try {
    const root = await fs.promises.realpath(workspaceDir);
    return isAbsoluteRegularPath(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * Execution-budget binding (SPEC §5.8 / TD §3.3): the Reader participates in
 * the host's Adaptive window instead of running on an unbounded clock. The
 * checks are COOPERATIVE stage gates placed before EVERY new I/O stage:
 * before the root resolve, before each parent level, before open, and then
 * open → gate → stat → gate → size validation → gate → read (plus a gate
 * after the read, which discards an over-budget result) — Node's promise-based
 * lstat/realpath/open and `FileHandle.read` accept NO AbortSignal, so an
 * in-flight single I/O call cannot be truly cancelled by Node core APIs. What
 * the deadline guarantees is therefore: once the budget is exhausted, no
 * FURTHER I/O starts and the turn fails closed to "no context"; an
 * already-started handle.read finishes bounded (≤65,537 bytes) and its result
 * is discarded. This is disclosed as a residual limitation, not claimed as
 * true cancellation.
 */
export interface PrincipleContextReaderBudget {
  /** Absolute host deadline (epoch ms); the provider passes its host window. */
  readonly deadlineAt?: number;
  /** Cooperative abort signal (checked at every stage gate). */
  readonly signal?: AbortSignal;
  /** Test seam; production uses Date.now. */
  readonly now?: () => number;
}

export async function readPrincipleContext(
  workspaceDir: string,
  budget: PrincipleContextReaderBudget = {},
): Promise<PrincipleContextRead> {
  const now = budget.now ?? Date.now;
  // Stage gate: `pre-open` exhaustion maps to `unreadable` (nothing was
  // opened); `post-open` exhaustion maps to `read_failed` (an open handle
  // exists). Both are inside the seven-value reason enum.
  const budgetExhausted = (): boolean => {
    if (budget.signal?.aborted === true) return true;
    return budget.deadlineAt !== undefined && now() >= budget.deadlineAt;
  };
  const preOpenExhausted = (): PrincipleContextRead => ({status: 'unreadable', reason: 'unreadable'});
  const postOpenExhausted = (): PrincipleContextRead => ({status: 'unreadable', reason: 'read_failed'});

  if (!isAbsoluteRegularPath(workspaceDir)) {
    return {status: 'invalid', reason: 'unsafe_path'};
  }
  if (budgetExhausted()) return preOpenExhausted();

  // Step 1 — canonical workspace root. A root that cannot be resolved is
  // unsafe to derive containment from (TD §3.3 step 1).
  const root = await resolveCanonicalRoot(workspaceDir);
  if (root === null) return {status: 'invalid', reason: 'unsafe_path'};

  // Step 2 — per-level validation of the fixed parent chain.
  let current = root;
  const segments = PRINCIPLE_CONTEXT_SEGMENTS;
  let targetPath = root;
  // The identity path validation measured for the target. The opened handle
  // must describe THIS object, not merely a self-consistent one (TOCTOU).
  let validatedTargetIdentity: LevelIdentity | null = null;
  for (let index = 0; index < segments.length; index++) {
    if (budgetExhausted()) return preOpenExhausted();
    const segment = segments[index];
    // noUncheckedIndexedAccess: an out-of-range read is impossible for this
    // fixed tuple; fail closed rather than casting.
    if (segment === undefined) return {status: 'invalid', reason: 'unsafe_path'};
    const isLast = index === segments.length - 1;
    current = path.join(current, segment);
    targetPath = current;

    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return {status: 'missing', reason: 'file_missing'};
      return {status: 'unreadable', reason: 'unreadable'};
    }
    if (isForbiddenEntry(stats, isLast ? 'file' : 'directory')) {
      return {status: 'invalid', reason: 'unsafe_path'};
    }
    if (isLast) validatedTargetIdentity = identityOf(stats);
    if (budgetExhausted()) return preOpenExhausted();
    let resolved: string;
    try {
      resolved = await fs.promises.realpath(current);
    } catch {
      return {status: 'invalid', reason: 'unsafe_path'};
    }
    if (!isWithin(root, resolved)) return {status: 'invalid', reason: 'unsafe_path'};
  }
  // Unreachable for the fixed tuple, but never open without a validated
  // identity: the TOCTOU comparison below must have a left-hand side.
  if (validatedTargetIdentity === null) return {status: 'invalid', reason: 'unsafe_path'};

  // Step 3 — handle-based bounded read. The path was validated level by level
  // above; from here only the opened handle is trusted. O_NOFOLLOW where the
  // platform provides it; elsewhere the lstat walk above is the guard.
  if (budgetExhausted()) return preOpenExhausted();
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW !== undefined && !IS_WINDOWS ? fs.constants.O_NOFOLLOW : 0);
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(targetPath, flags);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return {status: 'missing', reason: 'file_missing'};
    if (isErrnoException(error) && error.code === 'ELOOP') return {status: 'invalid', reason: 'unsafe_path'};
    return {status: 'unreadable', reason: 'unreadable'};
  }

  try {
    if (budgetExhausted()) return postOpenExhausted();
    let openedStats: fs.Stats;
    try {
      openedStats = await handle.stat();
    } catch {
      return {status: 'unreadable', reason: 'read_failed'};
    }
    if (!openedStats.isFile()) return {status: 'invalid', reason: 'unsafe_path'};
    // Stage gate: `handle.stat()` itself may have consumed the last budget.
    // No new I/O (and no body read) may start after that.
    if (budgetExhausted()) return postOpenExhausted();
    // TOCTOU closure (TD §3.3 step 3): the handle must describe the SAME
    // object path validation measured. Path validation proved the location;
    // this proves the opened object, so a swap between validation and open
    // (file or parent directory) fails closed before one byte is read.
    if (!identityMatches(identityOf(openedStats), validatedTargetIdentity)) {
      return {status: 'unreadable', reason: 'read_failed'};
    }
    // The hard raw-file ceiling applies BEFORE reading (SPEC §4.7 #5).
    if (openedStats.size > PRINCIPLE_CONTEXT_LIMITS.maxRawFileBytes) {
      return {status: 'invalid', reason: 'too_large'};
    }
    if (budgetExhausted()) return postOpenExhausted();

    const buffer = Buffer.alloc(PRINCIPLE_CONTEXT_LIMITS.maxReadBytes);
    let bytesRead: number;
    try {
      const {bytesRead: read} = await handle.read(buffer, 0, PRINCIPLE_CONTEXT_LIMITS.maxReadBytes, 0);
      bytesRead = read;
    } catch {
      return {status: 'unreadable', reason: 'read_failed'};
    }
    // The in-flight read could not be cancelled (Node API limitation — see
    // the budget interface docs); if the budget ran out during it, discard
    // the bytes instead of using them.
    if (budgetExhausted()) return postOpenExhausted();
    if (bytesRead > PRINCIPLE_CONTEXT_LIMITS.maxRawFileBytes) {
      return {status: 'invalid', reason: 'too_large'};
    }
    // The read must describe the same object the stat measured.
    if (bytesRead !== openedStats.size) return {status: 'unreadable', reason: 'read_failed'};

    // Best-effort replacement detection between open-time and post-read stat.
    if (budgetExhausted()) return postOpenExhausted();
    let postStats: fs.Stats;
    try {
      postStats = await handle.stat();
    } catch {
      return {status: 'unreadable', reason: 'read_failed'};
    }
    if (!postStats.isFile()) return {status: 'unreadable', reason: 'read_failed'};
    if (!identityMatches(identityOf(openedStats), identityOf(postStats))) {
      return {status: 'unreadable', reason: 'read_failed'};
    }
    if (postStats.size > PRINCIPLE_CONTEXT_LIMITS.maxRawFileBytes) {
      return {status: 'invalid', reason: 'too_large'};
    }

    const normalized = normalizePrincipleContextText(buffer.subarray(0, bytesRead));
    if (!normalized.ok) {
      return normalized.reason === 'empty_content'
        ? {status: 'missing', reason: 'empty_content'}
        : {status: 'invalid', reason: 'normalize_failed'};
    }
    return {status: 'available', text: normalized.text};
  } finally {
    await handle.close().catch(() => undefined);
  }
}
