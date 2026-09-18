/**
 * OwnerDecisionView derivation tests — Owner Decision Experience v1.
 *
 * Pure-derivation slices for T1/T2/T3/T4/T5/T7/T9/T10 (SPEC §17) plus the
 * Semantic Selector v0 golden samples from the Phase 2 audit (§13 — the five
 * canonical text forms; labels are TEST FIXTURES, not runtime inputs).
 */
import { describe, expect, it } from 'vitest';
import type { GovernanceFacts } from '../../index.js';
import { deriveOwnerDecisionView, selectLearnedPrincipleV0, selectLearnedPrincipleV1, extractStandaloneBehaviorSentence, isWholeFieldHumanReadable } from '../../index.js';
import type { OwnerDecisionInputs } from '../../index.js';

const AS_OF = '2026-09-18T10:00:00.000Z';

function facts(overrides: Partial<GovernanceFacts> = {}): GovernanceFacts {
  return {
    schemaVersion: '1', principleId: 'p1', asOf: AS_OF,
    lineage: { principleId: 'p1', artifactIds: ['artifact-1'], taskIds: [], revisionIdentities: [], confidence: 'strong', sourceRefs: [{ type: 'principle', id: 'p1' }] },
    principle: { schemaVersion: '1', family: 'principle', sourceRef: { type: 'principle', id: 'p1' }, principleId: 'p1', lineageConfidence: 'strong', recordedAt: '2026-09-17T08:00:00.000Z', state: 'candidate' },
    tasks: [], runnerVerdicts: [], derivedRelations: [], approvals: [], activations: [], timelineEvents: [], collectionIssues: [],
    ...overrides,
  };
}

function task(taskId: string, status: GovernanceFacts['tasks'][number]['status'], extra: Partial<GovernanceFacts['tasks'][number]> = {}): GovernanceFacts['tasks'][number] {
  return {
    schemaVersion: '1', family: 'task', sourceRef: { type: 'task', id: taskId }, principleId: 'p1',
    taskId, lineageConfidence: 'strong', occurredAt: '2026-09-15T08:00:00.000Z', recordedAt: '2026-09-15T08:10:00.000Z',
    taskKind: 'evaluator', channel: 'code_tool_hook', status, attemptCount: 1, maxAttempts: 3, ...extra,
  };
}

function baseInputs(overrides: Partial<OwnerDecisionInputs> = {}): OwnerDecisionInputs {
  return {
    schemaVersion: '1', principleId: 'p1', asOf: AS_OF,
    ledger: {
      status: 'candidate', text: '主任务未完成前不得推进次要议题。', evaluability: 'weak_heuristic',
      triggerPattern: '', action: '', derivedFromPainIds: ['cand-1'], ruleIds: [],
      createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    },
    governance: facts(),
    candidate: {
      candidateId: 'cand-1', status: 'consumed', recommendationKind: 'principle',
      description: '主任务未完成前不得推进次要议题。',
    },
    diagnosis: {
      artifactId: 'art-1', summary: 'Agent 在主任务未完成时切换到次要议题。', rootCause: '缺乏焦点锚定机制。',
      evidenceItems: [], truncated: false,
    },
    scribe: null,
    philosopher: null,
    applications: {
      sourceStatus: 'available', deterministicCount: 0, selfReportedCount: 0, contextPresenceCount: 0,
      windowDays: 90, recent: [],
    },
    coverageSourceStatus: 'available',
    semanticSources: [
      { tier: 'candidate_principle', text: '主任务未完成前不得推进次要议题。', sourceVersion: 'cand-1' },
    ],
    technicalRecommendationAvailable: false,
    readableSubjectArtifacts: [],
    piRootBound: true,
    sourceReads: [{ source: 'ledger', status: 'available', capturedAt: AS_OF, scope: 'ledger entry' }],
    ...overrides,
  };
}

// ── Semantic Selector v0 golden samples (Phase 2 audit §13) ─────────────────

