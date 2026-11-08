import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ConfigFileOps {
  mkdtempSync: typeof fs.mkdtempSync;
  openSync: typeof fs.openSync;
  writeFileSync: typeof fs.writeFileSync;
  writeSync: typeof fs.writeSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  rmdirSync: typeof fs.rmdirSync;
  readFileSync: typeof fs.readFileSync;
  existsSync: typeof fs.existsSync;
}

const FILE_OPS: ConfigFileOps = fs;

/** Extract a POSIX errno code (EPERM/EACCES/ENOENT/...) from a thrown fs error. */
export function errnoCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'code')) return undefined;
  const { code } = value as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** Rename errnos worth retrying: a host process (WorkBuddy) holding the
 * target with exclusive sharing surfaces as these on Windows. Transient by
 * nature — the host rewrites its settings periodically and releases. */
const RETRYABLE_RENAME_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface AtomicReplaceRetryOptions {
  /** Total rename attempts (default 5: initial + 4 retries). */
  maxAttempts?: number;
  sleep?: (milliseconds: number) => void;
}

/**
 * The target changed after the transaction snapshot; guarded replacement was
 * refused. `committed: false` means this writer did NOT replace the target.
 *
 * LIMIT (must not be described as a CAS): POSIX/Windows filesystems expose no
 * portable compare-and-swap rename. The guard re-reads and byte-compares
 * immediately before each rename, which narrows but CANNOT eliminate the
 * cross-process window between that read and the rename itself. A concurrent
 * write landing inside that window is not detectable here; callers must keep
 * the original snapshot as manual-recovery evidence instead of claiming the
 * concurrent edit survived.
 */
export class AtomicReplaceConflictError extends Error {
  readonly committed = false;
  readonly filePath: string;
  /** Private temp dir left behind when cleanup also failed (manual review). */
  readonly residueDir: string | undefined;

  constructor(filePath: string, residueDir?: string, cleanupDetail?: string) {
    const residue = residueDir !== undefined
      ? `; temporary write residue preserved at ${residueDir}` +
        (cleanupDetail !== undefined ? ` (${cleanupDetail})` : '')
      : '';
    super(
      `Atomic replacement refused because ${filePath} changed after the transaction snapshot${residue}. ` +
      'This is a best-effort byte guard, NOT an atomic compare-and-swap: a concurrent write landing in the final read-then-rename window cannot be ruled out.',
    );
    this.name = 'AtomicReplaceConflictError';
    this.filePath = filePath;
    this.residueDir = residueDir;
  }
}

/** The target rename committed, but cleanup of the private temp directory failed. */
export class AtomicReplaceCleanupError extends Error {
  readonly committed = true;
  readonly filePath: string;
  readonly tempDir: string;

