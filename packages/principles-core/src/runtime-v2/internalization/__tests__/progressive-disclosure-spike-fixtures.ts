/**
 * Phase 0 Spike fixtures — synthetic baseline chains for the
 * internalization progressive-disclosure value verification.
 *
 * SPIKE-ONLY. This module is deliberately isolated:
 *   - it is imported by Spike tests only (task 1.1 self-check, task 1.2 driver);
 *   - it is NOT exported from any barrel (`internalization/index.ts` untouched);
 *   - it imports **types only**, so it adds no production runtime dependency;
 *   - it performs no I/O (core is pure logic — AGENTS.md `antipattern-core-io`).
 *
 * Why the chain starts at the diagnostician chain and not at dreamer
 * (design §4.7.1 / F13): `diag_router` is dreamer's predecessor on the task
 * graph edge, so it is the only data source for the `pain.summary.*` /
 * `diagnosis.summary.*` fields the `pain_to_dreamer` diagnosis segment needs.
 * A chain that started at dreamer could only exercise 2 of the 3 segments.
 *
 * Every `contentJson` shape below is taken from the real output type in the
 * repo — no invented fields:
 *   diag_rootcause → `DiagRootCauseOutputV1`  (diagnostician/diag-rootcause-output.ts)
 *   diag_distiller → `DiagDistillerOutputV1`  (diagnostician/diag-distiller-output.ts)
 *   diag_router    → `DiagnosticianOutputV1`  (diagnostician-output.ts)
 *   dreamer        → `DreamerOutputV1`        (dreamer-output.ts)
 *   philosopher    → `PhilosopherOutputV1`    (philosopher-output.ts)
 *   scribe         → `ScribeOutputV1`         (scribe-output.ts)
 *   artificer      → `ArtificerRuleOutput`    (artificer-output.ts)
 *   evaluator      → `EvaluatorOutputV2`      (evaluator-output.ts)
 *
 * The evaluator hop carries only fields that exist today (V1 + optional
 * `codeReview`). `painCoverage` / `compressionFidelity` are Layer 2 additions
 * and are intentionally absent — the expected defect lives in fixture metadata
 * (`expectedDefect`), never inside the LLM-shaped payload, so a Spike assertion
 * cannot trivially read the answer out of the artifact it is judging (ERR-088).
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §12 Phase 0, §16.3
 * @see Requirement 12.2
 */

import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { DiagnosticianOutputV1 } from '../../diagnostician-output.js';
import type { DreamerOutputV1 } from '../dreamer-output.js';
import type { PhilosopherOutputV1 } from '../philosopher-output.js';
import type { ScribeOutputV1 } from '../scribe-output.js';
import type { ArtificerRuleOutput } from '../artificer-output.js';
import type { EvaluatorOutputV2 } from '../evaluator-output.js';

// ── Stage / chain identity ───────────────────────────────────────────────────

/** The 8 stages that carry a summary in Layer 0 (design §6.1). */
export type SpikeStageKind =
  | 'diag_rootcause'
  | 'diag_distiller'
  | 'diag_router'
  | 'dreamer'
  | 'philosopher'
  | 'scribe'
  | 'artificer'
  | 'evaluator';

/**
 * Stage order along the synthetic chain. Mirrors `DIAGNOSTICIAN_EDGES`
 * followed by `ALLOWED_EDGES` (design F5 / F14).
 */
export const SPIKE_STAGE_ORDER: readonly SpikeStageKind[] = [
  'diag_rootcause',
  'diag_distiller',
  'diag_router',
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
];

export type SpikeChainId =
  /** 缺陷链 A：scribe 原则文本完全丢失 dreamer 的 riskLevel 维度 */
  | 'defect_a_risk_level_dropped'
  /** 缺陷链 B：scribe 把 dreamer 的具体动作模糊为抽象表述 */
  | 'defect_b_action_abstracted'
  /** 对照链：无缺陷，用于识别「任何输入都报缺失」的假阳性 */
  | 'control_no_defect';

/** The 5 dreamer dimensions the pipeline is supposed to carry forward. */
export type DreamerDimension =
  | 'badDecision'
  | 'betterDecision'
  | 'rationale'
  | 'riskLevel'
  | 'strategicPerspective';

/**
 * The defect a chain encodes, stated independently of the artifacts.
 *
 * The Spike driver (task 1.2) compares the summary-level evaluator's finding
 * against this — it is the expected answer, not an input to any stage.
 */
export type SpikeExpectedDefect =
  | { readonly kind: 'none' }
  | {
      /** A dimension present at dreamer is absent from the scribe principle text. */
      readonly kind: 'missing_dimension';
      readonly segment: 'dreamer_to_scribe';
      readonly dimension: DreamerDimension;
    }
  | {
      /** Concrete actions at dreamer became an abstract phrase at scribe. */
      readonly kind: 'action_abstracted';
      readonly segment: 'dreamer_to_scribe';
      readonly concreteActions: readonly string[];
      readonly abstractedAs: string;
    };