describe('Semantic Selector v0 — audit golden samples (§10.2)', () => {
  const HUMAN = '主任务未完成前不得推进次要议题：行动焦点必须锚定 Owner 明确表达的当前目标，仅在其被验证完成或被 Owner 明确放下后才可切换。';
  const ABSTRACT = "将'交付的定义必须内含主动验证'确立为跨场景交付类工作流（代码、文档、内容生产等）的原则：质量确认是执行者的自主职责，完成执行不等于验证成功，不得外置为对外部反馈的被动响应。具体'主动验证'形态需按领域重新定义。";
  const TRIGGER = '当上下文已包含"所有子代理已完成/settled"类信号时，拦截后续 sessions_yield 调用。';
  const MIXED = "将'源文件为准'确立为不可绕过的通用原则：任何跨会话/跨状态合并、同步或巡检动作，都必须以可观察的源对象（mtime+内容哈希）作为最终事实来源，禁止直接继承先前会话记忆或历史状态文件作为权威。";
  const IMPLEMENTATION = '读取 source-of-truth.json 的 mtime 与 MD5 值，与 CURRENT_STATE.md 记录比对，不一致时通过 pre_check hook 阻止提交。';

  it('whole-field qualification: human/abstract pass; trigger/mixed/implementation are rejected', () => {
    expect(isWholeFieldHumanReadable(HUMAN)).toBe(true);
    expect(isWholeFieldHumanReadable(ABSTRACT)).toBe(true);
    expect(isWholeFieldHumanReadable(TRIGGER)).toBe(false); // sessions_yield snake_case
    expect(isWholeFieldHumanReadable(MIXED)).toBe(false); // mtime + hash
    expect(isWholeFieldHumanReadable(IMPLEMENTATION)).toBe(false); // .json/.md/MD5/hook
  });

  it('tier order: scribe beats distiller beats philosopher beats candidate', () => {
    const result = selectLearnedPrincipleV0([
      { tier: 'candidate_principle', text: HUMAN, sourceVersion: 'cand' },
      { tier: 'distiller', text: ABSTRACT, sourceVersion: 'distiller' },
      { tier: 'scribe', text: '写入系统路径前必须确认目标不在系统保护目录。', sourceVersion: 'scribe-art' },
    ]);
    expect(result.status).toBe('known');
    if (result.status === 'known') expect(result.sourceTier).toBe('scribe');
  });

  it('implementation-heavy description with no qualified alternative → UNKNOWN', () => {
    const result = selectLearnedPrincipleV0([
      { tier: 'candidate_principle', text: IMPLEMENTATION, sourceVersion: 'cand' },
    ]);
    expect(result).toMatchObject({ status: 'unknown', reasonCode: 'only_technical_recommendation_available' });
  });

  it('implementation kind falls back to its own abstractedPrinciple when qualified', () => {
    const result = selectLearnedPrincipleV0([
      { tier: 'distiller', text: '修改状态类文件前必须核对真实来源。', sourceVersion: 'cand' },
      { tier: 'candidate_principle', text: IMPLEMENTATION, sourceVersion: 'cand' },
    ]);
    expect(result.status).toBe('known');
    if (result.status === 'known') {
      expect(result.sourceTier).toBe('distiller');
      expect(result.text).toBe('修改状态类文件前必须核对真实来源。');
    }
  });

  it('no sources → UNKNOWN with explicit reason', () => {
    expect(selectLearnedPrincipleV0([])).toMatchObject({ status: 'unknown', reasonCode: 'no_sources' });
  });
});

// ── Semantic Selector v1 — bounded verbatim extraction (Phase D, §10.3) ─────

