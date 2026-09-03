import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { RuleHostInput } from './internalization/rule-host-contracts.js';
import type { RuleContextV2 } from './internalization/rule-context-v2.js';
import type { GoldenTraceCaseInput } from './internalization/artificer-output.js';
import { buildRuleHostAction } from './internalization/rule-host-input-builder.js';
import type { ToolSemanticRegistry } from './internalization/tool-semantic-registry.js';

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
const ISO_8601_UTC_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$';

export const CorrectionApplicationModeSchema = Type.Union([
  Type.Literal('shadow'),
  Type.Literal('live'),
]);

// GoldenTraceDecision represents test expectations, not runtime decisions.
// Differs from RuleHostDecision ('allow'|'block'|'requireApproval'): 'propose_correction'
// replaces 'requireApproval' per ADR-0004 shadow-first correction semantics.
// PRI-114/115 will reconcile these via the replay engine.
export const GoldenTraceDecisionSchema = Type.Union([
  Type.Literal('allow'),
  Type.Literal('block'),
  Type.Literal('propose_correction'),
]);

export const GoldenTraceCaseKindSchema = Type.Union([
  Type.Literal('negative'),
  Type.Literal('positive'),
]);

export const GoldenTraceCaseSchema = Type.Object({
  caseId: Type.String({ minLength: 1 }),
  kind: GoldenTraceCaseKindSchema,
  toolName: Type.String({ minLength: 1 }),
  params: UnknownRecordSchema,
  expectedDecision: GoldenTraceDecisionSchema,
  expectedProposedParams: Type.Optional(UnknownRecordSchema),
  expectedApplicationMode: Type.Optional(CorrectionApplicationModeSchema),
  sourceRefs: Type.Optional(Type.Object({
    painId: Type.Optional(Type.String({ minLength: 1 })),
    candidateId: Type.Optional(Type.String({ minLength: 1 })),
    artifactId: Type.Optional(Type.String({ minLength: 1 })),
    auditEventId: Type.Optional(Type.String({ minLength: 1 })),
  })),
  ruleContext: Type.Optional(Type.Unknown()),
});

export const GoldenTraceSchema = Type.Object({
  traceId: Type.String({ minLength: 1 }),
  sourcePainId: Type.Optional(Type.String({ minLength: 1 })),
  sourceCandidateId: Type.Optional(Type.String({ minLength: 1 })),
  sourceArtifactId: Type.Optional(Type.String({ minLength: 1 })),
  cases: Type.Array(GoldenTraceCaseSchema, { minItems: 1 }),
  createdAt: Type.String({ pattern: ISO_8601_UTC_PATTERN }),
  version: Type.Literal(1),
});

export type CorrectionApplicationMode = Static<typeof CorrectionApplicationModeSchema>;
export type GoldenTraceDecision = Static<typeof GoldenTraceDecisionSchema>;
export type GoldenTraceCaseKind = Static<typeof GoldenTraceCaseKindSchema>;
export type GoldenTraceCase = Omit<Static<typeof GoldenTraceCaseSchema>, 'ruleContext'> & {
  readonly ruleContext?: RuleContextV2;
};
export type GoldenTrace = Omit<Static<typeof GoldenTraceSchema>, 'cases'> & {
  cases: GoldenTraceCase[];
};

export interface GoldenTraceValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ToolCallSnapshot {
  toolName: string;
  params: Record<string, unknown>;
}

export interface SyntheticRuleHostInputOverrides {
  workspace?: Partial<RuleHostInput['workspace']>;
  session?: Partial<RuleHostInput['session']>;
  evolution?: Partial<RuleHostInput['evolution']>;
  derived?: Partial<RuleHostInput['derived']>;
  normalizedPath?: string | null;
  context?: RuleContextV2;
}

/**
 * Options for createSyntheticRuleHostInput (PRI-439 Phase 3).
 *
 * When `projectDir` is provided and `overrides.normalizedPath` is NOT set,
 * the action snapshot is built via `buildRuleHostAction` — extracting the
 * file path from `snapshot.params` and normalizing it against `projectDir`.
 * This produces a non-null `normalizedPath` that matches the production
 * OpenClaw Gate, so path-based rules can be validated in Golden Trace replay.
 *
 * When `projectDir` is NOT provided, `normalizedPath` falls back to `null`
 * (backwards compat with existing callers that don't have a project dir).
 *
 * PRI-634-F Phase 2: when `toolSemantics` is provided, the canonical kind is
 * resolved from the SAME registry the production gate uses, echoed onto
 * `action.canonicalKind`, and used to derive the bash/write extraction hints
 * inside buildRuleHostAction — closing the replay/production divergence where
 * bash command extraction and write-tool synthetic paths never fired in
 * replay. Absent → legacy behavior (no canonicalKind, no derived hints).
 */