/** One hop of a synthetic chain: artifact identity + the stage's contentJson. */
export interface SpikeChainHop<TContent> {
  readonly stage: SpikeStageKind;
  readonly artifactId: string;
  readonly taskId: string;
  /**
   * Stage identity source of truth. Per F1, `artifactKind` cannot identify a
   * stage (artificer writes `'principle'` too), so consumers must read this.
   */
  readonly taskKind: SpikeStageKind;
  /**
   * The artifact id of the predecessor **on the task graph edge**
   * (design §6.1). `null` only at the chain head.
   */
  readonly edgePredecessorArtifactId: string | null;
  readonly contentJson: TContent;
}

export interface SpikeChain {
  readonly chainId: SpikeChainId;
  /** Short human-readable label for Spike output. */
  readonly label: string;
  readonly expectedDefect: SpikeExpectedDefect;
  readonly diagRootCause: SpikeChainHop<DiagRootCauseOutputV1>;
  readonly diagDistiller: SpikeChainHop<DiagDistillerOutputV1>;
  readonly diagRouter: SpikeChainHop<DiagnosticianOutputV1>;
  readonly dreamer: SpikeChainHop<DreamerOutputV1>;
  readonly philosopher: SpikeChainHop<PhilosopherOutputV1>;
  readonly scribe: SpikeChainHop<ScribeOutputV1>;
  readonly artificer: SpikeChainHop<ArtificerRuleOutput>;
  readonly evaluator: SpikeChainHop<EvaluatorOutputV2>;
}

/** Ordered hops of a chain. `contentJson` stays `unknown` (rc-1). */
export function spikeChainHops(chain: SpikeChain): readonly SpikeChainHop<unknown>[] {
  return [
    chain.diagRootCause,
    chain.diagDistiller,
    chain.diagRouter,
    chain.dreamer,
    chain.philosopher,
    chain.scribe,
    chain.artificer,
    chain.evaluator,
  ];
}

// ── Shared scenario text ─────────────────────────────────────────────────────
//
// All three chains share byte-identical diagnostician / dreamer / philosopher
// content. Only the scribe principle text differs, so any difference the Spike
// observes is attributable to the dreamer→scribe compression and nothing else.

const GENERATED_AT = '2026-07-28T00:00:00.000Z';

/** The three concrete actions dreamer prescribes. Defect chain B loses these. */
export const CONCRETE_ACTIONS: readonly string[] = [
  '审计文件树',
  'grep 全部 imports',
  '检查导出依赖图',
];

/** The abstract phrase defect chain B substitutes for the concrete actions. */
export const ABSTRACTED_PHRASE = '理解架构';

/** The dreamer risk level. Defect chain A loses this dimension entirely. */
export const DREAMER_RISK_LEVEL = 'high';

const ROOT_CAUSE_TEXT =
  'Assumption: Agent 假设读过定义文件就等于掌握了该导出符号的影响面，因此跳过了调用方枚举。';

const EVIDENCE: readonly { readonly sourceRef: string; readonly note: string }[] = [
  { sourceRef: 'run://spike-rename#tsc', note: '重命名后 4 个包 tsc 失败，全部是找不到旧符号' },
  { sourceRef: 'run://spike-rename#diff', note: 'diff 只触及定义文件，未触及任何调用方' },
  { sourceRef: 'run://spike-rename#transcript', note: 'Agent 自述「已读过该文件，理解了这块代码」' },
];

const DISTILLER_CONFIDENCE = 0.76;

const DREAMER_BAD_DECISION =
  '直接重命名跨包引用的导出符号，只改了定义文件，没有枚举任何调用方。';
const DREAMER_BETTER_DECISION =
  '改动跨包引用的导出符号前，先审计文件树、grep 全部 imports、检查导出依赖图，把受影响的包列成清单，再动手改。';
const DREAMER_RATIONALE =
  '共享符号的影响面不在定义文件里而在调用方；先把影响面变成一份可核对的清单，才能判断这次改动的代价。';
const DREAMER_STRATEGIC_PERSPECTIVE = '最小变更面：先量出爆炸半径，再决定切口。';

const PHILOSOPHER_THESIS =
  '「理解」不是读过一个文件，而是能列出受影响的调用方清单；在跨包导出符号上，未量化的影响面等于未评估的高风险改动。';
const PHILOSOPHER_PRINCIPLE_TITLE = '改动跨包导出符号前先量出影响面';
const PHILOSOPHER_PRINCIPLE_RATIONALE =
  'dreamer 给出的更优动作是审计文件树、grep 全部 imports、检查导出依赖图并列出受影响的包；其风险级别为 high，因为影响面跨包扩散。';
const PHILOSOPHER_PRINCIPLE_SCOPE = '修改被多个包引用的导出符号时';

// ── Per-chain scribe principle text (the only diverging hop) ─────────────────

interface ScribePrincipleText {
  readonly statement: string;
  readonly rationale: string;
  readonly antiPatterns: readonly string[];
}

