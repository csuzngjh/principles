/**
 * PRI-939 Option A wiring regression guard.
 *
 * Phase 2 的验收面：四个短生命周期 CLI（pain record / pain retry / diagnose /
 * candidate review）必须通过 workspace-scoped 的 WorkspaceTelemetryEmitter
 * 发射遥测 —— 裸 storeEmitter 单例生产装配零订阅者、零持久化，allowlist 内的
 * critical 事件（reuse_gate_triggered / reuse_evaluation_unavailable）发射
 * 即丢。若有人把装配退回单例，此测试立即变红（防「发射即丢」复发）。
 *
 * 采用源码特征化断言（本仓库既有先例：evaluator-gate-wiring-guard.test.ts），
 * 因为驱动真实命令需要完整 workspace/service 环境，性价比不匹配。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI_COMMANDS = ['candidate.ts', 'pain-record.ts', 'pain-retry.ts', 'diagnose.ts'] as const;

function readSrc(relative: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('PRI-939 Option A — CLI telemetry wiring guard', () => {
  it.each(CLI_COMMANDS)('%s constructs the workspace-scoped telemetry emitter', (file) => {
    const source = readSrc(`../../src/commands/${file}`);
    expect(source).toContain('createWorkspaceTelemetryEmitter(');
  });

  it('no CLI command emits reuse/critical telemetry into the bare singleton anymore', () => {
    for (const file of CLI_COMMANDS) {
      const source = readSrc(`../../src/commands/${file}`);
      expect(source, `${file} must not emit through the bare storeEmitter singleton`)
        .not.toMatch(/storeEmitter\.emitTelemetry\(/);
    }
  });

  it('the shared factory wraps the existing singleton with WorkspaceTelemetryEmitter (construction reuse, not a new emitter)', () => {
    const source = readSrc('../../src/services/workspace-telemetry.ts');
    expect(source).toContain("new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir");
  });

  it('the bridge telemetry factory forwards into an injected sink when provided (default unchanged)', () => {
    const factory = readSrc('../../../../packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts');
    expect(factory).toContain('(sink ?? storeEmitter).emitTelemetry(mapped)');
  });
});
