/**
 * ScribeOutputV1 — Output schema for the Scribe peer runner.
 *
 * The Scribe reads a Philosopher artifact and produces a formal principle
 * draft with statement, rationale, applicability, and anti-patterns.
 * This is the third stage in the internalization pipeline
 * (Dreamer → Philosopher → Scribe → Artificer).
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import { Type, type Static } from '@sinclair/typebox';
import type { IntentContractV1, ScribeExecutionConditionsV1 } from './intent-contract.js';
import { isValidIntentContractV1, isValidScribeExecutionConditionsV1 } from './intent-contract.js';

export interface ScribePrincipleDraft {
  readonly title: string;
  readonly statement: string;
  readonly rationale: string;
  readonly applicability: readonly string[];
  readonly antiPatterns: readonly string[];
  readonly confidence: number;
}

export interface ScribeSourceTrace {
  readonly dreamerArtifactId?: string;
  readonly philosopherArtifactId: string;
}

export interface ScribeOutputV1 {
  readonly taskId: string;
  readonly sourcePhilosopherArtifactId: string;
  readonly principleDraft: ScribePrincipleDraft;
  readonly sourceTrace: ScribeSourceTrace;
  readonly risks: readonly string[];
  readonly generatedAt: string;
  /**
   * PRI-703 Phase 1 (Owner decision 2026-09-07): structured Owner-intent
   * contract — the single alignment anchor for rule generation / evaluation /
   * repair. Optional on the wire for backward compatibility: scribe outputs
   * that predate this field lack it and downstream stages degrade
   * best-effort (rc-9 observable, never silent). Present-but-malformed is a
   * hard validator rejection — a corrupted anchor is worse than none.
   */
  readonly intentContract?: IntentContractV1;
  /**
   * SPEC-RULECODE-QUALITY-001 A1: machine-readable execution conditions —
   * which trusted external facts (e.g. design_approval) the principle's
   * enforcement depends on, each grounded in Owner-attributed text. Consumed
   * by the artificer intent preflight BEFORE any generation call. Optional on
   * the wire (legacy scribe artifacts predate it); present-but-malformed is
   * a hard validator rejection — a corrupted condition record is worse than
   * none. The declaration is a SCRIBE semantic judgment, never an Owner
   * decision; the fact itself is resolved by a host trusted-facts port.
   */
  readonly executionConditions?: ScribeExecutionConditionsV1;
  /**
   * r6 review fix (P1-2, 2026-10-12): structured channel for Owner-attributed
   * requirements the scribe did NOT carry into the intentContract (narrowed,
   * partially carried, or dropped). Each entry states the requirement and why
   * it is not carried. This is the machine-consumed governance surface — the
   * pipeline surfaces it on the result and the evaluator is obliged to treat
   * these requirements as uncovered (never satisfied by implication); an
   * unresolved gap can only be closed by the Owner. Optional on the wire;
   * present-but-malformed is a hard validator rejection.
   */
  readonly ownerRequirementGaps?: readonly string[];
}

export const ScribePrincipleDraftSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  statement: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  applicability: Type.Array(Type.String()),
  antiPatterns: Type.Array(Type.String()),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export const ScribeSourceTraceSchema = Type.Object({
  dreamerArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.String({ minLength: 1 }),
});

const ScribeIntentContractSchema = Type.Object({
  ownerIntent: Type.String({ minLength: 1 }),
  targetBehavior: Type.String({ minLength: 1 }),
  forbiddenBehavior: Type.String({ minLength: 1 }),
  evidenceSource: Type.String({ minLength: 1 }),
  validationExpectation: Type.String({ minLength: 1 }),
});

const ScribeExecutionConditionsSchema = Type.Object({
  version: Type.Literal(1),
  requiredFacts: Type.Array(Type.Object({
    factKind: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
    textualBasis: Type.String({ minLength: 1 }),
  })),
});

export const ScribeOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourcePhilosopherArtifactId: Type.String({ minLength: 1 }),
  principleDraft: ScribePrincipleDraftSchema,
  sourceTrace: ScribeSourceTraceSchema,
  risks: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
  // New Scribe generation requires both RuleCode anchors. Legacy artifact
  // readers remain compatible through the optional fields on ScribeOutputV1
  // and the extraction helpers; this schema only describes new model output.
  intentContract: ScribeIntentContractSchema,
  executionConditions: ScribeExecutionConditionsSchema,
  // r6 review fix (P1-2): optional structured coverage-gap channel. This
  // schema is a LIVE runtime contract (output-schema-registry → pi-ai
  // adapter → response_format json_schema with additionalProperties:false on
  // strict decoding endpoints) — an absent field would make declared gaps
  // IMPOSSIBLE for the model to emit there, silently disabling the whole
  // disposition path. Element-level validation stays with the hand-rolled
  // DefaultScribeValidator (same discipline as intentContract).
  ownerRequirementGaps: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export type ScribeOutputV1TB = Static<typeof ScribeOutputV1Schema>;