  constructor(filePath: string, tempDir: string, cleanupError: unknown) {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(`Atomic replacement committed at ${filePath}, but temporary directory cleanup failed at ${tempDir}: ${detail}`);
    this.name = 'AtomicReplaceCleanupError';
    this.filePath = filePath;
    this.tempDir = tempDir;
  }
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Same-directory, flushed temp write followed by atomic replacement.
 * PRI-1062: the rename stage retries briefly on Windows lock errnos — the
 * WorkBuddy host holds settings.json while running and a single-attempt
 * rename turned minutes of installer work into a full rollback. */
// eslint-disable-next-line @typescript-eslint/max-params -- fs-ops seam + retry options; merging them would break every existing ops caller
export function atomicReplaceTextFile(
  filePath: string,
  content: string | Uint8Array,
  ops: ConfigFileOps = FILE_OPS,
  retry: AtomicReplaceRetryOptions = {},
  expectedCurrentBytes?: Uint8Array,
): void {
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 5);
  const wait = retry.sleep ?? sleepSync;
  const tempDir = ops.mkdtempSync(path.join(path.dirname(filePath), '.pd-config-write-'));
  const tempPath = path.join(tempDir, 'config.yaml');
  let fd: number | undefined;
  let replaced = false;
  let operationError: unknown;
  try {
    fd = ops.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    if (typeof content === 'string') ops.writeFileSync(fd, content, 'utf8');
    else ops.writeFileSync(fd, content);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        // A rollback caller supplies the exact bytes PD previously wrote.
        // Revalidate at the commit boundary on every retry so an edit observed
        // before the rename is not replaced by a stale snapshot. This is a
        // best-effort guard, NOT an atomic CAS: the read and the rename are two
        // separate syscalls and a non-cooperating process can write between
        // them. See AtomicReplaceConflictError for the documented limit.
        if (expectedCurrentBytes !== undefined) {
          let currentBytes: Buffer;
          try {
            currentBytes = Buffer.from(ops.readFileSync(filePath));
          } catch (error) {
            if (errnoCode(error) === 'ENOENT') throw new AtomicReplaceConflictError(filePath);
            throw error;
          }
          if (!currentBytes.equals(Buffer.from(expectedCurrentBytes))) {
            throw new AtomicReplaceConflictError(filePath);
          }
        }
        ops.renameSync(tempPath, filePath);
        operationError = undefined;
        break;
      } catch (error: unknown) {
        operationError = error;
        if (attempt >= maxAttempts - 1 || !RETRYABLE_RENAME_ERRNOS.has(errnoCode(error) ?? '')) break;
        wait(Math.min(100 * 2 ** attempt, 1_600));
      }
    }
    if (operationError === undefined) replaced = true;
  } catch (error: unknown) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (fd !== undefined) {
    try { ops.closeSync(fd); } catch (error: unknown) { cleanupError = error; }
  }
  if (!replaced && ops.existsSync(tempPath)) {
    try { ops.unlinkSync(tempPath); } catch (error: unknown) { cleanupError ??= error; }
  }
  if (ops.existsSync(tempDir)) {
    try { ops.rmdirSync(tempDir); } catch (error: unknown) { cleanupError ??= error; }
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    // A guarded conflict is the authoritative verdict (rename never committed).
    // Surface it with the residue path instead of an opaque AggregateError, so
    // the rollback can report the real state and preserve recovery evidence.
    if (operationError instanceof AtomicReplaceConflictError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AtomicReplaceConflictError(operationError.filePath, tempDir, detail);
    }
    throw new AggregateError([operationError, cleanupError], 'Atomic config replacement and cleanup both failed');
  }
  if (operationError !== undefined) throw operationError instanceof Error ? operationError : new Error(String(operationError));
  if (cleanupError !== undefined) {
    if (replaced) throw new AtomicReplaceCleanupError(filePath, tempDir, cleanupError);
    throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
  }
}

function readLockPid(lockPath: string, ops: ConfigFileOps): number | null {
  try {
    const value = Number.parseInt(ops.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isNaN(value) ? null : value;
  } catch {
    return null;
  }
}

export interface ConfigFileLockOptions {
  ops?: ConfigFileOps;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => void;
}

/** Cross-process O_EXCL lock following the project's Runtime lock convention. */
export function withConfigFileLock<T>(
  filePath: string,
  action: () => T,
  options: ConfigFileLockOptions = {},
): T {
  const ops = options.ops ?? FILE_OPS;
  const lockPath = `${filePath}.lock`;
  const maxAttempts = options.maxAttempts ?? 50;
  const wait = options.sleep ?? sleepSync;
  let acquired = false;
  for (let attempt = 0; attempt < maxAttempts && !acquired; attempt += 1) {
    let lockFd: number | undefined;
    try {
      lockFd = ops.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      ops.writeSync(lockFd, String(process.pid));
      ops.fsyncSync(lockFd);
      ops.closeSync(lockFd);
      lockFd = undefined;
      acquired = true;
    } catch (error: unknown) {
      if (lockFd !== undefined) {
        try { ops.closeSync(lockFd); } catch { /* preserve the acquisition error */ }
        try { ops.unlinkSync(lockPath); } catch { /* preserve the acquisition error */ }
      }
      if (errnoCode(error) !== 'EEXIST') throw error;
      // Ownership rule: EEXIST never authorizes deletion. PID/age metadata may
      // be stale or malformed, but only the creator may remove this lock.
      if (attempt < maxAttempts - 1) {
        wait(Math.min(10 * 2 ** attempt, 500));
      }
    }
  }
  if (!acquired) {
    const holderPid = readLockPid(lockPath, ops);
    const holder = holderPid === null ? 'unknown' : `PID ${holderPid}`;
    throw new Error(
      `Failed to acquire config lock ${lockPath}; holder ${holder}; ` +
      'nextAction=remove the lock manually only after verifying no installer is active',
    );
  }
  try {
    return action();
  } finally {
    if (readLockPid(lockPath, ops) === process.pid) ops.unlinkSync(lockPath);
  }
}