/** 对照链：三项具体动作与 riskLevel 都在原则文本里。 */
const SCRIBE_TEXT_CONTROL: ScribePrincipleText = {
  statement:
    '在修改被多个包引用的导出符号前，先审计文件树、grep 全部 imports、检查导出依赖图，把受影响的包列成清单；因为影响面跨包扩散，这类改动的风险级别为 high，清单未成形前不要动手。',
  rationale:
    '影响面不在定义文件里而在调用方。三项动作（审计文件树、grep 全部 imports、检查导出依赖图）把影响面变成可核对的清单；风险级别 high 说明清单缺失时不应继续。',
  antiPatterns: [
    '只读定义文件就认为掌握了影响面',
    '先改定义，再靠编译错误反查调用方',
    '在 high 风险改动上跳过影响面清单',
  ],
};

/** 缺陷链 A：三项具体动作保留，riskLevel 维度在原则文本中完全消失。 */
const SCRIBE_TEXT_DEFECT_A: ScribePrincipleText = {
  statement:
    '在修改被多个包引用的导出符号前，先审计文件树、grep 全部 imports、检查导出依赖图，把受影响的包列成清单，再动手改。',
  rationale:
    '影响面不在定义文件里而在调用方。三项动作（审计文件树、grep 全部 imports、检查导出依赖图）把影响面变成可核对的清单。',
  antiPatterns: [
    '只读定义文件就认为掌握了影响面',
    '先改定义，再靠编译错误反查调用方',
  ],
};

/** 缺陷链 B：riskLevel 保留，三项具体动作被模糊成「理解架构」。 */
const SCRIBE_TEXT_DEFECT_B: ScribePrincipleText = {
  statement:
    '在修改被多个包引用的导出符号前，先理解架构，确认自己掌握了整体结构；因为影响面跨包扩散，这类改动的风险级别为 high，理解不到位就不要动手。',
  rationale:
    '理解架构是 high 风险改动的前置条件；架构理解不到位时不应继续。',
  antiPatterns: [
    '在没有理解架构的情况下动手改跨包导出符号',
    '在 high 风险改动上跳过架构理解',
  ],
};

// ── Per-chain artificer implementation (derived from that chain's scribe text) ──

interface ArtificerImplementation {
  readonly implementationCode: string;
  readonly implementationSummary: string;
  readonly risks: readonly string[];
}

const ARTIFICER_IMPL_CONTROL: ArtificerImplementation = {
  implementationCode: [
    'function evaluate(input) {',
    '  const touchesSharedExport = /export (const|function|class|type) /.test(input.params.newText ?? "");',
    '  const auditDone = input.params.impactedPackagesChecklist?.length > 0;',
    '  if (touchesSharedExport && !auditDone) {',
    '    return { decision: "block", reason: "high-risk shared export change without impacted-package checklist" };',
    '  }',
    '  return { decision: "allow" };',
    '}',
  ].join('\n'),
  implementationSummary:
    '跨包导出符号变更时要求先提交受影响包清单（对应三项审计动作），缺清单则按 high 风险拦截。',
  risks: ['对单包内部私有导出可能过于严格'],
};

const ARTIFICER_IMPL_DEFECT_A: ArtificerImplementation = {
  implementationCode: [
    'function evaluate(input) {',
    '  const touchesSharedExport = /export (const|function|class|type) /.test(input.params.newText ?? "");',
    '  const auditDone = input.params.impactedPackagesChecklist?.length > 0;',
    '  if (touchesSharedExport && !auditDone) {',
    '    return { decision: "propose_correction", reason: "impacted-package checklist missing" };',
    '  }',
    '  return { decision: "allow" };',
    '}',
  ].join('\n'),
  implementationSummary:
    '跨包导出符号变更时提示补齐受影响包清单；原则文本未给出风险级别，因此未做拦截分级。',
  risks: ['未区分风险级别，高风险改动与低风险改动同等对待'],
};

const ARTIFICER_IMPL_DEFECT_B: ArtificerImplementation = {
  implementationCode: [
    'function evaluate(input) {',
    '  const claimsArchitectureUnderstood = input.params.notes?.includes("架构") === true;',
    '  if (!claimsArchitectureUnderstood) {',
    '    return { decision: "block", reason: "architecture not understood before high-risk change" };',
    '  }',
    '  return { decision: "allow" };',
    '}',
  ].join('\n'),
  implementationSummary:
    '按原则文本要求「先理解架构」，以 notes 中是否声称理解架构作为 high 风险改动的前置判据；原则文本未给出可执行动作，因此无法校验具体审计步骤。',
  risks: ['判据是自述而非可核验的动作，容易被空话通过'],
};

// ── Per-chain evaluator baseline verdict ────────────────────────────────────
//
// These are the *today* single-stage evaluator outputs: they can see the
// artificer implementation and the scribe principle, so they judge code-vs-text
// consistency and nothing more. None of them names the lost dimension or the
// hop where it was lost — that gap is precisely what the Spike measures.

interface EvaluatorBaselineVerdict {
  readonly decision: 'approved' | 'needs_revision' | 'rejected';
  readonly summary: string;
  readonly score: number;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly requiredChanges: readonly string[];
  readonly scopeVerdict: 'precise' | 'too_broad' | 'too_narrow';
  readonly scopeExplanation: string;
}

