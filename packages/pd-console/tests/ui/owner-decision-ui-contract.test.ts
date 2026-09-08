/**
 * PRI-629 — Owner Decision UI/架构契约测试（SPEC §27/§34）。
 *
 * 覆盖:
 *   - cr10: validateOwnerDecisionsData / validateOwnerResolutionResult 的
 *     信任边界 (unknown → 严格校验)
 *   - §34 架构回归: effectiveDecision 只有 core 的单一 resolver;
 *     Console UI 不参与 domain decision (不 import pitask-metadata /
 *     owner-review 策略);Recover guard 不只是 UI 隐藏 (route 层 409 在
 *     failed-tasks.test.ts 验证)
 *   - §27 badge: NotificationProvider 计数来源 = owner-decisions total
 *   - i18n parity: ownerDecision 键在两个 locale 都存在 (由 cr10-i18n 治理
 *     测试整体覆盖,这里校验关键新键)
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateOwnerDecisionsData, validateOwnerResolutionResult } from '../../src/ui/utils/validators.js';

function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewKey: 'odk_abc',
    kind: 'evaluator_review',
    taskId: 'evaluator-1',
    title: '自动改进已达到本轮上限',
    summary: '机器建议继续修改',
    reasonCode: 'evaluator_repair_budget_exhausted',
    legacy: false,
    allowedActions: ['accept_current', 'revise_once', 'reject_current'],
    expectedRevisionEpoch: 0,
    expectedSourceRunId: 'run-1',
    expectedSourceArtifactId: 'pi-art-x',
    expectedSourceArtifactHash: 'a'.repeat(64),
    expectedEvidenceDigest: 'e'.repeat(64),
    review: {
      brief: {
        kind: 'evaluator',
        principle: { statement: 'Confirm the target.', scope: ['filesystem'] },
        implementation: { summary: 'Adds a confirmation gate.', affectedTools: ['write_file'], risks: [] },
        strengths: ['Deterministic target check'], concerns: ['Copy is ambiguous'],
        requiredChanges: ['Clarify copy'], score: 0.72,
      },
      evidence: {
        completeness: 'complete',
        deterministicChecks: [{ check: 'adversarial_hard_gate', status: 'not_run' }],
        items: [{ evidenceClass: 'automated_review', label: 'concern', value: 'Copy is ambiguous' }],
        digest: 'e'.repeat(64),
      },
      capability: { acceptRequirement: { kind: 'none' } },
    },
    createdAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('cr10: validateOwnerDecisionsData (ERR-001/005/009/013)', () => {
  it('accepts a well-formed envelope and preserves optional fields', () => {
    const data = validateOwnerDecisionsData({
      items: [makeItem({ machineRecommendation: 'needs_revision', score: 0.72 })],
      total: 1,
      generatedAt: '2026-08-30T00:00:00.000Z',
    });
    expect(data).not.toBeNull();
    expect(data?.items[0]?.allowedActions).toHaveLength(3);
    expect(data?.items[0]?.score).toBe(0.72);
  });

  it('accepts a visible but non-actionable decision when evidence recovery is required', () => {
    const item = makeItem({
      allowedActions: [],
      evidenceUnavailableReason: 'decision_artifact_missing',
    });
    delete item.expectedEvidenceDigest;
    delete item.review;
    expect(validateOwnerDecisionsData({
      items: [item], total: 1, generatedAt: 't',
    })?.items[0]?.evidenceUnavailableReason).toBe('decision_artifact_missing');
  });

  it('rejects null / arrays / primitives / missing fields / unknown kind / bad action', () => {
    expect(validateOwnerDecisionsData(null)).toBeNull();
    expect(validateOwnerDecisionsData([])).toBeNull();
    expect(validateOwnerDecisionsData('x')).toBeNull();
    expect(validateOwnerDecisionsData({ items: [], total: 0 })).toBeNull(); // missing generatedAt
    expect(validateOwnerDecisionsData({
      items: [makeItem({ kind: 'mystery_kind' })], total: 1, generatedAt: 't',
    })).toBeNull();
    expect(validateOwnerDecisionsData({
      items: [makeItem({ allowedActions: ['format_disk'] })], total: 1, generatedAt: 't',
    })).toBeNull();
    expect(validateOwnerDecisionsData({
      items: [makeItem({ legacy: 'yes' })], total: 1, generatedAt: 't',
    })).toBeNull();
  });
});

describe('PRI-704: qualityChecklist validation (strict five-item contract, 评审修正)', () => {
  const QC_IDS = ['understandability', 'evidence', 'actionability', 'generalization', 'boundary'];
  const validChecklist = {
    schemaVersion: 1,
    items: QC_IDS.map((id, index) => ({ id, pass: index !== 3, note: `note-${id}` })),
  };

  /** Run one item through the envelope validator; return its parsed brief checklist. */
  function parseChecklist(qualityChecklist: unknown): unknown {
    const base = makeItem() as { review: { brief: Record<string, unknown> } };
    base.review.brief.qualityChecklist = qualityChecklist;
    const data = validateOwnerDecisionsData({ items: [base], total: 1, generatedAt: 't' });
    expect(data).not.toBeNull();
    const brief = (data?.items[0] as { review?: { brief?: { qualityChecklist?: unknown } } } | undefined)?.review?.brief;
    return brief?.qualityChecklist;
  }

  it('passes a valid five-item checklist through verbatim', () => {
    const parsed = parseChecklist(validChecklist);
    expect(parsed).toEqual(validChecklist);
  });

  it('omits the checklist when an entry is malformed (item itself stays valid)', () => {
    expect(parseChecklist({
      schemaVersion: 1,
      items: QC_IDS.map((id) => ({ id, pass: 'yes', note: 'n' })),
    })).toBeUndefined();
    expect(parseChecklist({
      schemaVersion: 1,
      items: QC_IDS.map((id) => ({ id, pass: true, note: 42 })),
    })).toBeUndefined();
  });

  it('omits the checklist on unknown / duplicate / missing ids', () => {
    // unknown id in place of a known one
    expect(parseChecklist({
      schemaVersion: 1,
      items: QC_IDS.slice(0, 4).map((id) => ({ id, pass: true, note: 'n' })).concat([{ id: 'clarity', pass: true, note: 'n' }]),
    })).toBeUndefined();
    // duplicate (6 items)
    expect(parseChecklist({
      schemaVersion: 1,
      items: QC_IDS.map((id) => ({ id, pass: true, note: 'n' })).concat([{ id: 'boundary', pass: false, note: 'dup' }]),
    })).toBeUndefined();
    // missing (4 items)
    expect(parseChecklist({
      schemaVersion: 1,
      items: QC_IDS.slice(0, 4).map((id) => ({ id, pass: true, note: 'n' })),
    })).toBeUndefined();
  });

  it('omits the checklist on schemaVersion !== 1 (number 2 / string \'1\')', () => {
    expect(parseChecklist({ ...validChecklist, schemaVersion: 2 })).toBeUndefined();
    expect(parseChecklist({ ...validChecklist, schemaVersion: '1' })).toBeUndefined();
  });

  it('omits a non-object checklist and keeps absent = undefined (older snapshots)', () => {
    expect(parseChecklist('x')).toBeUndefined();
    expect(parseChecklist(null)).toBeUndefined();
    expect(parseChecklist([1, 2])).toBeUndefined();
    // absent → brief.qualityChecklist undefined, review still valid
    const base = makeItem() as { review: { brief: Record<string, unknown> } };
    const data = validateOwnerDecisionsData({ items: [base], total: 1, generatedAt: 't' });
    const brief = (data?.items[0] as { review?: { brief?: { qualityChecklist?: unknown } } } | undefined)?.review?.brief;
    expect(brief?.qualityChecklist).toBeUndefined();
  });
});

