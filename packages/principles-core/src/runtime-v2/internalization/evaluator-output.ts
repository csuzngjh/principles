import { Type, type Static } from '@sinclair/typebox';
import type { GoldenTraceDecision } from '../golden-trace.js';
import type { RuleContextV2 } from './rule-context-v2.js';
import { validateRuleContextV2 } from './rule-context-v2.js';

/**
 * Attack type for adversarial cases (PRD Decision 4).
 * - boundary: probe ambiguous edges of principle text
 * - omission: satisfy all-but-one condition the code may have skipped
 * - inversion: mutate a positive case so it should become negative
 */
export type AdversarialAttackType = 'boundary' | 'omission' | 'inversion';

export interface AdversarialCase {
  readonly caseId: string;
  readonly attackType: AdversarialAttackType;
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  /** GoldenTraceDecision, NOT RuleHostDecision. */
  readonly expectedDecision: GoldenTraceDecision;
  readonly rationale: string;
  /**
   * Optional v2 rule context (PRI-485 Phase 6). When present, the case carries
   * a fabricated RuleContextV2 the sandbox uses to evaluate the rule with
   * history/facts (in addition to the action snapshot). Absent on v1 adversarial
   * cases for backward compatibility. Runtime-validated via validateRuleContextV2.
   */
  readonly ruleContext?: RuleContextV2;
}

export interface AdversarialFailedCase {
  readonly caseId: string;
  readonly attackType: AdversarialAttackType;
  readonly actualDecision: string;
  readonly expectedDecision: string;
  readonly rationale: string;
}

export interface EvaluatorCodeReview {
  readonly intentConsistency: {
    readonly aligned: boolean;
    readonly explanation: string;
  };
  readonly scopePrecision: {
    readonly verdict: 'precise' | 'too_broad' | 'too_narrow';
    readonly explanation: string;
  };
  readonly traceCoverage: {
    readonly sufficient: boolean;
    readonly gaps: readonly string[];
    readonly explanation: string;
  };
}

export interface EvaluatorAdversarialResult {
  readonly passed: boolean;
  readonly failedCases: readonly AdversarialFailedCase[];
}

/**
 * PRI-630 收敛契约: 第二轮及之后,评估器必须对上轮 review contract 的每个
 * 稳定需求 id 裁定 resolved / still_open / regressed。
 */
export type PriorRequirementStatus = 'resolved' | 'still_open' | 'regressed';

export interface PriorRequirementStatusEntry {
  readonly id: string;
  readonly status: PriorRequirementStatus;
}

export interface EvaluatorEvaluation {
  readonly decision: 'approved' | 'needs_revision' | 'rejected';
  readonly summary: string;
  readonly score: number;
  readonly strengths: readonly string[];
  readonly concerns: readonly string[];
  readonly requiredChanges: readonly string[];
  /** PRI-630: 上轮需求的逐条核销 (仅有上轮上下文时合法;首轮省略) */
  readonly priorRequirementStatuses?: readonly PriorRequirementStatusEntry[];
  /**
   * PRI-630 P1 评审修复: 输入需求的 ledger echo ({id, statement, status}) —
   * 下一轮上下文的身份载体,保证 requirement id 跨轮稳定。
   */
  readonly requirementLedger?: readonly {
    readonly id: string;
    readonly statement: string;
    readonly status: PriorRequirementStatus;
  }[];
}

