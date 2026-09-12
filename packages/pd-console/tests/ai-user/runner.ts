/**
 * PRI-754 — AI User Runner 主循环。
 *
 * 打通 AI → Playwright → PD：观察页面（可访问性快照，有界 rc-8）→ 请求 LLM
 * 决策 → 执行白名单动作 → 记录步骤/截图。每步的观察都是全新采集，不复用上
 * 一步的陈旧状态（rc-5/rc-7 循环状态新鲜度）；任何基础设施失败都以结构化
 * 原因落盘（rc-9 不做静默回退）。
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { AiUserScenario } from './scenario.js';
import type { AiUserAction, AiUserLlmClient } from './llm.js';
import { bounded } from './llm.js';
import { executeAiUserAction } from './actions.js';

const SNAPSHOT_MAX_CHARS = 3000;
const HISTORY_ENTRY_MAX_CHARS = 240;
const HISTORY_WINDOW = 8;

export interface StepRecord {
  index: number;
  thought: string;
  action: AiUserAction;
  execution: { ok: boolean; error?: string };
  observation: { url: string; title: string };
  /** 相对 screenshotsDir 的截图文件名。 */
  screenshot: string;
}

export interface ScenarioRunResult {
  scenario: AiUserScenario;
  result: 'passed' | 'failed' | 'incomplete';
  finishReason: string;
  problems: string[];
  suggestions: string[];
  steps: StepRecord[];
  startedAt: string;
  finishedAt: string;
  model: string;
  baseUrlOrigin: string;
}

interface PageObservation {
  url: string;
  title: string;
  snapshot: string;
}

async function observePage(page: Page): Promise<PageObservation> {
  const url = page.url();
  let title = '';
  let snapshot = '';
  try {
    title = await page.title();
  } catch {
    // 导航竞态下 title 可能暂时不可读，下一步会重新观察
  }
  try {
    const raw = await page.locator('body').ariaSnapshot();
    snapshot = raw.length > SNAPSHOT_MAX_CHARS ? raw.slice(0, SNAPSHOT_MAX_CHARS) + '…[截断]' : raw;
  } catch {
    // 同上：页面切换中快照失败不致命
  }
  return { url, title, snapshot };
}

function historyLine(step: StepRecord): string {
  const target = step.action.target ?? step.action.value ?? '';
  const outcome = step.execution.ok ? 'ok' : `失败:${bounded(step.execution.error ?? '', 80)}`;
  return bounded(
    `#${step.index} 想法:${step.thought} | 动作:${step.action.type} ${target} → ${outcome} | 页面:${step.observation.url}`,
    HISTORY_ENTRY_MAX_CHARS,
  );
}

export function buildStepPrompt(
  scenario: AiUserScenario,
  observation: PageObservation,
  history: string[],
): string {
  const successList = scenario.success.map(item => `- ${item}`).join('\n');
  const observeList = scenario.observe.map(item => `- ${item}`).join('\n');
  const historyText = history.length > 0 ? history.join('\n') : '（这是第一步）';
  return `## 你的身份与目标
用户身份：${scenario.persona}
目标：${scenario.goal}

成功标准（全部满足才算完成）：
${successList}

请特别留意并记录的观察点：
${observeList || '- （无特别观察点，正常使用即可）'}

## 已执行的历史（旧 → 新）
${historyText}

## 当前页面状态
URL: ${observation.url}
标题: ${observation.title}

页面可访问性快照（YAML）：
${observation.snapshot || '（快照为空——页面可能仍在加载，可考虑 wait 后再决策）'}

基于以上信息，输出下一个动作的 JSON 决策。`;
}

async function takeScreenshot(page: Page, screenshotsDir: string, fileName: string): Promise<void> {
  try {
    await page.screenshot({ path: join(screenshotsDir, fileName), fullPage: true });
  } catch {
    // 截图失败（如导航中）不阻塞流程；后续步骤会继续尝试
  }
}

export async function runScenario(opts: {
  scenario: AiUserScenario;
  page: Page;
  llm: AiUserLlmClient;
  screenshotsDir: string;
  baseUrl: string;
  maxSteps?: number;
}): Promise<ScenarioRunResult> {
  const maxSteps = opts.maxSteps ?? opts.scenario.maxSteps;
  const startedAt = new Date().toISOString();
  const steps: StepRecord[] = [];
  const problems: string[] = [];
  const suggestions: string[] = [];
  const pushUnique = (list: string[], item: string): void => {
    if (!list.includes(item)) list.push(item);
  };

  let finishReason = 'max-steps-reached';

  await opts.page.goto(new URL(opts.scenario.startUrl, opts.baseUrl).toString(), {
    waitUntil: 'load',
    timeout: 15_000,
  });
  // 初始状态截图：第一步动作之前的页面（证据链起点）
  await takeScreenshot(opts.page, opts.screenshotsDir, 'step-00.png');

  for (let i = 0; i < maxSteps; i++) {
    const observation = await observePage(opts.page);
    const history = steps.slice(-HISTORY_WINDOW).map(historyLine);
    const prompt = buildStepPrompt(opts.scenario, observation, history);

    let decision;
    try {
      decision = await opts.llm.decide(prompt);
    } catch (err) {
      finishReason = 'llm-error';
      const msg = err instanceof Error ? err.message : String(err);
      pushUnique(problems, `AI User 决策失败：${bounded(msg, 300)}`);
      break;
    }

    const execution = await executeAiUserAction(opts.page, decision.action, { baseUrl: opts.baseUrl });
    const screenshot = `step-${String(i + 1).padStart(2, '0')}.png`;
    await takeScreenshot(opts.page, opts.screenshotsDir, screenshot);

    steps.push({
      index: i + 1,
      thought: decision.thought,
      action: decision.action,
      execution,
      observation: { url: observation.url, title: observation.title },
      screenshot,
    });

    for (const p of decision.problems) pushUnique(problems, p);
    for (const s of decision.suggestions) pushUnique(suggestions, s);

    if (decision.action.type === 'finish') {
      const achieved = decision.action.success === true;
      finishReason = achieved ? 'user-finished-success' : 'user-finished-failed';
      if (typeof decision.action.note === 'string' && decision.action.note.length > 0) {
        pushUnique(achieved ? suggestions : problems, decision.action.note);
      }
      break;
    }
  }

  const result: ScenarioRunResult['result'] =
    finishReason === 'user-finished-success'
      ? 'passed'
      : finishReason === 'user-finished-failed'
        ? 'failed'
        : 'incomplete';

  return {
    scenario: opts.scenario,
    result,
    finishReason,
    problems,
    suggestions,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    model: opts.llm.config.model,
    baseUrlOrigin: new URL(opts.llm.config.baseUrl).origin,
  };
}
