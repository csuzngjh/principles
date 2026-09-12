/**
 * PRI-754 — 体验报告生成。
 *
 * report.json（机器可读）与 report.md（人可读）从同一个结构化对象渲染，
 * 不产生第二个事实来源（P4）。报告固定六节：Scenario / Result / Steps /
 * Evidence / Problems / Suggestions。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiUserScenario } from './scenario.js';
import type { ScenarioRunResult, StepRecord } from './runner.js';

export interface AiUserReport {
  scenario: Pick<AiUserScenario, 'id' | 'persona' | 'goal' | 'success' | 'observe'>;
  result: {
    status: ScenarioRunResult['result'];
    finishReason: string;
    stepsExecuted: number;
  };
  steps: StepRecord[];
  evidence: {
    runDir: string;
    /** 实际捕获成功的截图文件名（截图失败的步骤不冒充证据）。 */
    screenshots: string[];
    screenshotFailures: number;
  };
  problems: string[];
  suggestions: string[];
  run: {
    model: string;
    baseUrlOrigin: string;
    startedAt: string;
    finishedAt: string;
    /** 实际生效的步数预算（含 CLI 覆盖）。 */
    maxSteps: number;
  };
}

export function buildReport(run: ScenarioRunResult, runDir: string): AiUserReport {
  const captured = [
    run.initialScreenshot,
    ...run.steps.map(step => step.screenshot),
  ].filter((name): name is string => name !== null);
  const expected = run.steps.length + 1;
  return {
    scenario: {
      id: run.scenario.id,
      persona: run.scenario.persona,
      goal: run.scenario.goal,
      success: run.scenario.success,
      observe: run.scenario.observe,
    },
    result: {
      status: run.result,
      finishReason: run.finishReason,
      stepsExecuted: run.steps.length,
    },
    steps: run.steps,
    evidence: {
      runDir,
      screenshots: captured,
      screenshotFailures: expected - captured.length,
    },
    problems: run.problems,
    suggestions: run.suggestions,
    run: {
      model: run.model,
      baseUrlOrigin: run.baseUrlOrigin,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      maxSteps: run.effectiveMaxSteps,
    },
  };
}

const STATUS_LABELS: Record<ScenarioRunResult['result'], string> = {
  passed: '通过 — AI User 达成目标',
  failed: '失败 — AI User 确定无法完成',
  incomplete: '未完成 — 步数耗尽或运行中断',
};

/** markdown 表格单元格转义：先转反斜杠再转竖线（CodeQL incomplete-escaping）。 */
function mdEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function actionCell(step: StepRecord): string {
  const parts: string[] = [step.action.type];
  if (step.action.target) parts.push(step.action.target);
  if (step.action.value !== undefined) parts.push(`「${step.action.value}」`);
  return mdEscape(parts.join(' '));
}

export function renderReportMarkdown(report: AiUserReport): string {
  const lines: string[] = [];
  lines.push(`# AI User QA 体验报告 — ${report.scenario.id}`);
  lines.push('');
  lines.push('## Scenario');
  lines.push(`- 用户身份：${report.scenario.persona}`);
  lines.push(`- 目标：${report.scenario.goal}`);
  lines.push('- 成功标准：');
  for (const item of report.scenario.success) lines.push(`  - ${mdEscape(item)}`);
  if (report.scenario.observe.length > 0) {
    lines.push('- 观察点：');
    for (const item of report.scenario.observe) lines.push(`  - ${mdEscape(item)}`);
  }
  lines.push('');
  lines.push('## Result');
  lines.push(`- 结果：${STATUS_LABELS[report.result.status]}（${report.result.status}）`);
  lines.push(`- 结束原因：${report.result.finishReason}`);
  lines.push(`- 执行步数：${report.result.stepsExecuted}`);
  lines.push(`- 模型：${report.run.model}（端点 ${report.run.baseUrlOrigin}）`);
  lines.push(`- 步数预算：${report.run.maxSteps}`);
  lines.push(`- 时间：${report.run.startedAt} → ${report.run.finishedAt}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('| # | 想法 | 动作 | 结果 | 截图 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const step of report.steps) {
    const outcome = step.execution.ok ? 'ok' : `失败：${step.execution.error ?? ''}`;
    lines.push(
      `| ${step.index} | ${mdEscape(step.thought)} | ${actionCell(step)} | ${mdEscape(outcome)} | ${step.screenshot ?? '（截图失败）'} |`,
    );
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push(`- 运行目录：\`${report.evidence.runDir}\``);
  lines.push(`- 截图（${report.evidence.screenshots.length} 张捕获成功${report.evidence.screenshotFailures > 0 ? `，${report.evidence.screenshotFailures} 张失败` : ''}）：${report.evidence.screenshots.join(', ') || '（无）'}`);
  lines.push('');
  lines.push('## Problems');
  if (report.problems.length === 0) {
    lines.push('- （无记录）');
  } else {
    for (const item of report.problems) lines.push(`- ${mdEscape(item)}`);
  }
  lines.push('');
  lines.push('## Suggestions');
  if (report.suggestions.length === 0) {
    lines.push('- （无记录）');
  } else {
    for (const item of report.suggestions) lines.push(`- ${mdEscape(item)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeReport(
  runDir: string,
  run: ScenarioRunResult,
): { jsonPath: string; mdPath: string; report: AiUserReport } {
  const report = buildReport(run, runDir);
  const jsonPath = join(runDir, 'report.json');
  const mdPath = join(runDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, renderReportMarkdown(report), 'utf8');
  return { jsonPath, mdPath, report };
}
