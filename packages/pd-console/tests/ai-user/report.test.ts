/**
 * PRI-754 — 体验报告结构的单元测试。
 * 验证六节结构（Scenario/Result/Steps/Evidence/Problems/Suggestions）与
 * 真实文件写出（report.json 可解析 + report.md 人类可读），EP-09：走真实
 * 文件边界而非只测内存对象。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, renderReportMarkdown, writeReport } from './report.js';
import { parseScenario } from './scenario.js';
import type { ScenarioRunResult, StepRecord } from './runner.js';

const scenario = parseScenario({
  id: 'demo',
  persona: '测试用户',
  goal: '完成初始化',
  success: ['看到运行状态'],
  observe: ['首屏指引'],
});

const run: ScenarioRunResult = {
  scenario,
  result: 'passed',
  finishReason: 'user-finished-success',
  problems: ['术语「治理」对新用户不直观'],
  suggestions: ['首屏增加新手引导'],
  steps: [
    {
      index: 1,
      thought: '点击开始',
      action: { type: 'click', target: 'role=button[name="开始"]' },
      execution: { ok: true },
      observation: { url: 'http://127.0.0.1:3101/', title: 'PD Console' },
      screenshot: 'step-01.png',
    },
  ],
  effectiveMaxSteps: 8,
  initialScreenshot: 'step-00.png',
  startedAt: '2026-09-12T00:00:00.000Z',
  finishedAt: '2026-09-12T00:01:00.000Z',
  model: 'test-model',
  baseUrlOrigin: 'http://127.0.0.1:3101',
};

describe('buildReport', () => {
  it('报告包含全部六节且投影 scenario 运行字段', () => {
    const report = buildReport(run, '/tmp/run-1');
    expect(Object.keys(report).sort()).toEqual(
      ['evidence', 'problems', 'result', 'run', 'scenario', 'steps', 'suggestions'].sort(),
    );
    expect(report.scenario.id).toBe('demo');
    expect(report.result).toEqual({ status: 'passed', finishReason: 'user-finished-success', stepsExecuted: 1 });
    expect(report.evidence.screenshots).toEqual(['step-00.png', 'step-01.png']);
    expect(report.evidence.screenshotFailures).toBe(0);
    // 报告必须记录实际生效预算（含 CLI 覆盖），不是 scenario 原始值
    expect(report.run.maxSteps).toBe(8);
  });

  it('截图失败的步骤不冒充证据（rc-9 可观察）', () => {
    const broken = {
      ...run,
      steps: [
        {
          index: 1,
          thought: '点击开始',
          action: { type: 'click', target: 'text=开始' } as const,
          execution: { ok: true },
          observation: { url: 'http://127.0.0.1:3101/', title: 'PD Console' },
          screenshot: null,
        },
      ],
      initialScreenshot: null,
    };
    const report = buildReport(broken, '/tmp/run-broken');
    expect(report.evidence.screenshots).toEqual([]);
    expect(report.evidence.screenshotFailures).toBe(2);
    const md = renderReportMarkdown(report);
    expect(md).toContain('（截图失败）');
    expect(md).toContain('2 张失败');
  });

  it('markdown 单元格转义反斜杠与竖线（CodeQL incomplete-escaping 负向对照）', () => {
    const hostileSteps: StepRecord[] = [
      {
        index: 1,
        thought: '想法含 \\ 和 | 特殊字符',
        action: { type: 'click', target: 'text=a|b\\\\c' },
        execution: { ok: false, error: '失败信息含 | 竖线' },
        observation: { url: 'http://127.0.0.1:3101/', title: '' },
        screenshot: 'step-01.png',
      },
    ];
    const hostile = { ...run, problems: ['单元格注入尝试 \\ | 原文保留'], steps: hostileSteps };
    const md = renderReportMarkdown(buildReport(hostile, '/tmp/run-3'));
    expect(md).toContain('想法含 \\\\ 和 \\| 特殊字符');
    expect(md).toContain('text=a\\|b\\\\\\\\c');
    expect(md).toContain('失败信息含 \\| 竖线');
    expect(md).toContain('\\\\ \\| 原文保留');
  });
});

describe('renderReportMarkdown', () => {
  it('包含六节标题、步骤行与截图证据', () => {
    const md = renderReportMarkdown(buildReport(run, '/tmp/run-1'));
    for (const section of ['## Scenario', '## Result', '## Steps', '## Evidence', '## Problems', '## Suggestions']) {
      expect(md).toContain(section);
    }
    expect(md).toContain('role=button[name="开始"]');
    expect(md).toContain('step-01.png');
    expect(md).toContain('术语「治理」对新用户不直观');
  });

  it('空 problems/suggestions 有明确占位', () => {
    const md = renderReportMarkdown(buildReport({ ...run, problems: [], suggestions: [] }, '/tmp/run-2'));
    expect(md).toContain('（无记录）');
  });
});

describe('writeReport', () => {
  it('写出 report.json（可解析）与 report.md（含六节）到真实目录', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'ai-user-report-'));
    const { jsonPath, mdPath, report } = writeReport(runDir, run);
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(parsed.result.status).toBe('passed');
    expect(parsed.steps).toHaveLength(1);
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toContain('# AI User QA 体验报告 — demo');
    expect(report.evidence.runDir).toBe(runDir);
  });
});