describe('Semantic Selector v1 — bounded extraction golden samples', () => {
  it('extracts a verbatim standalone obligation sentence from a mixed field', () => {
    const mixedText = '说明：本原则由诊断于 2026-09-13 生成，依据 source-of-truth.json 的 mtime 比对。任何跨会话的合并动作都必须以可观察的源对象作为最终事实来源。';
    const sources = [{ tier: 'candidate_principle' as const, text: mixedText, sourceVersion: 'cand-mixed' }];
    const result = selectLearnedPrincipleV1(sources);
    expect(result.status).toBe('known');
    if (result.status === 'known') {
      expect(result.selectionMode).toBe('extracted_sentence');
      // Verbatim: the sentence appears in the source unchanged (no deletion,
      // no generalization — negations/conditions ride along by construction).
      expect(mixedText).toContain(result.text);
      expect(result.text).toBe('任何跨会话的合并动作都必须以可观察的源对象作为最终事实来源。');
      expect(result.text).not.toContain('mtime');
    }
  });

  it('audit MIXED sample stays UNKNOWN when every sentence carries technical residue', () => {
    const MIXED = "将'源文件为准'确立为不可绕过的通用原则：任何跨会话/跨状态合并、同步或巡检动作，都必须以可观察的源对象（mtime+内容哈希）作为最终事实来源，禁止直接继承先前会话记忆或历史状态文件作为权威。";
    expect(selectLearnedPrincipleV1([{ tier: 'candidate_principle', text: MIXED, sourceVersion: 'c' }]))
      .toMatchObject({ status: 'unknown' });
  });

  it('negations and conditions are preserved verbatim (no word deletion)', () => {
    const sentence = '在主任务未完成或未被明确放下之前，不得切换行动焦点。';
    const extracted = extractStandaloneBehaviorSentence([{
      tier: 'distiller',
      text: `背景补充：见 diagnosis_manual_1789317326914 记录。${sentence}`,
      sourceVersion: 'd',
    }]);
    expect(extracted).not.toBeNull();
    expect(extracted?.text).toBe(sentence);
  });

  it('single-sentence technical fields never gain extraction (no-op by design)', () => {
    const TECH = '读取 source-of-truth.json 的 mtime 与 MD5 值并比对。';
    expect(extractStandaloneBehaviorSentence([{ tier: 'distiller', text: TECH, sourceVersion: 'd' }])).toBeNull();
    expect(selectLearnedPrincipleV1([{ tier: 'distiller', text: TECH, sourceVersion: 'd' }]))
      .toMatchObject({ status: 'unknown' });
  });

  it('whole-field wins over extraction when both qualify', () => {
    const whole = '主任务未完成前不得推进次要议题。';
    const wholeResult = selectLearnedPrincipleV1([{ tier: 'candidate_principle', text: whole, sourceVersion: 'c' }]);
    // When the whole field qualifies, the result is whole_field — extraction
    // is only a fallback (checked directly; the mixed variant above covers
    // the extraction path).
    if (wholeResult.status === 'known') expect(wholeResult.selectionMode).toBe('whole_field');
  });

  it('Codex P2: splits English sentences on period+space+capital for extraction', () => {
    const enText = 'Generated from config.yaml diagnostics. Always ask the owner before deleting data.';
    const extracted = extractStandaloneBehaviorSentence([{ tier: 'distiller', text: enText, sourceVersion: 'd-en' }]);
    expect(extracted).not.toBeNull();
    expect(extracted?.text).toBe('Always ask the owner before deleting data.');
  });

  it('does not split decimals or lowercase continuations', () => {
    const text = 'The threshold is 3.5 units and must be respected.';
    expect(extractStandaloneBehaviorSentence([{ tier: 'distiller', text, sourceVersion: 'd' }])).toBeNull();
  });
});

// ── Codex P1: per-subject revision gating (scribe material never borrowed) ──

