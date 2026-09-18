/**
 * deriveOwnerDecisionView — Owner Decision Experience v1 (SPEC §§7–8, §13).
 *
 * Pure derivation from collected facts to the canonical Owner-facing
 * OwnerDecisionViewCore. The Console collector gathers facts (ledger,
 * GovernanceFacts, candidate/diagnosis/semantic sources, receipts coverage,
 * behavior applications); this module is the SINGLE Owner-facing derivation
 * boundary — the Console renders mechanically and mutation services remain
 * the final write authority.
 *
 * Non-negotiables encoded here:
 *   - F1: candidate ≠ waiting-for-owner-approval. Only concrete pending
 *     approval subjects (artifact+channel) create decision actions.
 *   - §8.1: unknown target/readable-subject/consequence blocks ordinary
 *     approve via the Decision Material Gate; reject is assessed separately.
 *   - §9.2: a readable diagnosis does NOT establish governance identity —
 *     lineage-unavailable principles are `blocked`, never `no_action`.
 *   - §13: old runtime frontier items never become a generic "do not
 *     approve"; they surface as relevance-unconfirmed historical issues.
 *   - §12: evidence dimensions stay separate (source availability ≠ record
 *     count ≠ lineage completeness ≠ promotion sufficiency).
 */
import { Value } from '@sinclair/typebox/value';
import { Type, type Static } from '@sinclair/typebox';
import { GovernanceFactsSchema } from '../governance-projection-contract.js';
import type { GovernanceFacts } from '../governance-projection-contract.js';
import { deriveOwnerGovernanceView } from '../governance-projection.js';
import { selectLearnedPrincipleV1, isWholeFieldHumanReadable } from './semantic-selector.js';
import type {
  Action, Blocker, DecisionMaterialGate, DecisionState, DecisionSubject,
  EnforcementItem, EnforcementSummary, EvidenceSummary, NarrativeField,
  NarrativeItem, NarrativeListField, NextAction, NumberField, OwnerDecisionViewCore,
  OwnerSourceRef, Reason, StringField,
} from './owner-decision-view-contract.js';
import { OwnerDecisionViewCoreSchema } from './owner-decision-view-contract.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Timestamp = GovernanceFactsSchema.properties.asOf;

// ── Input contract (gathered by the Console collector) ──────────────────────

export const OwnerDecisionCandidateSchema = Type.Object({
  candidateId: NonEmptyString,
  status: Type.String(),
  recommendationKind: Type.String(),
  description: Type.String(),
  abstractedPrinciple: Type.Optional(Type.String()),
  trigger: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
  sourceRef: Type.Optional(NonEmptyString),
});
export const OwnerDecisionDiagnosisSchema = Type.Object({
  artifactId: NonEmptyString,
  summary: Type.Optional(Type.String()),
  rootCause: Type.Optional(Type.String()),
  evidenceItems: Type.Array(Type.String()),
  diagnosisId: Type.Optional(NonEmptyString),
  sourceRunId: Type.Optional(NonEmptyString),
  truncated: Type.Boolean(),
});
export const OwnerDecisionScribeSchema = Type.Object({
  artifactId: NonEmptyString,
  statement: Type.Optional(Type.String()),
  rationale: Type.Optional(Type.String()),
  applicability: Type.Array(Type.String()),
  antiPatterns: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  targetBehavior: Type.Optional(Type.String()),
  updatedAt: Type.String(),
});
export const OwnerDecisionPhilosopherSchema = Type.Object({
  artifactId: NonEmptyString,
  title: Type.Optional(Type.String()),
  rationale: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
});
export const OwnerDecisionApplicationsSchema = Type.Object({
  sourceStatus: Type.Union([Type.Literal('available'), Type.Literal('disabled'), Type.Literal('unavailable')]),
  deterministicCount: Type.Integer({ minimum: 0 }),
  selfReportedCount: Type.Integer({ minimum: 0 }),
  contextPresenceCount: Type.Integer({ minimum: 0 }),
  windowDays: Type.Integer({ minimum: 0 }),
  recent: Type.Array(Type.Object({
    text: Type.String(),
    createdAt: Type.Optional(Type.String()),
    level: Type.String(),
  })),
});
export const OwnerDecisionInputsSchema = Type.Object({
  schemaVersion: Type.Literal('1'),
  principleId: NonEmptyString,
  asOf: Timestamp,
  ledger: Type.Object({
    status: NonEmptyString,
    text: Type.String(),
    evaluability: Type.String(),
    triggerPattern: Type.String(),
    action: Type.String(),
    derivedFromPainIds: Type.Array(NonEmptyString),
    ruleIds: Type.Array(NonEmptyString),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  }),
  governance: GovernanceFactsSchema,
  candidate: Type.Union([OwnerDecisionCandidateSchema, Type.Null()]),
  diagnosis: Type.Union([OwnerDecisionDiagnosisSchema, Type.Null()]),
  scribe: Type.Union([OwnerDecisionScribeSchema, Type.Null()]),
  philosopher: Type.Union([OwnerDecisionPhilosopherSchema, Type.Null()]),
  applications: Type.Union([OwnerDecisionApplicationsSchema, Type.Null()]),
  coverageSourceStatus: Type.Union([
    Type.Literal('available'), Type.Literal('disabled'), Type.Literal('unavailable'),
  ]),
  /** Lineage-constrained, pre-ordered semantic sources for this principle. */
  semanticSources: Type.Array(Type.Object({
    tier: Type.Union([
      Type.Literal('scribe'), Type.Literal('distiller'),
      Type.Literal('philosopher'), Type.Literal('candidate_principle'),
    ]),
    text: Type.String(),
    sourceVersion: NonEmptyString,
  })),
  /**
   * True when a diagnostic recommendation exists but was withheld from
   * semanticSources by the kind policy (rule/implementation/prompt originals
   * never surface as human principles, §10.3). Drives the honest UNKNOWN
   * reason ("technical recommendation exists, readable principle does not")
   * instead of a misleading "no sources".
   */
  technicalRecommendationAvailable: Type.Boolean(),
  /**
   * Codex review P1 fix (per-subject revision gating, SPEC §8.1/§10.2): when
   * the selected learned principle comes from a SCRIBE artifact, only pending
   * subjects whose artifact IS that scribe artifact (text path) or carries it
   * in its lineage closure (rule path) may rely on that text. Subjects on
   * unrelated revisions must not be approved using another revision's
   * readable material. Empty/omitted + non-scribe tier = material is
   * candidate-wide and applies to every subject.
   */
  readableSubjectArtifacts: Type.Array(NonEmptyString),
  /** True iff ≥1 pi_artifacts row carries source_principle_id = this principle. */
  piRootBound: Type.Boolean(),
  sourceReads: Type.Array(Type.Object({
    source: NonEmptyString,
    status: Type.Union([
      Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('not_requested'),
    ]),
    capturedAt: Timestamp,
    scope: NonEmptyString,
    reason: Type.Optional(NonEmptyString),
  })),
});
export type OwnerDecisionInputs = Static<typeof OwnerDecisionInputsSchema>;

