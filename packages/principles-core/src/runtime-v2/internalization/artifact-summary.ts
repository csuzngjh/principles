/**
 * Layer 0 — ArtifactSummary derivation (design §6.1, PR 1 / task 3.2).
 *
 * Pure logic only: no I/O, no fs, no DB, no network. Follows the Core vs
 * Plugin boundary (AGENTS.md `antipattern-core-io`).
 *
 * `deriveArtifactSummary` derives a small, deterministic, size-bounded
 * `ArtifactSummary` from a runner's already-validated structured output.
 * It never inspects raw prompt text, never calls an LLM, and never widens
 * any output schema, validator, or prompt — the summary is a read-only
 * projection of fields the production validator has already accepted
 * (design §4.1, Requirement 1.7 / 1.15).
 *
 * rc-1 / rc-2: `validatedOutput` is received as `unknown` and narrowed only
 * via `typeof` / `Array.isArray` — never via `as` casts.
 * rc-5: object keys are read with `Object.hasOwn`, not `in` (ERR-013 — `in`
 * would match inherited properties like `toString`/`constructor`).
 * rc-9: every field the mapping table cannot resolve is recorded in
 * `omittedFields`, never silently dropped.
 *
 * The per-stage field mapping mirrors the mapping already exercised (and
 * gated) in `__tests__/progressive-disclosure-spike.test.ts` for the three
 * diagnostic stages — that mapping went through the real Phase 0 LLM value
 * -validation gate (four rounds), so this implementation intentionally
 * matches it rather than inventing a second, divergent mapping.
 */

import { computeContentHash, type HashFn } from './artifact-content-hash.js';

// ── Types (design §6.1) ─────────────────────────────────────────────────────

/**
 * 8 kinds: 3 diagnostic stages + 5 peer stages.
 * The three diagnostic stages only participate in writer-side summary and
 * forwarding (design §4.7.1) — they do not own a `ContextManifest`.
 */
export type SummaryRunnerKind =
  | 'diag_rootcause'
  | 'diag_distiller'
  | 'diag_router'
  | 'dreamer'
  | 'philosopher'
  | 'scribe'
  | 'artificer'
  | 'evaluator';

export const SUMMARY_RUNNER_KINDS: readonly SummaryRunnerKind[] = [
  'diag_rootcause',
  'diag_distiller',
  'diag_router',
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
] as const;

export const ARTIFACT_SUMMARY_SCHEMA_VERSION = 1 as const;
export const SUMMARY_HEADLINE_MAX_CHARS = 200;
export const SUMMARY_FIELD_MAX_CHARS = 600;

/** Self-summary: deterministic derivation, never contains newly-generated LLM content. */
export interface ArtifactSummary {
  readonly schemaVersion: typeof ARTIFACT_SUMMARY_SCHEMA_VERSION;
  readonly runnerKind: SummaryRunnerKind;
  /** tier0: single-line headline, length <= SUMMARY_HEADLINE_MAX_CHARS. */
  readonly headline: string;
  /** tier1: structured field extraction, stable key names (design §6.6 manifest field paths). */
  readonly fields: Readonly<Record<string, string>>;
  /** Derivation source, always 'structured_output' — reserved for future source kinds. */
  readonly derivedFrom: 'structured_output';
  /** Fields skipped during derivation (missing/empty) — rc-9: degradation must carry a reason. */
  readonly omittedFields: readonly string[];
}

/** Direct-predecessor reference: exactly one level, no recursion. */
export interface PredecessorSummaryRef {
  readonly artifactId: string;
  readonly runnerKind: SummaryRunnerKind;
  /** Hash of the predecessor's canonical contentJson, used for staleness detection. */
  readonly contentHash: string;
  readonly summary: ArtifactSummary;
}

/** Additive envelope merged into an artifact's contentJson (all fields optional). */
export interface ArtifactSummaryEnvelope {
  readonly summary: ArtifactSummary;
  readonly predecessorSummary?: PredecessorSummaryRef;
}

export type DeriveSummaryFailureReason =
  | 'unsupported_runner_kind'
  | 'output_not_object'
  | 'no_derivable_field';

