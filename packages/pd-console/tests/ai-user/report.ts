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
    screenshots: string[];
  };
  problems: string[];
  suggestions: string[];
  run: {
    model: string;
    baseUrlOrigin: string;
    startedAt: string;
    finishedAt: string;
    maxSteps: number;
  };
}

export function buildReport(run: ScenarioRunResult, runDir: string): AiUserReport {
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
      // step-00.png 是初始状态截图，其余按步骤递增
      screenshots: ['step-00.png', ...run.steps.map(s => s.screenshot)],
    },
    problems: run.problems,
    suggestions: run.suggestions,
    run: {
      model: run.model,
      baseUrlOrigin: run.baseUrlOrigin,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      maxSteps: run.scenario.maxSteps,
    },
  };
}

const STATUS_LABELS: Record<ScenarioRunResult['result'], string> = {
  passed: '通过 — AI User 达成目标',
  failed: '失败 — AI User 确定无法完成',
  incomplete: '未完成 — 步数耗尽或运行中断',
};

function actionCell(step: StepRecord): string {
  const parts: string[] = [step.action.type];
  if (step.action.target) parts.push(step.action.target);
  if (step.action.value !== undefined) parts.push(`「${step.action.value}」`);
  return parts.join(' ').replace(/\|/g, '\\|');
}

export function renderReportMarkdown(report: AiUserReport): string {
  const lines: string[] = [];
  lines.push(`# AI User QA 体验报告 — ${report.scenario.id}`);
  lines.push('');
  lines.push('## Scenario');
  lines.push(`- 用户身份：${report.scenario.persona}`);
  lines.push(`- 目标：${report.scenario.goal}`);
  lines.push('- 成功标准：');
  for (const item of report.scenario.success) lines.push(`  - ${item}`);
  if (report.scenario.observe.length > 0) {
    lines.push('- 观察点：');
    for (const item of report.scenario.observe) lines.push(`  - ${item}`);
  }
  lines.push('');
  lines.push('## Result');
  lines.push(`- 结果：${STATUS_LABELS[report.result.status]}（${report.result.status}）`);
  lines.push(`- 结束原因：${report.result.finishReason}`);
  lines.push(`- 执行步数：${report.result.stepsExecuted}`);
  lines.push(`- 模型：${report.run.model}（端点 ${report.run.baseUrlOrigin}）`);
  lines.push(`- 时间：${report.run.startedAt} → ${report.run.finishedAt}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('| # | 想法 | 动作 | 结果 | 截图 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const step of report.steps) {
    const outcome = step.execution.ok ? 'ok' : `失败：${step.execution.error ?? ''}`;
    lines.push(
      `| ${step.index} | ${step.thought.replace(/\|/g, '\\|')} | ${actionCell(step)} | ${outcome.replace(/\|/g, '\\|')} | ${step.screenshot} |`,
    );
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push(`- 运行目录：\`${report.evidence.runDir}\``);
  lines.push(`- 截图：${report.evidence.screenshots.join(', ')}`);
  lines.push('');
  lines.push('## Problems');
  if (report.problems.length === 0) {
    lines.push('- （无记录）');
  } else {
    for (const item of report.problems) lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push('## Suggestions');
  if (report.suggestions.length === 0) {
    lines.push('- （无记录）');
  } else {
    for (const item of report.suggestions) lines.push(`- ${item}`);
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
