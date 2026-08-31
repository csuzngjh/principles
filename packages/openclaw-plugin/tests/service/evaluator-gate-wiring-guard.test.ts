/**
 * PRI-634 A1 wiring regression guard。
 *
 * R2（core 级 evaluator-gate-authority.test.ts）守卫的是「缺 gateDeps 必须
 * fail-loud」的运行时行为；本套件守卫的是**生产装配本身**——auto-consumer
 * 的 evaluator case 必须注入 gateDeps 且事件必须走 workspace-scoped emitter。
 * 若未来有人删除装配行，此测试立即变红（防止 48371236 事故以「装配回退」
 * 形式复发）。
 *
 * 采用源码特征化断言（本仓库既有先例：UI 逻辑无法挂载时以源码字符串
 * 断言锁定），因为 consumeWake 装配函数需要完整 service 环境（runtime
 * config / adapter / orchestrator）才能驱动，性价比不匹配。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_SRC = fileURLToPath(new URL('../../src/service/internalization-auto-consumer-service.ts', import.meta.url));

function src(): string {
  return fs.readFileSync(SERVICE_SRC, 'utf8');
}

/** evaluator case 的精确切片：从 `case 'evaluator':` 到下一个 `case '` */
function evaluatorCase(): string {
  const source = src();
  const start = source.indexOf("case 'evaluator':");
  const end = source.indexOf("case '", start + "case 'evaluator':".length);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

describe('PRI-634 A1 evaluator gateDeps wiring guard', () => {
  it('auto-consumer evaluator case 注入 gateDeps: createProductionGateDeps()', () => {
    expect(evaluatorCase()).toContain('gateDeps: createProductionGateDeps()');
  });

  it('gateDeps 位于 OPTIONS 参数（第二个构造参数）而非 deps（第一个）', () => {
    // EvaluatorRunner 构造: this.gateDeps = options.gateDeps ?? null
    // (evaluator-runner.ts) —— 注入到第一个参数会被静默丢弃, R2 会以
    // capability_missing fail-loud。E2E 曾把 gateDeps 错放到 deps (PRI-634
    // 修复 40d47738 的教训), 本断言锁死正确位置。
    const slice = evaluatorCase();
    const optsStart = slice.indexOf('...runnerOptions');
    expect(optsStart).toBeGreaterThan(-1);
    const afterOpts = slice.slice(optsStart);
    expect(afterOpts).toContain('gateDeps: createProductionGateDeps()');
    // 第一个参数对象里不得出现 gateDeps（防止回退到错位注入）
    const depsBlock = slice.slice(0, optsStart);
    expect(depsBlock).not.toContain('gateDeps:');
  });

  it('auto-consumer evaluator case 的事件走 workspace-scoped emitter 而非全局 storeEmitter', () => {
    expect(evaluatorCase()).toContain('eventEmitter: evaluatorEmitter');
    expect(evaluatorCase()).not.toContain('eventEmitter: storeEmitter');
  });

  it('WorkspaceTelemetryEmitter 在 per-wake 装配处构造（workspaceDir 在作用域内）', () => {
    expect(src()).toContain('const evaluatorEmitter = new WorkspaceTelemetryEmitter(storeEmitter, workspaceDir);');
  });
});
