/**
 * CandidateIntakeService — consumes pending candidates and writes ledger entries.
 *
 * Workflow:
 *   1. Validate input
 *   2. Check idempotency (existsForCandidate) — O(1) lookup
 *   3. Load candidate from DB (RuntimeStateManager)
 *   4. Load artifact from DB and parse recommendation
 *   5. Build 11-field LedgerPrincipleEntry
 *   6. Write via adapter.writeProbationEntry()
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
   * LedgerPrincipleEntry, and write it to the ledger via the adapter.
   *
   * @param candidateId - The candidate ID to intake.
   * @returns The written (or existing) LedgerPrincipleEntry.
   * @throws CandidateIntakeError with code:
   *   - INPUT_INVALID when candidateId is empty/invalid
   *   - CANDIDATE_NOT_FOUND when candidate does not exist
   *   - ARTIFACT_NOT_FOUND when artifact is missing or unreadable
   *   - LEDGER_WRITE_FAILED when ledger write fails
   */
  async intake(candidateId: string): Promise<LedgerPrincipleEntry> {
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
      return existing;
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
      return this.#ledgerAdapter.writeProbationEntry(entry);
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
