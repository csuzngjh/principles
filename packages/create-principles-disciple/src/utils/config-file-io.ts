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

function errnoCode(value: unknown): string | undefined {
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

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Cross-process O_EXCL lock following the project's Runtime V2 lock convention. */
export function withConfigFileLock<T>(filePath: string, action: () => T, ops: ConfigFileOps = FILE_OPS): T {
  const lockPath = `${filePath}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt += 1) {
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
      const holderPid = readLockPid(lockPath, ops);
      if (holderPid === null || !isProcessAlive(holderPid)) {
        try { ops.unlinkSync(lockPath); } catch { /* another contender may have won */ }
      } else if (attempt < 49) {
        sleepSync(Math.min(10 * 2 ** attempt, 500));
      }
    }
  }
  if (!acquired) {
    throw new Error(`Failed to acquire config lock ${lockPath}. Retry after the active installer exits.`);
  }
  try {
    return action();
  } finally {
    if (readLockPid(lockPath, ops) === process.pid) ops.unlinkSync(lockPath);
  }
}
