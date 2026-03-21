/**
 * Reliable File Lock - 可靠的文件锁实现
 * 
 * 设计原则：
 * 1. 使用 O_EXCL | O_CREAT 实现真正的原子锁获取
 * 2. PID 存活检测避免死锁
 * 3. 带退避的重试机制
 * 4. 锁获取后二次验证
 * 5. 数据不丢失：失败时抛出异常而非静默返回
 */

import * as fs from 'fs';
import * as path from 'path';

export interface LockOptions {
  /** 最大重试次数，默认 50 */
  maxRetries?: number;
  /** 基础重试延迟(ms)，默认 10 */
  baseRetryDelayMs?: number;
  /** 最大重试延迟(ms)，默认 500 */
  maxRetryDelayMs?: number;
  /** 锁过期时间(ms)，默认 10000 (10秒) */
  lockStaleMs?: number;
  /** 锁文件后缀，默认 '.lock' */
  lockSuffix?: string;
}

export interface LockContext {
  /** 锁文件路径 */
  lockPath: string;
  /** 持有锁的 PID */
  pid: number;
  /** 获取锁的时间 */
  acquiredAt: number;
}

export class LockAcquisitionError extends Error {
  public readonly filePath: string;
  public readonly lockPath: string;

  constructor(message: string, filePath: string, lockPath: string) {
    super(message);
    this.name = 'LockAcquisitionError';
    this.filePath = filePath;
    this.lockPath = lockPath;
  }
}

/** 默认锁选项 */
const DEFAULT_OPTIONS: Required<LockOptions> = {
  maxRetries: 50,
  baseRetryDelayMs: 10,
  maxRetryDelayMs: 500,
  lockStaleMs: 10000,
  lockSuffix: '.lock',
};

/**
 * 检查进程是否存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    // 发送信号 0 不会真正发送信号，只检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子创建锁文件
 * 使用 O_EXCL | O_CREAT 确保原子性
 * 
 * @returns true 表示成功获取锁，false 表示锁被占用
 */
function tryAcquireLock(lockPath: string, pid: number): boolean {
  try {
    // 确保锁文件的目录存在
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    
    // 使用 fs.constants 获取正确的 flag 值
    // O_EXCL: 排他创建 - 与 O_CREAT 一起使用时，如果文件存在则失败
    // O_CREAT: 文件不存在时创建
    // O_WRONLY: 只写模式
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
    
    // 使用底层的 openSync 实现真正的原子操作
    // 如果文件已存在，会抛出 EEXIST 错误
    const fd = fs.openSync(lockPath, flags);
    
    // 写入 PID
    fs.writeSync(fd, String(pid));
    fs.fsyncSync(fd);  // 确保数据落盘
    fs.closeSync(fd);
    
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      return false;  // 锁已被占用
    }
    // 其他错误（权限、磁盘满等）向上抛出
    throw err;
  }
}

/**
 * 读取锁文件中的 PID
 * @returns PID 或 null（如果文件不存在或无法解析）
 */
