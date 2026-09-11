import { randomBytes } from 'crypto';

/**
 * 创建新的 trace_id
 * 格式: ev_{timestamp}_{random}
 * 使用 crypto.randomBytes 确保不可预测性
 *
 * PRI-737: 自 evolution-logger.ts 迁入（原类随 legacy evolution worker 链退役，
 * 纯 trace id 生成仍是 pain/signal 链活跃依赖）。
 */
export function createTraceId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(3).toString('hex');
  return `ev_${timestamp}_${random}`;
}