const EVALUATOR_BASELINE_CONTROL: EvaluatorBaselineVerdict = {
  decision: 'approved',
  summary: '实现与原则文本一致：要求受影响包清单，缺清单按 high 风险拦截。',
  score: 0.86,
  strengths: ['拦截判据可核验', '与原则文本的风险分级一致'],
  concerns: [],
  requiredChanges: [],
  scopeVerdict: 'precise',
  scopeExplanation: '仅在跨包导出符号变更时触发，与原则 scope 吻合。',
};

const EVALUATOR_BASELINE_DEFECT_A: EvaluatorBaselineVerdict = {
  decision: 'approved',
  summary: '实现忠实覆盖了原则文本要求的清单动作，未见与文本冲突之处。',
  score: 0.81,
  strengths: ['清单判据与原则文本逐条对应'],
  concerns: [],
  requiredChanges: [],
  scopeVerdict: 'precise',
  scopeExplanation: '触发条件与原则文本给出的范围一致。',
};

const EVALUATOR_BASELINE_DEFECT_B: EvaluatorBaselineVerdict = {
  decision: 'needs_revision',
  summary: '实现与原则文本一致，但判据依赖自述，缺少可核验的动作。',
  score: 0.62,
  strengths: ['保留了 high 风险的前置门槛'],
  concerns: ['以 notes 是否提到「架构」作为判据，容易被空话通过'],
  requiredChanges: ['把判据换成可核验的输入字段'],
  scopeVerdict: 'too_broad',
  scopeExplanation: '任何变更只要 notes 提到架构即放行，范围过宽。',
};

// ── Chain factory ────────────────────────────────────────────────────────────

interface ChainSpec {
  readonly chainId: SpikeChainId;
  readonly slug: string;
  readonly label: string;
  readonly expectedDefect: SpikeExpectedDefect;
  readonly scribeText: ScribePrincipleText;
  readonly artificerImpl: ArtificerImplementation;
  readonly evaluatorVerdict: EvaluatorBaselineVerdict;
}