describe('deriveOwnerDecisionView — per-subject readable-material gate (Codex P1)', () => {
  const twoPending = facts({
    approvals: [
      {
        schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'apr-scribe' }, principleId: 'p1',
        artifactId: 'art-scribe', approvalId: 'apr-scribe', channel: 'prompt', outcome: 'pending',
        lineageConfidence: 'strong', recordedAt: '2026-09-18T09:00:00.000Z',
      },
      {
        schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'apr-unrelated' }, principleId: 'p1',
        artifactId: 'art-unrelated', approvalId: 'apr-unrelated', channel: 'prompt', outcome: 'pending',
        lineageConfidence: 'strong', recordedAt: '2026-09-18T09:30:00.000Z',
      },
    ],
  });

  function scribeInput(readableSubjectArtifacts: string[]) {
    return baseInputs({
      governance: twoPending,
      semanticSources: [
        { tier: 'scribe', text: '主任务未完成前不得推进次要议题。', sourceVersion: 'art-scribe' },
      ],
      readableSubjectArtifacts,
    });
  }

  it('a pending subject on an unrelated revision is NOT approvable via another revision scribe text', () => {
    const view = deriveOwnerDecisionView(scribeInput(['art-scribe']));
    const approveKeys = view.availableActions.filter((action) => action.semantic === 'approve').map((action) => action.key);
    expect(approveKeys).toContain('approve:apr-scribe');
    expect(approveKeys).not.toContain('approve:apr-unrelated');
    // The unrelated subject still exposes an independently safe reject.
    expect(view.availableActions.some((action) => action.key === 'reject:apr-unrelated')).toBe(true);
    // And the gate blocker names the revision-material reason.
    expect(view.blockers.some((blocker) => blocker.actionSemantic === 'approve' && blocker.subjectKey === 'apr-unrelated')).toBe(true);
  });

  it('a rule artifact whose lineage carries the scribe artifact stays approvable', () => {
    const view = deriveOwnerDecisionView(scribeInput(['art-scribe', 'art-unrelated']));
    const approveKeys = view.availableActions.filter((action) => action.semantic === 'approve').map((action) => action.key);
    expect(approveKeys).toContain('approve:apr-scribe');
    expect(approveKeys).toContain('approve:apr-unrelated');
  });

  it('distiller-tier material is candidate-wide (no per-subject restriction)', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      governance: twoPending,
      semanticSources: [{ tier: 'distiller', text: '修改状态类文件前必须核对真实来源。', sourceVersion: 'cand-1' }],
      readableSubjectArtifacts: [],
    }));
    const approveKeys = view.availableActions.filter((action) => action.semantic === 'approve').map((action) => action.key);
    expect(approveKeys).toContain('approve:apr-scribe');
    expect(approveKeys).toContain('approve:apr-unrelated');
  });
});

// ── T2 / CASE-A shape: lineage unavailable, diagnosis readable ──────────────

describe('deriveOwnerDecisionView — T2 (lineage unavailable ≠ no_action)', () => {
  const unboundFacts = facts({
    lineage: { principleId: 'p1', artifactIds: [], taskIds: [], revisionIdentities: [], confidence: 'unknown', sourceRefs: [{ type: 'principle', id: 'p1' }] },
    collectionIssues: [{ source: 'lineage', reasonCode: 'lineage_not_available', nextActionCode: 'wait_for_durable_lineage' }],
  });

  it('blocked (not no_action), with the diagnosis still displayed and labeled as PD interpretation', () => {
    const view = deriveOwnerDecisionView(baseInputs({ governance: unboundFacts, piRootBound: false }));
    expect(view.decisionState).toBe('blocked');
    expect(view.blockers.some((blocker) => blocker.reason.code === 'lineage_not_available')).toBe(true);
    expect(view.nextAction.ownerText).toContain('暂时无法');
    // The readable diagnosis survives — but as PD interpretation, not observed fact.
    expect(view.incidentSummary.status).toBe('known');
    if (view.incidentSummary.status === 'known') {
      expect(view.incidentSummary.value[0]?.text).toContain('PD 的事件概述');
      expect(view.incidentSummary.value[0]?.claimClass).toBe('pd_interpretation');
    }
    // Enforcement and rollback cannot claim "none" without complete binding.
    expect(view.currentEnforcement.status).toBe('unknown');
    expect(view.rollback.status).toBe('unknown');
    expect(view.availableActions.filter((action) => action.semantic === 'approve')).toHaveLength(0);
  });
});

// ── T1: candidate without pending approval ──────────────────────────────────

describe('deriveOwnerDecisionView — T1 (candidate ≠ waiting-for-owner-approval)', () => {
  it('bound lineage, no pending, no work → no_action and NO approve action', () => {
    const view = deriveOwnerDecisionView(baseInputs());
    expect(view.decisionState).toBe('no_action');
    expect(view.availableActions).toHaveLength(0);
    expect(view.nextAction.ownerText).toContain('目前没有需要你决定的事项');
  });

  it('bound lineage with running work → processing, no approve fabricated', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      governance: facts({ tasks: [task('task-1', 'leased', { leaseExpiresAt: '2026-09-18T11:00:00.000Z' })] }),
    }));
    expect(view.decisionState).toBe('processing');
    expect(view.availableActions.filter((action) => action.semantic === 'approve')).toHaveLength(0);
  });
});