export interface CreateSyntheticRuleHostInputOptions {
  projectDir?: string;
  toolSemantics?: ToolSemanticRegistry;
}

export interface GoldenTraceFixtureInput {
  toolName: string;
  negativeParams: Record<string, unknown>;
  positiveParams: Record<string, unknown>;
  expectedDecision: GoldenTraceDecision;
  expectedProposedParams?: Record<string, unknown>;
  expectedApplicationMode?: CorrectionApplicationMode;
  sourcePainId?: string;
  sourceCandidateId?: string;
  sourceArtifactId?: string;
  createdAt?: string;
}

function collectSchemaErrors(schema: Parameters<typeof Value.Errors>[0], input: unknown): string[] {
  return [...Value.Errors(schema, input)].map((error) => String(error.path || error.message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'case';
}

function isParseableTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateGoldenTraceCase(input: unknown): GoldenTraceValidationResult {
  const errors = collectSchemaErrors(GoldenTraceCaseSchema, input);
  if (errors.length === 0 && isRecord(input)) {
    if (input.expectedDecision === 'propose_correction' && !isRecord(input.expectedProposedParams)) {
      errors.push('expectedProposedParams is required when expectedDecision is propose_correction');
    }
    if (input.expectedDecision === 'propose_correction' && input.expectedApplicationMode === undefined) {
      errors.push('expectedApplicationMode is required when expectedDecision is propose_correction');
    }
    if (input.kind === 'positive' && input.expectedDecision !== 'allow') {
      errors.push('positive cases must expect allow');
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateGoldenTrace(input: unknown): GoldenTraceValidationResult {
  const errors = collectSchemaErrors(GoldenTraceSchema, input);
  if (!isRecord(input)) {
    return { valid: false, errors };
  }

  if (Object.hasOwn(input, 'createdAt') && !isParseableTimestamp(input.createdAt)) {
    errors.push('createdAt must be a parseable ISO-8601 timestamp');
  }

  if (Array.isArray(input.cases)) {
    let hasNegative = false;
    let hasPositive = false;
    input.cases.forEach((traceCase, index) => {
      const result = validateGoldenTraceCase(traceCase);
      if (!result.valid) {
        errors.push(...result.errors.map((error) => `cases[${index}].${error}`));
      }
      if (isRecord(traceCase) && traceCase.kind === 'negative') hasNegative = true;
      if (isRecord(traceCase) && traceCase.kind === 'positive') hasPositive = true;
    });
    if (!hasNegative) errors.push('cases must include at least one negative case');
    if (!hasPositive) errors.push('cases must include at least one positive case');
  }

  return { valid: errors.length === 0, errors };
}

export function createSyntheticRuleHostInput(
  snapshot: ToolCallSnapshot,
  overrides: SyntheticRuleHostInputOverrides = {},
  options: CreateSyntheticRuleHostInputOptions = {},
): RuleHostInput {
  // PRI-439 Phase 3: when projectDir is provided and normalizedPath is not
  // explicitly overridden, build the action snapshot via the pure
  // buildRuleHostAction function — extracting the file path from params and
  // normalizing it. This produces the same normalizedPath as the production
  // OpenClaw Gate, so path-based rules can be validated in Golden Trace replay.
  //
  // PRI-634-F Phase 2: with toolSemantics, the canonical kind flows into the
  // same builder call production makes, so hint derivation + canonicalKind
  // echo are identical on both paths.
  const canonicalKind = options.toolSemantics?.resolve(snapshot.toolName);
  const action =
    options.projectDir && overrides.normalizedPath === undefined
      ? buildRuleHostAction(snapshot.toolName, snapshot.params, options.projectDir,
        canonicalKind !== undefined ? { canonicalKind } : {})
      : {
          toolName: snapshot.toolName,
          normalizedPath: overrides.normalizedPath ?? null,
          paramsSummary: { ...snapshot.params },
          ...(canonicalKind !== undefined ? { canonicalKind } : {}),
        };

  return {
    action,
    workspace: {
      isRiskPath: false,
      ...overrides.workspace,
    },
    session: {
      currentGfi: 0,
      ...overrides.session,
    },
    evolution: {
      epTier: 0,
      ...overrides.evolution,
    },
    derived: {
      estimatedLineChanges: 0,
      bashRisk: 'unknown',
      ...overrides.derived,
    },
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
  };
}

export function createGoldenTraceFixture(input: GoldenTraceFixtureInput): GoldenTrace {
  return {
    traceId: `golden-trace-${slug(input.toolName)}-${slug(input.expectedDecision)}`,
    sourcePainId: input.sourcePainId,
    sourceCandidateId: input.sourceCandidateId,
    sourceArtifactId: input.sourceArtifactId,
    version: 1,
    createdAt: input.createdAt ?? '2026-05-11T00:00:00.000Z',
    cases: [
      {
        caseId: 'negative-1',
        kind: 'negative',
        toolName: input.toolName,
        params: { ...input.negativeParams },
        expectedDecision: input.expectedDecision,
        expectedProposedParams: input.expectedProposedParams ? { ...input.expectedProposedParams } : undefined,
        expectedApplicationMode: input.expectedApplicationMode ?? (
          input.expectedDecision === 'propose_correction' ? 'shadow' : undefined
        ),
      },
      {
        caseId: 'positive-1',
        kind: 'positive',
        toolName: input.toolName,
        params: { ...input.positiveParams },
        expectedDecision: 'allow',
      },
    ],
  };
}

/**
 * Input for buildGoldenTraceFromArtificer (RuleHost MVP Activation, PRD Decision 5).
 *
 * `cases` accepts a shape compatible with both the strict `GoldenTraceCaseInput`
 * interface (artificer TS callers) and the TypeBox `GoldenTraceCaseInputTypebox`
 * static type (L2 tool params decoded from JSON, where `ruleContext` is `unknown`
 * until runtime-validated). Each entry is re-validated by `validateGoldenTraceCase`
 * before use, so a loose input type here is safe — Runtime Contract Rule 4.
 */
export interface BuildGoldenTraceFromArtificerInput {
  readonly cases: readonly (Omit<GoldenTraceCaseInput, 'ruleContext'> & { readonly ruleContext?: unknown })[];
  readonly sourceArtifactId?: string;
  /** Override for createdAt; defaults to current ISO-8601 UTC timestamp. */
  readonly createdAt?: string;
}

export type BuildGoldenTraceResult =
  | { readonly ok: true; readonly trace: GoldenTrace }
  | { readonly ok: false; readonly reason: string };

/**
 * Wrap Artificer's 2-10 GoldenTraceCaseInput[] into a complete GoldenTrace with
 * metadata (traceId / createdAt / version). Unlike createGoldenTraceFixture
 * (fixed 2-case shape), this preserves an arbitrary number of cases.
 *
 * Returns a discriminated union rather than throwing: 0 cases, missing
 * positive/negative partner, or malformed input yields `{ ok: false, reason }`
 * so the caller (Evaluator assembly) can degrade gracefully without try/catch.
 *
 * The produced GoldenTrace is validated against validateGoldenTrace() before
 * returning; a result with ok=true always passes structural validation.
 */
export function buildGoldenTraceFromArtificer(input: BuildGoldenTraceFromArtificerInput): BuildGoldenTraceResult {
  if (!Array.isArray(input.cases)) {
    return { ok: false, reason: 'cases must be an array' };
  }
  if (input.cases.length === 0) {
    return { ok: false, reason: 'cases must contain at least 1 positive + 1 negative case, got 0' };
  }

  let hasPositive = false;
  let hasNegative = false;
  const mappedCases: GoldenTraceCase[] = [];
  for (const entry of input.cases) {
    // GoldenTraceCaseInput and GoldenTraceCase share the same structural shape;
    // we re-validate each entry defensively (Runtime Contract Rule 4) rather
    // than trust the upstream type, since this function may receive values
    // read back from an artifact's contentJson.
    const caseResult = validateGoldenTraceCase(entry);
    if (!caseResult.valid) {
      return { ok: false, reason: `invalid golden trace case: ${caseResult.errors.join('; ')}` };
    }
    if (entry.kind === 'positive') hasPositive = true;
    else hasNegative = true;
    mappedCases.push(entry as GoldenTraceCase);
  }

  if (!hasPositive || !hasNegative) {
    const missing = !hasPositive && !hasNegative
      ? 'positive and negative'
      : !hasPositive ? 'positive' : 'negative';
    return { ok: false, reason: `cases must include at least one ${missing} case` };
  }

  const trace: GoldenTrace = {
    traceId: `golden-trace-artificer-${Date.now().toString(36)}`,
    sourceArtifactId: input.sourceArtifactId,
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    cases: mappedCases,
  };

  // Final structural guard: never return a GoldenTrace that fails validation.
  const validation = validateGoldenTrace(trace);
  if (!validation.valid) {
    return { ok: false, reason: `produced trace failed validation: ${validation.errors.join('; ')}` };
  }

  return { ok: true, trace };
}