function buildChain(spec: ChainSpec): SpikeChain {
  const { slug } = spec;

  const rootCauseArtifactId = `pi-art-spike-${slug}-rootcause`;
  const distillerArtifactId = `pi-art-spike-${slug}-distiller`;
  const routerArtifactId = `pi-art-spike-${slug}-router`;
  const dreamerArtifactId = `pi-art-spike-${slug}-dreamer`;
  const philosopherArtifactId = `pi-art-spike-${slug}-philosopher`;
  const scribeArtifactId = `pi-art-spike-${slug}-scribe`;
  const artificerArtifactId = `pi-art-spike-${slug}-artificer`;
  const evaluatorArtifactId = `pi-art-spike-${slug}-evaluator`;

  const painTaskSuffix = `spike-${slug}`;
  const rootCauseTaskId = `diag_rootcause-${painTaskSuffix}`;
  const distillerTaskId = `diag_distiller-${painTaskSuffix}`;
  const routerTaskId = `diag_router-${painTaskSuffix}`;
  const dreamerTaskId = `dreamer-${painTaskSuffix}`;
  const philosopherTaskId = `philosopher-${painTaskSuffix}`;
  const scribeTaskId = `scribe-${painTaskSuffix}`;
  const artificerTaskId = `artificer-${painTaskSuffix}`;
  const evaluatorTaskId = `evaluator-${painTaskSuffix}`;

  const diagnosisId = `diag-${painTaskSuffix}`;

  const rootCauseContent: DiagRootCauseOutputV1 = {
    valid: true,
    diagnosisId,
    taskId: rootCauseTaskId,
    summary: 'Agent 重命名跨包导出符号前没有枚举调用方，导致 4 个包编译失败。',
    causalChain: [
      {
        why: 1,
        statement: '重命名跨包导出符号后 4 个包 tsc 失败',
        evidenceRefs: ['run://spike-rename#tsc'],
      },
      {
        why: 2,
        statement: 'Agent 只改了定义文件，没有搜索调用点',
        evidenceRefs: ['run://spike-rename#diff'],
      },
      {
        why: 3,
        statement: 'Agent 把「读过这个文件」当成了「掌握了这块代码」',
        evidenceRefs: ['run://spike-rename#transcript'],
      },
      {
        why: 4,
        statement: '流程里没有任何一步要求在改共享符号前枚举依赖',
        evidenceRefs: ['run://spike-rename#transcript'],
      },
      {
        why: 5,
        statement: '缺少「改动前先量出影响面」的成文约束',
        evidenceRefs: ['run://spike-rename#transcript'],
      },
    ],
    rootCause: ROOT_CAUSE_TEXT,
    rootCauseCategory: 'Assumption',
    evidence: EVIDENCE.map((e) => ({ sourceRef: e.sourceRef, note: e.note })),
    confidence: 0.82,
  };

  const distillerContent: DiagDistillerOutputV1 = {
    valid: true,
    taskId: distillerTaskId,
    sourceRootCauseArtifactId: rootCauseArtifactId,
    abstractedPrinciple: '改动跨包共享符号前，先把影响面变成一份可核对的清单。',
    rationale:
      '根因是把「读过文件」误当成「掌握影响面」；把影响面显式列出，才能让改动代价可判断。',
    groundedOnCorePrincipleIds: ['T-01', 'T-03'],
    scope: 'domain',
    confidence: DISTILLER_CONFIDENCE,
  };

  // diag_router 的 rootCause / evidence 来自 Stage A，confidence 来自 Stage B —
  // 这是 diag-router-runner.postFetchTransform 强制注入的不变式，不是随手写的值。
  const routerContent: DiagnosticianOutputV1 = {
    valid: true,
    diagnosisId,
    summary: 'Agent 在跨包导出符号上跳过影响面枚举，需要一条成文约束。',
    rootCause: ROOT_CAUSE_TEXT,
    violatedPrinciples: [
      {
        principleId: 'T-01',
        title: 'Survey Before Acting',
        rationale: '改动前未梳理结构，直接动手。',
      },
    ],
    evidence: EVIDENCE.map((e) => ({ sourceRef: e.sourceRef, note: e.note })),
    recommendations: [
      {
        kind: 'principle',
        description: '沉淀一条「改动跨包共享符号前先量出影响面」的原则。',
        abstractedPrinciple: '改动跨包共享符号前，先把影响面变成一份可核对的清单。',
      },
    ],
    confidence: DISTILLER_CONFIDENCE,
  };

  const dreamerContent: DreamerOutputV1 = {
    valid: true,
    taskId: dreamerTaskId,
    candidates: [
      {
        candidateIndex: 0,
        badDecision: DREAMER_BAD_DECISION,
        betterDecision: DREAMER_BETTER_DECISION,
        rationale: DREAMER_RATIONALE,
        confidence: 0.78,
        riskLevel: DREAMER_RISK_LEVEL,
        strategicPerspective: DREAMER_STRATEGIC_PERSPECTIVE,
      },
    ],
    // 血缘：dreamer 的 contextRefs 承载已加载前驱 artifact 的 ref
    // （dreamer-runner.buildContext 把依赖任务的 artifact ref 推进这里）。
    contextRefs: [routerArtifactId],
    generatedAt: GENERATED_AT,
  };

  const philosopherContent: PhilosopherOutputV1 = {
    taskId: philosopherTaskId,
    sourceDreamerArtifactId: dreamerArtifactId,
    thesis: PHILOSOPHER_THESIS,
    principleCandidate: {
      title: PHILOSOPHER_PRINCIPLE_TITLE,
      rationale: PHILOSOPHER_PRINCIPLE_RATIONALE,
      scope: PHILOSOPHER_PRINCIPLE_SCOPE,
      confidence: 0.75,
    },
    risks: ['对单包内部私有符号可能过重', '大仓 grep 成本较高'],
    generatedAt: GENERATED_AT,
  };

  const scribeContent: ScribeOutputV1 = {
    taskId: scribeTaskId,
    sourcePhilosopherArtifactId: philosopherArtifactId,
    principleDraft: {
      title: PHILOSOPHER_PRINCIPLE_TITLE,
      statement: spec.scribeText.statement,
      rationale: spec.scribeText.rationale,
      applicability: ['修改被多个包引用的导出符号', '重命名或删除公共 API'],
      antiPatterns: [...spec.scribeText.antiPatterns],
      confidence: 0.8,
    },
    sourceTrace: {
      dreamerArtifactId,
      philosopherArtifactId,
    },
    risks: ['对单包内部私有符号可能过重'],
    generatedAt: GENERATED_AT,
  };

  const artificerContent: ArtificerRuleOutput = {
    taskId: artificerTaskId,
    sourceScribeArtifactId: scribeArtifactId,
    implementationCode: spec.artificerImpl.implementationCode,
    goldenTraceCases: [
      {
        caseId: `${slug}-positive-1`,
        kind: 'positive',
        toolName: 'edit_file',
        params: { path: 'packages/principles-core/src/internal-helper.ts', newText: 'const local = 1;' },
        expectedDecision: 'allow',
      },
      {
        caseId: `${slug}-negative-1`,
        kind: 'negative',
        toolName: 'edit_file',
        params: { path: 'packages/principles-core/src/index.ts', newText: 'export const renamed = 1;' },
        expectedDecision: 'block',
      },
    ],
    affectedTools: ['edit_file'],
    implementationSummary: spec.artificerImpl.implementationSummary,
    risks: [...spec.artificerImpl.risks],
    sourceTrace: {
      scribeArtifactId,
      philosopherArtifactId,
      dreamerArtifactId,
    },
    generatedAt: GENERATED_AT,
  };

  const evaluatorContent: EvaluatorOutputV2 = {
    taskId: evaluatorTaskId,
    sourceArtificerArtifactId: artificerArtifactId,
    evaluation: {
      decision: spec.evaluatorVerdict.decision,
      summary: spec.evaluatorVerdict.summary,
      score: spec.evaluatorVerdict.score,
      strengths: [...spec.evaluatorVerdict.strengths],
      concerns: [...spec.evaluatorVerdict.concerns],
      requiredChanges: [...spec.evaluatorVerdict.requiredChanges],
    },
    sourceTrace: {
      artificerArtifactId,
      scribeArtifactId,
      philosopherArtifactId,
      dreamerArtifactId,
    },
    risks: [],
    generatedAt: GENERATED_AT,
    codeReview: {
      intentConsistency: {
        aligned: true,
        explanation: '实现动作与原则文本所写的动作一致。',
      },
      scopePrecision: {
        verdict: spec.evaluatorVerdict.scopeVerdict,
        explanation: spec.evaluatorVerdict.scopeExplanation,
      },
      traceCoverage: {
        sufficient: true,
        gaps: [],
        explanation: 'golden trace 覆盖了正例与反例各一条。',
      },
    },
  };

  return {
    chainId: spec.chainId,
    label: spec.label,
    expectedDefect: spec.expectedDefect,
    diagRootCause: {
      stage: 'diag_rootcause',
      artifactId: rootCauseArtifactId,
      taskId: rootCauseTaskId,
      taskKind: 'diag_rootcause',
      edgePredecessorArtifactId: null,
      contentJson: rootCauseContent,
    },
    diagDistiller: {
      stage: 'diag_distiller',
      artifactId: distillerArtifactId,
      taskId: distillerTaskId,
      taskKind: 'diag_distiller',
      edgePredecessorArtifactId: rootCauseArtifactId,
      contentJson: distillerContent,
    },
    diagRouter: {
      stage: 'diag_router',
      artifactId: routerArtifactId,
      taskId: routerTaskId,
      taskKind: 'diag_router',
      // 边上前驱是 distiller，不是 rootcause —— 尽管 router 同时加载了两者（F17）。
      edgePredecessorArtifactId: distillerArtifactId,
      contentJson: routerContent,
    },
    dreamer: {
      stage: 'dreamer',
      artifactId: dreamerArtifactId,
      taskId: dreamerTaskId,
      taskKind: 'dreamer',
      edgePredecessorArtifactId: routerArtifactId,
      contentJson: dreamerContent,
    },
    philosopher: {
      stage: 'philosopher',
      artifactId: philosopherArtifactId,
      taskId: philosopherTaskId,
      taskKind: 'philosopher',
      edgePredecessorArtifactId: dreamerArtifactId,
      contentJson: philosopherContent,
    },
    scribe: {
      stage: 'scribe',
      artifactId: scribeArtifactId,
      taskId: scribeTaskId,
      taskKind: 'scribe',
      edgePredecessorArtifactId: philosopherArtifactId,
      contentJson: scribeContent,
    },
    artificer: {
      stage: 'artificer',
      artifactId: artificerArtifactId,
      taskId: artificerTaskId,
      taskKind: 'artificer',
      edgePredecessorArtifactId: scribeArtifactId,
      contentJson: artificerContent,
    },
    evaluator: {
      stage: 'evaluator',
      artifactId: evaluatorArtifactId,
      taskId: evaluatorTaskId,
      taskKind: 'evaluator',
      // 边上前驱是 artificer，不是 scribe —— 尽管 evaluator 同时加载了两者（F17）。
      edgePredecessorArtifactId: artificerArtifactId,
      contentJson: evaluatorContent,
    },
  };
}

