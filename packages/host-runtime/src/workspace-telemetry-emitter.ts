import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoreEventEmitter, type TelemetryEvent } from '@principles/core/runtime-v2';

/**
 * PRI-634 A3 — workspace-scoped durable observability for critical runner
 * telemetry (host-neutral; PRI-624 Slice C final integration).
 *
 * 背景：`StoreEventEmitter`（进程内单例）生产装配零订阅者、零持久化 ——
 * `evaluator_adversarial_replay_skipped` 等关键事件发射即丢，事故（如
 * 48371236 链）无法从日志取证。
 *
 * 为什么不是「给全局 storeEmitter 挂落盘订阅者」：singleton 的 telemetry
 * payload 不含 workspaceDir，multi-workspace 进程下全局订阅者无法判断事件
 * 归属，会重演 SystemLogger PRI-504 修过的 cross-workspace log leakage
 * （ERR-092）。正确粒度是 **workspace-scoped**：本 emitter 在 consumer
 * cycle 的 per-wake 装配处构造，只经手本 workspace runner 发出的事件。
 *
 * 持久化策略：**allowlist**，只落盘 4 类 critical events（与 telemetry-event
 * schema 枚举同源），不做全量 telemetry 无差别写盘（日志量 + 隐私审计面
 * 无谓扩大）：
 *   - evaluator_adversarial_replay_skipped
 *   - evaluator_adversarial_replay
 *   - evaluator_rule_assembled
 *   - evaluator_rule_assembly_failed
 *
 * 落点 `<workspaceDir>/.pd/telemetry/critical-events.jsonl`（JSONL，一行一
 * 事件，含完整 TelemetryEvent）。同步 append：事件量小（allowlist 限流），
 * 换取 crash 前落盘的 durable 语义。写失败绝不影响 runner —— 降级为
 * `onPersistFailure` 回调（宿主注入的结构化告警口；OpenClaw 是
 * SystemLogger，Companion worker 是自己的事件口）。
 */
const CRITICAL_EVENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'evaluator_adversarial_replay_skipped',
  'evaluator_adversarial_replay',
  'evaluator_rule_assembled',
  'evaluator_rule_assembly_failed',
]);

export type WorkspaceTelemetryPersistFailureSink = (detailJson: string) => void;

export class WorkspaceTelemetryEmitter extends StoreEventEmitter {
  private readonly sinkFilePath: string;

  private readonly onPersistFailure: WorkspaceTelemetryPersistFailureSink;

  constructor(
    private readonly upstream: StoreEventEmitter,
    workspaceDir: string,
    onPersistFailure: WorkspaceTelemetryPersistFailureSink,
  ) {
    super();
    this.onPersistFailure = onPersistFailure;
    this.sinkFilePath = join(workspaceDir, '.pd', 'telemetry', 'critical-events.jsonl');
  }

  /**
   * Validate + persist (allowlist) + forward upstream. Never throws —
   * persistence errors degrade to the injected failure sink (the upstream
   * emit semantics are preserved unchanged).
   */
  emitTelemetry(event: TelemetryEvent): true {
    if (CRITICAL_EVENT_ALLOWLIST.has(event.eventType)) {
      this.persist(event);
    }
    return this.upstream.emitTelemetry(event);
  }

  private persist(event: TelemetryEvent): void {
    try {
      mkdirSync(dirname(this.sinkFilePath), { recursive: true });
      appendFileSync(this.sinkFilePath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      // Non-fatal by contract: losing a telemetry line must never break the
      // runner. Surface once per occurrence through the injected host sink.
      this.onPersistFailure(JSON.stringify({
        eventType: event.eventType,
        sinkFilePath: this.sinkFilePath,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
}