export interface EvaluatorSourceTrace {
  readonly artificerArtifactId: string;
  readonly scribeArtifactId?: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

export interface EvaluatorOutputV1 {
  readonly taskId: string;
  readonly sourceArtificerArtifactId: string;
  readonly evaluation: EvaluatorEvaluation;
  readonly sourceTrace: EvaluatorSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
}

/**
 * EvaluatorOutputV2 — V1 plus code review + adversarial attack fields
 * (PRD Decision 2, ADR-0014 Amendment 2026-06-17).
 *
 * All V2 fields are optional: they appear only when the upstream Artificer
 * output is V2 (code-bearing). V1 Artificer → Evaluator skips code review
 * entirely (no codeReview, no adversarialCases). Use `isEvaluatorOutputV2()`
 * after `validate()` to decide which assembly path applies.
 *
 * Layer 2 (progressive disclosure, design §6.5) adds two more optional fields:
 *   - painCoverage: how well the dreamer covered the original pain signal
 *   - compressionFidelity: per-dimension coverage of the dreamer 5-dim in the
 *     principle text (required dims only in missingDimensions; optional dims in
 *     optionalUncovered; excluded dims never appear — design §6.5.1)
 */
export interface EvaluatorPainCoverage {
  readonly fullyCovered: boolean;
  readonly uncoveredAspects: readonly string[];
  readonly explanation: string;
}

export interface EvaluatorCompressionFidelity {
  readonly betterDecisionCovered: boolean;
  readonly rationaleCovered: boolean;
  readonly riskLevelCovered: boolean;
  readonly badDecisionCovered: boolean;
  /** Required dimensions missing from the principle text (required-only). */
  readonly missingDimensions: readonly string[];
  /** Optional dimensions not covered (diagnostic only, never flags). */
  readonly optionalUncovered: readonly string[];
  readonly explanation: string;
}

export interface EvaluatorOutputV2 extends EvaluatorOutputV1 {
  readonly codeReview?: EvaluatorCodeReview;
  readonly adversarialCases?: readonly AdversarialCase[];
  readonly adversarialResult?: EvaluatorAdversarialResult;
  /** Layer 2 progressive disclosure (design §6.5). */
  readonly painCoverage?: EvaluatorPainCoverage;
  /** Layer 2 progressive disclosure (design §6.5.1). */
  readonly compressionFidelity?: EvaluatorCompressionFidelity;
}

export const EVALUATOR_DECISIONS = ['approved', 'needs_revision', 'rejected'] as const;

export const PriorRequirementStatusEntrySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal('resolved'),
    Type.Literal('still_open'),
    Type.Literal('regressed'),
  ]),
});

export const RequirementLedgerEntrySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  statement: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal('resolved'),
    Type.Literal('still_open'),
    Type.Literal('regressed'),
  ]),
});

export const EvaluatorEvaluationSchema = Type.Object({
  decision: Type.Union([
    Type.Literal('approved'),
    Type.Literal('needs_revision'),
    Type.Literal('rejected'),
  ]),
  summary: Type.String({ minLength: 1 }),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  strengths: Type.Array(Type.String()),
  concerns: Type.Array(Type.String()),
  requiredChanges: Type.Array(Type.String()),
  priorRequirementStatuses: Type.Optional(Type.Array(PriorRequirementStatusEntrySchema)),
  requirementLedger: Type.Optional(Type.Array(RequirementLedgerEntrySchema)),
});

export const EvaluatorSourceTraceSchema = Type.Object({
  artificerArtifactId: Type.String({ minLength: 1 }),
  scribeArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

export const EvaluatorOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceArtificerArtifactId: Type.String({ minLength: 1 }),
  evaluation: EvaluatorEvaluationSchema,
  sourceTrace: EvaluatorSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
});

export type EvaluatorOutputV1TB = Static<typeof EvaluatorOutputV1Schema>;

export interface EvaluatorValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const ADVERSARIAL_ATTACK_TYPES: ReadonlySet<string> = new Set(['boundary', 'omission', 'inversion']);
const GOLDEN_TRACE_DECISIONS: ReadonlySet<string> = new Set(['allow', 'block', 'propose_correction']);
const SCOPE_VERDICTS: ReadonlySet<string> = new Set(['precise', 'too_broad', 'too_narrow']);

