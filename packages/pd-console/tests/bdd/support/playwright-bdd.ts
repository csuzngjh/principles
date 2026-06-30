import { test, type Page, type APIRequestContext } from '@playwright/test';
import { parseFeature, type ParsedStep } from './gherkin-loader.js';

export interface PlaywrightStepContext {
  state: Record<string, unknown>;
  redactable: Record<string, unknown>;
  attachments: Array<{ name: string; body: string }>;
}

export type PlaywrightStepFn = (
  ctx: PlaywrightStepContext,
  page: Page,
  api: APIRequestContext,
  ...args: unknown[]
) => void | Promise<void>;

export interface PlaywrightStepMatch {
  fn: PlaywrightStepFn;
  args: unknown[];
}

export interface PlaywrightStepRegistry {
  given(pattern: string | RegExp, fn: PlaywrightStepFn): void;
  when(pattern: string | RegExp, fn: PlaywrightStepFn): void;
  then(pattern: string | RegExp, fn: PlaywrightStepFn): void;
  match(step: ParsedStep): PlaywrightStepMatch | null;
}

interface RegisteredStep {
  keyword: 'Given' | 'When' | 'Then';
  pattern: string | RegExp;
  fn: PlaywrightStepFn;
}

export function createPlaywrightStepRegistry(): PlaywrightStepRegistry {
  const steps: RegisteredStep[] = [];

  function register(keyword: RegisteredStep['keyword']) {
    return (pattern: string | RegExp, fn: PlaywrightStepFn) => {
      steps.push({ keyword, pattern, fn });
    };
  }

  function match(step: ParsedStep): PlaywrightStepMatch | null {
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
  };
}

function parseDisabledTag(tags: string[]): { reason: string; owner: string; date: string } | null {
  for (const tag of tags) {
    if (tag.startsWith('@disabled')) {
      // 格式: @disabled(reason="...",owner="...",date="...")
      const reasonMatch = tag.match(/reason="([^"]+)"/);
      const ownerMatch = tag.match(/owner="([^"]+)"/);
      const dateMatch = tag.match(/date="([^"]+)"/);
      return {
        reason: reasonMatch?.[1] ?? '(no reason)',
        owner: ownerMatch?.[1] ?? '(no owner)',
        date: dateMatch?.[1] ?? '(no date)',
      };
    }
  }
  return null;
}

/**
 * 把 .feature 文本注册为 Playwright test。
 *
 * 关键行为:
 * - @disabled 标签的 scenario 走 test.skip,并打印显式 skip 报告 (rc-9)
 * - step 未匹配时 fail loud,带 scenario 名 (rc-3)
 * - 每个场景独立 PlaywrightStepContext (rc-7)
 *
 * 复用现有 e2e-start.mjs 启动逻辑 (playwright.config.ts 的 webServer),0 改造。
 * Playwright config 的 screenshot: 'only-on-failure' 自动捕获失败截图。
 */
export function defineFeature(
  featureText: string,
  registry: PlaywrightStepRegistry
): void {
  const scenarios = parseFeature(featureText);

  test.describe(scenarios[0]?.featureName ?? '(feature)', () => {
    for (const scenario of scenarios) {
      const disabledInfo = parseDisabledTag(scenario.scenarioTags);

      if (disabledInfo) {
        // 显式 skip 报告 (rc-9: no silent fallback)
        test.skip(
          `${scenario.scenarioName} [SKIP: ${disabledInfo.reason}; owner=${disabledInfo.owner}; date=${disabledInfo.date}]`,
          async () => {}
        );
        continue;
      }

      test(scenario.scenarioName, async ({ page, request }) => {
        const ctx: PlaywrightStepContext = {
          state: {},
          redactable: {},
          attachments: [],
        };
        const allSteps = [...(scenario.background ?? []), ...scenario.steps];

        for (const step of allSteps) {
          const match = registry.match(step);
          if (!match) {
            // fail loud (rc-3): step 未匹配时列出 scenario 名帮助诊断
            throw new Error(
              `Step not matched: ${step.keyword} ${step.text}\n` +
              `Scenario: ${scenario.scenarioName}`
            );
          }

          try {
            await match.fn(ctx, page, request, ...match.args);
          } catch (e) {
            // 增强 error 信息:附加 step 文本和场景名
            // Playwright 自动截图 (screenshot: 'only-on-failure' 已在 config 里)
            const enhanced = e instanceof Error ? e : new Error(String(e));
            enhanced.message = `Step failed: ${step.keyword} ${step.text}\nScenario: ${scenario.scenarioName}\n${enhanced.message}`;
            throw enhanced;
          }
        }
      });
    }
  });
}
