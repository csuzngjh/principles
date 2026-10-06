/**
 * PRI-939 Option A — workspace-scoped telemetry construction for short-lived
 * CLI processes (pain record / pain retry / diagnose / candidate review).
 *
 * 背景：`WorkspaceTelemetryEmitter`（host-runtime，PRI-634 A3）只在共享消费环
 * （长进程 worker）装配；CLI 短进程直接用 `storeEmitter` 单例发射 —— 单例生产
 * 装配零订阅者、零持久化，allowlist 内的 critical 事件（含
 * reuse_gate_triggered / reuse_evaluation_unavailable）发射即丢。
 *
 * 本工厂是**构造复用**，不是新 emitter：与 internalization-consumer-cycle.ts
 * 的 per-wake 装配同款（upstream=storeEmitter 单例，persist 失败降级到注入的
 * 结构化告警口）。CLI 进程单工作区，workspaceDir 天然在作用域，归属正确。
 */
import { WorkspaceTelemetryEmitter } from '@principles/host-runtime';
import { storeEmitter } from '@principles/core/runtime-v2';

export function createWorkspaceTelemetryEmitter(workspaceDir: string): WorkspaceTelemetryEmitter {
  return new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir, (detail) => {
    // Non-fatal by contract (PRI-634): losing a telemetry line must never
    // break the command. Structured detail goes to stderr — `--json` stdout
    // contracts stay untouched (cli-1).
    process.stderr.write(`[PD:telemetry] WARNING: critical event persistence failed: ${detail}\n`);
  });
}