function validateCodeReview(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    errors.push('codeReview must be an object');
    return errors;
  }

  // intentConsistency
  if (!Object.hasOwn(raw, 'intentConsistency') || !isRecord(raw.intentConsistency)) {
    errors.push('codeReview.intentConsistency must be an object');
  } else {
    const ic = raw.intentConsistency;
    if (!Object.hasOwn(ic, 'aligned') || typeof ic.aligned !== 'boolean') {
      errors.push('codeReview.intentConsistency.aligned must be a boolean');
    }
    if (!Object.hasOwn(ic, 'explanation') || typeof ic.explanation !== 'string' || ic.explanation.trim() === '') {
      errors.push('codeReview.intentConsistency.explanation must be a non-empty string');
    }
  }

  // scopePrecision
  if (!Object.hasOwn(raw, 'scopePrecision') || !isRecord(raw.scopePrecision)) {
    errors.push('codeReview.scopePrecision must be an object');
  } else {
    const sp = raw.scopePrecision;
    if (!Object.hasOwn(sp, 'verdict') || typeof sp.verdict !== 'string' || !SCOPE_VERDICTS.has(sp.verdict)) {
      errors.push(`codeReview.scopePrecision.verdict must be one of precise|too_broad|too_narrow, got ${String(sp.verdict)}`);
    }
    if (!Object.hasOwn(sp, 'explanation') || typeof sp.explanation !== 'string' || sp.explanation.trim() === '') {
      errors.push('codeReview.scopePrecision.explanation must be a non-empty string');
    }
  }

  // traceCoverage
  if (!Object.hasOwn(raw, 'traceCoverage') || !isRecord(raw.traceCoverage)) {
    errors.push('codeReview.traceCoverage must be an object');
  } else {
    const tc = raw.traceCoverage;
    if (!Object.hasOwn(tc, 'sufficient') || typeof tc.sufficient !== 'boolean') {
      errors.push('codeReview.traceCoverage.sufficient must be a boolean');
    }
    if (!Object.hasOwn(tc, 'gaps') || !Array.isArray(tc.gaps)) {
      errors.push('codeReview.traceCoverage.gaps must be an array');
    } else if (!tc.gaps.every((g: unknown) => typeof g === 'string')) {
      errors.push('codeReview.traceCoverage.gaps must be an array of strings');
    }
    if (!Object.hasOwn(tc, 'explanation') || typeof tc.explanation !== 'string' || tc.explanation.trim() === '') {
      errors.push('codeReview.traceCoverage.explanation must be a non-empty string');
    }
  }

  return errors;
}

function validateAdversarialCases(raw: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push('adversarialCases must be an array');
    return errors;
  }
  raw.forEach((entry, index) => {
    const prefix = `adversarialCases[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!Object.hasOwn(entry, 'caseId') || typeof entry.caseId !== 'string' || entry.caseId.trim() === '') {
      errors.push(`${prefix}.caseId must be a non-empty string`);
    }
    if (!Object.hasOwn(entry, 'attackType') || typeof entry.attackType !== 'string' || !ADVERSARIAL_ATTACK_TYPES.has(entry.attackType)) {
      errors.push(`${prefix}.attackType must be one of boundary|omission|inversion, got ${String(entry.attackType)}`);
    }
    if (!Object.hasOwn(entry, 'toolName') || typeof entry.toolName !== 'string' || entry.toolName.trim() === '') {
      errors.push(`${prefix}.toolName must be a non-empty string`);
    }
    if (!Object.hasOwn(entry, 'params') || !isRecord(entry.params)) {
      errors.push(`${prefix}.params must be an object`);
    }
    if (
      !Object.hasOwn(entry, 'expectedDecision')
      || typeof entry.expectedDecision !== 'string'
      || !GOLDEN_TRACE_DECISIONS.has(entry.expectedDecision)
    ) {
      errors.push(`${prefix}.expectedDecision must be one of allow|block|propose_correction, got ${String(entry.expectedDecision)}`);
    }
    if (!Object.hasOwn(entry, 'rationale') || typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
      errors.push(`${prefix}.rationale must be a non-empty string`);
    }
    // PRI-485 Phase 6: optional ruleContext. Absent is valid (backward compat
    // with v1 adversarial cases). Present must pass validateRuleContextV2
    // (Runtime Contract Rule 1/2 — never `as` bypass on parsed input).
    if (Object.hasOwn(entry, 'ruleContext') && entry.ruleContext !== undefined) {
      const ctxResult = validateRuleContextV2(entry.ruleContext);
      if (!ctxResult.valid) {
        errors.push(`${prefix}.ruleContext invalid: ${ctxResult.errors.join('; ')}`);
      }
    }
  });
  return errors;
}

function validateAdversarialResult(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    errors.push('adversarialResult must be an object');
    return errors;
  }
  if (!Object.hasOwn(raw, 'passed') || typeof raw.passed !== 'boolean') {
    errors.push('adversarialResult.passed must be a boolean');
  }
  if (!Object.hasOwn(raw, 'failedCases') || !Array.isArray(raw.failedCases)) {
    errors.push('adversarialResult.failedCases must be an array');
  } else {
    raw.failedCases.forEach((entry: unknown, index: number) => {
      const prefix = `adversarialResult.failedCases[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!Object.hasOwn(entry, 'caseId') || typeof entry.caseId !== 'string' || entry.caseId.trim() === '') {
        errors.push(`${prefix}.caseId must be a non-empty string`);
      }
      if (!Object.hasOwn(entry, 'attackType') || typeof entry.attackType !== 'string' || !ADVERSARIAL_ATTACK_TYPES.has(entry.attackType)) {
        errors.push(`${prefix}.attackType must be one of boundary|omission|inversion, got ${String(entry.attackType)}`);
      }
      if (!Object.hasOwn(entry, 'actualDecision') || typeof entry.actualDecision !== 'string') {
        errors.push(`${prefix}.actualDecision must be a string`);
      }
      if (!Object.hasOwn(entry, 'expectedDecision') || typeof entry.expectedDecision !== 'string') {
        errors.push(`${prefix}.expectedDecision must be a string`);
      }
      if (!Object.hasOwn(entry, 'rationale') || typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
        errors.push(`${prefix}.rationale must be a non-empty string`);
      }
    });
  }
  return errors;
}

