/**
 * Language directive for principle generation prompts (PRI-336).
 *
 * Generates a prompt instruction telling the LLM to produce human-readable
 * principle fields in the owner's preferred language, while keeping technical
 * identifiers untranslated.
 *
 * ## Source of truth
 *
 * The canonical `outputLanguage` value comes from `.pd/config.yaml`
 * (`principles.outputLanguage`), read by `getPrinciplesOutputLanguage()`
 * in the pd-console config store. This module is pure logic — it receives
 * the resolved value as a parameter and never reads config directly.
 *
 * ## What is translated
 *
 * - `title`, `statement`, `rationale`, `applicability`, `antiPatterns`
 *   (human-readable principle fields)
 * - `description` in diagnostician recommendations
 *
 * ## What is NOT translated
 *
 * - Technical identifiers: `taskId`, `sourcePainId`, `sourceTaskId`,
 *   `sourceRunIds`, artifact IDs, run IDs
 * - File names, function names, class names, module paths
 * - Error codes, CLI commands, PR numbers
 * - Lineage and evidence fields
 * - Structured output schema field names (JSON keys)
 */

/** Valid output language values, matching pd-console config. */
export const VALID_OUTPUT_LANGUAGES = ['zh-CN', 'en'] as const;
export type OutputLanguage = (typeof VALID_OUTPUT_LANGUAGES)[number];

/** Default output language when not configured. */
export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'zh-CN';

/**
 * Runtime-validated output language with optional degradation warning.
 *
 * Per ERR-002/ERR-009: malformed config must produce a structured warning,
 * not a silent fallback.
 */
export interface ResolvedOutputLanguage {
  /** The effective output language to use. */
  readonly outputLanguage: OutputLanguage;
  /**
   * Warning when the provided value was invalid and a default was used.
   * Absent when the value was valid or not provided (legitimate default).
   * Present when the value was malformed (ERR-009: fail loud).
   */
  readonly degradationWarning?: string;
}

/**
 * Runtime type guard for OutputLanguage.
 * Per ERR-001: No `as` casts on untrusted values.
 */
