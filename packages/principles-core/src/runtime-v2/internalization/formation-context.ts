/**
 * Formation Context — bounded projection of ALREADY-PERSISTED formation
 * evidence into a peer runner's prompt payload (PRI-838 / PRI-839).
 *
 * PRI-835 (Formation Context Connectivity Audit) established the gap this
 * module closes: the identifiers that link a formation back to its evidence —
 * `scribe.sourceTrace.dreamerArtifactId`, the dreamer artifact's
 * `lineageArtifactIds` — are ALREADY persisted and ALREADY reach the runner.
 * They were simply never resolved into prompt *content*.
 *
 *   ⇒ This is a CONNECTION fix, not a capability addition:
 *     no new artifact kind, no new storage, no new authority, no feature flag,
 *     no change to any output schema or validator.
 *
 * `ArtifactSummary / deriveArtifactSummary` (artifact-summary.ts) is the only
 * bounded-projection implementation that survived PRI-819 R-06 in this layer,
 * and this module deliberately mirrors its contracts rather than inventing a
 * second idiom:
 *   - pure projection over structured output that is already persisted;
 *   - untrusted JSON is read with `Object.hasOwn` + `typeof` / `Array.isArray`
 *     guards — never an `as` cast (rc-1 / rc-2 / rc-5 / ERR-013);
 *   - every emitted value is clamped, and every value dropped by the bound is
 *     accounted for in `truncationNotes` or `omittedFields` (rc-9 — degradation
 *     must be observable, never silent);
 *   - deterministic: identical input yields byte-identical output.
 *
 * Deliberately NOT restored: the retired PRI-634 Layer 0/1/2 plane
 * (`ContextManifest` / `PromptBudgetManager` / `CandidateLineage`). PRI-819 R-06
 * removed it for never graduating, and PRI-835 explicitly rules out reviving
 * it. The budget below is a small, local, explicit cap — not a budget manager.
 *
 * Consumers (materially different → not a speculative seam):
 *   - Scribe   (PRI-838): dreamer proposals + source diagnosis + provenance;
 *   - Artificer(PRI-839): bounded, priority-ranked candidate set + differences;
 *   - Evaluator(PRI-843/846): pain-faithfulness grounding + mismatch routing;
 *   - Owner Decision Review (PRI-858): bounded diagnosis + pain provenance
 *     projected onto the decision snapshot (observation only, read-only store).
 *
 * @see docs/audit/PRI-835-formation-context-connectivity-audit.md (§DC-1, §DC-3, §6.1 C1/C2)
 */

// ── Budget contract ──────────────────────────────────────────────────────────

export const FORMATION_CONTEXT_VERSION = 'formation-context.v1';

/** `DreamerOutputV1Schema` allows 1..5 candidates — the bound matches the schema. */
export const FORMATION_CANDIDATE_LIMIT = 5;

/** Per-field clamp. Mirrors `SUMMARY_FIELD_MAX_CHARS` (artifact-summary.ts). */
export const FORMATION_FIELD_MAX_CHARS = 400;

export const FORMATION_DIAGNOSIS_EVIDENCE_LIMIT = 8;
export const FORMATION_DIAGNOSIS_VIOLATED_LIMIT = 8;
export const FORMATION_DIAGNOSIS_RECOMMENDATION_LIMIT = 5;
export const FORMATION_DREAMER_CONTEXT_REF_LIMIT = 8;

/**
 * Hard cap on the SERIALIZED formation block. The projection is trimmed to fit
 * it — never truncated mid-JSON — and every dropped item is recorded in
 * `truncationNotes`.
 *
 * PRI-815 Phase A measured the cost of this information channel at +24.9%
 * tokens for the frozen three-block payload; 8000 chars ≈ 2000 tokens keeps
 * that proportion for a smaller real-world field mix.
 */
export const FORMATION_TOTAL_MAX_CHARS = 8000;

/**
 * Per-section caps. They exist so the degradation ORDER is sensible: without
 * them a single oversized diagnosis could only be satisfied by dropping every
 * candidate, which is the wrong trade (the proposals are the unique content).
 */
export const FORMATION_PROPOSALS_MAX_CHARS = 4000;
export const FORMATION_DIAGNOSIS_MAX_CHARS = 3500;
/** Lineage ids are identity, not content — capped last, and only as a last resort. */
export const FORMATION_LINEAGE_ID_LIMIT = 16;

/**
 * Diagnostic stage task kinds that can carry the source diagnosis, in
 * descending authority. `diag_router` emits the canonical
 * `DiagnosticianOutputV1`; the earlier stages emit narrower schemas handled by
 * the tolerant readers below.
 */