/**
 * Runtime type guard distinguishing V2 (code-review/adversarial-bearing)
 * evaluator output from V1. A V2 output is one where at least one V2 field
 * is present AND well-formed. Use after `validate()` (Runtime Contract Rule 2).
 */
export function isEvaluatorOutputV2(output: unknown): output is EvaluatorOutputV2 {
  if (!isRecord(output)) return false;
  const hasCodeReview = Object.hasOwn(output, 'codeReview');
  const hasCases = Object.hasOwn(output, 'adversarialCases');
  const hasResult = Object.hasOwn(output, 'adversarialResult');
  // Layer 2 progressive disclosure fields (design §6.5 / 修正五 F8):
  // adding painCoverage / compressionFidelity to the whitelist so a V2 output
  // carrying only these new fields is correctly identified as V2 and its
  // values are preserved (not silently dropped).
  const hasPainCoverage = Object.hasOwn(output, 'painCoverage');
  const hasCompressionFidelity = Object.hasOwn(output, 'compressionFidelity');
  if (!hasCodeReview && !hasCases && !hasResult && !hasPainCoverage && !hasCompressionFidelity) return false;
  return (!hasCodeReview || validateCodeReview(output.codeReview).length === 0)
    && (!hasCases || validateAdversarialCases(output.adversarialCases).length === 0)
    && (!hasResult || validateAdversarialResult(output.adversarialResult).length === 0);
}

export interface EvaluatorValidator {
  validate(output: unknown, taskId: string, expectedSourceArtificerArtifactId?: string, convergence?: EvaluatorConvergenceContext): Promise<EvaluatorValidationResult>;
}

export interface EvaluatorExpectedRequirement {
  /** 上轮分配的稳定 id (req-N) */
  readonly id: string;
  /** 上轮注入上下文的陈述原文 — ledger 必须 verbatim echo */
  readonly statement: string;
}

export interface EvaluatorConvergenceContext {
  /**
   * 评审轮 2 P1: authoritative 修复轮契约 — runner 从上一轮上下文原样传入。
   * repair round 的 priorRequirementStatuses 与 requirementLedger 都以此为准
   * 做机器校验 (存在/完整/不重复/不重编号/statement 原文/status 互洽)。
   */
  readonly expectedRequirements?: readonly EvaluatorExpectedRequirement[];
}