export type DeriveSummaryResult =
  | { readonly ok: true; readonly value: ArtifactSummary }
  | {
      readonly ok: false;
      readonly reason: DeriveSummaryFailureReason;
      readonly detail: string;
    };

// ── Runtime guards (rc-1 / rc-2 / rc-5) ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSummaryRunnerKind(value: string): value is SummaryRunnerKind {
  return (SUMMARY_RUNNER_KINDS as readonly string[]).includes(value);
}

/** Reads a non-empty string field by own-property key (rc-5). Empty/whitespace-only counts as absent. */
function readString(source: unknown, key: string): string | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

function readRecord(source: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readArray(source: unknown, key: string): readonly unknown[] | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

/** rc-4: validate every array element's type before joining. */
function readStringList(source: unknown, key: string): string | null {
  const list = readArray(source, key);
  if (list === null) return null;
  const strings = list.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return strings.length === 0 ? null : strings.join(' / ');
}

/** Reads a finite number field and renders it as a string (rc-1: no blind `as number`). */
function readNumberAsString(source: unknown, key: string): string | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

/** Reads a boolean field and renders it as a string. */
function readBooleanAsString(source: unknown, key: string): string | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return typeof value === 'boolean' ? String(value) : null;
}

// ── Deterministic text shaping ───────────────────────────────────────────────

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** First sentence: bounded at the first CJK/ASCII sentence terminator, else the whole (clamped) text. */
function firstSentence(text: string): string {
  const match = /^[\s\S]*?[。；;.]/.exec(text);
  const sentence = match?.[0] ?? text;
  return clamp(sentence.trim(), SUMMARY_HEADLINE_MAX_CHARS);
}

/** Deterministic composition for headlines built from more than one field (e.g. "verdict + count"). */
function composeHeadline(parts: readonly (string | null)[]): string | null {
  const nonEmpty = parts.filter((part): part is string => part !== null && part.trim() !== '');
  return nonEmpty.length === 0 ? null : clamp(nonEmpty.join('; '), SUMMARY_HEADLINE_MAX_CHARS);
}

// ── Per-stage target key mapping (design §6.1) ──────────────────────────────

/** Target field resolution for one stage: headline source + per-key resolved values (null = omitted). */
interface StageResolution {
  readonly headlineSource: string | null;
  readonly resolved: Readonly<Record<string, string | null>>;
}

function resolveDiagRootCause(output: Record<string, unknown>): StageResolution {
  const rootCause = readString(output, 'rootCause');
  return {
    headlineSource: rootCause === null ? null : firstSentence(rootCause),
    resolved: {
      rootSymptom: readString(output, 'summary'),
      category: readString(output, 'rootCauseCategory'),
      // DiagRootCauseOutputV1 has no severity-equivalent field → omitted (Requirement 1.13).
      severity: null,
      rootCause,
    },
  };
}

function resolveDiagDistiller(output: Record<string, unknown>): StageResolution {
  const abstractedPrinciple = readString(output, 'abstractedPrinciple');
  return {
    headlineSource: abstractedPrinciple === null ? null : firstSentence(abstractedPrinciple),
    resolved: {
      // DiagDistillerOutputV1 has no literal "rootCause" field; `rationale`
      // ("why this principle addresses the root cause") is the closest
      // semantically-corresponding textual field (Requirement 1.13).
      rootCause: readString(output, 'rationale'),
      // No affectedComponents / severity equivalent in this stage's schema → omitted.
      affectedComponents: null,
      category: readString(output, 'scope'),
      severity: null,
    },
  };
}