export const FORMATION_DIAGNOSIS_TASK_KINDS = ['diag_router', 'diag_distiller', 'diag_rootcause'] as const;

// ── Projected shapes ─────────────────────────────────────────────────────────

/**
 * One Dreamer proposal, projected and clamped.
 *
 * Both orderings are exposed so a consumer never has to guess which one it is
 * reading:
 *   - `candidateIndex` — the order the Dreamer authored;
 *   - `priorityRank`   — a DERIVED 1-based reading aid (see `rankCandidates`).
 */
export interface FormationCandidateProjection {
  readonly candidateIndex: number;
  readonly priorityRank: number;
  readonly badDecision: string;
  readonly betterDecision: string;
  readonly rationale: string;
  readonly confidence: number | null;
  readonly riskLevel: string | null;
  readonly strategicPerspective: string | null;
}

export interface FormationDiagnosisViolatedPrinciple {
  readonly principleId: string | null;
  readonly title: string | null;
  readonly rationale: string;
}

export interface FormationDiagnosisEvidence {
  readonly sourceRef: string;
  readonly note: string;
}

export interface FormationDiagnosisProjection {
  readonly artifactId: string;
  readonly taskId: string;
  /** The diagnostic stage this projection came from (`diag_router`, …). */
  readonly stage: string;
  readonly rootCause: string | null;
  readonly summary: string | null;
  readonly violatedPrinciples: readonly FormationDiagnosisViolatedPrinciple[];
  readonly evidence: readonly FormationDiagnosisEvidence[];
  /** `description` of each recommendation, bounded; kind is prefixed inline. */
  readonly recommendations: readonly string[];
  readonly confidence: number | null;
  /** Field names the tolerant readers could not resolve (rc-9). */
  readonly omittedFields: readonly string[];
}

export interface FormationProvenance {
  readonly sourceDreamerArtifactId: string;
  readonly sourceDreamerTaskId: string;
  readonly sourceDiagnosisArtifactId: string | null;
  readonly sourceDiagnosisTaskId: string | null;
  readonly sourcePainId: string | null;
  readonly lineageArtifactIds: readonly string[];
}

export interface FormationContext {
  readonly version: string;
  /** ALL candidates the Dreamer proposed — never only the selected one. */
  readonly dreamerProposals: readonly FormationCandidateProjection[];
  /** `DreamerOutput.contextRefs` — the evidence references the Dreamer consumed. */
  readonly dreamerContextRefs: readonly string[];
  readonly sourceDiagnosis?: FormationDiagnosisProjection;
  readonly provenance: FormationProvenance;
  readonly truncationNotes: readonly string[];
}

// ── Runtime guards (rc-1 / rc-2 / rc-5, mirroring artifact-summary.ts) ──────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a non-empty string by OWN property key. Empty/whitespace-only counts as absent. */
function readString(source: unknown, key: string): string | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

function readArray(source: unknown, key: string): readonly unknown[] | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

/** rc-1: no blind `as number` — a finite number or nothing. */
function readNumber(source: unknown, key: string): number | null {
  if (!isRecord(source) || !Object.hasOwn(source, key)) return null;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Clamp one field to the per-field budget.
 *
 * Intentionally module-private: `artifact-summary.ts` (`clamp`) and
 * `quality-scorecard/validation.ts` (`truncate`) already carry two private
 * copies of this three-line helper. Consolidating all three is a tidy-up outside
 * this ticket's change surface (AGENTS.md §1) — recorded as a follow-up rather
 * than widened into this PR.
 */
function clamp(text: string, max: number = FORMATION_FIELD_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Parses untrusted contentJson. Returns null when it is not a JSON object. */
function parseContentJson(contentJson: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

// ── Candidate priority (PRI-839) ─────────────────────────────────────────────

const RISK_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2 };

/**
 * `DreamerOutput` carries NO explicit priority field, so priority is DERIVED
 * deterministically from the signals the Dreamer did author:
 *
 *   1. `confidence` DESC — the Dreamer's own confidence in the proposal;
 *   2. `riskLevel` ASC (low < medium < high) — least risky first on a tie;
 *   3. `candidateIndex` ASC — authored order as the final tiebreak.
 *
 * This is a READING AID over Dreamer-authored evidence, **not a new
 * authority**. The Philosopher critique remains the sole authority on which
 * proposals were rejected — which is exactly why the prompt contract that
 * consumes this projection states "do NOT revive a proposal the critique
 * explicitly rejected".
 */
function rankCandidates<T extends { readonly confidence: number | null; readonly riskLevel: string | null; readonly candidateIndex: number }>(
  candidates: readonly T[],
): readonly (T & { readonly priorityRank: number })[] {
  const ordered = [...candidates].sort((a, b) => {
    const confidenceDelta = (b.confidence ?? -1) - (a.confidence ?? -1);
    if (confidenceDelta !== 0) return confidenceDelta;
    const riskDelta = (RISK_ORDER[a.riskLevel ?? ''] ?? 3) - (RISK_ORDER[b.riskLevel ?? ''] ?? 3);
    if (riskDelta !== 0) return riskDelta;
    return a.candidateIndex - b.candidateIndex;
  });
  return ordered.map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }));
}

