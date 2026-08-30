/**
 * PRI-629 §34 — Owner Decision 架构回归守卫（core 侧）。
 *
 *   - effectiveDecision 只有一个 resolver (owner-review.ts);orchestrator 的
 *     transition 投影必须经它 (禁止旁路计算)
 *   - 不存在 owner decision authority 的第二张表/第二 store: ownerResolutions
 *     只在 PITaskMetadata (diagnosticJson) 内,不新增 store 模块
 *   - ActivationDispatcher 仍是 activation 唯一 policy boundary:
 *     owner-review/owner-resolution-service 不得 import dispatcher 绕过门
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.resolve(here, '../../..');  // .../src/runtime-v2/internalization/__tests__ → .../src

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

describe('PRI-629 §34: owner decision architecture guards', () => {
  it('resolveEffectiveRunnerDecision is defined exactly once (single resolution point)', () => {
    const files = walk(coreSrc);
    expect(files.length).toBeGreaterThan(100);
    const definers = files.filter((f) => /export function resolveEffectiveRunnerDecision/.test(fs.readFileSync(f, 'utf-8')));
    expect(definers.map((f) => path.relative(coreSrc, f))).toEqual([
      path.join('runtime-v2', 'internalization', 'owner-review.ts'),
    ]);
  });

  it('transition arbitration consumes the resolver (no bypass re-implementation)', () => {
    const src = fs.readFileSync(
      path.join(coreSrc, 'runtime-v2/internalization/internalization-transition-decision.ts'), 'utf-8');
    expect(src).toContain('resolveEffectiveRunnerDecision(piTask)');
  });

  it('no owner-decision store/table module was added (authority stays in PITaskMetadata)', () => {
    const files = walk(path.join(coreSrc, 'runtime-v2/store'));
    const offenders = files.filter((f) => /owner.?decision|owner.?resolution/i.test(path.basename(f)));
    expect(offenders).toEqual([]);
  });

  it('owner decision policy does not import the activation dispatcher (boundary intact)', () => {
    for (const mod of ['owner-review.ts', 'owner-resolution-service.ts']) {
      const src = fs.readFileSync(path.join(coreSrc, 'runtime-v2/internalization', mod), 'utf-8');
      expect(src.includes('activation-dispatcher'), `${mod} must not import dispatcher`).toBe(false);
    }
  });

  it('machine verdict immutability: owner-resolution paths never write runnerDecision', () => {
    const src = fs.readFileSync(
      path.join(coreSrc, 'runtime-v2/internalization/owner-resolution-service.ts'), 'utf-8');
    expect(src.includes('runnerDecision:'), 'service must not set runnerDecision').toBe(false);
  });
});