// ── small builders ──────────────────────────────────────────────────────────

function ref(input: {
  kind: OwnerSourceRef['kind']; id: string; fieldPath: string;
  relation: OwnerSourceRef['relation']; claimClass: OwnerSourceRef['claimClass'];
  producer: OwnerSourceRef['producer']; capturedAt: string;
  recordedAt?: string; truncated?: boolean;
}): OwnerSourceRef {
  return {
    kind: input.kind, id: input.id, fieldPath: input.fieldPath,
    relation: input.relation, claimClass: input.claimClass, producer: input.producer,
    capturedAt: input.capturedAt,
    ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
    truncated: input.truncated ?? false,
  };
}

function reason(code: string, ownerText: string, sourceRefs: OwnerSourceRef[] = []): Reason {
  return { code, ownerText, sourceRefs };
}

function knownNarrative(items: NarrativeItem[], provenance: OwnerSourceRef[], warnings: Reason[] = []): NarrativeField {
  return { status: 'known', value: items, provenance, warnings };
}

function unknownField(code: string, ownerText: string, provenance: OwnerSourceRef[] = []): NarrativeField {
  return { status: 'unknown', reason: reason(code, ownerText, provenance), provenance };
}

function knownString(value: string, provenance: OwnerSourceRef[]): StringField {
  return { status: 'known', value, provenance, warnings: [] };
}

function knownNumber(value: number, provenance: OwnerSourceRef[]): NumberField {
  return { status: 'known', value, provenance, warnings: [] };
}

function unknownNumber(code: string, ownerText: string, provenance: OwnerSourceRef[] = []): NumberField {
  return { status: 'unknown', reason: reason(code, ownerText, provenance), provenance };
}

function narrativeItem(text: string, claimClass: NarrativeItem['claimClass'], sourceRefs: OwnerSourceRef[]): NarrativeItem {
  return { text, claimClass, sourceRefs };
}

// ── enforcement folding (mirrors governance-projection foldActivations) ─────