export function isValidOutputLanguage(value: unknown): value is OutputLanguage {
  return typeof value === 'string' && (VALID_OUTPUT_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Validate and resolve an outputLanguage value from config.
 *
 * Per ERR-001: No `as` casts — use runtime type guard.
 * Per ERR-002: Degradation must include a reason.
 * Per ERR-009: Malformed values must fail loud with reason + nextAction.
 *
 * @param raw - The raw value from config (unknown at boundary).
 * @returns ResolvedOutputLanguage with effective value and optional warning.
 */
export function resolveOutputLanguage(raw: unknown): ResolvedOutputLanguage {
  // Missing/undefined → legitimate default, no warning
  if (raw === undefined || raw === null) {
    return { outputLanguage: DEFAULT_OUTPUT_LANGUAGE };
  }

  // Valid value → use as-is
  if (isValidOutputLanguage(raw)) {
    return { outputLanguage: raw };
  }

  // Invalid value → default with structured warning (ERR-002, ERR-009)
  const rawPreview = typeof raw === 'string'
    ? raw.slice(0, 50)
    : typeof raw;
  return {
    outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
    degradationWarning:
      `principles.outputLanguage is invalid (got: ${rawPreview}). ` +
      `Valid values: ${VALID_OUTPUT_LANGUAGES.join(', ')}. ` +
      `Falling back to default: ${DEFAULT_OUTPUT_LANGUAGE}. ` +
      `nextAction: Set principles.outputLanguage to one of: ${VALID_OUTPUT_LANGUAGES.join(', ')}`,
  };
}

/**
 * Human-readable language name for prompt directives.
 */
function languageDisplayName(lang: OutputLanguage): string {
  switch (lang) {
    case 'zh-CN': return 'Simplified Chinese (简体中文)';
    case 'en': return 'English';
  }
}

/**
 * Build a language directive string for inclusion in a generation prompt.
 *
 * This directive tells the LLM:
 * 1. Which language to use for human-readable output fields
 * 2. Which fields must NOT be translated (technical identifiers, lineage)
 *
 * Returns empty string when `outputLanguage` is undefined (no directive).
 *
 * PRI-714: `subject` selects the field list named in the directive. The
 * language, no-translate and JSON-key rules are identical for all subjects;
 * only the enumerated human-readable field list (and subject-specific echo
 * rules) change. Each list mirrors the agent's actual output schema:
 * - 'principle'      — scribe (PRI-336 wording, byte-identical when omitted)
 * - 'dreamer'        — dreamer candidates (candidates[].{badDecision,
 *                      betterDecision, rationale, strategicPerspective})
 * - 'philosopher'    — philosopher thesis/principleCandidate/risks
 * - 'review'         — evaluator (explicit nested paths incl.
 *                      codeReview.traceCoverage.gaps and
 *                      adversarialCases[].rationale; carries the PRI-630
 *                      requirementLedger verbatim-echo rule)
 * - 'rollout-review' — rollout reviewer (review.* fields)
 * - 'implementation' — artificer (implementationSummary/risks)
 *
 * @param outputLanguage - The resolved output language preference.
 *   When undefined, no directive is generated (backward compatible).
 * @param subject - Which artifact family the target prompt generates.
 *   Defaults to 'principle' (PRI-336 wording, byte-identical when omitted).
 */
export type LanguageDirectiveSubject =
  | 'principle'
  | 'dreamer'
  | 'philosopher'
  | 'review'
  | 'rollout-review'
  | 'implementation';

/** Per-subject human-readable field lists (explicit nested paths where the schema nests them). */
const SUBJECT_HUMAN_READABLE_FIELDS: Record<LanguageDirectiveSubject, string> = {
  principle: '(title, statement, rationale, applicability, antiPatterns, description)',
  dreamer: '(candidates[].badDecision, candidates[].betterDecision, candidates[].rationale, candidates[].strategicPerspective)',
  philosopher: '(thesis, principleCandidate.title, principleCandidate.rationale, principleCandidate.scope, risks[])',
  review: '(evaluation.summary, evaluation.strengths, evaluation.concerns, evaluation.requiredChanges, codeReview.intentConsistency.explanation, codeReview.scopePrecision.explanation, codeReview.traceCoverage.explanation, codeReview.traceCoverage.gaps, adversarialCases[].rationale, painCoverage.explanation, compressionFidelity.explanation, risks)',
  'rollout-review': '(review.summary, review.requiredChanges, review.rolloutRisks, review.safetyChecks, risks)',
  implementation: '(implementationSummary, risks)',
};

/**
 * PRI-630 convergence guard (PRI-714 review): the evaluator's
 * requirementLedger[].statement is a VERBATIM echo of the input
 * previousEvaluation requirements — the validator enforces exact equality
 * (`statement must match the authoritative context verbatim`), so translating
 * or rewording it breaks the repair-round contract. Only statements the
 * evaluator authors THIS round (evaluation.requiredChanges) follow the
 * language directive.
 */
const REQUIREMENT_LEDGER_ECHO_RULE =
  '- evaluation.requirementLedger[].statement MUST be copied verbatim from the corresponding input.previousEvaluation.requirements statement (PRI-630 historical protocol content). Do NOT translate or reword it. Only statements you author this round (evaluation.requiredChanges) follow the language directive above.';

/** Subject-specific additional rules appended after the shared rules. */
const SUBJECT_EXTRA_RULES: Partial<Record<LanguageDirectiveSubject, string>> = {
  review: REQUIREMENT_LEDGER_ECHO_RULE,
};

export function buildLanguageDirective(
  outputLanguage: OutputLanguage | undefined,
  subject: LanguageDirectiveSubject = 'principle',
): string {
  if (outputLanguage === undefined) {
    return '';
  }

  const langName = languageDisplayName(outputLanguage);

  const extraRule = SUBJECT_EXTRA_RULES[subject];

  return `

LANGUAGE DIRECTIVE (PRI-336):
The owner's preferred language for principle generation is ${langName}.
- Human-readable fields ${SUBJECT_HUMAN_READABLE_FIELDS[subject]} MUST be written in ${langName}.
- Technical identifiers MUST NOT be translated. This includes: taskId, sourcePainId, sourceTaskId, sourceRunIds, artifact IDs, run IDs, file names, function names, class names, module paths, error codes, CLI commands, and PR numbers.
- Lineage and evidence fields MUST NOT be translated.
- JSON field names (keys) MUST remain in English as defined by the output schema.
- If the evidence or context is in a different language, translate the human-readable fields into ${langName} while preserving the original meaning and technical accuracy.${extraRule !== undefined ? `\n${extraRule}` : ''}`;
}