function resolveDiagRouter(output: Record<string, unknown>): StageResolution {
  const summary = readString(output, 'summary');
  const violated = readArray(output, 'violatedPrinciples') ?? [];
  const violatedIds = violated
    .map((entry) => readString(entry, 'principleId'))
    .filter((id): id is string => id !== null);
  const recommendations = readArray(output, 'recommendations') ?? [];
  const firstRecommendationKind = recommendations.length > 0 ? readString(recommendations[0], 'kind') : null;
  return {
    headlineSource: composeHeadline([summary, firstRecommendationKind]),
    resolved: {
      rootCause: readString(output, 'rootCause'),
      affectedComponents: violatedIds.length > 0 ? violatedIds.join(' / ') : null,
      rootSymptom: summary,
      category: firstRecommendationKind,
      // DiagnosticianOutputV1 has no severity-equivalent field → omitted.
      severity: null,
    },
  };
}

function resolveDreamer(output: Record<string, unknown>): StageResolution {
  const candidates = readArray(output, 'candidates') ?? [];
  const firstCandidate = candidates.length > 0 ? candidates[0] : null;
  const betterDecision = readString(firstCandidate, 'betterDecision');
  return {
    headlineSource: betterDecision === null ? null : firstSentence(betterDecision),
    resolved: {
      badDecision: readString(firstCandidate, 'badDecision'),
      betterDecision,
      rationale: readString(firstCandidate, 'rationale'),
      riskLevel: readString(firstCandidate, 'riskLevel'),
      strategicPerspective: readString(firstCandidate, 'strategicPerspective'),
    },
  };
}

function resolvePhilosopher(output: Record<string, unknown>): StageResolution {
  const principleCandidate = readRecord(output, 'principleCandidate');
  const title = readString(principleCandidate, 'title');
  return {
    headlineSource: title,
    resolved: {
      thesis: readString(output, 'thesis'),
      principleTitle: title,
      principleScope: readString(principleCandidate, 'scope'),
      principleConfidence: readNumberAsString(principleCandidate, 'confidence'),
    },
  };
}

function resolveScribe(output: Record<string, unknown>): StageResolution {
  const principleDraft = readRecord(output, 'principleDraft');
  const statement = readString(principleDraft, 'statement');
  return {
    headlineSource: statement === null ? null : firstSentence(statement),
    resolved: {
      principleText: statement,
      scope: readStringList(principleDraft, 'applicability'),
      exceptions: readStringList(principleDraft, 'antiPatterns'),
    },
  };
}

function resolveArtificer(output: Record<string, unknown>): StageResolution {
  // ArtificerRuleOutput has no literal "changed files" / "API surface" field.
  // `affectedTools` (list of tool names the rule affects) and
  // `implementationSummary` are the closest semantically-corresponding
  // fields (Requirement 1.13) — the real `implementationCode` is a tier2
  // raw field and intentionally excluded from the summary.
  const affectedTools = readStringList(output, 'affectedTools');
  const implementationSummary = readString(output, 'implementationSummary');
  const toolCount = readArray(output, 'affectedTools')?.length ?? null;
  return {
    headlineSource: composeHeadline([
      toolCount !== null ? `${toolCount} affected tools` : null,
      implementationSummary === null ? null : firstSentence(implementationSummary),
    ]),
    resolved: {
      changedFiles: affectedTools,
      apiSurface: implementationSummary,
      risks: readStringList(output, 'risks'),
    },
  };
}

function resolveEvaluator(output: Record<string, unknown>): StageResolution {
  const evaluation = readRecord(output, 'evaluation');
  const decision = readString(evaluation, 'decision');
  const concerns = readArray(evaluation, 'concerns');
  const concernCount = concerns === null ? null : String(concerns.length);
  const codeReview = readRecord(output, 'codeReview');
  const intentConsistency = readRecord(codeReview, 'intentConsistency');
  return {
    headlineSource: composeHeadline([
      decision === null ? null : `verdict=${decision}`,
      concernCount === null ? null : `concerns=${concernCount}`,
    ]),
    resolved: {
      verdict: decision,
      concernCount,
      intentConsistency: readBooleanAsString(intentConsistency, 'aligned'),
    },
  };
}

