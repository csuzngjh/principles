/**
 * PRI-788 G4: 纠正信号检测健康度产物。
 *
 * 背景：检测器停摆 5 天 409 次失败只进 7 天滚动的 SYSTEM log（ERR-101 家族），
 * Owner 无从发现。本模块把检测链路的关键计数/时间戳原子写入
 * `<workspace>/.state/signal-health.json`，供 `pd config doctor` 呈现。
 *
 * 契约：
 *  - 当日计数（stage1Strong/stage2Confirmed/stage2Queued/stage2Dropped）在跨日
 *    首次写入时归零；时间戳字段为绝对 ISO 值。
 *  - 写失败绝不抛出（健康度是旁路观测，不阻塞检测管线）——记 SYSTEM log（rc-9）。
 *  - 文件缺失/损坏按默认值重建，读取方（doctor）自行 unknown 呈现。
 */
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';
import { SystemLogger } from './system-logger.js';

const SIGNAL_HEALTH_FILE = 'signal-health.json';

export interface SignalHealthState {
  /** 当日计数：跨日首写归零 */
  stage1Strong: number;
  stage2Confirmed: number;
  stage2Queued: number;
  stage2Dropped: number;
  /** 最近一次刷新的队列深度（非计数） */
  pendingCount: number;
  lastStage2SuccessAt: string | null;
  observerLastSuccessAt: string | null;
  /** observer 周期连续失败次数（成功即归零） */
  observerConsecutiveFailures: number;
  /** 归零基准日（YYYY-MM-DD） */
  day: string;
  updatedAt: string;
}

function defaultState(now: Date): SignalHealthState {
  return {
    stage1Strong: 0,
    stage2Confirmed: 0,
    stage2Queued: 0,
    stage2Dropped: 0,
    pendingCount: 0,
    lastStage2SuccessAt: null,
    observerLastSuccessAt: null,
    observerConsecutiveFailures: 0,
    day: now.toISOString().slice(0, 10),
    updatedAt: now.toISOString(),
  };
}

function healthFilePath(stateDir: string): string {
  return path.join(stateDir, SIGNAL_HEALTH_FILE);
}

/**
 * 结构校验：只接受带全部必需数值/字符串字段的对象（ERR-001/ERR-013）。
 * 用 Object.hasOwn + typeof 做运行时收窄，避免 `in` 命中原型链、
 * 也避免 `as` 把未校验数据直接断言成领域类型。
 */
function isSignalHealthState(value: unknown): value is SignalHealthState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const numericFields = [
    'stage1Strong',
    'stage2Confirmed',
    'stage2Queued',
    'stage2Dropped',
    'pendingCount',
    'observerConsecutiveFailures',
  ] as const;
  for (const field of numericFields) {
    if (!Object.hasOwn(obj, field) || typeof obj[field] !== 'number') {
      return false;
    }
  }
  return (
    typeof obj['day'] === 'string' &&
    typeof obj['updatedAt'] === 'string'
  );
}

function loadState(stateDir: string, now: Date): SignalHealthState {
  try {
    const raw = fs.readFileSync(healthFilePath(stateDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isSignalHealthState(parsed)) {
      const today = now.toISOString().slice(0, 10);
      if (parsed.day !== today) {
        // 跨日：计数归零，时间戳与失败计数保留
        return {
          ...parsed,
          stage1Strong: 0,
          stage2Confirmed: 0,
          stage2Queued: 0,
          stage2Dropped: 0,
          day: today,
        };
      }
      return parsed;
    }
  } catch {
    // 缺失/损坏 → 重建默认值（doctor 侧以 updatedAt/字段存在性呈现 unknown）
  }
  return defaultState(now);
}

/**
 * 读健康状态（doctor 用）。文件缺失/损坏返回 null，由读取方呈现 unknown。
 */
export function readSignalHealth(stateDir: string): SignalHealthState | null {
  try {
    const raw = fs.readFileSync(healthFilePath(stateDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isSignalHealthState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 原子更新健康状态。mutator 收到当前状态（已做跨日归零），就地修改后写回。
 * 任何失败都不抛出——旁路观测不阻塞检测管线。
 */
export function updateSignalHealth(stateDir: string, mutate: (state: SignalHealthState) => void): void {
  try {
    const now = new Date();
    const state = loadState(stateDir, now);
    mutate(state);
    state.updatedAt = now.toISOString();
    state.day = now.toISOString().slice(0, 10);
    fs.mkdirSync(stateDir, { recursive: true });
    atomicWriteFileSync(healthFilePath(stateDir), JSON.stringify(state, null, 2));
  } catch (err) {
    SystemLogger.log(undefined, 'SIGNAL_HEALTH_WRITE_FAIL', String(err));
  }
}
