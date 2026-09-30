/**
 * Reuse Evaluation Output — the Semantic Reuse Evaluation Capability's
 * proposal contract (PRI-917 SPEC v0.3.2 §4.2).
 *
 * This is a PROPOSAL-ONLY contract: it is what the LLM-backed evaluation
 * returns to the Owner's review surface, never what it can do. The word
 * "decision" deliberately does NOT appear here — in the reuse chain,
 * "decision" belongs exclusively to the Owner; this layer can only
 * recommend (SPEC v0.3.2 §3 naming boundary).
 *
 * Pure contract + runtime validator, zero I/O. The runtime validator is the
 * trust boundary for an UNTRUSTED LLM output (rc-1/rc-2/rc-3):
 *   - closed field set: ANY key outside the schema is rejected, so a model
 *     output can never smuggle persistence-ish fields (`reuseEvidence`,
 *     `write`, `persist`, ...) — T7a of SPEC v0.3.2 §11;
 *   - cross-field rules: `recommendation=reuse` REQUIRES
 *     `selectedPrincipleId`; `recommendation=uncertain` FORBIDS it.
 *
 * Deliberate deviation from SPEC v0.3.2 §4.2 ("合法 UUID 形状"): the
 * validator does NOT assert a UUID shape on `selectedPrincipleId`, because
 * bootstrap core principles carry `T-xx` ids in the live ledger — a UUID
 * assertion would wrongly reject them as reuse targets. Existence of the id
 * is enforced one layer up, against the actual shortlist (INV-R08).
 */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** Registry key for OUTPUT_SCHEMA_REGISTRY (adapter-side validation). */
export const REUSE_EVALUATION_OUTPUT_SCHEMA_REF = 'reuse-evaluation-output-v1';

export const ReuseEvaluationRecommendationSchema = Type.Union([
  Type.Literal('reuse'),
  Type.Literal('create'),
  Type.Literal('uncertain'),
]);

export interface ReuseEvaluationOutputV1 {
  /** A RECOMMENDATION for the Owner — never a decision. */
  recommendation: 'reuse' | 'create' | 'uncertain';
  /** REQUIRED when recommendation=reuse; FORBIDDEN when uncertain. */
  selectedPrincipleId?: string;
  rationale: string;
  confidence: number;
}

export const ReuseEvaluationOutputV1Schema = Type.Object({
  recommendation: ReuseEvaluationRecommendationSchema,
  selectedPrincipleId: Type.Optional(Type.String({ minLength: 1 })),
  rationale: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export type ReuseEvaluationValidation =
  | { ok: true; output: ReuseEvaluationOutputV1 }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'recommendation',
  'selectedPrincipleId',
  'rationale',
  'confidence',
]);

/**
 * Runtime validation for the evaluation output (rc-1/rc-2/rc-3).
 *
 * Pure function, never throws. Returns the FIRST failure reason:
 *   - non-object input → `evaluation_is_not_an_object`
 *   - any key outside the closed field set → `unknown_field:<key>` (T7a)
 *   - schema violation (bad recommendation value, empty rationale,
 *     confidence out of [0,1], empty/non-string selectedPrincipleId) →
 *     `schema_validation_failed:<details>`
 *   - `recommendation=reuse` without `selectedPrincipleId` →
 *     `reuse_without_principle_id`
 *   - `recommendation=uncertain` WITH `selectedPrincipleId` →
 *     `uncertain_with_principle_id`
 */
export function validateReuseEvaluationOutput(raw: unknown): ReuseEvaluationValidation {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'evaluation_is_not_an_object' };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: `unknown_field:${key}` };
    }
  }
  if (!Value.Check(ReuseEvaluationOutputV1Schema, raw)) {
    const details = [...Value.Errors(ReuseEvaluationOutputV1Schema, raw)]
      .slice(0, 5)
      .map((e) => `${e.path || '/'}: ${e.message}`)
      .join('; ');
    return { ok: false, reason: `schema_validation_failed:${details}` };
  }
  const { recommendation, rationale, confidence } = raw as {
    recommendation: ReuseEvaluationOutputV1['recommendation'];
    rationale: string;
    confidence: number;
  };
  const selected = raw.selectedPrincipleId;
  if (recommendation === 'reuse' && (typeof selected !== 'string' || selected.trim() === '')) {
    return { ok: false, reason: 'reuse_without_principle_id' };
  }
  if (recommendation === 'uncertain' && typeof selected === 'string' && selected.trim() !== '') {
    return { ok: false, reason: 'uncertain_with_principle_id' };
  }
  return {
    ok: true,
    output: {
      recommendation,
      rationale,
      confidence,
      ...(typeof selected === 'string' && selected.trim() !== '' ? { selectedPrincipleId: selected } : {}),
    },
  };
}
