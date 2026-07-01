import { Type, type Static } from '@sinclair/typebox';
import type { GoldenTraceDecision } from '../golden-trace.js';
import type { RuleContextV2 } from './rule-context-v2.js';
import { validateRuleContextV2 } from './rule-context-v2.js';

/**
 * Artificer source trace — lineage back to upstream peer artifacts.
 */
export interface ArtificerSourceTrace {
  readonly scribeArtifactId: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

/**
 * Artificer-generated golden trace case input (RuleHost MVP Activation, ADR-0014
 * Amendment 2026-06-17 Decision 1).
 *
 * `expectedDecision` uses `GoldenTraceDecision` ('allow'|'block'|'propose_correction'),
 * NOT `RuleHostDecision`. The sandbox replay layer maps the two enums (see PRD
 * Decision 1 mapping table). `kind='positive'` requires `expectedDecision='allow'`
 * (mirrors `validateGoldenTraceCase` invariant in golden-trace.ts:116).
 */
export interface GoldenTraceCaseInput {
  readonly caseId: string;
  readonly kind: 'positive' | 'negative';
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly expectedDecision: GoldenTraceDecision;
  readonly expectedProposedParams?: Record<string, unknown>;
  readonly expectedApplicationMode?: 'shadow' | 'live';
  readonly ruleContext?: RuleContextV2;
}

/**
 * ArtificerRuleOutput — the UNIFIED Artificer output (PRI-439).
 *
 * Replaces the former V1/V2 dual-version system. `implementationCode` is now
 * MANDATORY; there is no plan-only (V1) acceptance path and no degradation.
 * Missing, invalid, or replay-failing RuleCode fails loud and creates no rule
 * artifact, approval, or activation.
 *
 * `meta`, `taskId`, lineage, and `generatedAt` are server-injected / model-filled
 * per the existing contract; the validator enforces their presence and consistency.
 *
 * PRI-484 (Phase 5): `requiresContextVersion?: 2` declares a v2 rule that may
 * inspect `input.context` and may carry `ruleContext` on its golden trace cases.
 * When absent, the rule is v1 and MUST NOT read input.context (validator rejects
 * any case-level ruleContext on a v1 rule).
 */
export interface ArtificerRuleOutput {
  readonly taskId: string;
  readonly sourceScribeArtifactId: string;
  readonly implementationCode: string;
  readonly goldenTraceCases: readonly GoldenTraceCaseInput[];
  readonly affectedTools: readonly string[];
  readonly implementationSummary: string;
  readonly risks: readonly string[];
  readonly sourceTrace: ArtificerSourceTrace;
  readonly generatedAt: string;
  /** PRI-484 — declare v2 rule that reads input.context. Only `2` is supported. */
  readonly requiresContextVersion?: 2;
  /**
   * PRI-490 — evidence references from BehaviorExamplePack, preserved through
   * the full artifact chain. Required when requiresContextVersion: 2; optional
   * for v1 rules (v1 does not require evidenceRefs).
   */
  readonly evidenceRefs?: readonly string[];
}

export const ArtificerSourceTraceSchema = Type.Object({
  scribeArtifactId: Type.String({ minLength: 1 }),
  philosopherArtifactId: Type.Optional(Type.String({ minLength: 1 })),
  dreamerArtifactId: Type.Optional(Type.String({ minLength: 1 })),
});

export const ArtificerRuleOutputSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceScribeArtifactId: Type.String({ minLength: 1 }),
  implementationCode: Type.String({ minLength: 1 }),
  goldenTraceCases: Type.Array(
    Type.Object({
      caseId: Type.String({ minLength: 1 }),
      kind: Type.Union([Type.Literal('positive'), Type.Literal('negative')]),
      toolName: Type.String({ minLength: 1 }),
      params: Type.Record(Type.String(), Type.Unknown()),
      expectedDecision: Type.Union([
        Type.Literal('allow'),
        Type.Literal('block'),
        Type.Literal('propose_correction'),
      ]),
      expectedProposedParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      expectedApplicationMode: Type.Optional(Type.Union([Type.Literal('shadow'), Type.Literal('live')])),
    }),
    { minItems: 2, maxItems: 10 },
  ),
  affectedTools: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  implementationSummary: Type.String({ minLength: 1 }),
  risks: Type.Array(Type.String()),
  sourceTrace: ArtificerSourceTraceSchema,
  generatedAt: Type.String({ minLength: 1 }),
  // PRI-484 — optional v2 context declaration. Only literal `2` is supported.
  requiresContextVersion: Type.Optional(Type.Literal(2)),
  // PRI-490 — evidence references, required for v2 rules.
  evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export type ArtificerRuleOutputTB = Static<typeof ArtificerRuleOutputSchema>;

export interface ArtificerValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface ArtificerValidator {
  /** Validate untrusted output. Accepts `unknown` — must perform runtime checks (ERR-001). */
  validate(output: unknown, taskId: string, expectedSourceScribeArtifactId?: string): Promise<ArtificerValidationResult>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const GOLDEN_TRACE_DECISIONS: ReadonlySet<string> = new Set(['allow', 'block', 'propose_correction']);
const MAX_GOLDEN_TRACE_CASES = 10;
const MIN_GOLDEN_TRACE_CASES = 2;

/**
 * Validate Artificer's goldenTraceCases input. Mirrors the structural invariants
 * of `validateGoldenTraceCase` / `validateGoldenTrace` in golden-trace.ts but
 * operates on the artificer-input shape (GoldenTraceCaseInput, no sourceRefs).
 * - At least 1 positive + 1 negative case (PRD Decision 1).
 * - 2..10 cases inclusive.
 * - positive case must expect 'allow' (golden-trace.ts:116).
 * - expectedDecision ∈ {allow, block, propose_correction}.
 */
function validateGoldenTraceCasesInput(raw: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push('goldenTraceCases must be an array');
    return errors;
  }
  if (raw.length < MIN_GOLDEN_TRACE_CASES) {
    errors.push(`goldenTraceCases must contain at least ${MIN_GOLDEN_TRACE_CASES} cases (1 positive + 1 negative), got ${raw.length}`);
  }
  if (raw.length > MAX_GOLDEN_TRACE_CASES) {
    errors.push(`goldenTraceCases must contain at most ${MAX_GOLDEN_TRACE_CASES} cases, got ${raw.length}`);
  }