// ── The three chains ─────────────────────────────────────────────────────────

/** 缺陷链 A：scribe 原则文本完全丢失 dreamer 的 `riskLevel` 维度。 */
export const SPIKE_CHAIN_DEFECT_A: SpikeChain = buildChain({
  chainId: 'defect_a_risk_level_dropped',
  slug: 'a',
  label: '缺陷链 A — scribe 丢失 riskLevel 维度',
  expectedDefect: {
    kind: 'missing_dimension',
    segment: 'dreamer_to_scribe',
    dimension: 'riskLevel',
  },
  scribeText: SCRIBE_TEXT_DEFECT_A,
  artificerImpl: ARTIFICER_IMPL_DEFECT_A,
  evaluatorVerdict: EVALUATOR_BASELINE_DEFECT_A,
});

/** 缺陷链 B：scribe 把 dreamer 的具体动作模糊为抽象表述。 */
export const SPIKE_CHAIN_DEFECT_B: SpikeChain = buildChain({
  chainId: 'defect_b_action_abstracted',
  slug: 'b',
  label: '缺陷链 B — scribe 把具体动作模糊为「理解架构」',
  expectedDefect: {
    kind: 'action_abstracted',
    segment: 'dreamer_to_scribe',
    concreteActions: CONCRETE_ACTIONS,
    abstractedAs: ABSTRACTED_PHRASE,
  },
  scribeText: SCRIBE_TEXT_DEFECT_B,
  artificerImpl: ARTIFICER_IMPL_DEFECT_B,
  evaluatorVerdict: EVALUATOR_BASELINE_DEFECT_B,
});

