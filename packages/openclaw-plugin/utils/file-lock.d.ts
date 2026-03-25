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
export declare class LockAcquisitionError extends Error {
    readonly filePath: string;
    readonly lockPath: string;
    constructor(message: string, filePath: string, lockPath: string);
}
/**
 * 获取文件锁
 *
 * @param filePath 要锁定的文件路径
 * @param options 锁选项
 * @returns 锁上下文（用于后续释放）
 * @throws Error 如果无法获取锁
 */
export declare function acquireLock(filePath: string, options?: LockOptions): LockContext;
export declare function acquireLockAsync(filePath: string, options?: LockOptions): Promise<LockContext>;
/**
 * 释放文件锁
 *
 * @param ctx 锁上下文（由 acquireLock 返回）
 */
export declare function releaseLock(ctx: LockContext): void;
/**
 * 使用锁执行操作（自动获取和释放）
 *
 * @param filePath 要锁定的文件路径
 * @param fn 要执行的操作
 * @param options 锁选项
 * @returns 操作的返回值
 */
export declare function withLock<T>(filePath: string, fn: () => T, options?: LockOptions): T;
export declare function withLockAsync<T>(filePath: string, fn: () => Promise<T>, options?: LockOptions): Promise<T>;
export declare function withAsyncLock<T>(filePath: string, fn: () => Promise<T>): Promise<T>;
/**
 * 检查锁状态（用于调试）
 */
export declare function getLockStatus(filePath: string, options?: LockOptions): {
    locked: boolean;
    holderPid: number | null;
    holderAlive: boolean;
    lockAge: number | null;
};
