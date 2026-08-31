/**
 * PRI-634 A1 wiring regression guard（PRI-624 最终集成迁移版）。
 *
 * R2（core 级 evaluator-gate-authority.test.ts）守卫的是「缺 gateDeps 必须
 * fail-loud」的运行时行为；本套件守卫的是**生产装配本身**——shared
 * consumer cycle 的 evaluator case 必须注入 gateDeps 且事件必须走
 * workspace-scoped emitter。若未来有人删除装配行，此测试立即变红（防止
 * 48371236 事故以「装配回退」形式复发）。
 *
 * PRI-624 Slice C 把 EvaluatorRunner 的生产构造点从 openclaw-plugin 的
 * auto-consumer service 搬进了 host-runtime 的
 * `internalization-consumer-cycle.ts`（OpenClaw shell 与 Codex worker 都
 * 调用它）——因此 guard 迁移到新的 canonical 构造点，并额外锁定：
 * 两个宿主侧都不得重新出现自己的 EvaluatorRunner 构造（第二套 gate
 * authority 是禁止项）。
 *
 * 采用源码特征化断言（本仓库既有先例：UI 逻辑无法挂载时以源码字符串
 * 断言锁定），因为装配函数需要完整 service 环境（runtime config /
 * adapter / orchestrator）才能驱动，性价比不匹配。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CYCLE_SRC = fileURLToPath(new URL('../src/internalization-consumer-cycle.ts', import.meta.url));
const OPENCLAW_SERVICE_SRC = fileURLToPath(new URL('../../openclaw-plugin/src/service/internalization-auto-consumer-service.ts', import.meta.url));
const CODEX_WORKER_SRC = fileURLToPath(new URL('../../codex-adapter/src/worker/workspace-worker.ts', import.meta.url));

function readSrc(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** evaluator case 的精确切片：从 `case 'evaluator':` 到下一个 `case '` */
function evaluatorCase(): string {
  const source = readSrc(CYCLE_SRC);
  const start = source.indexOf("case 'evaluator':");
  const end = source.indexOf("case '", start + "case 'evaluator':".length);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

describe('PRI-634 A1 evaluator gateDeps wiring guard (shared cycle construction site)', () => {
  it('Guard A: shared cycle evaluator case 注入 gateDeps: createProductionGateDeps()', () => {
    expect(evaluatorCase()).toContain('gateDeps: createProductionGateDeps()');
  });

  it('Guard B: gateDeps 位于 OPTIONS 参数（第二个构造参数）且在 ...runnerOptions 之后', () => {
    // EvaluatorRunner 构造: this.gateDeps = options.gateDeps ?? null
    // (evaluator-runner.ts) —— 注入到第一个参数会被静默丢弃, R2 会以
    // capability_missing fail-loud。E2E 曾把 gateDeps 错放到 deps (PRI-634
    // 修复 40d47738 的教训), 本断言锁死正确位置。
    const slice = evaluatorCase();
    const optsStart = slice.indexOf('...runnerOptions');
    expect(optsStart).toBeGreaterThan(-1);
    const afterOpts = slice.slice(optsStart);
    expect(afterOpts).toContain('gateDeps: createProductionGateDeps()');
  });

  it('Guard C: 第一个 Evaluator deps object 中不得出现 gateDeps', () => {
    const slice = evaluatorCase();
    const optsStart = slice.indexOf('...runnerOptions');
    expect(optsStart).toBeGreaterThan(-1);
    const depsBlock = slice.slice(0, optsStart);
    expect(depsBlock).not.toContain('gateDeps:');
  });

  it('Guard D: 守卫定位的是 shared host-runtime cycle（canonical 构造点），不是 OpenClaw lifecycle shell', () => {
    // OpenClaw service 已是 thin shell —— 它不得再包含 EvaluatorRunner 构造。
    const shell = readSrc(OPENCLAW_SERVICE_SRC);
    expect(shell).not.toContain('new EvaluatorRunner');
    // 守卫对象本身必须仍是 shared cycle 源文件。
    expect(CYCLE_SRC).toContain('internalization-consumer-cycle.ts');
    expect(evaluatorCase()).toContain('new EvaluatorRunner');
  });

  it('AC-2: Codex worker 也不得另建 EvaluatorRunner（gate wiring 由 shared cycle 统一提供）', () => {
    const worker = readSrc(CODEX_WORKER_SRC);
    expect(worker).not.toContain('new EvaluatorRunner');
    expect(worker).toContain('runInternalizationConsumerCycle');
  });

  it('shared cycle evaluator case 的事件走 workspace-scoped emitter 而非全局 storeEmitter', () => {
    expect(evaluatorCase()).toContain('eventEmitter: evaluatorEmitter');
    expect(evaluatorCase()).not.toContain('eventEmitter: storeEmitter');
  });

  it('WorkspaceTelemetryEmitter 在 per-wake 装配处构造（workspaceDir 在作用域内）且落盘失败走注入回调', () => {
    const source = readSrc(CYCLE_SRC);
    expect(source).toContain('const evaluatorEmitter = new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir,');
    expect(source).toContain("'WORKSPACE_TELEMETRY_PERSIST_FAILED'");
  });
});
