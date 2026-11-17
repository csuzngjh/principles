/**
 * PRI-1234 / SPEC-PD-INTENT-UNIFICATION-001 §12.2 — Intent summary content
 * readiness mapping.
 *
 * The console model must derive contentReadiness / usableSectionCount /
 * sectionStates EXCLUSIVELY from Core's shared classification — the same
 * deterministic rules Stage A, the prompt hook and the conflict gate use.
 * A template question must never surface as Owner intent.
 *
 * Real temp workspaces + real files (EP-09).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IntentPageModel } from '../../src/server/models/IntentPageModel.js';
import { INTENT_DOC_TEMPLATE, createIntentTemplate } from '@principles/core/runtime';

let workspaceDir: string;
let principlesDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-readiness-'));
  principlesDir = path.join(workspaceDir, '.principles');
  fs.mkdirSync(principlesDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeIntent(content: string): void {
  fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), content, 'utf8');
}

function sectionDoc(filled: Record<string, string | undefined>): string {
  return [
    '# INTENT.md',
    '',
    '## 1. Why', '', filled.why ?? '', '',
    '## 2. Desired Outcome', '', filled.desiredOutcome ?? '', '',
    '## 3. Non-negotiables', '', filled.nonNegotiables ?? '', '',
    '## 4. Stop / Escalation', '', filled.stopEscalation ?? '', '',
    '## 5. Current Strategic Focus', '', filled.currentStrategicFocus ?? '', '',
  ].join('\n');
}

const AUTHORED = {
  why: '保护 Owner 注意力是这个阶段的最高优先级。',
  desiredOutcome: '重复偏离在一个周期内被识别。',
  nonNegotiables: '不牺牲证据真实性换取速度。',
  stopEscalation: '影响生产规则时必须升级 Owner。',
  currentStrategicFocus: '诊断可信度优先于吞吐。',
};

describe('IntentPageModel.getSummary content readiness (PRI-1234)', () => {
  it('all five authored → configured, 5/5, all sectionStates authored', async () => {
    writeIntent(sectionDoc(AUTHORED));
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.contentReadiness).toBe('configured');
    expect(result.usableSectionCount).toBe(5);
    expect(result.totalSectionCount).toBe(5);
    expect(result.sectionStates).toEqual({
      why: 'authored',
      desiredOutcome: 'authored',
      nonNegotiables: 'authored',
      stopEscalation: 'authored',
      currentStrategicFocus: 'authored',
    });
  });

  it('one authored section → incomplete, 1/5 (partial is usable, not an error)', async () => {
    writeIntent(sectionDoc({ why: AUTHORED.why }));
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.contentReadiness).toBe('incomplete');
    expect(result.usableSectionCount).toBe(1);
    expect(result.sectionStates?.why).toBe('authored');
    expect(result.sectionStates?.desiredOutcome).toBe('missing');
  });

  it('two-to-four authored sections → incomplete with the exact count', async () => {
    writeIntent(sectionDoc({
      why: AUTHORED.why,
      nonNegotiables: AUTHORED.nonNegotiables,
      stopEscalation: AUTHORED.stopEscalation,
    }));
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.contentReadiness).toBe('incomplete');
    expect(result.usableSectionCount).toBe(3);
  });

  it('shipped template content → template_only, 0/5 — a template question is never Owner intent', async () => {
    writeIntent(createIntentTemplate('zh-CN'));
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.contentReadiness).toBe('template_only');
    expect(result.usableSectionCount).toBe(0);
    expect(Object.values(result.sectionStates ?? {}).every((s) => s === 'placeholder')).toBe(true);
  });

  it('legacy generic template is equally recognized as placeholder', async () => {
    // INTENT_DOC_TEMPLATE (the legacy short template) shipped in earlier
    // releases; documents created from it must classify as placeholder too.
    writeIntent(INTENT_DOC_TEMPLATE);
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.contentReadiness).toBe('template_only');
    expect(result.usableSectionCount).toBe(0);
  });

  it('template text plus a real answer in ONE section counts that section authored', async () => {
    const template = createIntentTemplate('zh-CN');
    const withAnswer = template.replace(
      '## 1. Why\n\n这个项目 / 阶段为什么重要？',
      `## 1. Why\n\n这个项目 / 阶段为什么重要？\n真实回答：减少 Owner 的纠正成本。`,
    );
    writeIntent(withAnswer);
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.contentReadiness).toBe('incomplete');
    expect(result.usableSectionCount).toBe(1);
    expect(result.sectionStates?.why).toBe('authored');
    expect(result.sectionStates?.desiredOutcome).toBe('placeholder');
  });

  it('TODO/待填写 noise alone is placeholder, never authored', async () => {
    writeIntent(sectionDoc({
      why: 'TODO',
      desiredOutcome: '待填写',
      nonNegotiables: '...',
      stopEscalation: 'tbd',
      currentStrategicFocus: '补充说明',
    }));
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.contentReadiness).toBe('template_only');
    expect(result.usableSectionCount).toBe(0);
  });

  it('every degraded read (flag off / not found / oversized / read error) reports template_only with 0/5', async () => {
    const model = new IntentPageModel(workspaceDir);

    const flagOff = await model.getSummary(false, 'zh-CN');
    expect(flagOff).toMatchObject({ ok: false, contentReadiness: 'template_only', usableSectionCount: 0, totalSectionCount: 5, reason: 'flag_disabled' });

    const missing = await model.getSummary(true, 'zh-CN');
    expect(missing).toMatchObject({ ok: false, contentReadiness: 'template_only', usableSectionCount: 0, reason: 'not_found' });

    writeIntent('z'.repeat(33 * 1024));
    const oversized = await model.getSummary(true, 'zh-CN');
    expect(oversized).toMatchObject({ ok: false, found: true, contentReadiness: 'template_only', usableSectionCount: 0, reason: 'oversized' });
  });

  it('empty document (headers only) → template_only 0/5 with missing states', async () => {
    writeIntent(sectionDoc({}));
    const result = await new IntentPageModel(workspaceDir).getSummary(true, 'zh-CN');
    expect(result.contentReadiness).toBe('template_only');
    expect(result.usableSectionCount).toBe(0);
    expect(Object.values(result.sectionStates ?? {}).every((s) => s === 'missing')).toBe(true);
  });

  it('saveContent projects the SAME readiness fields onto the save response (SPEC §12.1)', async () => {
    const model = new IntentPageModel(workspaceDir);
    const saved = await model.saveContent(true, sectionDoc({ why: AUTHORED.why }), 'zh-CN');
    expect(saved.ok).toBe(true);
    expect(saved.contentReadiness).toBe('incomplete');
    expect(saved.usableSectionCount).toBe(1);
    expect(saved.totalSectionCount).toBe(5);
    expect(saved.sectionStates?.why).toBe('authored');
    expect(saved.sectionStates?.desiredOutcome).toBe('missing');

    const configured = await model.saveContent(true, sectionDoc(AUTHORED), 'zh-CN');
    expect(configured.contentReadiness).toBe('configured');
    expect(configured.usableSectionCount).toBe(5);
  });
});
