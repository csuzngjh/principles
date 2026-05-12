import { Type, type Static } from '@sinclair/typebox';

export interface TrainerRuleCandidate {
  readonly toolScope: string;
  readonly triggerCondition: string;
  readonly proposedDecision: 'allow' | 'block' | 'require_approval' | 'auto_correct';
  readonly proposedCorrection?: {
    readonly description: string;
    readonly proposedParams: unknown;
  };
  readonly rationale: string;
  readonly confidence: number;
}

export interface TrainerSafety {
  readonly limitations: readonly string[];
  readonly falsePositiveRisks: readonly string[];
  readonly requiredReplayCases: readonly string[];
}

export interface TrainerSourceTrace {
  readonly rolloutReviewerArtifactId: string;
  readonly evaluatorArtifactId?: string;
  readonly artificerArtifactId?: string;
  readonly scribeArtifactId?: string;
  readonly philosopherArtifactId?: string;
  readonly dreamerArtifactId?: string;
}

export interface TrainerOutputV1 {
  readonly taskId: string;
  readonly sourceRolloutReviewerArtifactId: string;
  readonly ruleCandidate: TrainerRuleCandidate;
  readonly goldenTraceRefs?: readonly string[];
  readonly inlineGoldenTraceCases?: readonly {
    readonly caseId: string;
    readonly kind: 'negative' | 'positive';
    readonly toolName: string;
    readonly params: unknown;
    readonly expectedDecision: 'allow' | 'block' | 'propose_correction';
    readonly expectedProposedParams?: unknown;
    readonly expectedApplicationMode?: 'shadow' | 'live';
    readonly sourceRefs?: readonly string[];
  }[];
  readonly safety: TrainerSafety;
  readonly sourceTrace: TrainerSourceTrace;
  readonly generatedAt: string;
}

export const TRAINER_DECISIONS = ['allow', 'block', 'require_approval', 'auto_correct'] as const;

export const TrainerRuleCandidateSchema = Type.Object({
  toolScope: Type.String({ minLength: 1 }),
  triggerCondition: Type.String({ minLength: 1 }),
  proposedDecision: Type.Union([
    Type.Literal('allow'),
    Type.Literal('block'),
    Type.Literal('require_approval'),
    Type.Literal('auto_correct'),
  ]),
  proposedCorrection: Type.Optional(Type.Object({
    description: Type.String({ minLength: 1 }),
    proposedParams: Type.Any(),
  })),
  rationale: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export const TrainerSafetySchema = Type.Object({
  limitations: Type.Array(Type.String()),
  falsePositiveRisks: Type.Array(Type.String()),
  requiredReplayCases: Type.Array(Type.String()),
});

export const TrainerSourceTraceSchema = Type.Object({
  rolloutReviewerArtifactId: Type.String({ minLength: 1 }),
  evaluatorArtifactId: Type.Optional(Type.String()),
  artificerArtifactId: Type.Optional(Type.String()),
  scribeArtifactId: Type.Optional(Type.String()),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

export const TrainerOutputV1Schema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceRolloutReviewerArtifactId: Type.String({ minLength: 1 }),
  ruleCandidate: TrainerRuleCandidateSchema,
  goldenTraceRefs: Type.Optional(Type.Array(Type.String())),
  inlineGoldenTraceCases: Type.Optional(Type.Array(Type.Object({
    caseId: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal('negative'), Type.Literal('positive')]),
    toolName: Type.String({ minLength: 1 }),
    params: Type.Any(),
    expectedDecision: Type.Union([
      Type.Literal('allow'),
      Type.Literal('block'),
      Type.Literal('propose_correction'),
    ]),
    expectedProposedParams: Type.Optional(Type.Any()),
    expectedApplicationMode: Type.Optional(Type.Union([
      Type.Literal('shadow'),
      Type.Literal('live'),
    ])),
    sourceRefs: Type.Optional(Type.Array(Type.String())),
  }))),
  safety: TrainerSafetySchema,
  sourceTrace: TrainerSourceTraceSchema,
  generatedAt: Type.String({ minLength: 1 }),
});