  let hasPositive = false;
  let hasNegative = false;
  raw.forEach((entry, index) => {
    const prefix = `goldenTraceCases[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!Object.hasOwn(entry, 'caseId') || typeof entry.caseId !== 'string' || entry.caseId.trim() === '') {
      errors.push(`${prefix}.caseId must be a non-empty string`);
    }
    if (!Object.hasOwn(entry, 'kind') || (entry.kind !== 'positive' && entry.kind !== 'negative')) {
      errors.push(`${prefix}.kind must be 'positive' or 'negative'`);
    } else if (entry.kind === 'positive') {
      hasPositive = true;
    } else {
      hasNegative = true;
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
    } else if (entry.kind === 'positive' && entry.expectedDecision !== 'allow') {
      errors.push(`${prefix}: positive cases must expect allow (got ${entry.expectedDecision})`);
    }
    // propose_correction requires expectedProposedParams + expectedApplicationMode
    // (mirrors golden-trace.ts:110-114). Enforced here so malformed output
    // fails at validation, not later in the sandbox.
    if (entry.expectedDecision === 'propose_correction') {
      if (!Object.hasOwn(entry, 'expectedProposedParams') || !isRecord(entry.expectedProposedParams)) {
        errors.push(`${prefix}.expectedProposedParams is required when expectedDecision is propose_correction`);
      }
      if (!Object.hasOwn(entry, 'expectedApplicationMode')
        || (entry.expectedApplicationMode !== 'shadow' && entry.expectedApplicationMode !== 'live')) {
        errors.push(`${prefix}.expectedApplicationMode must be shadow or live when expectedDecision is propose_correction`);
      }
    }
  });

  // Only check positive/negative presence when array shape is valid (avoid
  // double-reporting on the same malformed array).
  if (Array.isArray(raw) && raw.length > 0) {
    if (!hasPositive) errors.push('goldenTraceCases must include at least one positive case');
    if (!hasNegative) errors.push('goldenTraceCases must include at least one negative case');
  }

  return errors;
}

function validateAffectedTools(raw: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    errors.push('affectedTools must be an array');
    return errors;
  }
  if (raw.length === 0) {
    errors.push('affectedTools must be a non-empty array');
  }
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push(`affectedTools[${index}] must be a non-empty string`);
    }
  });
  return errors;
}

export class DefaultArtificerValidator implements ArtificerValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: unknown, taskId: string, expectedSourceScribeArtifactId?: string): Promise<ArtificerValidationResult> {
    const errors: string[] = [];

    if (!isRecord(output)) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    const rec = output;

    // ── taskId ──
    if (!Object.hasOwn(rec, 'taskId') || rec.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(rec.taskId)}`);
    }