// ── T5 + Material Gate: technical subject blocks approve, not reject ────────

describe('deriveOwnerDecisionView — T5 (Decision Material Gate)', () => {
  const pendingApproval = facts({
    approvals: [{
      schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'apr-1' }, principleId: 'p1',
      artifactId: 'artifact-1', approvalId: 'apr-1', channel: 'code_tool_hook', outcome: 'pending',
      lineageConfidence: 'strong', recordedAt: '2026-09-17T09:00:00.000Z',
    }],
  });

  it('pending subject with human-readable material → needs_owner_decision with approve AND reject', () => {
    const view = deriveOwnerDecisionView(baseInputs({ governance: pendingApproval }));
    expect(view.decisionState).toBe('needs_owner_decision');
    const semantics = view.availableActions.map((action) => action.semantic);
    expect(semantics).toContain('approve');
    expect(semantics).toContain('reject');
  });

  it('pending subject with ONLY technical text → blocked; approve absent, reject still independently available', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      governance: pendingApproval,
      ledger: {
        status: 'candidate', text: '读取 source-of-truth.json 的 mtime 与 MD5 值并比对。', evaluability: 'weak_heuristic',
        triggerPattern: '', action: '', derivedFromPainIds: ['cand-1'], ruleIds: [],
        createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
      },
      candidate: {
        candidateId: 'cand-1', status: 'consumed', recommendationKind: 'implementation',
        description: '读取 source-of-truth.json 的 mtime 与 MD5 值并比对。',
      },
      semanticSources: [
        { tier: 'candidate_principle', text: '读取 source-of-truth.json 的 mtime 与 MD5 值并比对。', sourceVersion: 'cand-1' },
      ],
      scribe: null,
    }));
    expect(view.decisionState).toBe('blocked');
    expect(view.learnedPrinciple.status).toBe('unknown');
    const approve = view.availableActions.filter((action) => action.semantic === 'approve');
    expect(approve).toHaveLength(0);
    const reject = view.availableActions.filter((action) => action.semantic === 'reject');
    expect(reject).toHaveLength(1);
    const gateBlocker = view.blockers.find((blocker) => blocker.actionSemantic === 'approve');
    expect(gateBlocker?.reason.ownerText).toContain('缺少足够的信息');
  });

  it('expected consequence is concrete per channel and never claims live execution', () => {
    const view = deriveOwnerDecisionView(baseInputs({ governance: pendingApproval }));
    const approve = view.availableActions.find((action) => action.semantic === 'approve');
    expect(approve).toBeDefined();
    if (approve?.expectedConsequence.status === 'known') {
      expect(approve.expectedConsequence.value[0]?.text).toContain('影子观察');
      expect(approve.expectedConsequence.value[0]?.text).not.toContain('立即拦截');
    }
  });
});

// ── T3 / CASE-B shape: decided + deactivated + historical effect + old task ─