function foldGovernanceActivations(facts: GovernanceFacts) {
  const groups = new Map<string, GovernanceFacts['activations']>();
  for (const row of facts.activations.filter((item) => item.lineageConfidence === 'strong')) {
    const key = `${row.artifactId}:${row.channel}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => [...group]
    .sort((a, b) => a.activatedAt.localeCompare(b.activatedAt) || a.activationId.localeCompare(b.activationId))
    .at(-1))
    .filter((row): row is GovernanceFacts['activations'][number] => row !== undefined);
}

// ── approval subject folding (artifact+channel latest, SPEC §8.1) ──────────

interface FoldedSubject {
  artifactId: string;
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive';
  approvalId: string;
  outcome: 'pending' | 'approved' | 'rejected' | 'cancelled';
  recordedAt: string;
  sourceRefId: string;
}

function foldApprovalSubjects(facts: GovernanceFacts): FoldedSubject[] {
  const groups = new Map<string, GovernanceFacts['approvals']>();
  for (const approval of facts.approvals) {
    if (approval.lineageConfidence !== 'strong') continue;
    const key = `${approval.artifactId}:${approval.channel}`;
    groups.set(key, [...(groups.get(key) ?? []), approval]);
  }
  const subjects: FoldedSubject[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.approvalId.localeCompare(b.approvalId));
    const latest = sorted.at(-1);
    if (latest === undefined) continue;
    subjects.push({
      artifactId: latest.artifactId,
      channel: latest.channel,
      approvalId: latest.approvalId,
      outcome: latest.outcome,
      recordedAt: latest.recordedAt,
      sourceRefId: latest.sourceRef.id,
    });
  }
  return subjects;
}

// ── main derivation ─────────────────────────────────────────────────────────

export function deriveOwnerDecisionView(rawInput: unknown): OwnerDecisionViewCore {
  if (!Value.Check(OwnerDecisionInputsSchema, rawInput)) {
    throw new Error('invalid_owner_decision_inputs');
  }
  const input = rawInput;
  const { principleId, asOf, governance } = input;
  const capturedAt = asOf;
  // The existing projection remains the attention/automation authority — this
  // derivation consumes it (one algorithm, no second truth for recovery items).
  const ownerGovernanceView = deriveOwnerGovernanceView(governance);

  const ledgerRef = ref({
    kind: 'ledger', id: principleId, fieldPath: '_tree.principles.<id>',
    relation: 'exact_id', claimClass: 'system_state',
    producer: { status: 'known', value: 'candidate-intake-ledger' }, capturedAt,
    recordedAt: input.ledger.updatedAt,
  });

  const lineageAvailable = governance.lineage.confidence !== 'unknown';
  const lineageNotAvailableIssue = governance.collectionIssues.find((issue) => issue.reasonCode === 'lineage_not_available');
  const sourceReadStatus = input.sourceReads.some((read) => read.status === 'unavailable')
    ? ('partial' as const)
    : ('complete' as const);

  // ── incident_summary (§7.5: diagnosis summary is PD's interpretation) ────
  let incidentSummary: NarrativeField;
  if (input.diagnosis !== null && input.diagnosis.summary !== undefined && input.diagnosis.summary.trim() !== '') {
    const diagRef = ref({
      kind: 'generic_artifact', id: input.diagnosis.artifactId, fieldPath: 'contentJson.summary',
      relation: input.candidate?.sourceRef === input.diagnosis.artifactId ? 'exact_id' : 'derived_relation',
      claimClass: 'pd_interpretation',
      producer: { status: 'known', value: 'diagnostician' }, capturedAt,
    });
    incidentSummary = knownNarrative(
      [narrativeItem(`【PD 的事件概述】${input.diagnosis.summary.trim()}`, 'pd_interpretation', [diagRef])],
      [diagRef],
      input.diagnosis.truncated ? [reason('diagnosis_truncated', '诊断原文包含截断标记，事件经过未完整核验。', [diagRef])] : [],
    );
  } else {
    incidentSummary = unknownField(
      'incident_summary_unavailable',
      input.diagnosis === null
        ? '暂无法读取这条原则对应的事件经过（诊断来源缺失或不可读）。'
        : '诊断来源存在，但没有可用的事件摘要。',
      [ledgerRef],
    );
  }

  // ── learned_principle (Semantic Selector v0) ─────────────────────────────
  // Semantic Selector v1 (Phase D): whole-field first, bounded verbatim
  // sentence extraction as the only fallback (SPEC §10.3 — no rewriting).
  const selection = selectLearnedPrincipleV1(input.semanticSources);
  const learnedPrinciple: OwnerDecisionViewCore['learnedPrinciple'] = selection.status === 'known'
    ? {
        status: 'known',
        value: {
          text: selection.text,
          sourceTier: selection.sourceTier,
          selectionMode: selection.selectionMode,
          selectionReason: selection.selectionReason,
          sourceVersion: selection.sourceVersion,
        },
        provenance: [ref({
          kind: selection.sourceTier === 'scribe' || selection.sourceTier === 'philosopher' ? 'pi_artifact' : 'candidate',
          id: selection.sourceVersion, fieldPath: selection.sourceTier === 'scribe' ? 'principleDraft.statement' : 'abstracted_principle',
          relation: 'exact_id', claimClass: 'proposed_behavior',
          producer: { status: 'known', value: selection.sourceTier }, capturedAt,
        })],
        warnings: [],
      }
    : {
        status: 'unknown',
        reason: reason(
          selection.reasonCode === 'no_sources' && input.technicalRecommendationAvailable
            ? 'only_technical_recommendation_available'
            : selection.reasonCode,
          selection.reasonCode === 'no_sources' && input.technicalRecommendationAvailable
            ? '这项提案已有技术建议，但可读的行为准则暂缺。'
            : selection.reasonText,
          [ledgerRef],
        ),
        provenance: [ledgerRef],
      };

  // ── rationale (scribe rationale → diagnosis rootCause, both if present) ──
  const rationaleItems: NarrativeItem[] = [];
  const rationaleRefs: OwnerSourceRef[] = [];
  if (input.scribe?.rationale !== undefined && input.scribe.rationale.trim() !== '') {
    const scribeRef = ref({
      kind: 'pi_artifact', id: input.scribe.artifactId, fieldPath: 'principleDraft.rationale',
      relation: 'exact_id', claimClass: 'pd_interpretation',
      producer: { status: 'known', value: 'scribe' }, capturedAt,
      recordedAt: input.scribe.updatedAt,
    });
    rationaleItems.push(narrativeItem(`【正式草案理由】${input.scribe.rationale.trim()}`, 'pd_interpretation', [scribeRef]));
    rationaleRefs.push(scribeRef);
  }
  if (input.diagnosis?.rootCause !== undefined && input.diagnosis.rootCause.trim() !== '') {
    const diagRef = ref({
      kind: 'generic_artifact', id: input.diagnosis.artifactId, fieldPath: 'contentJson.rootCause',
      relation: 'derived_relation', claimClass: 'pd_interpretation',
      producer: { status: 'known', value: 'diagnostician' }, capturedAt,
    });
    rationaleItems.push(narrativeItem(`【诊断归因】${input.diagnosis.rootCause.trim()}`, 'pd_interpretation', [diagRef]));
    rationaleRefs.push(diagRef);
  }
  const rationale = rationaleItems.length > 0
    ? knownNarrative(rationaleItems, rationaleRefs)
    : unknownField('rationale_unavailable', '暂无法说明 PD 形成这条判断的理由。', [ledgerRef]);

  // ── applicability / non-applicability ────────────────────────────────────
  const applicabilityQualified = (input.scribe?.applicability ?? [])
    .filter((item) => isWholeFieldHumanReadable(item));
  const scribeRefFor = (fieldPath: string): OwnerSourceRef => ref({
    kind: 'pi_artifact', id: input.scribe?.artifactId ?? 'unknown', fieldPath,
    relation: input.scribe === null ? 'unknown' : 'exact_id', claimClass: 'pd_interpretation',
    producer: input.scribe === null ? { status: 'unknown', reasonCode: 'scribe_artifact_absent' } : { status: 'known', value: 'scribe' },
    capturedAt,
  });
  const applicability: NarrativeListField = input.scribe !== null && applicabilityQualified.length > 0
    ? knownNarrative(
        applicabilityQualified.map((item) => narrativeItem(item, 'pd_interpretation', [scribeRefFor('principleDraft.applicability')])),
        [scribeRefFor('principleDraft.applicability')],
      )
    : unknownField(
        'applicability_unavailable',
        '尚未记录这条准则的明确适用条件（触发条件多为技术配置，保留在技术详情中）。',
        [ledgerRef],
      );
  // antiPatterns are NOT exceptions (SPEC §10.3); explicit exceptions must be
  // explicitly written — v0 has no reliable source, so UNKNOWN.
  const nonApplicability = unknownField(
    'non_applicability_unavailable',
    '尚未记录明确的例外或不适用范围。',
    input.scribe === null ? [ledgerRef] : [scribeRefFor('risks')],
  );

  // ── expected_behavior (proposal ≠ current execution) ─────────────────────
  const behaviorRefs: OwnerSourceRef[] = [];
  const behaviorItems: NarrativeItem[] = [];
  if (input.scribe?.targetBehavior !== undefined && input.scribe.targetBehavior.trim() !== '') {
    const scribeBehaviorRef = scribeRefFor('intentContract.targetBehavior');
    behaviorItems.push(narrativeItem(`【拟议行为】${input.scribe.targetBehavior.trim()}`, 'proposed_behavior', [scribeBehaviorRef]));
    behaviorRefs.push(scribeBehaviorRef);
  } else if (input.ledger.action !== undefined && input.ledger.action.trim() !== '' && isWholeFieldHumanReadable(input.ledger.action)) {
    const actionRef = ref({
      kind: 'ledger', id: principleId, fieldPath: 'action', relation: 'exact_id',
      claimClass: 'proposed_behavior', producer: { status: 'unknown', reasonCode: 'ledger_action_producer_unverified' }, capturedAt,
    });
    behaviorItems.push(narrativeItem(`【未部署建议】${input.ledger.action.trim()}`, 'proposed_behavior', [actionRef]));
    behaviorRefs.push(actionRef);
  }
  const expectedBehavior = behaviorItems.length > 0
    ? knownNarrative(behaviorItems, behaviorRefs)
    : unknownField('expected_behavior_unavailable', '尚未记录批准后 Agent 应当如何行动的可读说明。', [ledgerRef]);

  // ── current_enforcement (§7.5: unknown unless binding/query complete) ────
  const foldedActivations = foldGovernanceActivations(governance);
  const currentEnforcement: OwnerDecisionViewCore['currentEnforcement'] = lineageAvailable
    ? (() => {
        const items: EnforcementItem[] = foldedActivations.map((row) => {
          const enforcementRef = ref({
            kind: 'activation', id: row.activationId, fieldPath: 'activations.row', relation: 'exact_id',
            claimClass: 'system_state', producer: { status: 'known', value: 'activation-store' }, capturedAt,
            recordedAt: row.activatedAt,
          });
          return {
            activationRef: enforcementRef,
            artifactRef: ref({
              kind: 'pi_artifact', id: row.artifactId, fieldPath: 'source_principle_id', relation: 'exact_id',
              claimClass: 'system_state', producer: { status: 'known', value: 'pi-artifact-store' }, capturedAt,
            }),
            channel: row.channel,
            effectKind: row.channel === 'prompt' ? 'context_guidance' : row.channel === 'code_tool_hook' ? 'runtime_rule' : 'non_enforcing_outcome',
            mode: knownString(row.channel === 'code_tool_hook' ? 'RuleCode 执行' : row.channel === 'prompt' ? '上下文提示' : '归档', [enforcementRef]),
            active: row.deactivatedAt === undefined,
            since: knownString(row.activatedAt, [enforcementRef]),
          };
        });
        const activeCount = items.filter((item) => item.active).length;
        const state: EnforcementSummary['state'] = items.length === 0
          ? 'none'
          : activeCount === items.length ? 'active' : activeCount > 0 ? 'partially_active' : 'deactivated';
        return { status: 'known' as const, value: { state, items }, provenance: items.map((item) => item.activationRef), warnings: [] };
      })()
    : {
        status: 'unknown' as const,
        reason: reason('enforcement_binding_unknown', '治理身份尚未建立，无法确认这条原则当前是否有正在执行的生效方式。', [ledgerRef]),
        provenance: [ledgerRef],
        warnings: [],
      };

  // ── evidence_summary (five separate dimensions, §12) ─────────────────────
  const applicationRef = ref({
    kind: 'application', id: principleId, fieldPath: 'principle_applications', relation: 'exact_id',
    claimClass: 'observed_fact', producer: { status: 'known', value: 'principle-application-ledger' }, capturedAt,
  });
  const coverageRef = ref({
    kind: 'evidence_snapshot', id: principleId, fieldPath: 'receipt-coverage', relation: 'derived_relation',
    claimClass: 'system_state', producer: { status: 'known', value: 'receipt-coverage-reader' }, capturedAt,
  });
  const availabilityText = input.coverageSourceStatus === 'available'
    ? '行为记录来源可读取。'
    : input.coverageSourceStatus === 'disabled'
      ? '行为记录采集当前处于关闭状态。'
      : '行为记录来源当前不可读取。';
  const evidenceValue: EvidenceSummary = (() => {
    const apps = input.applications;
    const retained = apps === null ? null : apps.deterministicCount + apps.selfReportedCount + apps.contextPresenceCount;
    const explanationParts: string[] = [];
    if (apps !== null && retained === 0) {
      explanationParts.push('行为记录来源可读取；当前保留窗口内没有行为记录。不能据此判断原则已经产生影响。');
    } else if (apps !== null && retained !== null) {
      explanationParts.push(`当前保留窗口内有 ${retained} 条行为相关记录（确定性干预 ${apps.deterministicCount}、自述遵循 ${apps.selfReportedCount}、上下文出现 ${apps.contextPresenceCount}）。数字代表当前保留的证据，不是完整历史。`);
    }
    explanationParts.push(`来源引用 ${input.ledger.derivedFromPainIds.length} 条（当前指向诊断候选记录，非行为证据行数）。`);
    explanationParts.push(input.piRootBound
      ? '治理关联已建立（原则工件与审批/执行链路相连）。'
      : '诊断来源存在，但用于判断审批状态的治理关联尚未建立。');
    return {
      ownerExplanation: explanationParts.join(''),
      sourceAvailability: knownString(availabilityText, [coverageRef]),
      retainedBehaviorCount: apps === null || retained === null
        ? unknownNumber('applications_unavailable', '行为记录数据暂不可读取。', [applicationRef])
        : knownNumber(retained, [applicationRef]),
      sourceReferenceCount: knownNumber(input.ledger.derivedFromPainIds.length, [ledgerRef]),
      governanceLineage: knownString(input.piRootBound ? '已建立' : '未建立', [ledgerRef]),
      promotionSufficiency: knownString('未评估（仅在实际启用正式执行的决策中读取）', [ledgerRef]),
      observation: {
        deterministicEffects: apps === null ? unknownNumber('applications_unavailable', '暂不可读。', [applicationRef]) : knownNumber(apps.deterministicCount, [applicationRef]),
        selfReportedEffects: apps === null ? unknownNumber('applications_unavailable', '暂不可读。', [applicationRef]) : knownNumber(apps.selfReportedCount, [applicationRef]),
        contextPresence: apps === null ? unknownNumber('applications_unavailable', '暂不可读。', [applicationRef]) : knownNumber(apps.contextPresenceCount, [applicationRef]),
        window: knownString(`${input.applications?.windowDays ?? 0} 天保留窗口`, [applicationRef]),
        recentExamples: (apps?.recent ?? []).slice(0, 5).map((row) => narrativeItem(
          row.text,
          'observed_fact',
          [ref({
            kind: 'application', id: `${principleId}:${row.createdAt ?? ''}`, fieldPath: 'recent', relation: 'exact_id',
            claimClass: 'observed_fact', producer: { status: 'known', value: 'principle-application-ledger' }, capturedAt,
            recordedAt: row.createdAt,
          })],
        )),
      },
    };
  })();
  const evidenceSummary: OwnerDecisionViewCore['evidenceSummary'] = input.applications === null && input.coverageSourceStatus === 'unavailable'
    ? { status: 'unknown', reason: reason('evidence_sources_unavailable', '证据相关来源当前不可读取。', [coverageRef]), provenance: [coverageRef], warnings: [] }
    : { status: 'known', value: evidenceValue, provenance: [coverageRef, applicationRef, ledgerRef], warnings: [] };

  // ── uncertainty ──────────────────────────────────────────────────────────
  const uncertaintyItems: NarrativeItem[] = [];
  if (lineageNotAvailableIssue !== undefined) {
    uncertaintyItems.push(narrativeItem('治理身份尚未建立：这条原则与正式治理链路（审批/执行）的关联暂时无法确认。', 'system_state', [ledgerRef]));
  }
  if (input.diagnosis?.truncated === true) {
    uncertaintyItems.push(narrativeItem('原始事件文本包含截断标记，经过未完整核验。', 'observed_fact', [ledgerRef]));
  }
  if (input.ledger.evaluability === 'weak_heuristic') {
    uncertaintyItems.push(narrativeItem('这条准则目前主要依赖行为观察来评估（可评价性：弱启发式）。', 'system_state', [ledgerRef]));
  }
  const recoveryAttention = ownerGovernanceView.attention.items.filter((item) => item.kind === 'recovery');
  for (const item of recoveryAttention) {
    // §13: relevance to current actions is NOT confirmed — honest copy only.
    uncertaintyItems.push(narrativeItem('存在历史处理问题（如失败或等待重试的任务），其与当前操作的关系尚未确认。', 'system_state', [
      ref({ kind: 'task', id: item.sourceRef.id, fieldPath: 'tasks.status', relation: 'exact_id', claimClass: 'system_state', producer: { status: 'known', value: 'runtime-task-store' }, capturedAt }),
    ]));
  }
  const uncertainty: NarrativeListField = knownNarrative(uncertaintyItems, [ledgerRef]);

  // ── risk ─────────────────────────────────────────────────────────────────
  const risk: OwnerDecisionViewCore['risk'] = input.scribe !== null
    ? {
        status: 'known',
        value: {
          items: input.scribe.risks
            .filter((item) => item.trim() !== '')
            .map((item) => narrativeItem(item, 'pd_interpretation', [scribeRefFor('risks')])),
          completeness: 'partial',
        },
        provenance: [scribeRefFor('risks')],
        warnings: input.scribe.risks.length === 0
          ? [reason('risks_not_assessed', '尚未对这条准则做过风险评估；这不代表没有风险。', [scribeRefFor('risks')])]
          : [],
      }
    : { status: 'unknown', reason: reason('risk_unavailable', '暂无这条准则的风险记录。这不代表没有风险。', [ledgerRef]), provenance: [ledgerRef], warnings: [] };

  // ── rollback (§14: capability-proven, per activation) ────────────────────
  const rollback: OwnerDecisionViewCore['rollback'] = (() => {
    if (!lineageAvailable) {
      return {
        status: 'unknown' as const,
        reason: reason('rollback_binding_unknown', '治理关联尚未建立，无法确认是否存在可以停止的执行对象。', [ledgerRef]),
        provenance: [ledgerRef], warnings: [],
      };
    }
    const activeRows = foldedActivations.filter((row) => row.deactivatedAt === undefined);
    const deactivatedRows = foldedActivations.filter((row) => row.deactivatedAt !== undefined);
    const stopFuture: NarrativeListField = activeRows.length > 0
      ? knownNarrative(activeRows.map((row) => narrativeItem(
          `可通过「停止此执行方式」停止 ${row.channel === 'code_tool_hook' ? 'RuleCode 运行拦截' : row.channel === 'prompt' ? '上下文提示' : '归档通道'} 今后的影响（执行对象 ${row.activationId}）。该操作只停止后续影响，不撤回已发生的外部效果。`,
          'system_state',
          [ref({ kind: 'activation', id: row.activationId, fieldPath: 'deactivated_at', relation: 'exact_id', claimClass: 'system_state', producer: { status: 'known', value: 'activation-store' }, capturedAt })],
        )), [ledgerRef])
      : {
          status: 'not_applicable' as const,
          reason: reason('no_active_enforcement', deactivatedRows.length > 0 ? '当前没有正在执行的生效方式（此前的执行方式已停用）。' : '当前没有可停止的执行对象（这条原则尚未进入任何执行通道）。', [ledgerRef]),
          provenance: [ledgerRef],
        };
    const ownerText = activeRows.length > 0
      ? '可以停止未来的影响；无法撤回已经发生的外部效果。'
      : deactivatedRows.length > 0
        ? '此前的执行方式已停用；当前没有需要停止的执行对象。'
        : '这条原则当前没有生效中的执行对象，无需撤销。';
    return {
      status: 'known' as const,
      value: {
        stopFuture,
        restoreConfiguration: unknownField('restore_capability_unverified', '没有已验证的配置恢复服务；不承诺恢复到先前版本。', [ledgerRef]),
        undoPastExternalEffects: unknownField('compensation_capability_unverified', '未验证可撤回已发生外部效果的能力；不提供通用承诺。', [ledgerRef]),
        ownerText,
      },
      provenance: [ledgerRef], warnings: [],
    };
  })();

  // ── Decision subjects + Material Gates + Actions (§7.4, §8) ─────────────
  const foldedSubjects = foldApprovalSubjects(governance);
  const pendingSubjects = foldedSubjects.filter((row) => row.outcome === 'pending');

  function approveConsequenceText(channel: FoldedSubject['channel']): string {
    if (channel === 'prompt') return '批准后，这条行为准则将进入 Agent 的上下文提示（prompt 通道）。它影响后续对话中的行为倾向，不构成运行时强制拦截。';
    if (channel === 'code_tool_hook') return '批准后，将进入 RuleCode 影子观察流程；是否正式启用运行拦截属于另一个独立决定（需要通过准备度检查）。';
    return '批准后，该提案将通过归档通道处理，不会主动执行任何行为变更。';
  }

  const decisionSubjects: DecisionSubject[] = foldedSubjects.map((row) => {
    const approvalRef = ref({
      kind: 'approval', id: row.approvalId, fieldPath: 'approvals.status', relation: 'exact_id',
      claimClass: 'system_state', producer: { status: 'known', value: 'approval-queue-store' }, capturedAt,
      recordedAt: row.recordedAt,
    });
    const artifactRef = ref({
      kind: 'pi_artifact', id: row.artifactId, fieldPath: 'artifact_id', relation: 'exact_id',
      claimClass: 'system_state', producer: { status: 'known', value: 'pi-artifact-store' }, capturedAt,
    });
    // Codex review P1 fix: human-readable material is per-subject when it
    // comes from a SCRIBE artifact — an unrelated revision's pending subject
    // must not be approvable using another revision's readable text
    // (SPEC §10.2: different artifact branches each show their own material).
    const subjectReadableSatisfied = learnedPrinciple.status === 'known'
      && (learnedPrinciple.status !== 'known'
        || learnedPrinciple.value.sourceTier !== 'scribe'
        || input.readableSubjectArtifacts.includes(row.artifactId));
    const subjectBlockerText = learnedPrinciple.status !== 'known'
      ? '缺少可读的行为准则：目前只有技术建议，无法呈现为可理解的批准对象。'
      : '该待批对象所属修订没有自己的可读行为准则材料（不能借用其他修订的文本作为批准依据）。';
    // §7.4 item 3: the approve consequence is CHANNEL-level ("批准以后这个
    // subject 会发生什么") — derivable from the subject's real channel
    // semantics, never "批准=已 live". The principle-level proposed behavior
    // is a separate field (expectedBehavior) and does not gate this item.
    const approveGate: DecisionMaterialGate = {
      actionSemantic: 'approve',
      status: subjectReadableSatisfied ? 'ready' : 'blocked',
      requiredItems: [
        {
          key: 'target_identity',
          status: 'satisfied',
          ownerText: `将要批准的对象：审批记录 ${row.approvalId}（工件 ${row.artifactId}，通道 ${row.channel}）。`,
          sourceRefs: [approvalRef, artifactRef],
        },
        {
          key: 'human_readable_subject',
          status: subjectReadableSatisfied ? 'satisfied' : 'missing',
          ownerText: subjectReadableSatisfied
            ? '已具备可读的行为准则说明。'
            : subjectBlockerText,
          sourceRefs: [ledgerRef],
        },
        {
          key: 'expected_consequence',
          status: 'satisfied',
          ownerText: approveConsequenceText(row.channel),
          sourceRefs: [approvalRef, artifactRef],
        },
        {
          key: 'current_revision',
          status: 'satisfied',
          ownerText: `当前目标版本：${row.artifactId}`,
          sourceRefs: [artifactRef],
        },
      ],
    };
    const rejectGate: DecisionMaterialGate = {
      actionSemantic: 'reject',
      status: 'ready',
      requiredItems: [
        {
          key: 'target_identity',
          status: 'satisfied',
          ownerText: `将要拒绝的对象：审批记录 ${row.approvalId}（工件 ${row.artifactId}，通道 ${row.channel}）。`,
          sourceRefs: [approvalRef, artifactRef],
        },
        {
          key: 'expected_consequence',
          status: 'satisfied',
          ownerText: '拒绝后，这个提案不会进入执行；已产生的诊断和工件记录会保留。',
          sourceRefs: [approvalRef],
        },
      ],
    };
    return {
      key: row.approvalId,
      targetRefs: [approvalRef, artifactRef],
      channel: row.channel,
      revisionArtifactId: knownString(row.artifactId, [artifactRef]),
      state: row.outcome,
      reason: reason(
        'approval_subject_state',
        row.outcome === 'pending' ? '该对象存在待处理审批。' : `该对象的最近审批结果为 ${row.outcome}。`,
        [approvalRef],
      ),
      materialGates: [approveGate, rejectGate],
    };
  });

  const availableActions: Action[] = [];
  for (const subject of pendingSubjects) {
    const subjectFull = decisionSubjects.find((row) => row.key === subject.approvalId);
    if (subjectFull === undefined) continue;
    const approveGate = subjectFull.materialGates.find((gate) => gate.actionSemantic === 'approve');
    if (approveGate?.status === 'ready') {
      const consequenceItems = [narrativeItem(approveConsequenceText(subject.channel), 'system_state', subjectFull.targetRefs)];
      if (expectedBehavior.status === 'known') {
        consequenceItems.push(...expectedBehavior.value);
      }
      availableActions.push({
        key: `approve:${subject.approvalId}`,
        semantic: 'approve',
        label: '批准',
        targetRefs: subjectFull.targetRefs,
        serviceOperation: 'POST /api/v1/approvals/:id/approve',
        channel: subject.channel,
        assessedAt: capturedAt,
        requirements: [{ name: 'note', ownerText: '可以附加备注（可选）。', required: false }],
        expectedConsequence: knownNarrative(consequenceItems, subjectFull.targetRefs),
        confirmation: { required: true, text: `确认批准该对象？${approveConsequenceText(subject.channel)}` },
        sourceRefs: subjectFull.targetRefs,
      });
    }
    // reject is assessed independently (SPEC §7.4): a safe rejection needs only
    // the concrete target, not the readable-subject material approve needs.
    availableActions.push({
      key: `reject:${subject.approvalId}`,
      semantic: 'reject',
      label: '拒绝',
      targetRefs: subjectFull.targetRefs,
      serviceOperation: 'POST /api/v1/approvals/:id/reject',
      channel: subject.channel,
      assessedAt: capturedAt,
      requirements: [{ name: 'reason', ownerText: '需要填写拒绝原因。', required: true }],
      expectedConsequence: knownNarrative([narrativeItem('拒绝后，这个提案不会进入执行；已产生的诊断和工件记录会保留。', 'system_state', subjectFull.targetRefs)], subjectFull.targetRefs),
      confirmation: { required: true, text: '确认拒绝该对象？此操作不会删除已产生的记录。' },
      sourceRefs: subjectFull.targetRefs,
    });
    // edit_approval (SPEC §8.2): a REAL existing capability with a concrete
    // pending target — kept on genuinely supported subjects, with its real
    // operator-grade requirements surfaced (validated artifact id + reason).
    availableActions.push({
      key: `edit:${subject.approvalId}`,
      semantic: 'edit_approval',
      label: '替换审批工件',
      targetRefs: subjectFull.targetRefs,
      serviceOperation: 'POST /api/v1/approvals/:id/edit',
      channel: subject.channel,
      assessedAt: capturedAt,
      requirements: [
        { name: 'newArtifactId', ownerText: '需要提供新的已验证工件 ID（操作员级输入）。', required: true },
        { name: 'reason', ownerText: '需要填写编辑原因。', required: true },
      ],
      expectedConsequence: knownNarrative([narrativeItem('将该审批的目标工件替换为你指定的新工件（需要已验证的工件 ID）。这是替换审批对象，不是修改原则措辞。', 'system_state', subjectFull.targetRefs)], subjectFull.targetRefs),
      confirmation: { required: true, text: '确认替换该审批的目标工件？需要新的已验证工件 ID 与编辑原因。' },
      sourceRefs: subjectFull.targetRefs,
    });
  }
  for (const row of foldedActivations.filter((item) => item.deactivatedAt === undefined)) {
    const activationRef = ref({
      kind: 'activation', id: row.activationId, fieldPath: 'deactivated_at', relation: 'exact_id',
      claimClass: 'system_state', producer: { status: 'known', value: 'activation-store' }, capturedAt,
      recordedAt: row.activatedAt,
    });
    availableActions.push({
      key: `disable:${row.activationId}`,
      semantic: 'disable',
      label: '停止此执行方式今后的影响',
      targetRefs: [activationRef],
      serviceOperation: 'POST /api/v1/activations/:id/disable',
      channel: row.channel,
      assessedAt: capturedAt,
      requirements: [{ name: 'confirmed', ownerText: '需要明确确认（confirmed=true）。', required: true }],
      expectedConsequence: knownNarrative([narrativeItem('停止后，该执行方式不再影响后续行为；已经发生的外部效果不会被撤回。', 'system_state', [activationRef])], [activationRef]),
      confirmation: { required: true, text: '确认停止该执行方式今后的影响？已发生的外部效果不会被撤回。' },
      sourceRefs: [activationRef],
    });
  }

  // ── blockers ─────────────────────────────────────────────────────────────
  const blockers: Blocker[] = [];
  if (lineageNotAvailableIssue !== undefined) {
    blockers.push({
      subjectKey: principleId,
      actionSemantic: 'judgment',
      kind: 'data',
      reason: reason('lineage_not_available', '治理身份尚未建立，系统暂时无法判断是否需要你决定。', [ledgerRef]),
      requiredAudience: 'owner',
    });
  }
  for (const subject of pendingSubjects) {
    const subjectFull = decisionSubjects.find((row) => row.key === subject.approvalId);
    const approveGate = subjectFull?.materialGates.find((gate) => gate.actionSemantic === 'approve');
    if (approveGate?.status === 'blocked') {
      blockers.push({
        subjectKey: subject.approvalId,
        actionSemantic: 'approve',
        kind: 'data',
        reason: reason('decision_material_missing', '这个对象虽然有待处理审批，但缺少足够的信息让你安全地批准（可读的行为准则或后果说明缺失）。拒绝仍可单独评估。', subjectFull?.targetRefs ?? [ledgerRef]),
        requiredAudience: 'owner',
      });
    }
  }
  for (const read of input.sourceReads) {
    if (read.status === 'unavailable') {
      blockers.push({
        subjectKey: principleId,
        actionSemantic: 'judgment',
        kind: 'data',
        reason: reason(`source_unavailable:${read.source}`, `数据源 ${read.source} 读取失败：${read.reason ?? '原因未知'}。`, [ledgerRef]),
        requiredAudience: 'operator',
      });
    }
  }
  for (const item of recoveryAttention) {
    blockers.push({
      subjectKey: principleId,
      actionSemantic: 'judgment',
      kind: 'runtime',
      reason: reason('historical_processing_issue', '存在历史处理问题，其与当前操作的关系尚未确认。', [
        ref({ kind: 'task', id: item.sourceRef.id, fieldPath: 'tasks.status', relation: 'exact_id', claimClass: 'system_state', producer: { status: 'known', value: 'runtime-task-store' }, capturedAt }),
      ]),
      requiredAudience: 'system',
    });
  }

  // ── decision_state (§8.1 priority) ───────────────────────────────────────
  const runningWork = ownerGovernanceView.automation.state === 'running'
    || ownerGovernanceView.automation.state === 'queued'
    || ownerGovernanceView.automation.state === 'retry_scheduled';
  const hasApproveAction = availableActions.some((action) => action.semantic === 'approve');
  const decisionState: DecisionState = (() => {
    if (pendingSubjects.length > 0 && hasApproveAction) return 'needs_owner_decision';
    if (pendingSubjects.length > 0) {
      // Pending subject exists but no approve passed its material gate.
      return 'blocked';
    }
    if (lineageNotAvailableIssue !== undefined) {
      // §9.2: readable diagnostics do NOT establish governance identity. We
      // cannot prove "nothing needs deciding" without the lineage, so this is
      // blocked (system cannot establish the governance judgment), never
      // no_action.
      return 'blocked';
    }
    if (recoveryAttention.length > 0) return 'recovery_needed';
    if (runningWork) return 'processing';
    if (foldedSubjects.some((row) => row.outcome === 'approved' || row.outcome === 'rejected')) return 'decided';
    if (foldedActivations.length > 0) return 'decided';
    return 'no_action';
  })();

  // ── next_action ──────────────────────────────────────────────────────────
  const nextAction: NextAction = (() => {
    if (decisionState === 'needs_owner_decision') {
      const first = availableActions.find((action) => action.semantic === 'approve');
      return { code: 'review', ownerText: '有一项决定需要你审阅：请阅读上述说明后选择批准或拒绝。', targetRefs: first?.sourceRefs ?? [ledgerRef], actionKey: first?.key };
    }
    if (decisionState === 'blocked') {
      const dataBlocker = blockers.find((blocker) => blocker.kind === 'data');
      return {
        code: 'inspect_data',
        ownerText: dataBlocker?.reason.ownerText ?? '系统暂时无法建立完整的治理判断。',
        targetRefs: [ledgerRef],
      };
    }
    if (decisionState === 'recovery_needed') {
      return { code: 'inspect_recovery', ownerText: '这项处理存在历史遗留问题；可查看恢复信息，由系统或操作员处理。', targetRefs: [ledgerRef] };
    }
    if (decisionState === 'processing') {
      return { code: 'wait', ownerText: '系统正在处理这项提案，请等待处理完成。', targetRefs: [ledgerRef] };
    }
    if (decisionState === 'decided') {
      return { code: 'monitor', ownerText: '此提案已有完成的决定。可查看上方的执行状态与行为记录。', targetRefs: [ledgerRef] };
    }
    return { code: 'none', ownerText: '目前没有需要你决定的事项。', targetRefs: [ledgerRef] };
  })();

  // ── inbox placement (§11.1) ──────────────────────────────────────────────
  const inbox: OwnerDecisionViewCore['inbox'] = (() => {
    if (decisionState === 'needs_owner_decision') {
      return { group: 'decision', attention: 'individual', reason: reason('pending_decision_subject', '存在待决定的审批对象。', [ledgerRef]) };
    }
    if (decisionState === 'blocked') {
      const hasRealSubject = pendingSubjects.length > 0;
      return {
        group: 'blocked',
        attention: hasRealSubject ? 'individual' : 'aggregate',
        reason: reason(
          hasRealSubject ? 'blocked_real_subject' : 'judgment_unavailable',
          hasRealSubject
            ? '当前待批对象缺少安全批准所需的决策材料。'
            : '系统暂时无法判断是否需要你决定（治理关联尚未建立）。',
          [ledgerRef],
        ),
      };
    }
    if (decisionState === 'recovery_needed') {
      return { group: 'recovery', attention: 'individual', reason: reason('recovery_attention', '存在需要恢复处理的事项。', [ledgerRef]) };
    }
    return { group: 'none', attention: 'none', reason: reason('no_inbox_attention', '当前无需特别关注。', [ledgerRef]) };
  })();

  const view: OwnerDecisionViewCore = {
    schemaVersion: '1',
    principleId,
    asOf,
    sourceReadStatus,
    sourceReads: input.sourceReads,
    incidentSummary,
    learnedPrinciple,
    rationale,
    applicability,
    nonApplicabilityOrUnknown: nonApplicability,
    expectedBehavior,
    currentEnforcement,
    evidenceSummary,
    uncertainty,
    risk,
    rollback,
    decisionState,
    decisionSubjects,
    availableActions,
    blockers,
    nextAction,
    inbox,
    technicalDetails: {
      available: true,
      links: [
        { kind: 'governance', target: `/api/v1/principles/${principleId}/governance`, reason: '完整治理投影（任务图、时间线、数据质量）。' },
        { kind: 'trajectory', target: `/api/v1/principles/${principleId}/trajectory`, reason: '六阶段轨迹（证据→诊断→提案→评审→部署→行为）。' },
        { kind: 'receipts', target: `/api/v1/principles/${principleId}/receipts`, reason: '行为回执与证据覆盖。' },
      ],
      warnings: [],
    },
  };
  if (!Value.Check(OwnerDecisionViewCoreSchema, view)) {
    throw new Error('invalid_owner_decision_view');
  }
  return view;
}