function readLockPid(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * 安全删除锁文件
 * 只有当锁文件包含当前进程的 PID 时才删除
 */
function safeReleaseLock(lockPath: string, expectedPid: number): void {
  try {
    const pid = readLockPid(lockPath);
    if (pid === expectedPid) {
      fs.unlinkSync(lockPath);
    }
    // 如果 PID 不匹配，说明锁已被其他进程重新获取，不删除
  } catch {
    // 忽略删除错误
  }
}

/**
 * 检查并清理过期锁
 */
function cleanupStaleLock(lockPath: string, staleMs: number): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const pid = readLockPid(lockPath);
    
    // 检查是否过期
    const isStale = Date.now() - stat.mtimeMs > staleMs;
    
    // 检查持有者是否已死亡
    // PID 为 null 表示锁文件损坏，应视为无效锁
    const isDead = pid === null || !isProcessAlive(pid);
    
    // 满足任一条件即可清理：过期、持有者死亡、PID 无效
    if (isStale || isDead) {
      try {
        fs.unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * 计算退避延迟（指数退避 + 抖动）
 */
function calculateBackoff(attempt: number, baseMs: number, maxMs: number): number {
  // 指数退避：10, 20, 40, 80, 160, 320, 500, 500, ...
  const exponentialDelay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  
  // 添加 20% 的随机抖动，避免多个进程同时重试
  const jitter = exponentialDelay * 0.2 * Math.random();
  
  return Math.floor(exponentialDelay + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLockError(filePath: string, lockPath: string): LockAcquisitionError {
  const holderPid = readLockPid(lockPath);
  const holderStatus = holderPid !== null
    ? (isProcessAlive(holderPid) ? `alive (PID ${holderPid})` : `dead (PID ${holderPid})`)
    : 'unknown';

  return new LockAcquisitionError(
    `Failed to acquire lock for ${filePath}. Lock holder: ${holderStatus}.`,
    filePath,
    lockPath,
  );
}

function tryAcquireWithStaleCleanup(filePath: string, opts: Required<LockOptions>, pid: number): LockContext | null {
  const lockPath = filePath + opts.lockSuffix;

  if (tryAcquireLock(lockPath, pid)) {
    const actualPid = readLockPid(lockPath);
    if (actualPid === pid) {
      return { lockPath, pid, acquiredAt: Date.now() };
    }
  }

  cleanupStaleLock(lockPath, opts.lockStaleMs);

  if (tryAcquireLock(lockPath, pid)) {
    const actualPid = readLockPid(lockPath);
    if (actualPid === pid) {
      return { lockPath, pid, acquiredAt: Date.now() };
    }
  }

  return null;
}

/**
 * 获取文件锁
 * 
 * @param filePath 要锁定的文件路径
 * @param options 锁选项
 * @returns 锁上下文（用于后续释放）
 * @throws Error 如果无法获取锁
 */
export function acquireLock(filePath: string, options: LockOptions = {}): LockContext {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pid = process.pid;

  const ctx = tryAcquireWithStaleCleanup(filePath, opts, pid);
  if (ctx) {
    return ctx;
  }

  throw buildLockError(filePath, filePath + opts.lockSuffix);
}

export async function acquireLockAsync(filePath: string, options: LockOptions = {}): Promise<LockContext> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pid = process.pid;

  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const ctx = tryAcquireWithStaleCleanup(filePath, opts, pid);
    if (ctx) {
      return ctx;
    }

    if (attempt < opts.maxRetries - 1) {
      const delay = calculateBackoff(attempt, opts.baseRetryDelayMs, opts.maxRetryDelayMs);
      await sleep(delay);
    }
  }

  throw buildLockError(filePath, filePath + opts.lockSuffix);
}

/**
 * 释放文件锁
 * 
 * @param ctx 锁上下文（由 acquireLock 返回）
 */
export function releaseLock(ctx: LockContext): void {
  safeReleaseLock(ctx.lockPath, ctx.pid);
}

/**
 * 使用锁执行操作（自动获取和释放）
 * 
 * @param filePath 要锁定的文件路径
 * @param fn 要执行的操作
 * @param options 锁选项
 * @returns 操作的返回值
 */
export function withLock<T>(
  filePath: string,
  fn: () => T,
  options: LockOptions = {}
): T {
  const ctx = acquireLock(filePath, options);
  try {
    return fn();
  } finally {
    releaseLock(ctx);
  }
}

export async function withLockAsync<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const ctx = await acquireLockAsync(filePath, options);
  try {
    return await fn();
  } finally {
    releaseLock(ctx);
  }
}

/**
 * 异步版本的文件锁（使用 Promise 链）
 * 
 * 注意：这是一个简化的实现，适用于单进程内的异步并发控制
 * 对于多进程场景，应使用同步版本的 acquireLock
 */
const asyncLockQueues = new Map<string, Promise<void>>();

export async function withAsyncLock<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = filePath + '.async';
  
  // 获取或创建该文件的任务队列
  let queue = asyncLockQueues.get(lockPath);
  
  // 创建新的 Promise 链
  let resolveRelease: () => void;
  const releasePromise = new Promise<void>(resolve => {
    resolveRelease = resolve;
  });
  
  // 将当前任务加入队列
  const previousQueue = queue || Promise.resolve();
  const currentQueue = previousQueue.then(() => releasePromise);
  asyncLockQueues.set(lockPath, currentQueue);
  
  // 等待前面的任务完成
  await previousQueue;
  
  try {
    return await fn();
  } finally {
    resolveRelease!();
    // 清理已完成的队列
    if (asyncLockQueues.get(lockPath) === currentQueue) {
      asyncLockQueues.delete(lockPath);
    }
  }
}

/**
 * 检查锁状态（用于调试）
 */
export function getLockStatus(filePath: string, options: LockOptions = {}): {
  locked: boolean;
  holderPid: number | null;
  holderAlive: boolean;
  lockAge: number | null;
} {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lockPath = filePath + opts.lockSuffix;
  
  try {
    const stat = fs.statSync(lockPath);
    const pid = readLockPid(lockPath);
    
    return {
      locked: true,
      holderPid: pid,
      holderAlive: pid !== null && isProcessAlive(pid),
      lockAge: Date.now() - stat.mtimeMs,
    };
  } catch {
    return {
      locked: false,
      holderPid: null,
      holderAlive: false,
      lockAge: null,
    };
  }
}