describe('deriveOwnerDecisionView — T3 (CASE-B composite)', () => {
  const bFacts = facts({
    principle: { schemaVersion: '1', family: 'principle', sourceRef: { type: 'principle', id: 'p1' }, principleId: 'p1', lineageConfidence: 'strong', recordedAt: '2026-09-15T08:00:00.000Z', state: 'active' },
    approvals: [{
      schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'apr-b' }, principleId: 'p1',
      artifactId: 'artifact-1', approvalId: 'apr-b', channel: 'code_tool_hook', outcome: 'approved',
      lineageConfidence: 'strong', recordedAt: '2026-09-15T23:31:11.835Z', occurredAt: '2026-09-15T23:31:11.835Z',
    }],
    activations: [{
      schemaVersion: '1', family: 'activation', sourceRef: { type: 'activation', id: 'act-b' }, principleId: 'p1',
      artifactId: 'artifact-1', activationId: 'act-b', channel: 'code_tool_hook', outcome: 'deactivated',
      activatedAt: '2026-09-17T07:45:01.379Z', deactivatedAt: '2026-09-17T07:54:41.687Z',
      lineageConfidence: 'strong', recordedAt: '2026-09-17T07:54:41.687Z',
    }],
    tasks: [task('task-failed', 'failed')],
    timelineEvents: [],
  });

  it('shows approval history + deactivated enforcement + historical effect, without a generic do-not-approve', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      governance: bFacts,
      ledger: { ...baseInputs().ledger, status: 'active' },
      applications: {
        sourceStatus: 'available', deterministicCount: 1, selfReportedCount: 0, contextPresenceCount: 2,
        windowDays: 90,
        recent: [{ text: '一次确定性拦截记录', createdAt: '2026-09-16T00:00:00.000Z', level: 'effect' }],
      },
    }));

    // The approved subject is preserved as history.
    expect(view.decisionSubjects.some((subject) => subject.state === 'approved')).toBe(true);
    // Current enforcement shows deactivated — never "live".
    expect(view.currentEnforcement.status).toBe('known');
    if (view.currentEnforcement.status === 'known') {
      expect(view.currentEnforcement.value?.state).toBe('deactivated');
      expect(view.currentEnforcement.value?.items[0]?.active).toBe(false);
    }
    // Historical effect retained and NOT presented as current causation.
    expect(view.evidenceSummary.status).toBe('known');
    if (view.evidenceSummary.status === 'known') {
      expect(view.evidenceSummary.value?.observation.deterministicEffects).toMatchObject({ status: 'known', value: 1 });
    }
    // The old runtime issue surfaces with the honest, relevance-unconfirmed copy.
    const runtimeBlocker = view.blockers.find((blocker) => blocker.kind === 'runtime');
    expect(runtimeBlocker?.reason.ownerText).toContain('尚未确认');
    // No approve action is fabricated for an already-decided principle.
    expect(view.availableActions.filter((action) => action.semantic === 'approve')).toHaveLength(0);
    // No disable for the deactivated activation (§14).
    expect(view.availableActions.filter((action) => action.semantic === 'disable')).toHaveLength(0);
    // Rollback says: previously active, now deactivated — no stop action, no undo promise.
    expect(view.rollback.status).toBe('known');
    if (view.rollback.status === 'known') {
      expect(view.rollback.value?.stopFuture.status).toBe('not_applicable');
      expect(view.rollback.value?.undoPastExternalEffects.status).toBe('unknown');
    }
  });

  it('a REAL pending approval outranks the historical recovery item (no false do-not-approve)', () => {
    const withPending = facts({
      ...bFacts,
      approvals: [...bFacts.approvals ?? [], {
        schemaVersion: '1', family: 'approval', sourceRef: { type: 'approval', id: 'apr-new' }, principleId: 'p1',
        artifactId: 'artifact-2', approvalId: 'apr-new', channel: 'prompt', outcome: 'pending',
        lineageConfidence: 'strong', recordedAt: '2026-09-18T09:00:00.000Z',
      }],
      lineage: { ...bFacts.lineage, artifactIds: ['artifact-1', 'artifact-2'] },
    });
    const view = deriveOwnerDecisionView(baseInputs({ governance: withPending }));
    expect(view.decisionState).toBe('needs_owner_decision');
    expect(view.availableActions.some((action) => action.semantic === 'approve')).toBe(true);
  });
});

// ── T4 / CASE-C: coverage available + zero records + one reference ──────────

describe('deriveOwnerDecisionView — T4 (evidence dimensions stay separate)', () => {
  it('states all three facts explicitly; reference count is not behavior records', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      applications: { sourceStatus: 'available', deterministicCount: 0, selfReportedCount: 0, contextPresenceCount: 0, windowDays: 90, recent: [] },
      coverageSourceStatus: 'available',
    }));
    expect(view.evidenceSummary.status).toBe('known');
    if (view.evidenceSummary.status === 'known') {
      const evidence = view.evidenceSummary.value;
      expect(evidence).toBeDefined();
      expect(evidence?.ownerExplanation).toContain('当前保留窗口内没有行为记录');
      expect(evidence?.ownerExplanation).toContain('不能据此判断原则已经产生影响');
      expect(evidence?.ownerExplanation).toContain('来源引用 1 条');
      expect(evidence?.sourceAvailability).toMatchObject({ status: 'known', value: '行为记录来源可读取。' });
      expect(evidence?.retainedBehaviorCount).toMatchObject({ status: 'known', value: 0 });
      expect(evidence?.sourceReferenceCount).toMatchObject({ status: 'known', value: 1 });
      expect(evidence?.governanceLineage).toMatchObject({ status: 'known', value: '已建立' });
    }
  });
});

