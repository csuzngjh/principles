/**
 * CandidateIntakeService — consumes pending candidates and writes ledger entries.
 *
 * Workflow:
 *   1. Validate input
 *   2. Check idempotency (existsForCandidate) — O(1) lookup
 *   3. Load candidate from DB (RuntimeStateManager)
 *   3b. ★ Principle Ledger write boundary (Phase 1 / PR1) — see below
 *   4. Load artifact from DB and parse recommendation
 *   5. Build 11-field LedgerPrincipleEntry
 *   6. Write via adapter.writeProbationEntry()
 *
 * ── Principle Ledger write boundary (Phase 1 / PR1) ─────────────────────────
 * This service is the single shared chokepoint through which EVERY
 * candidate-origin write to the Principle Ledger flows (pd-cli `candidate
 * intake` / `repair` / `backfill`, `diagnose --intake`, `pain-retry`, and the
 * automatic PainSignalBridge path). The boundary is therefore enforced HERE,
 * once, rather than at each call site.
 *
 * Only a candidate whose persisted `recommendation_kind` is EXACTLY
 * `'principle'` may write the ledger. Every other kind (`rule` / `prompt` /
 * `implementation` / `defer`) and every unknown / missing / malformed value is
 * refused FAIL CLOSED and reported as an explicit `refused` disposition — the
 * refusal never collapses into a principle, and it never throws, so sibling
 * candidates in a batch keep their existing persistence / routing / defer
 * behaviour.
 *
 * On error: candidate stays `pending`, throws CandidateIntakeError.
 * Idempotent: if adapter already has entry for candidate, returns it (no-op).
 *
 * Non-goals (M7):
 *   - No DB status update to 'consumed' (m7-04 CLI handler does that)
 *   - No promotion to active principle (M8+)
 *   - No pain signal bridge
 */

import { randomUUID } from 'crypto';
import type { LedgerAdapter, LedgerPrincipleEntry, Recommendation } from './candidate-intake.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES, isRecord, validateRecommendation } from './candidate-intake.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
import {
  isPrincipleLedgerEligibleKind,
  validateRecommendationKind,
} from './store/candidate/recommendation-kind-resolver.js';

/**
 * Why the Principle Ledger write boundary refused a candidate (Phase 1 / PR1).
 *
 * - `non_principle_kind` — a *valid* kind that simply does not target the
 *   Principle Ledger (`rule` / `prompt` / `implementation` / `defer`). The
 *   candidate keeps flowing through its existing route / defer handling.
 * - `unknown_kind` — no usable kind at all (missing / non-string / not in the
 *   known set). This is the case that previously FAILED OPEN into a principle.
 */
export type LedgerRefusalReason = 'non_principle_kind' | 'unknown_kind';

/**
 * Explicit disposition returned by {@link CandidateIntakeService.intake}.
 *
 * `intake()` intentionally does NOT return a bare `LedgerPrincipleEntry`: a
 * refused ledger write must never be indistinguishable from a successful one
 * (rc-9-no-silent-fallback).
 */
export type CandidateIntakeResult =
  | {
      readonly outcome: 'ledger_entry';
      /** `true` when THIS call wrote a new entry; `false` for the idempotent no-op. */
      readonly written: boolean;
      readonly entry: LedgerPrincipleEntry;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: LedgerRefusalReason;
      readonly candidateId: string;
      /** The raw persisted kind, or `null` when it was absent / not a string. */
      readonly rawRecommendationKind: string | null;
      readonly message: string;
    };


export interface CandidateIntakeServiceOptions {
  stateManager: RuntimeStateManager;
  ledgerAdapter: LedgerAdapter;
}

/**
 * Normalize a DiagnosticianRecommendation-shaped object to the Recommendation
 * contract by mapping `description` → `text`. The diagnostician-committer stores
 * `JSON.stringify(rec)` where rec has `description`, but the intake service's
 * Recommendation contract uses `text`. Without this, the canonical
 * sourceRecommendationJson path would reject every real diagnostician candidate.
 *
 * Returns the normalized object, or `null` if the input is not a record carrying
 * a string `description`. The result MUST still pass `validateRecommendation`.
 */
function normalizeDiagnosticianRecommendation(raw: unknown): { text: string } | null {
  if (!isRecord(raw)) return null;
  const desc = raw.description;
  if (typeof desc !== 'string') return null;
  return { text: desc };
}

/**
 * Extract a validated Recommendation from the three historical contentJson shapes:
 *   1. { recommendation: {...} }  — manual E2E wrapper
 *   2. DiagnosticianOutputV1      — { summary, rootCause, recommendations: [...] }
 *   3. bare Recommendation-like object
 *
 * rc-1/rc-2: the value is untrusted — every branch validates before returning.
 * Returns the validated Recommendation, or null if none of the shapes match.
 */