export interface ScribeValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface ScribeValidator {
  /**
   * Validate untrusted LLM/runtime output.
   *
   * Receives `unknown` — must perform runtime validation before
   * treating as ScribeOutputV1 (ERR-001, ERR-005).
   */
  validate(
    output: unknown,
    taskId: string,
    expectedSourcePhilosopherArtifactId?: string,
  ): Promise<ScribeValidationResult>;
}

/** Runtime type guard: true if v is a non-null plain object (not an array). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class DefaultScribeValidator implements ScribeValidator {
  private readonly requireRuleCodeContracts: boolean;

  constructor(options: { readonly requireRuleCodeContracts?: boolean } = {}) {
    this.requireRuleCodeContracts = options.requireRuleCodeContracts ?? false;
  }

  async validate(
    output: unknown,
    taskId: string,
    expectedSourcePhilosopherArtifactId?: string,
  ): Promise<ScribeValidationResult> {
    const errors: string[] = [];

    if (!isRecord(output)) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    // taskId — required field (ERR-013: use Object.hasOwn)
    if (!Object.hasOwn(output, 'taskId') || output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    // sourcePhilosopherArtifactId — required, non-empty string (ERR-013)
    if (!Object.hasOwn(output, 'sourcePhilosopherArtifactId') || typeof output.sourcePhilosopherArtifactId !== 'string' || output.sourcePhilosopherArtifactId.trim() === '') {
      errors.push('sourcePhilosopherArtifactId must be non-empty string');
    } else if (expectedSourcePhilosopherArtifactId && output.sourcePhilosopherArtifactId !== expectedSourcePhilosopherArtifactId) {
      errors.push(`sourcePhilosopherArtifactId mismatch: expected ${expectedSourcePhilosopherArtifactId}, got ${output.sourcePhilosopherArtifactId}`);
    }

    // principleDraft — required nested object (ERR-001, ERR-005: use isRecord, not as)
    if (!Object.hasOwn(output, 'principleDraft') || !isRecord(output.principleDraft)) {
      errors.push('principleDraft must be an object');
    } else {
      const pd = output.principleDraft;
      if (!Object.hasOwn(pd, 'title') || typeof pd.title !== 'string' || pd.title.trim() === '') errors.push('principleDraft.title must be non-empty string');
      if (!Object.hasOwn(pd, 'statement') || typeof pd.statement !== 'string' || pd.statement.trim() === '') errors.push('principleDraft.statement must be non-empty string');
      if (!Object.hasOwn(pd, 'rationale') || typeof pd.rationale !== 'string' || pd.rationale.trim() === '') errors.push('principleDraft.rationale must be non-empty string');
      if (!Object.hasOwn(pd, 'applicability') || !Array.isArray(pd.applicability)) errors.push('principleDraft.applicability must be an array');
      else if (!pd.applicability.every((e: unknown) => typeof e === 'string')) errors.push('principleDraft.applicability must be an array of strings');
      if (!Object.hasOwn(pd, 'antiPatterns') || !Array.isArray(pd.antiPatterns)) errors.push('principleDraft.antiPatterns must be an array');
      else if (!pd.antiPatterns.every((e: unknown) => typeof e === 'string')) errors.push('principleDraft.antiPatterns must be an array of strings');
      if (!Object.hasOwn(pd, 'confidence') || typeof pd.confidence !== 'number') errors.push('principleDraft.confidence must be number');
      else if (pd.confidence < 0 || pd.confidence > 1) errors.push('principleDraft.confidence must be in [0, 1]');
    }

    // sourceTrace — required nested object (ERR-001, ERR-005: use isRecord, not as)
    if (!Object.hasOwn(output, 'sourceTrace') || !isRecord(output.sourceTrace)) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace;
      if (!Object.hasOwn(st, 'philosopherArtifactId') || typeof st.philosopherArtifactId !== 'string' || st.philosopherArtifactId.trim() === '') {
        errors.push('sourceTrace.philosopherArtifactId must be non-empty string');
      } else if (expectedSourcePhilosopherArtifactId && st.philosopherArtifactId !== expectedSourcePhilosopherArtifactId) {
        errors.push(`sourceTrace.philosopherArtifactId mismatch: expected ${expectedSourcePhilosopherArtifactId}, got ${st.philosopherArtifactId}`);
      }
      // dreamerArtifactId — optional, but if present must be non-empty string
      if (Object.hasOwn(st, 'dreamerArtifactId') && st.dreamerArtifactId !== undefined) {
        if (typeof st.dreamerArtifactId !== 'string' || st.dreamerArtifactId.trim() === '') {
          errors.push('sourceTrace.dreamerArtifactId must be non-empty string when present');
        }
      }
    }

    // risks — required array of strings (ERR-005: validate element types)
    if (!Object.hasOwn(output, 'risks') || !Array.isArray(output.risks)) {
      errors.push('risks must be an array');
    } else if (!output.risks.every((e: unknown) => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    // ownerRequirementGaps — r6 review fix (P1-2): structured governance
    // channel for uncovered Owner-attributed requirements. Optional on the
    // wire; present-but-malformed is a hard rejection (a corrupted gap
    // disclosure is worse than none — the pipeline surfaces it to the Owner).
    if (Object.hasOwn(output, 'ownerRequirementGaps') && output.ownerRequirementGaps !== undefined) {
      if (!Array.isArray(output.ownerRequirementGaps)) {
        errors.push('ownerRequirementGaps must be an array');
      } else if (!output.ownerRequirementGaps.every((e: unknown) => typeof e === 'string' && (e).trim() !== '')) {
        errors.push('ownerRequirementGaps must be an array of non-empty strings');
      }
    }

    // intentContract — PRI-703 Phase 1: optional, but present-but-malformed
    // is a hard rejection (the contract is the alignment anchor for rule
    // generation / evaluation / repair; a corrupted anchor is worse than none).
    const hasIntentContract = Object.hasOwn(output, 'intentContract') && output.intentContract !== undefined;
    if (this.requireRuleCodeContracts && !hasIntentContract) {
      errors.push('intentContract is required for new RuleCode generation');
    }
    if (hasIntentContract) {
      if (!isValidIntentContractV1(output.intentContract)) {
        errors.push('intentContract must contain non-empty string fields: ownerIntent, targetBehavior, forbiddenBehavior, evidenceSource, validationExpectation');
      }
    }

    // executionConditions — SPEC-RULECODE-QUALITY-001 A1: optional, but
    // present-but-malformed is a hard rejection (a corrupted condition
    // declaration must surface at the trust boundary, not downstream).
    const hasExecutionConditions = Object.hasOwn(output, 'executionConditions') && output.executionConditions !== undefined;
    if (this.requireRuleCodeContracts && !hasExecutionConditions) {
      errors.push('executionConditions is required for new RuleCode generation');
    }
    if (hasExecutionConditions) {
      if (!isValidScribeExecutionConditionsV1(output.executionConditions)) {
        errors.push('executionConditions must be { version: 1, requiredFacts: [{ factKind: non-empty string, required: boolean, textualBasis: non-empty string }] }');
      }
    }

    // generatedAt — required, non-empty string (ERR-013)
    if (!Object.hasOwn(output, 'generatedAt') || typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}

/**
 * EP002-R3 (live evidence, glm-5.3-flash structured-output path): the model
 * sometimes serializes the nested `intentContract` object as a JSON-encoded
 * STRING. The information content is complete — only the carrier is wrong —
 * so present-but-string is normalized in place to the parsed object before
 * validation instead of dead-ending as output_invalid. A string that does not
 * parse, or parses to a non-object, is left untouched and fails validation
 * loudly (rc-2/rc-9: normalization never invents data, never silently drops).
 *
 * Mutates `untrustedOutput` in place (BasePeerRunner.postFetchTransform
 * contract) and returns true when a normalization happened.
 */
export function normalizeStringEncodedIntentContract(untrustedOutput: unknown): boolean {
  if (typeof untrustedOutput !== 'object' || untrustedOutput === null || Array.isArray(untrustedOutput)) return false;
  if (!Object.hasOwn(untrustedOutput, 'intentContract')) return false;
  const raw: unknown = Reflect.get(untrustedOutput, 'intentContract');
  if (typeof raw !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // unparseable string → validator rejects loudly
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  Reflect.set(untrustedOutput, 'intentContract', parsed);
  return true;
}