/**
 * Deterministic, factual summary of how the proposals differ — a bounded
 * alternative to dumping every candidate verbatim. States only what the
 * evidence actually shows (count, risk spread, distinct better-decisions);
 * it never editorialises about which proposal is "best".
 */
export function summarizeCandidateDifferences(
  candidates: readonly FormationCandidateProjection[],
): string {
  if (candidates.length === 0) return 'No dreamer proposals were available.';
  if (candidates.length === 1) {
    return `1 proposal available (candidateIndex ${candidates[0]?.candidateIndex ?? 0}); no alternatives were proposed.`;
  }
  const riskCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const risk = candidate.riskLevel ?? 'unspecified';
    riskCounts.set(risk, (riskCounts.get(risk) ?? 0) + 1);
  }
  const riskSpread = [...riskCounts.entries()]
    .map(([risk, count]) => `${risk}=${count}`)
    .join(', ');
  const distinctBetterDecisions = new Set(candidates.map((candidate) => candidate.betterDecision)).size;
  const confidences = candidates
    .map((candidate) => candidate.confidence)
    .filter((confidence): confidence is number => confidence !== null);
  const confidenceRange = confidences.length === 0
    ? 'unspecified'
    : `${Math.min(...confidences)}..${Math.max(...confidences)}`;
  return [
    `${candidates.length} mutually distinct proposals (this is a bounded top-${candidates.length} view, not necessarily the full set).`,
    `risk spread: ${riskSpread}`,
    `distinct better-decisions: ${distinctBetterDecisions}`,
    `dreamer confidence range: ${confidenceRange}`,
  ].join(' ');
}

// ── Dreamer projection ───────────────────────────────────────────────────────

export interface DreamerProjection {
  readonly candidates: readonly FormationCandidateProjection[];
  readonly contextRefs: readonly string[];
  readonly sourcePainId: string | null;
  /** VALID proposals dropped by the candidate bound (malformed entries excluded). */
  readonly omittedCandidateCount: number;
  /** Candidates dropped by the bound and malformed entries skipped (rc-9). */
  readonly truncationNotes: readonly string[];
}

/**
 * Project a Dreamer artifact's contentJson into a bounded candidate set.
 *
 * Never throws. A malformed candidate is SKIPPED and recorded, so one bad
 * element cannot discard the whole formation's alternatives.
 */
export function projectDreamerProposals(
  dreamerContent: Record<string, unknown>,
): DreamerProjection {
  const truncationNotes: string[] = [];

  const rawContextRefs = readArray(dreamerContent, 'contextRefs') ?? [];
  const contextRefStrings = rawContextRefs.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );
  if (contextRefStrings.length > FORMATION_DREAMER_CONTEXT_REF_LIMIT) {
    truncationNotes.push(
      `dreamer contextRefs truncated: ${contextRefStrings.length} -> ${FORMATION_DREAMER_CONTEXT_REF_LIMIT}`,
    );
  }
  const contextRefs = contextRefStrings
    .slice(0, FORMATION_DREAMER_CONTEXT_REF_LIMIT)
    .map((ref) => clamp(ref));

  const rawCandidates = readArray(dreamerContent, 'candidates') ?? [];
  const projected: FormationCandidateProjection[] = [];
  let malformed = 0;

  for (let index = 0; index < rawCandidates.length; index += 1) {
    const entry = rawCandidates[index];
    const badDecision = readString(entry, 'badDecision');
    const betterDecision = readString(entry, 'betterDecision');
    const rationale = readString(entry, 'rationale');
    if (badDecision === null || betterDecision === null || rationale === null) {
      // rc-9: a malformed candidate is an observable loss, never a silent one.
      malformed += 1;
      continue;
    }
    const authoredIndex = readNumber(entry, 'candidateIndex');
    const strategicPerspective = readString(entry, 'strategicPerspective');
    projected.push({
      candidateIndex: authoredIndex ?? index,
      priorityRank: 0, // assigned by rankCandidates below
      badDecision: clamp(badDecision),
      betterDecision: clamp(betterDecision),
      rationale: clamp(rationale),
      confidence: readNumber(entry, 'confidence'),
      riskLevel: readString(entry, 'riskLevel'),
      strategicPerspective: strategicPerspective === null ? null : clamp(strategicPerspective),
    });
  }

  if (malformed > 0) {
    truncationNotes.push(`dreamer candidates skipped as malformed: ${malformed}`);
  }

  const withinBound = projected.slice(0, FORMATION_CANDIDATE_LIMIT);
  if (projected.length > withinBound.length) {
    truncationNotes.push(
      `dreamer candidates truncated: ${projected.length} -> ${withinBound.length} (bounded projection)`,
    );
  }

  return {
    candidates: rankCandidates(withinBound),
    contextRefs,
    sourcePainId: readString(dreamerContent, 'sourcePainId'),
    omittedCandidateCount: projected.length - withinBound.length,
    truncationNotes,
  };
}