function extractRecommendationFromContentJson(parsed: unknown): Recommendation | null {
  if (!isRecord(parsed)) return null;
  // Shape 1: { recommendation: {...} } wrapper.
  if (Object.hasOwn(parsed, 'recommendation')) {
    const inner = parsed.recommendation;
    const rec = validateRecommendation(inner);
    if (rec) return rec;
    const norm = normalizeDiagnosticianRecommendation(inner);
    if (norm) return validateRecommendation(norm);
  }
  // Shape 2: DiagnosticianOutputV1 with recommendations[].
  if (Object.hasOwn(parsed, 'recommendations')) {
    const arr = parsed.recommendations;
    if (Array.isArray(arr) && arr.length > 0) {
      const [first] = arr;
      const rec = validateRecommendation(first);
      if (rec) return rec;
      const norm = normalizeDiagnosticianRecommendation(first);
      if (norm) return validateRecommendation(norm);
    }
  }
  // Shape 3: bare Recommendation-like object.
  const bare = validateRecommendation(parsed);
  if (bare) return bare;
  const norm = normalizeDiagnosticianRecommendation(parsed);
  if (norm) return validateRecommendation(norm);
  return null;
}

export class CandidateIntakeService {
  readonly #stateManager: RuntimeStateManager;
  readonly #ledgerAdapter: LedgerAdapter;

  constructor(opts: CandidateIntakeServiceOptions) {
    this.#stateManager = opts.stateManager;
    this.#ledgerAdapter = opts.ledgerAdapter;
  }

  /**
   * Consume a pending candidate: load it and its artifact, build a
   * LedgerPrincipleEntry, and write it to the ledger via the adapter — but ONLY
   * when the candidate's persisted `recommendation_kind` is exactly
   * `'principle'` (Principle Ledger write boundary, Phase 1 / PR1).
   *
   * @param candidateId - The candidate ID to intake.
   * @returns `{ outcome: 'ledger_entry' }` with the written (or already
   *          existing) entry, or `{ outcome: 'refused' }` when the write
   *          boundary rejected the candidate's kind. Refusal is a normal
   *          disposition, NOT an error.
   * @throws CandidateIntakeError with code:
   *   - INPUT_INVALID when candidateId is empty/invalid
   *   - CANDIDATE_NOT_FOUND when candidate does not exist
   *   - ARTIFACT_NOT_FOUND when artifact is missing or unreadable
   *   - LEDGER_WRITE_FAILED when ledger write fails
   */
  async intake(candidateId: string): Promise<CandidateIntakeResult> {
    // 1. Input validation (E-01)
    if (!candidateId || typeof candidateId !== 'string' || candidateId.trim() === '') {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        'candidateId must be a non-empty string',
        { candidateId },
      );
    }

    // 2. Idempotency check FIRST (E-02, D-10)
    const existing = this.#ledgerAdapter.existsForCandidate(candidateId);
    if (existing) {
      return { outcome: 'ledger_entry', written: false, entry: existing };
    }