    // ── sourceScribeArtifactId ──
    if (!Object.hasOwn(rec, 'sourceScribeArtifactId') || typeof rec.sourceScribeArtifactId !== 'string' || rec.sourceScribeArtifactId.trim() === '') {
      errors.push('sourceScribeArtifactId must be non-empty string');
    } else if (expectedSourceScribeArtifactId && rec.sourceScribeArtifactId !== expectedSourceScribeArtifactId) {
      errors.push(`sourceScribeArtifactId mismatch: expected ${expectedSourceScribeArtifactId}, got ${rec.sourceScribeArtifactId}`);
    }

    // ── implementationCode (MANDATORY — no V1 plan-only acceptance) ──
    if (!Object.hasOwn(rec, 'implementationCode') || typeof rec.implementationCode !== 'string' || rec.implementationCode.trim() === '') {
      errors.push('implementationCode must be a non-empty string');
    }

    // ── implementationSummary (MANDATORY) ──
    if (!Object.hasOwn(rec, 'implementationSummary') || typeof rec.implementationSummary !== 'string' || rec.implementationSummary.trim() === '') {
      errors.push('implementationSummary must be a non-empty string');
    }

    // ── goldenTraceCases (MANDATORY) ──
    // PRI-484: ruleContext on a case is only allowed when requiresContextVersion === 2.
    // v1 rules (no requiresContextVersion) MUST NOT carry ruleContext — this is
    // enforced below after the per-case structural validation runs.
    if (!Object.hasOwn(rec, 'goldenTraceCases')) {
      errors.push('goldenTraceCases is required');
    } else {
      const casesErr = validateGoldenTraceCasesInput(rec.goldenTraceCases);
      errors.push(...casesErr);
    }

    // ── requiresContextVersion (PRI-484, optional v2 declaration) ──
    // Only `2` is supported. Any other value (number or non-number) is rejected.
    const hasRequiresContextVersion = Object.hasOwn(rec, 'requiresContextVersion');
    const {requiresContextVersion} = rec;
    const isV2Declared = hasRequiresContextVersion
      && typeof requiresContextVersion === 'number'
      && requiresContextVersion === 2;
    if (hasRequiresContextVersion) {
      if (typeof requiresContextVersion !== 'number' || requiresContextVersion !== 2) {
        errors.push(
          `requiresContextVersion must be 2 (only v2 is supported), got ${String(requiresContextVersion)}`,
        );
      }
    }

    // ── ruleContext consistency (PRI-484) + v2 propose_correction ban (PRI-490) ──
    // Walk the cases once more to enforce the v1/v2 contract on ruleContext.
    // Only runs when the array shape was already accepted (avoid noise on
    // malformed arrays that already produced errors above).
    // PRI-490: v2 seed rules must only emit allow/block — propose_correction
    // is forbidden because seed-user MVP does not support auto-correct.
    if (Array.isArray(rec.goldenTraceCases)) {
      const cases = rec.goldenTraceCases as readonly unknown[];
      for (let i = 0; i < cases.length; i++) {
        const entry = cases[i];
        if (!isRecord(entry)) {
          continue;
        }
        // PRI-490: v2 rules forbid propose_correction
        if (isV2Declared
          && Object.hasOwn(entry, 'expectedDecision')
          && entry.expectedDecision === 'propose_correction') {
          errors.push(
            `goldenTraceCases[${i}].expectedDecision 'propose_correction' is forbidden in v2 seed rules (only allow/block permitted)`,
          );
        }
        if (!Object.hasOwn(entry, 'ruleContext')) {
          if (isV2Declared) {
            errors.push(
              `goldenTraceCases[${i}].ruleContext is required when requiresContextVersion: 2 is declared`,
            );
          }
          continue;
        }
        const ctxValue = entry.ruleContext;
        if (!isV2Declared) {
          errors.push(
            `goldenTraceCases[${i}].ruleContext is only allowed when requiresContextVersion: 2 is declared (v1 rules must not read input.context)`,
          );
          continue;
        }
        // v2 declared: validate the ruleContext structurally (ERR-001, ERR-076).
        if (ctxValue === undefined) {
          errors.push(
            `goldenTraceCases[${i}].ruleContext is required when requiresContextVersion: 2 is declared`,
          );
          continue;
        }
        const ctxResult = validateRuleContextV2(ctxValue);
        if (!ctxResult.valid) {
          errors.push(`goldenTraceCases[${i}].ruleContext invalid: ${ctxResult.errors.join('; ')}`);
        }
      }
    }

