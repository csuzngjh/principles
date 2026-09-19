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

// ── PRI-858: formation evidence reaches the Owner decision card ──────────────

describe('PRI-858: formationEvidence validation + governance neutrality', () => {
  const validEvidence = {
    version: 'formation-context.v1',
    sourcePainId: 'pain-42',
    diagnosis: {
      artifactId: 'pi-art-diag-review-1-run-1',
      taskId: 'diag-review-1',
      stage: 'diag_router',
      rootCause: 'Edits destructive targets without confirmation.',
      summary: 'Repeated ambiguous-target writes.',
      violatedPrinciples: [{ principleId: 'P-1', title: 'Confirm first', rationale: 'guessed' }],
      evidence: [{ sourceRef: 'pain-42', note: 'Two unconfirmed overwrites.' }],
      recommendations: ['[principle] Require explicit confirmation.'],
      confidence: 0.81,
      omittedFields: [],
    },
    provenance: {
      sourceDreamerArtifactId: 'pi-art-dreamer-review-1-run-1',
      sourceDiagnosisArtifactId: 'pi-art-diag-review-1-run-1',
      sourceDiagnosisTaskId: 'diag-review-1',
    },
    notes: [],
  };

  /** Parse one item whose brief carries `formationEvidence`; return the parsed block. */
  function parseFormation(formationEvidence: unknown): unknown {
    const base = makeItem() as { review: { brief: Record<string, unknown> } };
    base.review.brief.formationEvidence = formationEvidence;
    const data = validateOwnerDecisionsData({ items: [base], total: 1, generatedAt: 't' });
    expect(data).not.toBeNull();
    const brief = (data?.items[0] as { review?: { brief?: { formationEvidence?: unknown } } } | undefined)?.review?.brief;
    return brief?.formationEvidence;
  }

  it('keeps the decision actionable and unchanged when evidence is attached', () => {
    const plain = makeItem() as { review: { brief: Record<string, unknown> } };
    const withEvidence = makeItem() as { review: { brief: Record<string, unknown> } };
    withEvidence.review.brief.formationEvidence = validEvidence;

    const plainData = validateOwnerDecisionsData({ items: [plain], total: 1, generatedAt: 't' });
    const evidenceData = validateOwnerDecisionsData({ items: [withEvidence], total: 1, generatedAt: 't' });
    expect(evidenceData?.items[0]?.allowedActions).toEqual(plainData?.items[0]?.allowedActions);
    expect(evidenceData?.items[0]?.review?.capability).toEqual(plainData?.items[0]?.review?.capability);
    expect(evidenceData?.items[0]?.review?.evidence.completeness).toBe(plainData?.items[0]?.review?.evidence.completeness);
    expect(evidenceData?.items[0]?.expectedEvidenceDigest).toBe(plainData?.items[0]?.expectedEvidenceDigest);
  });

  it('projects the bounded diagnosis and drops fields the Owner does not read', () => {
    const parsed = parseFormation(validEvidence) as Record<string, unknown>;
    expect(parsed).not.toBeNull();
    expect(parsed?.sourcePainId).toBe('pain-42');
    expect(parsed?.diagnosis).toEqual({
      rootCause: 'Edits destructive targets without confirmation.',
      summary: 'Repeated ambiguous-target writes.',
      evidence: [{ sourceRef: 'pain-42', note: 'Two unconfirmed overwrites.' }],
    });
    // rc-9 transparency survives; raw dumps and debug identity do not.
    expect(JSON.stringify(parsed)).not.toContain('omittedFields');
    expect(JSON.stringify(parsed)).not.toContain('violatedPrinciples');
    expect(JSON.stringify(parsed)).not.toContain('recommendations');
    expect(parsed?.provenance).toEqual(validEvidence.provenance);
  });

  it('accepts a degraded (diagnosis-less) block so the reason stays visible', () => {
    const degraded = { ...validEvidence, sourcePainId: null, diagnosis: undefined, notes: ['formation_dreamer_artifact_missing'] };
    const parsed = parseFormation(degraded) as { diagnosis?: unknown; notes: string[] };
    expect(parsed.diagnosis).toBeUndefined();
    expect(parsed.notes).toEqual(['formation_dreamer_artifact_missing']);
  });

  it('omits a malformed block instead of half-rendering it (and keeps the item valid)', () => {
    expect(parseFormation({ ...validEvidence, notes: 'not-an-array' })).toBeUndefined();
    expect(parseFormation({ ...validEvidence, provenance: {} })).toBeUndefined();
    expect(parseFormation({ ...validEvidence, diagnosis: { ...validEvidence.diagnosis, evidence: [{ sourceRef: 'x' }] } })).toBeUndefined();
    expect(parseFormation('x')).toBeUndefined();
    const data = validateOwnerDecisionsData({ items: [makeItem()], total: 1, generatedAt: 't' });
    expect(data?.items).toHaveLength(1);
  });

  it('card renders the formation section, keeps ids in the advanced fold only, and both locales carry the keys', () => {
    const cardSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/ui/pages/focus/OwnerDecisionCard.tsx'), 'utf-8');
    expect(cardSrc).toContain('owner-formation-evidence-');
    expect(cardSrc).toContain('formationRootCauseLabel');
    // 不在 Owner 面前倾倒原始血缘/调试字段
    expect(cardSrc).not.toContain('lineageArtifactIds');
    expect(cardSrc).not.toContain('omittedFields');
    for (const locale of ['zh-CN', 'en']) {
      const raw = fs.readFileSync(path.resolve(__dirname, `../../src/ui/i18n/${locale}.json`), 'utf-8');
      const od = (JSON.parse(raw) as { pages: { focus: { ownerDecision: Record<string, unknown> } } }).pages.focus.ownerDecision;
      for (const key of ['formationLabel', 'formationPainLabel', 'formationDiagnosisLabel', 'formationRootCauseLabel', 'formationEvidenceLabel', 'formationUnavailableNote']) {
        expect(typeof od[key], `${locale} ownerDecision.${key}`).toBe('string');
      }
    }
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

  it('PRI-787: decision card renders a visible lock reason and no longer triple-renders the rollout brief summary', () => {
    const cardSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/ui/pages/focus/OwnerDecisionCard.tsx'), 'utf-8');
    // rc-9: 动作被治理门禁用时卡片必须给出可见原因（无声禁用=bug）
    expect(cardSrc).toContain('owner-actions-locked-');
    // rollout 的 brief.summary 只由 item.summary 渲染一次；正文不再重复
    expect(cardSrc).not.toContain('item.review.brief.summary &&');
    // 锁定原因由 FocusPage 派生并传入（experience readiness 门）
    const focusSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/ui/pages/focus/FocusPage.tsx'), 'utf-8');
    expect(focusSrc).toContain('actionsLockedReason');
  });

  it('i18n: ownerDecision keys exist in BOTH locales (parity)', () => {
    for (const locale of ['zh-CN', 'en']) {
      const raw = fs.readFileSync(path.resolve(__dirname, `../../src/ui/i18n/${locale}.json`), 'utf-8');
      const data = JSON.parse(raw) as { pages: { focus: Record<string, unknown>; failedTasks: Record<string, unknown> } };
      const od = data.pages.focus.ownerDecision as Record<string, unknown> | undefined;
      expect(od, `${locale} pages.focus.ownerDecision missing`).toBeDefined();
      for (const key of ['sectionTitle', 'empty', 'acceptCurrent', 'reviseOnce', 'rejectCurrent', 'staleError', 'qualityChecklistLabel', 'actionsLockedAuth', 'actionsLockedIdentity', 'goSettingsCta']) {
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

  // P1-2 regression (PRI-798): rollout_activation_candidate_unresolved must
  // show a distinct copy from hard-gate reasons; any other accept-blocked
  // reason (e.g. review_evidence_insufficient) must fall back to a truthful
  // generic copy instead of mislabeling as the hard gate.
  it('P1-2: acceptBlockedNoCandidate i18n key exists in both locales and differs from acceptBlockedHardGate', () => {
    for (const locale of ['zh-CN', 'en']) {
      const raw = fs.readFileSync(path.resolve(__dirname, `../../src/ui/i18n/${locale}.json`), 'utf-8');
      const data = JSON.parse(raw) as { pages: { focus: { ownerDecision?: Record<string, unknown> } } };
      const od = data.pages.focus.ownerDecision;
      expect(od, `${locale}: pages.focus.ownerDecision missing`).toBeDefined();
      expect(typeof od?.['acceptBlockedNoCandidate'], `${locale}: acceptBlockedNoCandidate missing or not a string`).toBe('string');
      expect(typeof od?.['acceptBlockedHardGate'], `${locale}: acceptBlockedHardGate missing or not a string`).toBe('string');
      expect(typeof od?.['acceptBlockedGeneric'], `${locale}: acceptBlockedGeneric missing or not a string`).toBe('string');
      // The three keys must be distinct — they describe different situations
      expect(od?.['acceptBlockedNoCandidate']).not.toBe(od?.['acceptBlockedHardGate']);
      expect(od?.['acceptBlockedGeneric']).not.toBe(od?.['acceptBlockedHardGate']);
      expect(od?.['acceptBlockedGeneric']).not.toBe(od?.['acceptBlockedNoCandidate']);
    }
  });

  it('P1-2: OwnerDecisionCard branches on structured reason codes, not just canAccept', () => {
    const cardSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/ui/pages/focus/OwnerDecisionCard.tsx'), 'utf-8');
    // Must use the dedicated i18n key for the candidate-unresolved case
    expect(cardSrc).toContain('acceptBlockedNoCandidate');
    // Must still retain the hard-gate key, gated on the hard-gate reason codes
    expect(cardSrc).toContain('acceptBlockedHardGate');
    expect(cardSrc).toContain("adversarial_hard_gate_failed");
    expect(cardSrc).toContain("adversarial_hard_gate_not_passed");
    // Must branch on reasonCode, not just canAccept (quote-style agnostic)
    expect(cardSrc).toMatch(/item\.reasonCode === ["']rollout_activation_candidate_unresolved["']/);
    // Unknown/other blocked reasons must fall back to the truthful generic copy
    expect(cardSrc).toContain('acceptBlockedGeneric');
  });
});