/** 对照链：无缺陷。用于识别「任何输入都报缺失」的假阳性。 */
export const SPIKE_CHAIN_CONTROL: SpikeChain = buildChain({
  chainId: 'control_no_defect',
  slug: 'control',
  label: '对照链 — 无缺陷',
  expectedDefect: { kind: 'none' },
  scribeText: SCRIBE_TEXT_CONTROL,
  artificerImpl: ARTIFICER_IMPL_CONTROL,
  evaluatorVerdict: EVALUATOR_BASELINE_CONTROL,
});

export const SPIKE_CHAINS: readonly SpikeChain[] = [
  SPIKE_CHAIN_DEFECT_A,
  SPIKE_CHAIN_DEFECT_B,
  SPIKE_CHAIN_CONTROL,
];

// ── Lineage consistency self-check (rc-6 / ERR-004 / ERR-008) ───────────────

/** One inconsistency between a hop's lineage field and the hop it should name. */
export interface SpikeLineageViolation {
  readonly chainId: SpikeChainId;
  readonly stage: SpikeStageKind;
  /** Dotted path of the offending field, e.g. `sourceTrace.scribeArtifactId`. */
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

// test-fixture helper: 6 params map 1:1 to the violation record fields.
function pushIfMismatch( // eslint-disable-line @typescript-eslint/max-params
  out: SpikeLineageViolation[],
  chainId: SpikeChainId,
  stage: SpikeStageKind,
  field: string,
  expected: string,
  actual: string | undefined,
): void {
  if (actual !== expected) {
    out.push({ chainId, stage, field, expected, actual: actual ?? '<absent>' });
  }
}

/**
 * Collect every lineage inconsistency in a chain.
 *
 * Only fields that actually exist on the real output types are checked, and each
 * check names the concrete field and the hop it must point at — so a failure
 * reports *which* field of *which* stage drifted, not merely "chain invalid"
 * (ERR-088: the assertion signal must identify the intended path uniquely).
 *
 * Checked invariants:
 *   - `taskKind` equals `stage` (F1: stage identity comes from taskKind, never artifactKind)
 *   - each hop's `edgePredecessorArtifactId` is the previous hop on the task graph edge
 *   - `contentJson.taskId` equals the hop's own `taskId` (every stage except
 *     `diag_router`, whose output carries no `taskId` — PRI-272 removed it)
 *   - `diag_distiller.sourceRootCauseArtifactId` → rootcause artifact
 *   - `diag_router` carries Stage A's `rootCause`/`evidence` and Stage B's
 *     `confidence` (the invariants `diag-router-runner.postFetchTransform` injects)
 *   - `dreamer.contextRefs` contains the router artifact
 *   - `philosopher.sourceDreamerArtifactId` → dreamer artifact
 *   - scribe / artificer / evaluator top-level source ids and every
 *     `sourceTrace.*` id point at the actual upstream artifacts
 */
export function findSpikeLineageViolations(chain: SpikeChain): readonly SpikeLineageViolation[] {
  const violations: SpikeLineageViolation[] = [];
  const { chainId } = chain;
  const hops = spikeChainHops(chain);

  // taskKind ⟺ stage, and edge predecessor chaining.
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    if (!hop) continue;
    if (hop.taskKind !== hop.stage) {
      violations.push({
        chainId,
        stage: hop.stage,
        field: 'taskKind',
        expected: hop.stage,
        actual: hop.taskKind,
      });
    }
    const previous = i === 0 ? undefined : hops[i - 1];
    const expectedPredecessor = previous ? previous.artifactId : null;
    if (hop.edgePredecessorArtifactId !== expectedPredecessor) {
      violations.push({
        chainId,
        stage: hop.stage,
        field: 'edgePredecessorArtifactId',
        expected: expectedPredecessor ?? '<null>',
        actual: hop.edgePredecessorArtifactId ?? '<null>',
      });
    }
  }

  // contentJson.taskId ⟺ hop.taskId. diag_router excluded: DiagnosticianOutputV1
  // has no taskId field (removed in PRI-272 so the LLM cannot fabricate lineage).
  const taskIdBearingHops: readonly { readonly hop: SpikeChainHop<{ readonly taskId: string }> }[] = [
    { hop: chain.diagRootCause },
    { hop: chain.diagDistiller },
    { hop: chain.dreamer },
    { hop: chain.philosopher },
    { hop: chain.scribe },
    { hop: chain.artificer },
    { hop: chain.evaluator },
  ];
  for (const { hop } of taskIdBearingHops) {
    pushIfMismatch(violations, chainId, hop.stage, 'taskId', hop.taskId, hop.contentJson.taskId);
  }

  // diag_distiller → diag_rootcause
  pushIfMismatch(
    violations,
    chainId,
    'diag_distiller',
    'sourceRootCauseArtifactId',
    chain.diagRootCause.artifactId,
    chain.diagDistiller.contentJson.sourceRootCauseArtifactId,
  );