    // ── affectedTools (MANDATORY) ──
    if (!Object.hasOwn(rec, 'affectedTools')) {
      errors.push('affectedTools is required');
    } else {
      const toolsErr = validateAffectedTools(rec.affectedTools);
      errors.push(...toolsErr);
    }

    // ── sourceTrace ──
    if (!Object.hasOwn(rec, 'sourceTrace') || !isRecord(rec.sourceTrace)) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = rec.sourceTrace;
      if (!Object.hasOwn(st, 'scribeArtifactId') || typeof st.scribeArtifactId !== 'string' || st.scribeArtifactId.trim() === '') {
        errors.push('sourceTrace.scribeArtifactId must be non-empty string');
      } else if (expectedSourceScribeArtifactId && st.scribeArtifactId !== expectedSourceScribeArtifactId) {
        errors.push(`sourceTrace.scribeArtifactId mismatch: expected ${expectedSourceScribeArtifactId}, got ${st.scribeArtifactId}`);
      }
      if (Object.hasOwn(st, 'philosopherArtifactId') && st.philosopherArtifactId !== undefined) {
        if (typeof st.philosopherArtifactId !== 'string' || st.philosopherArtifactId.trim() === '') {
          errors.push('sourceTrace.philosopherArtifactId must be non-empty string if present');
        }
      }
      if (Object.hasOwn(st, 'dreamerArtifactId') && st.dreamerArtifactId !== undefined) {
        if (typeof st.dreamerArtifactId !== 'string' || st.dreamerArtifactId.trim() === '') {
          errors.push('sourceTrace.dreamerArtifactId must be non-empty string if present');
        }
      }
    }

    // ── risks ──
    if (!Object.hasOwn(rec, 'risks') || !Array.isArray(rec.risks)) {
      errors.push('risks must be an array');
    } else if (!rec.risks.every((e: unknown) => typeof e === 'string')) {
      errors.push('risks must be an array of strings');
    }

    // ── lineage consistency: sourceScribeArtifactId ↔ sourceTrace.scribeArtifactId ──
    if (typeof rec.sourceScribeArtifactId === 'string' && rec.sourceScribeArtifactId.trim() !== ''
      && isRecord(rec.sourceTrace)
      && Object.hasOwn(rec.sourceTrace, 'scribeArtifactId')
      && typeof rec.sourceTrace.scribeArtifactId === 'string'
      && rec.sourceScribeArtifactId !== rec.sourceTrace.scribeArtifactId) {
      errors.push('sourceScribeArtifactId and sourceTrace.scribeArtifactId must match');
    }

    // ── generatedAt ──
    if (!Object.hasOwn(rec, 'generatedAt') || typeof rec.generatedAt !== 'string' || rec.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    }

    // ── evidenceRefs (PRI-490) ──
    // v2 rules MUST have evidenceRefs (non-empty array of non-empty strings).
    // v1 rules MAY have evidenceRefs but are not required to (backward compatible).
    if (isV2Declared) {
      if (!Object.hasOwn(rec, 'evidenceRefs') || !Array.isArray(rec.evidenceRefs) || rec.evidenceRefs.length === 0) {
        errors.push('evidenceRefs is required and must be a non-empty array for v2 rules');
      } else if (!rec.evidenceRefs.every((e: unknown) => typeof e === 'string' && e.trim() !== '')) {
        errors.push('evidenceRefs must be an array of non-empty strings');
      }
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