    // 3. Load candidate from DB
    const candidate = await this.#stateManager.getCandidate(candidateId);
    if (!candidate) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.CANDIDATE_NOT_FOUND,
        `Candidate ${candidateId} not found`,
        { candidateId },
      );
    }

    // 3b. ★ Principle Ledger write boundary (Phase 1 / PR1).
    //
    // SPEC v2.1 §5.1 "Raw Kind Provenance Validation": the decision is made on
    // the RAW persisted `recommendation_kind` — never on
    // `candidate.recommendationKind`, whose fail-open normalization collapses
    // every unknown value into 'principle' and would silently defeat this gate.
    //
    // FAIL CLOSED: anything that is not exactly 'principle' is refused, so an
    // unknown/missing/malformed kind can no longer become a principle.
    //
    // Refusal is returned as an explicit disposition rather than thrown: the
    // six production call sites (pd-cli candidate/diagnose/pain-retry and the
    // PainSignalBridge batch loop) must keep their existing per-candidate
    // persistence / routing / defer behaviour, and a throw would abort sibling
    // candidates in the same batch (EP-03 / ERR-089).
    if (!isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind)) {
      const validatedKind = validateRecommendationKind(candidate.rawRecommendationKind);
      const reason: LedgerRefusalReason = validatedKind === null ? 'unknown_kind' : 'non_principle_kind';
      const rawKind = typeof candidate.rawRecommendationKind === 'string' ? candidate.rawRecommendationKind : null;
      return {
        outcome: 'refused',
        reason,
        candidateId,
        rawRecommendationKind: rawKind,
        message: reason === 'non_principle_kind'
          ? `Candidate ${candidateId} has recommendation_kind '${rawKind}' which does not target the Principle Ledger; ledger write refused (existing routing/defer handling preserved).`
          : `Candidate ${candidateId} has an unrecognized recommendation_kind (${rawKind === null ? 'absent' : `'${rawKind}'`}); Principle Ledger write refused fail-closed.`,
      };
    }

    // 4. Load artifact (E-04)
    const artifact = await this.#stateManager.getArtifact(candidate.artifactId);
    if (!artifact) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.ARTIFACT_NOT_FOUND,
        `Artifact ${candidate.artifactId} not found for candidate ${candidateId}`,
        { candidateId, artifactId: candidate.artifactId },
      );
    }

    // 4b. Parse recommendation from candidate.sourceRecommendationJson FIRST (canonical source)
    // Fall back to artifact.contentJson for backwards-compatibility with legacy/manual inserts.
     
    let recommendation!: Recommendation;
    const sourceRecJson = candidate.sourceRecommendationJson;
    try {
      if (sourceRecJson && sourceRecJson.trim() !== '') {
        // rc-1/rc-2 (ERR-001/ERR-005): candidate JSON is untrusted — validate shape,
        // never cast directly. validateRecommendation returns null on bad shape;
        // a null result falls through to the contentJson branch below.
        const parsed = JSON.parse(sourceRecJson) as unknown;
        const fromCandidate = validateRecommendation(parsed);
        if (fromCandidate) {
          recommendation = fromCandidate;
        } else {
          // diagnostician-committer stores a DiagnosticianRecommendation, whose
          // body field is `description` (not `text`). Normalize that shape to the
          // Recommendation contract so the canonical source path is preferred over
          // the contentJson fallback. rc-4: validate the normalized value too.
          const normalized = normalizeDiagnosticianRecommendation(parsed);
          const fromNorm = normalized ? validateRecommendation(normalized) : null;
          if (fromNorm) {
            recommendation = fromNorm;
          }
        }
      }
    } catch (err: unknown) {
      // sourceRecommendationJson is non-empty but malformed — warn and fall through
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[CandidateIntakeService] sourceRecommendationJson parse failed for candidate ${candidateId}: ${detail}. Falling back to artifact.contentJson.`);
    }

    // 4c. Fall back to artifact.contentJson if no valid sourceRecommendationJson
    if (!recommendation) {
      try {
        const parsed = JSON.parse(artifact.contentJson) as unknown;
        // Three historical shapes can land in contentJson:
        //   1. { recommendation: {...} }  — manual E2E wrapper
        //   2. DiagnosticianOutputV1      — { summary, rootCause, recommendations: [...] }
        //   3. bare Recommendation-like object
        // rc-1/rc-2: parsed is untrusted — validate, never cast. rc-5: Object.hasOwn.
        const rec = extractRecommendationFromContentJson(parsed);
        if (!rec) {
          throw new CandidateIntakeError(
            INTAKE_ERROR_CODES.INPUT_INVALID,
            `Failed to parse artifact content for candidate ${candidateId}: contentJson is not a valid recommendation object`,
            { candidateId },
          );
        }
        recommendation = rec;
      } catch (err: unknown) {
        if (err instanceof CandidateIntakeError) throw err;
        throw new CandidateIntakeError(
          INTAKE_ERROR_CODES.INPUT_INVALID,
          `Failed to parse artifact content for candidate ${candidateId}: ${err instanceof Error ? err.message : String(err)}`,
          { candidateId, cause: err },
        );
      }
    }

    // 5. Build 11-field LedgerPrincipleEntry (E-06)
    const entry: LedgerPrincipleEntry = {
      id: randomUUID(),
      title: candidate.title,
      text: recommendation.text || candidate.description || '',
      triggerPattern: recommendation.triggerPattern,
      action: recommendation.action,
      status: 'probation',
      evaluability: 'weak_heuristic',
      sourceRef: `candidate://${candidateId}`,
      artifactRef: `artifact://${candidate.artifactId}`,
      taskRef: candidate.taskId ? `task://${candidate.taskId}` : undefined,
      createdAt: new Date().toISOString(),
    };

    // 6. Write to ledger via adapter (E-01, D-09)
    try {
      const written = this.#ledgerAdapter.writeProbationEntry(entry);
      return { outcome: 'ledger_entry', written: true, entry: written };
    } catch (err: unknown) {
      if (err instanceof CandidateIntakeError) {
        throw err;
      }
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED,
        `Failed to write ledger entry for candidate ${candidateId}`,
        { candidateId, cause: err },
      );
    }
  }
}