// ── Diagnosis projection ─────────────────────────────────────────────────────

/**
 * Tolerant projection over a diagnostic stage artifact. `diag_router` emits the
 * canonical `DiagnosticianOutputV1`; earlier stages expose a narrower schema,
 * so unresolvable fields are recorded in `omittedFields` instead of failing.
 */
export function projectDiagnosisOutput(
  diagnosisContent: Record<string, unknown>,
  identity: { readonly artifactId: string; readonly taskId: string; readonly stage: string },
): FormationDiagnosisProjection {
  const omittedFields: string[] = [];

  const rootCause = readString(diagnosisContent, 'rootCause');
  if (rootCause === null) omittedFields.push('rootCause');
  const summary = readString(diagnosisContent, 'summary');
  if (summary === null) omittedFields.push('summary');

  const rawViolated = readArray(diagnosisContent, 'violatedPrinciples') ?? [];
  if (rawViolated.length === 0) omittedFields.push('violatedPrinciples');
  const violatedPrinciples = rawViolated
    .slice(0, FORMATION_DIAGNOSIS_VIOLATED_LIMIT)
    .map((entry): FormationDiagnosisViolatedPrinciple | null => {
      const rationale = readString(entry, 'rationale');
      if (rationale === null) return null;
      const principleId = readString(entry, 'principleId');
      const title = readString(entry, 'title');
      return {
        principleId,
        title: title === null ? null : clamp(title),
        rationale: clamp(rationale),
      };
    })
    .filter((entry): entry is FormationDiagnosisViolatedPrinciple => entry !== null);
  if (rawViolated.length > FORMATION_DIAGNOSIS_VIOLATED_LIMIT) {
    omittedFields.push(
      `violatedPrinciples[${FORMATION_DIAGNOSIS_VIOLATED_LIMIT}..${rawViolated.length - 1}]`,
    );
  }

  const rawEvidence = readArray(diagnosisContent, 'evidence') ?? [];
  if (rawEvidence.length === 0) omittedFields.push('evidence');
  const evidence = rawEvidence
    .slice(0, FORMATION_DIAGNOSIS_EVIDENCE_LIMIT)
    .map((entry): FormationDiagnosisEvidence | null => {
      const sourceRef = readString(entry, 'sourceRef');
      const note = readString(entry, 'note');
      if (sourceRef === null || note === null) return null;
      return { sourceRef: clamp(sourceRef), note: clamp(note) };
    })
    .filter((entry): entry is FormationDiagnosisEvidence => entry !== null);
  if (rawEvidence.length > FORMATION_DIAGNOSIS_EVIDENCE_LIMIT) {
    omittedFields.push(
      `evidence[${FORMATION_DIAGNOSIS_EVIDENCE_LIMIT}..${rawEvidence.length - 1}]`,
    );
  }

  const rawRecommendations = readArray(diagnosisContent, 'recommendations') ?? [];
  if (rawRecommendations.length === 0) omittedFields.push('recommendations');
  const recommendations = rawRecommendations
    .slice(0, FORMATION_DIAGNOSIS_RECOMMENDATION_LIMIT)
    .map((entry): string | null => {
      const description = readString(entry, 'description');
      if (description === null) return null;
      const kind = readString(entry, 'kind');
      return clamp(kind === null ? description : `[${kind}] ${description}`);
    })
    .filter((entry): entry is string => entry !== null);
  if (rawRecommendations.length > FORMATION_DIAGNOSIS_RECOMMENDATION_LIMIT) {
    omittedFields.push(
      `recommendations[${FORMATION_DIAGNOSIS_RECOMMENDATION_LIMIT}..${rawRecommendations.length - 1}]`,
    );
  }

  const confidence = readNumber(diagnosisContent, 'confidence');
  if (confidence === null) omittedFields.push('confidence');

  return {
    artifactId: identity.artifactId,
    taskId: identity.taskId,
    stage: identity.stage,
    rootCause: rootCause === null ? null : clamp(rootCause),
    summary: summary === null ? null : clamp(summary),
    violatedPrinciples,
    evidence,
    recommendations,
    confidence,
    omittedFields,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** Narrow task view — phase identity lives on the task row, never on the artifact. */
export interface FormationTaskView {
  readonly taskKind: string;
  readonly status: string;
  readonly dependencyTaskIds: readonly string[];
}

/**
 * Minimal artifact view the resolver reads — deliberately NOT `PIArtifactRecord`:
 * the Owner Decision review store (PRI-858) projects the same durable facts
 * through the narrower `DecisionArtifactRecord`, and a read-only consumer must
 * not be forced to fabricate write-surface columns (updatedAt et al.) just to
 * satisfy the type. `PIArtifactRecord` structurally satisfies this view, so
 * existing runners keep passing `this.artifactStore` unchanged.
 */
export interface FormationArtifactView {
  readonly artifactId: string;
  readonly sourceTaskId: string;
  readonly contentJson: string;
  readonly lineageArtifactIds: readonly string[];
}

export interface FormationArtifactReader {
  getArtifactById(artifactId: string): Promise<FormationArtifactView | null>;
  listBySourceTaskId(sourceTaskId: string): Promise<readonly FormationArtifactView[]>;
}

export interface FormationContextResolverParams {
  /**
   * Untrusted. The dreamer artifact id the upstream stage copied out of the
   * philosopher artifact (`philosopher.sourceDreamerArtifactId`).
   */
  readonly sourceDreamerArtifactId: string | undefined;
  readonly artifactStore: FormationArtifactReader;
  /**
   * Resolves a task row (with hydrated PI dependency ids).
   *
   * Required because every PI artifact is written with `artifact_kind =
   * 'principle'` — the stage identity of a lineage artifact exists ONLY on its
   * task row, so the diagnosis cannot be identified from the artifact alone.
   */
  readonly lookupTask: (taskId: string) => Promise<FormationTaskView | null>;
  readonly emitEvent: (eventName: string, taskId: string, payload: Record<string, unknown>) => void;
  /** The consuming task, for event attribution only. */
  readonly taskId: string;
}

/**
 * Drops items from the TAIL until `render(kept)` serializes within `maxChars`,
 * recording every drop in `notes`. Never slices a string mid-value and never
 * emits partial JSON — the unit of degradation is a whole item (rc-9).
 */
function trimSection<T>(params: {
  readonly items: readonly T[];
  readonly maxChars: number;
  readonly render: (kept: readonly T[]) => unknown;
  readonly describe: (dropped: T) => string;
  readonly notes: string[];
}): readonly T[] {
  const { items, maxChars, render, describe, notes } = params;
  let kept = items;
  while (kept.length > 0 && JSON.stringify(render(kept)).length > maxChars) {
    const dropped = kept[kept.length - 1];
    kept = kept.slice(0, -1);
    if (dropped !== undefined) notes.push(describe(dropped));
  }
  return kept;
}

/**
 * Reduces the remaining unbounded terms until the WHOLE serialized context fits
 * `FORMATION_TOTAL_MAX_CHARS`, recording each step. Order — identity and
 * bookkeeping before content, content last:
 *
 *   1. `lineageArtifactIds` below the per-id limit,
 *   2. `dreamerContextRefs` (references, not content) dropped entirely,
 *   3. `truncationNotes` collapsed to a bounded summary — the notes describe the
 *      degradation, so they are the correct sacrifice once degradation is the
 *      only thing keeping the block over budget,
 *   4. whole `dreamerProposals` items dropped from the tail as the last resort.
 *
 * Never truncates mid-value and never emits partial JSON (rc-9): every step drops
 * a whole item and records it. Terminates because each branch strictly shrinks a
 * finite array.
 */
function enforceTotalBudget(params: {
  readonly context: FormationContext;
  readonly notes: readonly string[];
}): FormationContext {
  const { context: initialContext, notes: initialNotes } = params;
  let context = initialContext;
  const notes = [...initialNotes];

  const size = (candidate: FormationContext): number => JSON.stringify(candidate).length;

  if (size(context) <= FORMATION_TOTAL_MAX_CHARS) return context;

  // 1. Lineage ids: identity, not content — cap to the last-resort limit.
  if (context.provenance.lineageArtifactIds.length > FORMATION_LINEAGE_ID_LIMIT) {
    notes.push(
      `lineageArtifactIds truncated to ${FORMATION_LINEAGE_ID_LIMIT} to satisfy FORMATION_TOTAL_MAX_CHARS=${FORMATION_TOTAL_MAX_CHARS}`,
    );
    context = {
      ...context,
      provenance: {
        ...context.provenance,
        lineageArtifactIds: context.provenance.lineageArtifactIds.slice(0, FORMATION_LINEAGE_ID_LIMIT),
      },
      truncationNotes: notes,
    };
  }

  // 2. Dreamer contextRefs are references to evidence the prompt cannot read
  //    anyway — cheaper to lose than any projected proposal.
  if (context.dreamerContextRefs.length > 0 && size(context) > FORMATION_TOTAL_MAX_CHARS) {
    notes.push(
      `dreamerContextRefs dropped (${context.dreamerContextRefs.length} refs) to satisfy FORMATION_TOTAL_MAX_CHARS=${FORMATION_TOTAL_MAX_CHARS}`,
    );
    context = { ...context, dreamerContextRefs: [], truncationNotes: notes };
  }

  // 3. Collapse the notes themselves. Keeping raw notes here would be circular:
  //    they exist to explain the drops, and they are the term keeping us over.
  if (size(context) > FORMATION_TOTAL_MAX_CHARS && context.truncationNotes.length > 1) {
    const collapsed = [
      ...context.truncationNotes.slice(0, 1),
      `… ${context.truncationNotes.length - 1} further truncation note(s) collapsed to satisfy FORMATION_TOTAL_MAX_CHARS=${FORMATION_TOTAL_MAX_CHARS}`,
    ];
    context = { ...context, truncationNotes: collapsed };
  }

  // 4. Last resort: drop whole trailing proposals. Sections were already sized
  //    against their own caps, so reaching here means the aggregate bound is the
  //    binding constraint.
  while (context.dreamerProposals.length > 0 && size(context) > FORMATION_TOTAL_MAX_CHARS) {
    const dropped = context.dreamerProposals[context.dreamerProposals.length - 1];
    context = {
      ...context,
      dreamerProposals: context.dreamerProposals.slice(0, -1),
      truncationNotes: [
        ...context.truncationNotes,
        `dreamer candidate dropped to satisfy FORMATION_TOTAL_MAX_CHARS=${FORMATION_TOTAL_MAX_CHARS}: candidateIndex ${dropped?.candidateIndex ?? 'unknown'}`,
      ],
    };
  }

  // 5. Diagnosis block as the final content sacrifice.
  if (context.sourceDiagnosis !== undefined && size(context) > FORMATION_TOTAL_MAX_CHARS) {
    context = {
      ...context,
      truncationNotes: [
        ...context.truncationNotes,
        `diagnosis block dropped entirely to satisfy FORMATION_TOTAL_MAX_CHARS=${FORMATION_TOTAL_MAX_CHARS}`,
      ],
    };
    const { sourceDiagnosis: _dropped, ...rest } = context;
    context = rest;
  }

  // 6. If a pathological note set still exceeds the cap, keep collapsing to the
  //    last note. The bound is a hard prompt-boundary contract.
  while (context.truncationNotes.length > 1 && size(context) > FORMATION_TOTAL_MAX_CHARS) {
    context = {
      ...context,
      truncationNotes: context.truncationNotes.slice(0, context.truncationNotes.length - 1),
    };
  }

  return context;
}

/**
 * Apply the budget contract. Degradation order — cheapest information loss first:
 *   1. trailing dreamer candidates, then
 *   2. trailing diagnosis evidence, then violatedPrinciples, then recommendations,
 *   3. the diagnosis block as a whole,
 *   4. lineage ids (identity, not content) as the last resort.
 *
 * Every step records a `truncationNote`, so a quality regression can always be
 * traced back to whether the bound — not the evidence — cut the input.
 */
function applyBudget(context: FormationContext): FormationContext {
  const notes = [...context.truncationNotes];

  const dreamerProposals = trimSection({
    items: context.dreamerProposals,
    maxChars: FORMATION_PROPOSALS_MAX_CHARS,
    render: (kept) => kept,
    describe: (dropped) =>
      `dreamer candidate dropped to satisfy FORMATION_PROPOSALS_MAX_CHARS=${FORMATION_PROPOSALS_MAX_CHARS}: candidateIndex ${dropped.candidateIndex}`,
    notes,
  });

  let { sourceDiagnosis } = context;
  if (sourceDiagnosis !== undefined) {
    const evidence = trimSection({
      items: sourceDiagnosis.evidence,
      maxChars: FORMATION_DIAGNOSIS_MAX_CHARS,
      render: (kept) => ({ ...sourceDiagnosis, evidence: kept }),
      describe: (dropped) =>
        `diagnosis evidence dropped to satisfy FORMATION_DIAGNOSIS_MAX_CHARS=${FORMATION_DIAGNOSIS_MAX_CHARS}: ${dropped.sourceRef}`,
      notes,
    });
    const violatedPrinciples = trimSection({
      items: sourceDiagnosis.violatedPrinciples,
      maxChars: FORMATION_DIAGNOSIS_MAX_CHARS,
      render: (kept) => ({ ...sourceDiagnosis, evidence, violatedPrinciples: kept }),
      describe: () =>
        `diagnosis violatedPrinciples entry dropped to satisfy FORMATION_DIAGNOSIS_MAX_CHARS=${FORMATION_DIAGNOSIS_MAX_CHARS}`,
      notes,
    });
    const recommendations = trimSection({
      items: sourceDiagnosis.recommendations,
      maxChars: FORMATION_DIAGNOSIS_MAX_CHARS,
      render: (kept) => ({ ...sourceDiagnosis, evidence, violatedPrinciples, recommendations: kept }),
      describe: () =>
        `diagnosis recommendation dropped to satisfy FORMATION_DIAGNOSIS_MAX_CHARS=${FORMATION_DIAGNOSIS_MAX_CHARS}`,
      notes,
    });

    const trimmed: FormationDiagnosisProjection = {
      ...sourceDiagnosis,
      evidence,
      violatedPrinciples,
      recommendations,
    };
    if (JSON.stringify(trimmed).length > FORMATION_DIAGNOSIS_MAX_CHARS) {
      notes.push(
        `diagnosis block dropped entirely: it exceeds FORMATION_DIAGNOSIS_MAX_CHARS=${FORMATION_DIAGNOSIS_MAX_CHARS} even after trimming`,
      );
      sourceDiagnosis = undefined;
    } else {
      sourceDiagnosis = trimmed;
    }
  }

  // Built field-by-field (not spread from `context`) so a section that was
  // dropped above is genuinely ABSENT rather than present-and-undefined.
  const bounded: FormationContext = {
    version: context.version,
    dreamerProposals,
    dreamerContextRefs: context.dreamerContextRefs,
    provenance: context.provenance,
    ...(sourceDiagnosis !== undefined ? { sourceDiagnosis } : {}),
    truncationNotes: notes,
  };

  // Final guard: the per-section caps bound the two CONTENT blocks, but three
  // terms remain unbounded above the section level — `provenance.lineageArtifactIds`,
  // `dreamerContextRefs`, and `truncationNotes` itself — and every drop recorded
  // by `trimSection` GROWS the last of those. A single lineage truncation is
  // therefore not sufficient: it must be re-checked and the ladder continued.
  return enforceTotalBudget({ context: bounded, notes });
}

/**
 * Picks the diagnostic predecessor of the dreamer task, honouring
 * `FORMATION_DIAGNOSIS_TASK_KINDS` order (most authoritative first) and
 * requiring a succeeded task (an unfinished stage has no artifact to read).
 */
async function resolveDiagnosisDependency(
  dreamerTask: FormationTaskView,
  lookupTask: (taskId: string) => Promise<FormationTaskView | null>,
): Promise<{ readonly taskId: string; readonly taskKind: string } | null> {
  const deps = await Promise.all(
    dreamerTask.dependencyTaskIds.map(async (depId) => ({ depId, task: await lookupTask(depId) })),
  );
  for (const stage of FORMATION_DIAGNOSIS_TASK_KINDS) {
    const match = deps.find(
      (entry) => entry.task !== null && entry.task.taskKind === stage && entry.task.status === 'succeeded',
    );
    if (match) return { taskId: match.depId, taskKind: stage };
  }
  return null;
}

async function resolveFormationContextUnsafe(
  params: FormationContextResolverParams,
): Promise<FormationContext | undefined> {
  const { sourceDreamerArtifactId, taskId, emitEvent } = params;

  if (sourceDreamerArtifactId === undefined || sourceDreamerArtifactId.trim() === '') {
    emitEvent('formation_context_skipped', taskId, { reason: 'dreamer_artifact_id_missing' });
    return undefined;
  }

  const dreamerArtifact = await params.artifactStore.getArtifactById(sourceDreamerArtifactId);
  if (!dreamerArtifact) {
    // rc-9: observable — the id was present, so its absence is a real gap.
    emitEvent('formation_dreamer_artifact_missing', taskId, { sourceDreamerArtifactId });
    return undefined;
  }

  const dreamerParsed = parseContentJson(dreamerArtifact.contentJson);
  if (!dreamerParsed) {
    emitEvent('formation_context_invalid', taskId, {
      sourceDreamerArtifactId,
      reason: 'dreamer_content_not_object',
    });
    return undefined;
  }

  const dreamerProjection = projectDreamerProposals(dreamerParsed);
  const truncationNotes = [...dreamerProjection.truncationNotes];
  if (dreamerProjection.candidates.length === 0) {
    // Degrade, do not fail: the diagnosis may still carry the source intent.
    truncationNotes.push('dreamer candidates empty or all malformed — proposals block is empty');
  }

  // ── Diagnosis: walk the dreamer task's predecessors, most-authoritative first.
  let sourceDiagnosis: FormationDiagnosisProjection | undefined;
  const dreamerTaskId = dreamerArtifact.sourceTaskId;
  const dreamerTask = await params.lookupTask(dreamerTaskId);
  if (!dreamerTask) {
    truncationNotes.push(`dreamer task ${dreamerTaskId} not resolvable — diagnosis not attempted`);
  } else {
    const diagnosisDep = await resolveDiagnosisDependency(dreamerTask, params.lookupTask);
    if (!diagnosisDep) {
      truncationNotes.push('no diagnostic stage found among dreamer dependencies — diagnosis omitted');
    } else {
      const artifacts = await params.artifactStore.listBySourceTaskId(diagnosisDep.taskId);
      const [diagnosisArtifact] = artifacts;
      const parsed = diagnosisArtifact ? parseContentJson(diagnosisArtifact.contentJson) : null;
      if (!diagnosisArtifact || !parsed) {
        truncationNotes.push(
          `diagnosis artifact for task ${diagnosisDep.taskId} (${diagnosisDep.taskKind}) unreadable — diagnosis omitted`,
        );
      } else {
        sourceDiagnosis = projectDiagnosisOutput(parsed, {
          artifactId: diagnosisArtifact.artifactId,
          taskId: diagnosisDep.taskId,
          stage: diagnosisDep.taskKind,
        });
      }
    }
  }

  const context: FormationContext = {
    version: FORMATION_CONTEXT_VERSION,
    dreamerProposals: dreamerProjection.candidates,
    dreamerContextRefs: dreamerProjection.contextRefs,
    ...(sourceDiagnosis !== undefined ? { sourceDiagnosis } : {}),
    provenance: {
      sourceDreamerArtifactId: dreamerArtifact.artifactId,
      sourceDreamerTaskId: dreamerTaskId,
      sourceDiagnosisArtifactId: sourceDiagnosis?.artifactId ?? null,
      sourceDiagnosisTaskId: sourceDiagnosis?.taskId ?? null,
      sourcePainId: dreamerProjection.sourcePainId,
      lineageArtifactIds: [...dreamerArtifact.lineageArtifactIds],
    },
    truncationNotes,
  };

  const bounded = applyBudget(context);

  emitEvent('formation_context_resolved', taskId, {
    version: bounded.version,
    candidateCount: bounded.dreamerProposals.length,
    hasDiagnosis: bounded.sourceDiagnosis !== undefined,
    diagnosisStage: bounded.sourceDiagnosis?.stage ?? null,
    truncationNoteCount: bounded.truncationNotes.length,
    serializedChars: JSON.stringify(bounded).length,
  });

  return bounded;
}

/**
 * Resolve the bounded formation context reachable from a dreamer artifact id.
 *
 * Degradation policy (PRI-838 Phase 4 Case 2 — degrade, never fail):
 *   - no dreamer id, or the dreamer artifact cannot be read/parsed
 *       ⇒ returns `undefined` (the caller keeps its previous prompt shape) and
 *         emits an observable event;
 *   - dreamer resolvable but the diagnosis is absent/unreadable
 *       ⇒ returns a context WITHOUT `sourceDiagnosis`, plus a truncation note.
 *
 * NEVER throws — including when the artifact store or the task lookup itself
 * fails. Formation evidence is an enrichment: a store error must not fail a
 * formation run, so every escaping failure is converted into an observable
 * event plus `undefined` (rc-9: degradation is never silent).
 */
export async function resolveFormationContext(
  params: FormationContextResolverParams,
): Promise<FormationContext | undefined> {
  try {
    return await resolveFormationContextUnsafe(params);
  } catch (error) {
    params.emitEvent('formation_context_failed', params.taskId, {
      reason: 'unexpected_error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
