import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '../../../..');

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

describe('M8: Legacy diagnostician/cron/subagent paths disabled', () => {
  test('does NOT register createWritePainFlagTool', () => {
    const index = readFile('packages/openclaw-plugin/src/index.ts');
    expect(index).not.toMatch(/createWritePainFlagTool/);
  });

  test('does NOT have empathy-optimizer in BUILTIN_PD_TASKS', () => {
    const content = readFile('packages/openclaw-plugin/src/core/pd-task-types.ts');
    expect(content).not.toMatch(/empathy-optimizer/);
  });

  test('does NOT have empathy-optimizer case in buildTaskPrompt', () => {
    const content = readFile('packages/openclaw-plugin/src/core/pd-task-reconciler.ts');
    expect(content).not.toMatch(/case 'empathy-optimizer'/);
  });

  test('does NOT have EmpathyObserverWorkflowManager in prompt.ts active code', () => {
    const content = readFile('packages/openclaw-plugin/src/hooks/prompt.ts');
    // Only check for actual usage (not comments)
    const uncommented = content.replace(/\/\/.*$/mg, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(uncommented).not.toMatch(/EmpathyObserverWorkflowManager/);
  });

  test('does NOT have EmpathyObserverWorkflowManager import in subagent.ts', () => {
    const content = readFile('packages/openclaw-plugin/src/hooks/subagent.ts');
    expect(content).not.toMatch(/EmpathyObserverWorkflowManager/);
  });

  test('does NOT have empathy-observer case in subagent.ts active code', () => {
    const content = readFile('packages/openclaw-plugin/src/hooks/subagent.ts');
    const uncommented = content.replace(/\/\/.*$/mg, '');
    expect(uncommented).not.toMatch(/empathy-observer/);
  });

  test('PD task reconciliation does NOT create PD Empathy Optimizer cron job', () => {
    const content = readFile('packages/openclaw-plugin/src/core/pd-task-types.ts');
    // BUILTIN_PD_TASKS should be empty array
    const match = content.match(/BUILTIN_PD_TASKS\s*:\s*PDTaskSpec\[\]\s*=\s*\[\s*\]/);
    expect(match).not.toBeNull();
  });

  test('pain signal calls PainSignalBridge.emit via evolutionReducer', () => {
    const content = readFile('packages/openclaw-plugin/src/hooks/pain.ts');
    expect(content).toMatch(/emitPainDetectedEvent/);
    expect(content).toMatch(/evolutionReducer\.emitSync/);
  });

  test('empathy keyword matcher is still functional (kept capability)', () => {
    const content = readFile('packages/openclaw-plugin/src/core/empathy-keyword-matcher.ts');
    expect(content).toMatch(/matchEmpathyKeywords/);
    expect(content).toMatch(/loadKeywordStore/);
  });
});
