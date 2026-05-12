import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { RuleHostInput } from './internalization/rule-host-contracts.js';

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
export type GoldenTraceCase = Static<typeof GoldenTraceCaseSchema>;
export type GoldenTrace = Static<typeof GoldenTraceSchema>;

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

  if ('createdAt' in input && !isParseableTimestamp(input.createdAt)) {
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
): RuleHostInput {
  return {
    action: {
      toolName: snapshot.toolName,
      normalizedPath: overrides.normalizedPath ?? null,
      paramsSummary: { ...snapshot.params },
    },
    workspace: {
      isRiskPath: false,
      planStatus: 'UNKNOWN',
      hasPlanFile: false,
      ...overrides.workspace,
    },
    session: {
      currentGfi: 0,
      recentThinking: false,
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