export class DefaultEvaluatorValidator implements EvaluatorValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, @typescript-eslint/max-params -- 4th param is the PRI-630 convergence context (mirrors EvaluatorValidator interface); a params object would break existing call sites
  async validate(output: unknown, taskId: string, expectedSourceArtificerArtifactId?: string, convergence?: EvaluatorConvergenceContext): Promise<EvaluatorValidationResult> {
    const errors: string[] = [];

    if (!isRecord(output)) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (!Object.hasOwn(output, 'taskId')) {
      errors.push('taskId is missing');
    } else if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (!Object.hasOwn(output, 'sourceArtificerArtifactId') || typeof output.sourceArtificerArtifactId !== 'string' || output.sourceArtificerArtifactId.trim() === '') {
      errors.push('sourceArtificerArtifactId must be non-empty string');
    } else if (expectedSourceArtificerArtifactId && output.sourceArtificerArtifactId !== expectedSourceArtificerArtifactId) {
      errors.push(`sourceArtificerArtifactId mismatch: expected ${expectedSourceArtificerArtifactId}, got ${output.sourceArtificerArtifactId}`);
    }

    if (!Object.hasOwn(output, 'evaluation') || !isRecord(output.evaluation)) {
      errors.push('evaluation must be an object');
    } else {
      const ev = output.evaluation;
      if (!Object.hasOwn(ev, 'decision') || !EVALUATOR_DECISIONS.includes(ev.decision as 'approved' | 'needs_revision' | 'rejected')) {
        errors.push(`evaluation.decision must be one of ${EVALUATOR_DECISIONS.join('/')}, got ${String(ev.decision)}`);
      }
      if (!Object.hasOwn(ev, 'summary') || typeof ev.summary !== 'string' || (ev.summary).trim() === '') errors.push('evaluation.summary must be non-empty string');
      if (!Object.hasOwn(ev, 'score') || typeof ev.score !== 'number' || !Number.isFinite(ev.score)) errors.push('evaluation.score must be number');
      else if (ev.score < 0 || ev.score > 1) errors.push('evaluation.score must be in [0, 1]');
      if (!Object.hasOwn(ev, 'strengths') || !Array.isArray(ev.strengths)) errors.push('evaluation.strengths must be an array');
      else if (!ev.strengths.every((e: unknown) => typeof e === 'string')) errors.push('evaluation.strengths must be an array of strings');
      if (!Object.hasOwn(ev, 'concerns') || !Array.isArray(ev.concerns)) errors.push('evaluation.concerns must be an array');
      else if (!ev.concerns.every((e: unknown) => typeof e === 'string')) errors.push('evaluation.concerns must be an array of strings');
      if (!Object.hasOwn(ev, 'requiredChanges') || !Array.isArray(ev.requiredChanges)) errors.push('evaluation.requiredChanges must be an array');
      else if (!ev.requiredChanges.every((e: unknown) => typeof e === 'string')) errors.push('evaluation.requiredChanges must be an array of strings');
      // PRI-630 (SPEC §18.4) schema invariant: needs_revision 必须携带至少一条
      // 可执行修改 — 空清单的 revision 判定是裁决与依据脱节 (链 48371236 轮3)。
      else if (ev.decision === 'needs_revision' && ev.requiredChanges.length === 0) {
        errors.push('evaluation.requiredChanges must be non-empty when decision is needs_revision (PRI-630 convergence invariant)');
      }
      // PRI-630 (SPEC §18.2): 上轮需求核销 — 结构校验 + id/status 枚举
      if (Object.hasOwn(ev, 'priorRequirementStatuses') && ev.priorRequirementStatuses !== undefined) {
        if (!Array.isArray(ev.priorRequirementStatuses)) {
          errors.push('evaluation.priorRequirementStatuses must be an array');
        } else {
          for (const entry of ev.priorRequirementStatuses) {
            if (!isRecord(entry)) {
              errors.push('evaluation.priorRequirementStatuses entries must be objects');
              break;
            }
            if (typeof entry.id !== 'string' || entry.id.trim() === '') {
              errors.push('evaluation.priorRequirementStatuses entries must have non-empty id');
            }
            if (entry.status !== 'resolved' && entry.status !== 'still_open' && entry.status !== 'regressed') {
              errors.push(`evaluation.priorRequirementStatuses status must be resolved/still_open/regressed, got ${String(entry.status)}`);
            }
          }
        }
      }
      // PRI-630 P1 评审修复: requirementLedger 结构校验 (id/statement 非空,
      // status 枚举;『new』是上下文构建侧的状态,evaluator 输出不含)
      if (Object.hasOwn(ev, 'requirementLedger') && ev.requirementLedger !== undefined) {
        if (!Array.isArray(ev.requirementLedger)) {
          errors.push('evaluation.requirementLedger must be an array');
        } else {
          for (const entry of ev.requirementLedger) {
            if (!isRecord(entry)) {
              errors.push('evaluation.requirementLedger entries must be objects');
              break;
            }
            if (typeof entry.id !== 'string' || entry.id.trim() === '') {
              errors.push('evaluation.requirementLedger entries must have non-empty id');
            }
            if (typeof entry.statement !== 'string' || entry.statement.trim() === '') {
              errors.push('evaluation.requirementLedger entries must have non-empty statement');
            }
            if (entry.status !== 'resolved' && entry.status !== 'still_open' && entry.status !== 'regressed') {
              errors.push(`evaluation.requirementLedger status must be resolved/still_open/regressed, got ${String(entry.status)}`);
            }
          }
        }
      }
    }

    if (!Object.hasOwn(output, 'sourceTrace') || !isRecord(output.sourceTrace)) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace;
      if (!Object.hasOwn(st, 'artificerArtifactId') || typeof st.artificerArtifactId !== 'string' || (st.artificerArtifactId).trim() === '') {
        errors.push('sourceTrace.artificerArtifactId must be non-empty string');
      } else if (expectedSourceArtificerArtifactId && st.artificerArtifactId !== expectedSourceArtificerArtifactId) {
        errors.push(`sourceTrace.artificerArtifactId mismatch: expected ${expectedSourceArtificerArtifactId}, got ${st.artificerArtifactId}`);
      }
      if (Object.hasOwn(st, 'scribeArtifactId') && st.scribeArtifactId !== undefined && typeof st.scribeArtifactId !== 'string') {
        errors.push('sourceTrace.scribeArtifactId must be string if present');
      }
      if (Object.hasOwn(st, 'philosopherArtifactId') && st.philosopherArtifactId !== undefined && typeof st.philosopherArtifactId !== 'string') {
        errors.push('sourceTrace.philosopherArtifactId must be string if present');
      }
      if (Object.hasOwn(st, 'dreamerArtifactId') && st.dreamerArtifactId !== undefined && typeof st.dreamerArtifactId !== 'string') {
        errors.push('sourceTrace.dreamerArtifactId must be string if present');
      }
    }

    if (!Object.hasOwn(output, 'risks') || !Array.isArray(output.risks)) {
      errors.push('risks must be an array');
    } else if (!output.risks.every((e: unknown) => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    if (typeof output.sourceArtificerArtifactId === 'string' && output.sourceArtificerArtifactId.trim() !== ''
      && isRecord(output.sourceTrace)
      && Object.hasOwn(output.sourceTrace, 'artificerArtifactId') && typeof output.sourceTrace.artificerArtifactId === 'string'
      && output.sourceArtificerArtifactId !== output.sourceTrace.artificerArtifactId) {
      errors.push('sourceArtificerArtifactId and sourceTrace.artificerArtifactId must match');
    }

    if (!Object.hasOwn(output, 'generatedAt') || typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    // ── V2 fields (optional; present only when Artificer output is V2) ──
    // V1 backward compatibility: absence is valid. Presence requires well-formed
    // structure (fail loud, ERR-009). Detect via Object.hasOwn (ERR-013).
    if (Object.hasOwn(output, 'codeReview')) {
      errors.push(...validateCodeReview(output.codeReview));
    }
    if (Object.hasOwn(output, 'adversarialCases')) {
      errors.push(...validateAdversarialCases(output.adversarialCases));
    }
    if (Object.hasOwn(output, 'adversarialResult')) {
      errors.push(...validateAdversarialResult(output.adversarialResult));
    }

    // 评审轮 2 P1: requirementLedger 从 prompt-only echo 收紧为
    // validator-enforced authoritative contract (机器可验证,不再依赖模型自觉):
    //   statuses   — 每个 expected id 恰好一次 (不缺、不重复、无幻觉 id)
    //   ledger     — 必须存在;每个 expected id 恰好一次;不重编号 (额外 id 拒绝);
    //                statement 与上下文原文一致;status 与 statuses 同 id 一致
    const expectedReqs = convergence?.expectedRequirements;
    if (expectedReqs && expectedReqs.length > 0) {
      const ev = (isRecord(output) && isRecord(output.evaluation)) ? output.evaluation : undefined;
      const statuses = ev && Array.isArray(ev.priorRequirementStatuses) ? ev.priorRequirementStatuses : undefined;
      const ledger = ev && Array.isArray(ev.requirementLedger) ? ev.requirementLedger : undefined;

      if (!statuses) {
        errors.push('evaluation.priorRequirementStatuses is required in a repair round (previous evaluation context was provided)');
      }
      if (!ledger) {
        errors.push('evaluation.requirementLedger is required in a repair round (previous evaluation context was provided)');
      }
      if (statuses && ledger) {
        const statusById = new Map<string, { count: number; status: unknown }>();
        for (const entry of statuses) {
          if (!isRecord(entry) || typeof entry.id !== 'string') continue;
          const prev = statusById.get(entry.id) ?? { count: 0, status: entry.status };
          statusById.set(entry.id, { count: prev.count + 1, status: entry.status });
        }
        const ledgerById = new Map<string, { count: number; statement: unknown; status: unknown }>();
        for (const entry of ledger) {
          if (!isRecord(entry) || typeof entry.id !== 'string') continue;
          const prev = ledgerById.get(entry.id) ?? { count: 0, statement: entry.statement, status: entry.status };
          ledgerById.set(entry.id, { count: prev.count + 1, statement: entry.statement, status: entry.status });
        }
        for (const expected of expectedReqs) {
          const st = statusById.get(expected.id);
          if (st === undefined || st.count === 0) {
            errors.push(`evaluation.priorRequirementStatuses must cover prior requirement id ${expected.id} (missing)`);
          } else if (st.count > 1) {
            errors.push(`evaluation.priorRequirementStatuses id ${expected.id} must appear exactly once (got ${st.count})`);
          }
          const lg = ledgerById.get(expected.id);
          if (lg === undefined || lg.count === 0) {
            errors.push(`evaluation.requirementLedger must cover prior requirement id ${expected.id} (missing or renumbered)`);
          } else if (lg.count > 1) {
            errors.push(`evaluation.requirementLedger id ${expected.id} must appear exactly once (got ${lg.count})`);
          } else {
            if (lg.statement !== expected.statement) {
              errors.push(`evaluation.requirementLedger statement for ${expected.id} must match the authoritative context verbatim (got ${String(lg.statement)})`);
            }
            if (st !== undefined && st.count === 1 && lg.status !== st.status) {
              errors.push(`evaluation.requirementLedger status for ${expected.id} (${String(lg.status)}) must match priorRequirementStatuses (${String(st.status)})`);
            }
          }
        }
        // 幻觉/重编号 id: expected 之外的任何 id 都不允许 (echo 契约)
        const expectedIdSet = new Set(expectedReqs.map((e) => e.id));
        for (const [id] of statusById) {
          if (!expectedIdSet.has(id)) {
            errors.push(`evaluation.priorRequirementStatuses has unexpected id ${id} (not in prior context — renumbering/fabrication)`);
          }
        }
        for (const [id] of ledgerById) {
          if (!expectedIdSet.has(id)) {
            errors.push(`evaluation.requirementLedger has unexpected id ${id} (not in prior context — renumbering/fabrication)`);
          }
        }
      }
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