export type TrainerOutputV1TB = Static<typeof TrainerOutputV1Schema>;

export interface TrainerValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: string;
}

export interface TrainerValidator {
  validate(output: TrainerOutputV1, taskId: string, expectedSourceRolloutReviewerArtifactId?: string): Promise<TrainerValidationResult>;
}

export class DefaultTrainerValidator implements TrainerValidator {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async validate(output: TrainerOutputV1, taskId: string, expectedSourceRolloutReviewerArtifactId?: string): Promise<TrainerValidationResult> {
    const errors: string[] = [];

    if (typeof output !== 'object' || output === null) {
      return { valid: false, errors: ['Output is not an object'], errorCategory: 'output_invalid' };
    }

    if (output.taskId !== taskId) {
      errors.push(`taskId mismatch: expected ${taskId}, got ${String(output.taskId)}`);
    }

    if (typeof output.sourceRolloutReviewerArtifactId !== 'string' || output.sourceRolloutReviewerArtifactId.trim() === '') {
      errors.push('sourceRolloutReviewerArtifactId must be non-empty string');
    } else if (expectedSourceRolloutReviewerArtifactId && output.sourceRolloutReviewerArtifactId !== expectedSourceRolloutReviewerArtifactId) {
      errors.push(`sourceRolloutReviewerArtifactId mismatch: expected ${expectedSourceRolloutReviewerArtifactId}, got ${output.sourceRolloutReviewerArtifactId}`);
    }

    if (typeof output.ruleCandidate !== 'object' || output.ruleCandidate === null) {
      errors.push('ruleCandidate must be an object');
    } else {
      const rc = output.ruleCandidate as unknown as Record<string, unknown>;
      if (typeof rc.toolScope !== 'string' || (rc.toolScope).trim() === '') {
        errors.push('ruleCandidate.toolScope must be non-empty string');
      }
      if (typeof rc.triggerCondition !== 'string' || (rc.triggerCondition).trim() === '') {
        errors.push('ruleCandidate.triggerCondition must be non-empty string');
      }
      if (!TRAINER_DECISIONS.includes(rc.proposedDecision as 'allow' | 'block' | 'require_approval' | 'auto_correct')) {
        errors.push(`ruleCandidate.proposedDecision must be one of ${TRAINER_DECISIONS.join('/')}, got ${String(rc.proposedDecision)}`);
      }
      if (typeof rc.rationale !== 'string' || (rc.rationale).trim() === '') {
        errors.push('ruleCandidate.rationale must be non-empty string');
      }
      if (typeof rc.confidence !== 'number' || !Number.isFinite(rc.confidence)) {
        errors.push('ruleCandidate.confidence must be number');
      } else if (rc.confidence < 0 || rc.confidence > 1) {
        errors.push('ruleCandidate.confidence must be in [0, 1]');
      }

      const isAutoCorrect = rc.proposedDecision === 'auto_correct';
      const hasProposedCorrection = rc.proposedCorrection !== undefined && rc.proposedCorrection !== null;
      if (isAutoCorrect && !hasProposedCorrection) {
        errors.push('ruleCandidate.proposedCorrection is required when proposedDecision is auto_correct');
      }
      if (!isAutoCorrect && hasProposedCorrection) {
        errors.push('ruleCandidate.proposedCorrection must not exist when proposedDecision is not auto_correct');
      }
    }

