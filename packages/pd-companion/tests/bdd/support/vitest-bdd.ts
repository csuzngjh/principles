import { describe, it } from 'vitest';
import { parseFeature, type ParsedStep } from './gherkin-loader.js';

export interface StepContext {
  state: Record<string, unknown>;
  redactable: Record<string, unknown>;
  attachments: Array<{ name: string; body: string }>;
}

export type StepFn = (ctx: StepContext, ...args: unknown[]) => void | Promise<void>;

export interface StepMatch {
  fn: StepFn;
  args: unknown[];
}

export interface StepRegistry {
  given(pattern: string | RegExp, fn: StepFn): void;
  when(pattern: string | RegExp, fn: StepFn): void;
  then(pattern: string | RegExp, fn: StepFn): void;
  match(step: ParsedStep): StepMatch | null;
  /** 返回已注册步骤的描述列表，用于 fail-loud 诊断 (rc-3)。 */
  list(): ReadonlyArray<{ keyword: 'Given' | 'When' | 'Then'; pattern: string }>;
}

interface RegisteredStep {
  keyword: 'Given' | 'When' | 'Then';
  pattern: string | RegExp;
  fn: StepFn;
}

/**
 * defineFeature 使用的测试注册钩子。可选注入,便于单元测试验证
 * @disabled 与正常注册路径调用了正确的钩子 (vitest 4.x 不允许在 it 内调 describe)。
 */
export interface DefineFeatureHooks {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  itSkip: (name: string, fn: () => void) => void;
}

export function createStepRegistry(): StepRegistry {
  const steps: RegisteredStep[] = [];

  function register(keyword: RegisteredStep['keyword']) {
    return (pattern: string | RegExp, fn: StepFn) => {
      steps.push({ keyword, pattern, fn });
    };
  }

  function match(step: ParsedStep): StepMatch | null {
    for (const registered of steps) {
      // keyword 匹配:And/But 匹配任何 registered keyword (gherkin 语义)
      const keywordMatch =
        step.keyword === registered.keyword ||
        step.keyword === 'And' ||
        step.keyword === 'But';
      if (!keywordMatch) continue;

      if (typeof registered.pattern === 'string') {
        if (registered.pattern === step.text) {
          return { fn: registered.fn, args: [] };
        }
      } else {
        const m = registered.pattern.exec(step.text);
        if (m) {
          return { fn: registered.fn, args: m.slice(1) };
        }
      }
    }
    return null;
  }

  return {
    given: register('Given'),
    when: register('When'),
    then: register('Then'),
    match,
    list: () => steps.map((s) => ({ keyword: s.keyword, pattern: String(s.pattern) })),
  };
}

function parseDisabledTag(tags: string[]): { reason: string; owner: string; date: string } | null {
  for (const tag of tags) {
    if (tag.startsWith('@disabled')) {
      // 格式: @disabled(reason="...",owner="...",date="...")
      // rc-3/rc-9: 三字段必填，缺失即 fail loud，不允许静默 skip。
      const reasonMatch = tag.match(/reason="([^"]+)"/);
      const ownerMatch = tag.match(/owner="([^"]+)"/);
      const dateMatch = tag.match(/date="([^"]+)"/);
      if (!reasonMatch || !ownerMatch || !dateMatch) {
        throw new Error(
          `Malformed @disabled tag: reason, owner, date are all required. ` +
          `Expected: @disabled(reason="...",owner="...",date="..."). Got: ${tag}`
        );
      }
      return {
        reason: reasonMatch[1],
        owner: ownerMatch[1],
        date: dateMatch[1],
      };
    }
  }
  return null;
}

function createStepContext(): StepContext {
  return {
    state: {},
    redactable: {},
    attachments: [],
  };
}

/**
 * 把 .feature 文本注册为 vitest describe/it。
 *
 * 关键行为:
 * - @disabled 标签的 scenario 走 it.skip,并打印显式 skip 报告 (rc-9)
 * - step 未匹配时 fail loud (rc-3)
 * - 每个场景独立 StepContext (rc-7)
 *
 * hooks 可选注入,默认使用 vitest 的 describe/it/it.skip。测试时传 spy
 * 可避免在 it 内调 describe 触发 vitest "suite inside test" 错误。
 */
export function defineFeature(
  featureText: string,
  registry: StepRegistry,
  hooks?: Partial<DefineFeatureHooks>
): void {
  const h: DefineFeatureHooks = {
    describe,
    it,
    itSkip: (name, fn) => it.skip(name, fn),
    ...hooks,
  };
  const scenarios = parseFeature(featureText);

  h.describe(scenarios[0]?.featureName ?? '(feature)', () => {
    for (const scenario of scenarios) {
      const disabledInfo = parseDisabledTag(scenario.scenarioTags);

      if (disabledInfo) {
        // 显式 skip 报告 (rc-9: no silent fallback)
        h.itSkip(`${scenario.scenarioName} [SKIP: ${disabledInfo.reason}; owner=${disabledInfo.owner}; date=${disabledInfo.date}]`, () => {});
        continue;
      }

      h.it(scenario.scenarioName, async () => {
        const ctx = createStepContext();
        const allSteps = [...(scenario.background ?? []), ...scenario.steps];

        for (const step of allSteps) {
          const match = registry.match(step);
          if (!match) {
            // fail loud (rc-3): 列出已注册 steps 帮助诊断
            const registeredList = registry.list().length > 0
              ? registry.list().map((s) => `  ${s.keyword} ${s.pattern}`).join('\n')
              : '  (no steps registered)';
            throw new Error(
              `Step not matched: ${step.keyword} ${step.text}\n` +
              `Scenario: ${scenario.scenarioName}\n` +
              `Registered steps:\n${registeredList}`
            );
          }

          try {
            await match.fn(ctx, ...match.args);
          } catch (e) {
            // 增强 error 信息:附加 step 文本和场景名
            const enhanced = e instanceof Error ? e : new Error(String(e));
            enhanced.message = `Step failed: ${step.keyword} ${step.text}\nScenario: ${scenario.scenarioName}\n${enhanced.message}`;
            throw enhanced;
          }
        }
      });
    }
  });
}