// ── T7: no activation → no generic rollback promise ─────────────────────────

describe('deriveOwnerDecisionView — T7 (rollback honesty)', () => {
  it('bound lineage with zero activations → stopFuture not_applicable, no "可回滚" claim', () => {
    const view = deriveOwnerDecisionView(baseInputs());
    expect(view.rollback.status).toBe('known');
    if (view.rollback.status === 'known') {
      expect(view.rollback.value?.stopFuture.status).toBe('not_applicable');
      expect(view.rollback.value?.ownerText).toContain('无需撤销');
    }
  });

  it('active activation → concrete disable capability with future-only scope', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      governance: facts({
        activations: [{
          schemaVersion: '1', family: 'activation', sourceRef: { type: 'activation', id: 'act-1' }, principleId: 'p1',
          artifactId: 'artifact-1', activationId: 'act-1', channel: 'code_tool_hook', outcome: 'active',
          activatedAt: '2026-09-17T07:45:01.379Z', lineageConfidence: 'strong', recordedAt: '2026-09-17T07:45:01.379Z',
        }],
      }),
    }));
    const disable = view.availableActions.find((action) => action.semantic === 'disable');
    expect(disable).toBeDefined();
    expect(disable?.confirmation.text).toContain('不会被撤回');
    if (view.rollback.status === 'known') {
      expect(view.rollback.value?.stopFuture.status).toBe('known');
      if (view.rollback.value?.stopFuture.status === 'known') {
        expect(view.rollback.value.stopFuture.value[0]?.text).toContain('今后的影响');
      }
    }
  });
});

// ── T9/T10: source semantics + evaluability label separation ────────────────

describe('deriveOwnerDecisionView — T9/T10 (labels and semantics)', () => {
  it('truncated diagnosis carries an explicit truncation warning', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      diagnosis: { artifactId: 'art-1', summary: '（部分）……', rootCause: 'x', evidenceItems: [], truncated: true },
    }));
    expect(view.uncertainty.status).toBe('known');
    if (view.uncertainty.status === 'known') {
      expect(view.uncertainty.value.some((item) => item.text.includes('截断'))).toBe(true);
    }
  });

  it('weak_heuristic evaluability is described as evaluability, never as low confidence', () => {
    const view = deriveOwnerDecisionView(baseInputs());
    if (view.uncertainty.status === 'known') {
      const evaluabilityNote = view.uncertainty.value.find((item) => item.text.includes('弱启发式'));
      expect(evaluabilityNote?.text).toContain('可评价性');
      expect(JSON.stringify(view)).not.toContain('置信度：低');
      expect(JSON.stringify(view)).not.toContain('confidence: low');
    }
  });

  it('source_read_status=complete never fabricates lineage completeness', () => {
    const view = deriveOwnerDecisionView(baseInputs({
      governance: facts({
        lineage: { principleId: 'p1', artifactIds: [], taskIds: [], revisionIdentities: [], confidence: 'unknown', sourceRefs: [{ type: 'principle', id: 'p1' }] },
        collectionIssues: [{ source: 'lineage', reasonCode: 'lineage_not_available', nextActionCode: 'wait_for_durable_lineage' }],
      }),
      piRootBound: false,
    }));
    expect(view.sourceReadStatus).toBe('complete'); // reads succeeded…
    expect(view.evidenceSummary.status === 'known'
      && view.evidenceSummary.value?.governanceLineage.status === 'known'
      && view.evidenceSummary.value.governanceLineage.value).toBe('未建立'); // …but lineage is honestly not established
  });
});