const STAGE_RESOLVERS: Readonly<Record<SummaryRunnerKind, (output: Record<string, unknown>) => StageResolution>> = {
  diag_rootcause: resolveDiagRootCause,
  diag_distiller: resolveDiagDistiller,
  diag_router: resolveDiagRouter,
  dreamer: resolveDreamer,
  philosopher: resolvePhilosopher,
  scribe: resolveScribe,
  artificer: resolveArtificer,
  evaluator: resolveEvaluator,
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pure function. Input is a runner's own already-validated output, but is
 * still treated as `unknown` (rc-1) and read via `Object.hasOwn` (rc-5).
 *
 * Preconditions: `runnerKind` belongs to `SummaryRunnerKind`.
 * Postconditions:
 *   - never throws (writer paths must not fail because of summary derivation)
 *   - `ok === true` implies `headline.length <= SUMMARY_HEADLINE_MAX_CHARS`
 *     and every `fields` value has `length <= SUMMARY_FIELD_MAX_CHARS`
 *   - identical input always produces byte-identical output (determinism,
 *     supports golden replay)
 *   - `ok === false` carries a `reason`; the caller must emit a degradation
 *     event (rc-9)
 */
export function deriveArtifactSummary(
  runnerKind: SummaryRunnerKind,
  validatedOutput: unknown,
): DeriveSummaryResult {
  if (!isSummaryRunnerKind(runnerKind)) {
    return {
      ok: false,
      reason: 'unsupported_runner_kind',
      detail: `Unsupported SummaryRunnerKind: ${String(runnerKind)}`,
    };
  }

  if (!isRecord(validatedOutput)) {
    return {
      ok: false,
      reason: 'output_not_object',
      detail: `validatedOutput for runnerKind "${runnerKind}" is not a non-null object`,
    };
  }

  const resolve = STAGE_RESOLVERS[runnerKind];
  const { headlineSource, resolved } = resolve(validatedOutput);

  const fields: Record<string, string> = {};
  const omittedFields: string[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== null) {
      fields[key] = clamp(value, SUMMARY_FIELD_MAX_CHARS);
    } else {
      omittedFields.push(key);
    }
  }

  if (headlineSource === null && Object.keys(fields).length === 0) {
    return {
      ok: false,
      reason: 'no_derivable_field',
      detail: `No derivable headline or field for runnerKind "${runnerKind}" from the given output`,
    };
  }

  return {
    ok: true,
    value: {
      schemaVersion: ARTIFACT_SUMMARY_SCHEMA_VERSION,
      runnerKind,
      // Clamped here (not trusted to each resolver) so the documented
      // `headline.length <= SUMMARY_HEADLINE_MAX_CHARS` postcondition holds
      // even if a resolver passes through a raw field (e.g. philosopher's
      // `principleCandidate.title`) without an intermediate `firstSentence`.
      headline: headlineSource === null ? '' : clamp(headlineSource, SUMMARY_HEADLINE_MAX_CHARS),
      fields,
      derivedFrom: 'structured_output',
      omittedFields,
    },
  };
}

// ── Freshness detection (design §6.1, task 3.8) ─────────────────────────────

export type SummaryFreshness =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly reason: 'content_hash_mismatch' | 'predecessor_missing' };

/**
 * Freshness is judged solely by content-hash comparison — `updatedAt` is
 * never read (Requirements 3.2 / 3.9): a pending→validated timestamp
 * refresh must not be mistaken for a content change.
 *
 * No artifact-store read happens here — `loadedPredecessorContentJson` must
 * already be in memory (it is the same object `buildContext` loaded for the
 * current runner invocation, design F3). `hash` is the same injected
 * `HashFn` used by `computeContentHash` (core does not import
 * `node:crypto`, `antipattern-core-io`).
 */
export function checkPredecessorSummaryFreshness(
  ref: PredecessorSummaryRef | undefined,
  loadedPredecessorContentJson: unknown | undefined,
  hash: HashFn,
): SummaryFreshness {
  if (ref === undefined || loadedPredecessorContentJson === undefined) {
    return { fresh: false, reason: 'predecessor_missing' };
  }
  const actualHash = computeContentHash(loadedPredecessorContentJson, hash);
  return actualHash === ref.contentHash
    ? { fresh: true }
    : { fresh: false, reason: 'content_hash_mismatch' };
}
