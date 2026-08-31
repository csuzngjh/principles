/**
 * PRI-634 A3 — WorkspaceTelemetryEmitter 契约测试（host-neutral canonical
 * seam，PRI-624 最终集成时从 openclaw-plugin 的 workspace-telemetry-sink
 * 迁移；OpenClaw 与 Codex worker 共用本实现）。
 *
 * 锁定的语义：
 *   1. allowlist（4 类 critical events）→ 落盘到 <workspaceDir>/.pd/telemetry/
 *      critical-events.jsonl（JSONL 一行一事件，含完整 TelemetryEvent）；
 *   2. 非 allowlist → 不落盘但照常转发 upstream（全局 storeEmitter 语义
 *      不被破坏）；
 *   3. upstream 转发永远发生（即使落盘失败也不影响 runner —— emitTelemetry
 *      的 never-throw 契约）；
 *   4. 落盘失败降级为注入的 onPersistFailure 回调，不抛异常（host-neutral:
 *      OpenClaw 侧由 SystemLogger 口接收，worker 侧由事件口接收）；
 *   5. multi-workspace 隔离：A 的 emitter 只写 A 的 sink，绝不写 B。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StoreEventEmitter, type TelemetryEvent } from '@principles/core/runtime-v2';
import { WorkspaceTelemetryEmitter } from '../src/workspace-telemetry-emitter.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-telemetry-emitter-'));
});

afterEach(() => {
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* temp */ }
});

function makeEvent(eventType: string): TelemetryEvent {
  return {
    eventType,
    traceId: 'trace-sink',
    timestamp: '2026-08-31T00:00:00.000Z',
    sessionId: 'owner-sink',
    agentId: 'agent-sink',
    payload: { runId: 'run-sink', reason: 'test' },
  };
}

function sinkFilePath(dir: string = workspaceDir): string {
  return path.join(dir, '.pd', 'telemetry', 'critical-events.jsonl');
}

describe('WorkspaceTelemetryEmitter (PRI-634 A3, canonical host-runtime seam)', () => {
  it('allowlist 事件：落盘 JSONL + 转发 upstream', () => {
    const upstream = new StoreEventEmitter();
    const forwarded: TelemetryEvent[] = [];
    upstream.onTelemetry((e) => forwarded.push(e));
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => undefined);

    emitter.emitTelemetry(makeEvent('evaluator_adversarial_replay_skipped'));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.eventType).toBe('evaluator_adversarial_replay_skipped');

    const lines = fs.readFileSync(sinkFilePath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const persisted = JSON.parse(lines[0] ?? '') as TelemetryEvent;
    expect(persisted.eventType).toBe('evaluator_adversarial_replay_skipped');
    expect(persisted.traceId).toBe('trace-sink');
    expect(persisted.payload).toEqual({ runId: 'run-sink', reason: 'test' });
  });

  it('非 allowlist 事件：不落盘，仅转发 upstream', () => {
    const upstream = new StoreEventEmitter();
    const forwarded: TelemetryEvent[] = [];
    upstream.onTelemetry((e) => forwarded.push(e));
    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, () => undefined);

    emitter.emitTelemetry(makeEvent('evaluator_llm_call_started'));

    expect(forwarded).toHaveLength(1);
    expect(fs.existsSync(sinkFilePath())).toBe(false);
  });

  it('4 类 allowlist 全部落盘，事件之间以换行分隔（JSONL）', () => {
    const emitter = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => undefined);
    const allowlisted: readonly string[] = [
      'evaluator_adversarial_replay_skipped',
      'evaluator_adversarial_replay',
      'evaluator_rule_assembled',
      'evaluator_rule_assembly_failed',
    ];

    for (const t of allowlisted) emitter.emitTelemetry(makeEvent(t));

    const lines = fs.readFileSync(sinkFilePath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    const types = lines.map((l) => (JSON.parse(l) as TelemetryEvent).eventType);
    expect(types).toEqual([...allowlisted]);
  });

  it('落盘失败不抛异常、不阻断 upstream 转发，且降级事件到达注入的 failure sink（never-throw 契约）', () => {
    // 把 .pd/telemetry 位置占为普通文件 → mkdirSync 失败 → 走注入的
    // onPersistFailure 降级路径，emitTelemetry 仍返回 true 且 upstream
    // 仍收到事件。
    const upstream = new StoreEventEmitter();
    const forwarded: TelemetryEvent[] = [];
    upstream.onTelemetry((e) => forwarded.push(e));
    const failures: string[] = [];
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'telemetry'), 'blocking file');

    const emitter = new WorkspaceTelemetryEmitter(upstream, workspaceDir, (detail) => failures.push(detail));
    const result = emitter.emitTelemetry(makeEvent('evaluator_adversarial_replay_skipped'));

    expect(result).toBe(true);
    expect(forwarded).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('evaluator_adversarial_replay_skipped');
    expect(failures[0]).toContain('sinkFilePath');
  });

  it('同一 workspace 多次 emit 追加而非覆盖（durable append）', () => {
    const emitter = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => undefined);
    emitter.emitTelemetry(makeEvent('evaluator_adversarial_replay'));
    emitter.emitTelemetry(makeEvent('evaluator_adversarial_replay_skipped'));

    const lines = fs.readFileSync(sinkFilePath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('multi-workspace 隔离：workspace A 的 critical event 只写 A 的 sink，绝不写 B（AC-3/AC-4 语义）', () => {
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-telemetry-emitter-b-'));
    try {
      const emitterA = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceDir, () => undefined);
      const emitterB = new WorkspaceTelemetryEmitter(new StoreEventEmitter(), workspaceB, () => undefined);

      emitterA.emitTelemetry(makeEvent('evaluator_rule_assembled'));
      emitterB.emitTelemetry(makeEvent('evaluator_llm_call_started')); // 非 allowlist

      expect(fs.existsSync(sinkFilePath(workspaceDir))).toBe(true);
      expect(fs.existsSync(sinkFilePath(workspaceB))).toBe(false);

      const lines = fs.readFileSync(sinkFilePath(workspaceDir), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
    } finally {
      try { fs.rmSync(workspaceB, { recursive: true, force: true }); } catch { /* temp */ }
    }
  });
});