describe('cr10: validateOwnerResolutionResult', () => {
  it('accepts resolved and rejects non-resolved / malformed', () => {
    expect(validateOwnerResolutionResult({
      status: 'resolved', resolutionId: 'ores_x', reviewKey: 'odk_k',
      action: 'accept_current', applied: false, runnerWillApply: true,
    })).not.toBeNull();
    expect(validateOwnerResolutionResult({
      status: 'stale_owner_decision', resolutionId: 'x', reviewKey: 'k',
      action: 'a', applied: false, runnerWillApply: false,
    })).toBeNull();
    expect(validateOwnerResolutionResult({
      status: 'resolved', resolutionId: 'x', reviewKey: 'k',
      action: 'a', applied: 'false', runnerWillApply: false,
    })).toBeNull();
  });
});

describe('PRI-629 §34 architecture regression guards', () => {
  const uiDir = path.resolve(__dirname, '../../src/ui');

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }

  it('Console UI does not import core domain decision internals (pitask-metadata / owner-review)', () => {
    const files = walk(uiDir);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      if (src.includes('pitask-metadata') || src.includes('owner-review.js')) {
        offenders.push(path.relative(uiDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('badge source: NotificationProvider counts owner-decisions total (not approvals/candidates) (§27)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/ui/components/notifications/NotificationProvider.tsx'), 'utf-8');
    expect(src).toContain('fetchOwnerDecisions');
    expect(src).toContain('decisionsResult.data.total');
  });

  it('FailedTasksPage hides Recover for owner-decision tasks and links to the governance focus (§28)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/ui/pages/failed-tasks/FailedTasksPage.tsx'), 'utf-8');
    expect(src).toContain('ownerDecisionRequired === true');
    expect(src).toContain('goGovernanceFocus');
  });

  it('i18n: ownerDecision keys exist in BOTH locales (parity)', () => {
    for (const locale of ['zh-CN', 'en']) {
      const raw = fs.readFileSync(path.resolve(__dirname, `../../src/ui/i18n/${locale}.json`), 'utf-8');
      const data = JSON.parse(raw) as { pages: { focus: Record<string, unknown>; failedTasks: Record<string, unknown> } };
      const od = data.pages.focus.ownerDecision as Record<string, unknown> | undefined;
      expect(od, `${locale} pages.focus.ownerDecision missing`).toBeDefined();
      for (const key of ['sectionTitle', 'empty', 'acceptCurrent', 'reviseOnce', 'rejectCurrent', 'staleError', 'qualityChecklistLabel']) {
        expect(typeof od?.[key], `${locale} ownerDecision.${key}`).toBe('string');
      }
      // PRI-704: quality checklist 状态文案 + 五项检查名（OwnerDecisionCard
      // 按 id 构造 i18n 键，缺键会渲染未本地化标签）
      const status = od?.qualityCheckStatus as Record<string, unknown> | undefined;
      for (const key of ['passed', 'failed']) {
        expect(typeof status?.[key], `${locale} ownerDecision.qualityCheckStatus.${key}`).toBe('string');
      }
      const check = od?.qualityCheck as Record<string, unknown> | undefined;
      for (const key of ['understandability', 'evidence', 'actionability', 'generalization', 'boundary']) {
        expect(typeof check?.[key], `${locale} ownerDecision.qualityCheck.${key}`).toBe('string');
      }
      expect(data.pages.failedTasks.awaitingOwnerDecision).toBeDefined();
      expect(data.pages.failedTasks.goGovernanceFocus).toBeDefined();
    }
  });
});
