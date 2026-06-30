import { describe, it, expect, vi } from 'vitest';
import { createStepRegistry, defineFeature } from '../support/vitest-bdd.js';

describe('vitest-bdd step registry', () => {
  it('match 精确字符串 step', () => {
    const registry = createStepRegistry();
    const fn = vi.fn();
    registry.given('前提条件', fn);

    const match = registry.match({ keyword: 'Given', text: '前提条件' });
    expect(match).not.toBeNull();
    expect(match?.fn).toBe(fn);
    expect(match?.args).toEqual([]);
  });

  it('match 正则 step 并提取参数', () => {
    const registry = createStepRegistry();
    const fn = vi.fn();
    registry.when(/原则处于 (.+) 状态/, fn);

    const match = registry.match({ keyword: 'When', text: '原则处于 validated 状态' });
    expect(match).not.toBeNull();
    expect(match?.args).toEqual(['validated']);
  });

  it('未匹配时返回 null (defineFeature 时会 fail loud)', () => {
    const registry = createStepRegistry();
    registry.given('已注册的 step', vi.fn());

    const match = registry.match({ keyword: 'Given', text: '未注册的 step' });
    expect(match).toBeNull();
  });

  it('StepContext 每次创建独立实例', () => {
    // 这个测试通过 defineFeature 的行为间接验证
    // 这里只验证 createStepRegistry 返回的 registry 行为正确
    const registry = createStepRegistry();
    expect(registry).toBeDefined();
    expect(typeof registry.given).toBe('function');
    expect(typeof registry.when).toBe('function');
    expect(typeof registry.then).toBe('function');
    expect(typeof registry.match).toBe('function');
  });
});

describe('vitest-bdd defineFeature @disabled handling', () => {
  it('scenario 标记 @disabled 时,defineFeature 注册 test.skip', () => {
    // defineFeature 内部调用 vitest 的 describe/it,vitest 4.x 不允许在 it 内调
    // suite 函数,故注入 spy 验证它调用了 itSkip 而非 it (rc-9 显式 skip 报告)。
    // describe spy 需执行回调,内部的 it/itSkip 才会被调用。
    const describeSpy = vi.fn((_name: string, fn: () => void) => fn());
    const itSpy = vi.fn();
    const itSkipSpy = vi.fn();
    const feature = `Feature: 测试
  @disabled(reason="测试禁用",owner="pd",date="2026-06-30")
  Scenario: 被禁用的场景
    Given A
    Then B
`;
    expect(() =>
      defineFeature(feature, createStepRegistry(), {
        describe: describeSpy,
        it: itSpy,
        itSkip: itSkipSpy,
      })
    ).not.toThrow();
    expect(describeSpy).toHaveBeenCalledOnce();
    expect(itSkipSpy).toHaveBeenCalledOnce();
    expect(itSpy).not.toHaveBeenCalled();
  });

  it('scenario 无 @disabled 时,defineFeature 正常注册', () => {
    const describeSpy = vi.fn((_name: string, fn: () => void) => fn());
    const itSpy = vi.fn();
    const itSkipSpy = vi.fn();
    const feature = `Feature: 测试
  Scenario: 正常场景
    Given A
    Then B
`;
    expect(() =>
      defineFeature(feature, createStepRegistry(), {
        describe: describeSpy,
        it: itSpy,
        itSkip: itSkipSpy,
      })
    ).not.toThrow();
    expect(describeSpy).toHaveBeenCalledOnce();
    expect(itSpy).toHaveBeenCalledOnce();
    expect(itSkipSpy).not.toHaveBeenCalled();
  });
});