    if (typeof output.safety !== 'object' || output.safety === null) {
      errors.push('safety must be an object');
    } else {
      const s = output.safety as unknown as Record<string, unknown>;
      if (!Array.isArray(s.limitations)) {
        errors.push('safety.limitations must be an array');
      } else if (!(s.limitations as unknown[]).every(e => typeof e === 'string')) {
        errors.push('safety.limitations must be an array of strings');
      }
      if (!Array.isArray(s.falsePositiveRisks)) {
        errors.push('safety.falsePositiveRisks must be an array');
      } else if (!(s.falsePositiveRisks as unknown[]).every(e => typeof e === 'string')) {
        errors.push('safety.falsePositiveRisks must be an array of strings');
      }
      if (!Array.isArray(s.requiredReplayCases)) {
        errors.push('safety.requiredReplayCases must be an array');
      } else if (!(s.requiredReplayCases as unknown[]).every(e => typeof e === 'string')) {
        errors.push('safety.requiredReplayCases must be an array of strings');
      }
    }

    if (typeof output.sourceTrace !== 'object' || output.sourceTrace === null) {
      errors.push('sourceTrace must be an object');
    } else {
      const st = output.sourceTrace as unknown as Record<string, unknown>;
      if (typeof st.rolloutReviewerArtifactId !== 'string' || (st.rolloutReviewerArtifactId).trim() === '') {
        errors.push('sourceTrace.rolloutReviewerArtifactId must be non-empty string');
      } else if (expectedSourceRolloutReviewerArtifactId && st.rolloutReviewerArtifactId !== expectedSourceRolloutReviewerArtifactId) {
        errors.push(`sourceTrace.rolloutReviewerArtifactId mismatch: expected ${expectedSourceRolloutReviewerArtifactId}, got ${st.rolloutReviewerArtifactId}`);
      }
      if (st.evaluatorArtifactId !== undefined && typeof st.evaluatorArtifactId !== 'string') {
        errors.push('sourceTrace.evaluatorArtifactId must be string if present');
      }
      if (st.artificerArtifactId !== undefined && typeof st.artificerArtifactId !== 'string') {
        errors.push('sourceTrace.artificerArtifactId must be string if present');
      }
      if (st.scribeArtifactId !== undefined && typeof st.scribeArtifactId !== 'string') {
        errors.push('sourceTrace.scribeArtifactId must be string if present');
      }
      if (st.philosopherArtifactId !== undefined && typeof st.philosopherArtifactId !== 'string') {
        errors.push('sourceTrace.philosopherArtifactId must be string if present');
      }
      if (st.dreamerArtifactId !== undefined && typeof st.dreamerArtifactId !== 'string') {
        errors.push('sourceTrace.dreamerArtifactId must be string if present');
      }
    }

    if (typeof output.sourceRolloutReviewerArtifactId === 'string' && output.sourceRolloutReviewerArtifactId.trim() !== ''
      && typeof output.sourceTrace === 'object' && output.sourceTrace !== null
      && typeof (output.sourceTrace as unknown as Record<string, unknown>).rolloutReviewerArtifactId === 'string'
      && output.sourceRolloutReviewerArtifactId !== (output.sourceTrace as unknown as Record<string, unknown>).rolloutReviewerArtifactId) {
      errors.push('sourceRolloutReviewerArtifactId and sourceTrace.rolloutReviewerArtifactId must match');
    }

    if (output.goldenTraceRefs !== undefined) {
      if (!Array.isArray(output.goldenTraceRefs)) {
        errors.push('goldenTraceRefs must be an array');
      } else if (!(output.goldenTraceRefs as unknown[]).every(e => typeof e === 'string')) {
        errors.push('goldenTraceRefs must be an array of strings');
      }
    }

    if (output.inlineGoldenTraceCases !== undefined) {
      if (!Array.isArray(output.inlineGoldenTraceCases)) {
        errors.push('inlineGoldenTraceCases must be an array');
      }
    }

    if (typeof output.generatedAt !== 'string' || output.generatedAt.trim() === '') {
      errors.push('generatedAt must be non-empty string');
    } else {
      const date = new Date(output.generatedAt);
      if (isNaN(date.getTime())) {
        errors.push('generatedAt must be a parseable ISO-8601 timestamp');
      }
    }

    return errors.length > 0
      ? { valid: false, errors, errorCategory: 'output_invalid' }
      : { valid: true, errors: [] };
  }
}
