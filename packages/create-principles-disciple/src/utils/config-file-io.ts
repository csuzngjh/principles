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

/** Same-directory, flushed temp write followed by atomic replacement. */
export function atomicReplaceTextFile(filePath: string, content: string, ops: ConfigFileOps = FILE_OPS): void {
  const tempDir = ops.mkdtempSync(path.join(path.dirname(filePath), '.pd-config-write-'));
  const tempPath = path.join(tempDir, 'config.yaml');
  let fd: number | undefined;
  let replaced = false;
  let operationError: unknown;
  try {
    fd = ops.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    ops.writeFileSync(fd, content, 'utf8');
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = undefined;
    ops.renameSync(tempPath, filePath);
    replaced = true;
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
    throw new AggregateError([operationError, cleanupError], 'Atomic config replacement and cleanup both failed');
  }
  if (operationError !== undefined) throw operationError instanceof Error ? operationError : new Error(String(operationError));
  if (cleanupError !== undefined) throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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

/** Cross-process O_EXCL lock following the project's Runtime V2 lock convention. */
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