  // diag_router invariants injected from Stage A / Stage B.
  pushIfMismatch(
    violations,
    chainId,
    'diag_router',
    'rootCause',
    chain.diagRootCause.contentJson.rootCause,
    chain.diagRouter.contentJson.rootCause,
  );
  pushIfMismatch(
    violations,
    chainId,
    'diag_router',
    'confidence',
    String(chain.diagDistiller.contentJson.confidence),
    String(chain.diagRouter.contentJson.confidence),
  );
  const stageAEvidence = chain.diagRootCause.contentJson.evidence;
  const routerEvidence = chain.diagRouter.contentJson.evidence;
  if (routerEvidence.length !== stageAEvidence.length) {
    violations.push({
      chainId,
      stage: 'diag_router',
      field: 'evidence.length',
      expected: String(stageAEvidence.length),
      actual: String(routerEvidence.length),
    });
  } else {
    for (let i = 0; i < stageAEvidence.length; i++) {
      const expected = stageAEvidence[i];
      const actual = routerEvidence[i];
      if (!expected || !actual) continue;
      pushIfMismatch(
        violations,
        chainId,
        'diag_router',
        `evidence[${i}].sourceRef`,
        expected.sourceRef,
        actual.sourceRef,
      );
      pushIfMismatch(
        violations,
        chainId,
        'diag_router',
        `evidence[${i}].note`,
        expected.note,
        actual.note,
      );
    }
  }

  // dreamer ← diag_router (contextRefs carries the loaded predecessor artifact ref)
  if (!chain.dreamer.contentJson.contextRefs.includes(chain.diagRouter.artifactId)) {
    violations.push({
      chainId,
      stage: 'dreamer',
      field: 'contextRefs',
      expected: `contains ${chain.diagRouter.artifactId}`,
      actual: chain.dreamer.contentJson.contextRefs.join(',') || '<empty>',
    });
  }

  // philosopher → dreamer
  pushIfMismatch(
    violations,
    chainId,
    'philosopher',
    'sourceDreamerArtifactId',
    chain.dreamer.artifactId,
    chain.philosopher.contentJson.sourceDreamerArtifactId,
  );

  // scribe → philosopher (+ dreamer via sourceTrace)
  pushIfMismatch(
    violations,
    chainId,
    'scribe',
    'sourcePhilosopherArtifactId',
    chain.philosopher.artifactId,
    chain.scribe.contentJson.sourcePhilosopherArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'scribe',
    'sourceTrace.philosopherArtifactId',
    chain.philosopher.artifactId,
    chain.scribe.contentJson.sourceTrace.philosopherArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'scribe',
    'sourceTrace.dreamerArtifactId',
    chain.dreamer.artifactId,
    chain.scribe.contentJson.sourceTrace.dreamerArtifactId,
  );

  // artificer → scribe (+ philosopher / dreamer via sourceTrace)
  pushIfMismatch(
    violations,
    chainId,
    'artificer',
    'sourceScribeArtifactId',
    chain.scribe.artifactId,
    chain.artificer.contentJson.sourceScribeArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'artificer',
    'sourceTrace.scribeArtifactId',
    chain.scribe.artifactId,
    chain.artificer.contentJson.sourceTrace.scribeArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'artificer',
    'sourceTrace.philosopherArtifactId',
    chain.philosopher.artifactId,
    chain.artificer.contentJson.sourceTrace.philosopherArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'artificer',
    'sourceTrace.dreamerArtifactId',
    chain.dreamer.artifactId,
    chain.artificer.contentJson.sourceTrace.dreamerArtifactId,
  );

  // evaluator → artificer (+ scribe / philosopher / dreamer via sourceTrace)
  pushIfMismatch(
    violations,
    chainId,
    'evaluator',
    'sourceArtificerArtifactId',
    chain.artificer.artifactId,
    chain.evaluator.contentJson.sourceArtificerArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'evaluator',
    'sourceTrace.artificerArtifactId',
    chain.artificer.artifactId,
    chain.evaluator.contentJson.sourceTrace.artificerArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'evaluator',
    'sourceTrace.scribeArtifactId',
    chain.scribe.artifactId,
    chain.evaluator.contentJson.sourceTrace.scribeArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'evaluator',
    'sourceTrace.philosopherArtifactId',
    chain.philosopher.artifactId,
    chain.evaluator.contentJson.sourceTrace.philosopherArtifactId,
  );
  pushIfMismatch(
    violations,
    chainId,
    'evaluator',
    'sourceTrace.dreamerArtifactId',
    chain.dreamer.artifactId,
    chain.evaluator.contentJson.sourceTrace.dreamerArtifactId,
  );

  return violations;
}

/**
 * Throw with a per-field report when a chain's lineage is inconsistent.
 *
 * Used by the fixture self-check test and available to the Spike driver so a
 * corrupted fixture fails loud instead of silently weakening the Spike (rc-9).
 */
export function assertSpikeChainLineageConsistent(chain: SpikeChain): void {
  const violations = findSpikeLineageViolations(chain);
  if (violations.length === 0) return;
  const detail = violations
    .map((v) => `${v.stage}.${v.field}: expected ${v.expected}, got ${v.actual}`)
    .join('\n  ');
  throw new Error(
    `Spike chain "${chain.chainId}" lineage is inconsistent (${violations.length} violation(s)):\n  ${detail}`,
  );
}
