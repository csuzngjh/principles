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
import type { LedgerAdapter, LedgerPrincipleEntry } from './candidate-intake.js';
import { CandidateIntakeError, INTAKE_ERROR_CODES } from './candidate-intake.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';

interface Recommendation {
  title?: string;
  text?: string;
  triggerPattern?: string;
  action?: string;
  abstractedPrinciple?: string;
}

export interface CandidateIntakeServiceOptions {
  stateManager: RuntimeStateManager;
  ledgerAdapter: LedgerAdapter;
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
    // eslint-disable-next-line @typescript-eslint/init-declarations
    let recommendation!: Recommendation;
    const sourceRecJson = candidate.sourceRecommendationJson;
    try {
      if (sourceRecJson && sourceRecJson.trim() !== '') {
        const fromCandidate = JSON.parse(sourceRecJson) as Recommendation;
        if (fromCandidate && typeof fromCandidate === 'object') {
          recommendation = fromCandidate;
        }
      }
    } catch {
      // sourceRecommendationJson is empty or invalid — fall through to artifact parsing
    }

    // 4c. Fall back to artifact.contentJson if no valid sourceRecommendationJson
    if (!recommendation) {
      try {
        const parsed = JSON.parse(artifact.contentJson) as { recommendation?: Recommendation };
        // DiagnosticianRunner stores raw DiagnosticianOutputV1 (no wrapper)
        // Manual E2E tests store { recommendation: {...} } wrapper
        recommendation = parsed.recommendation ?? parsed as unknown as Recommendation;
      } catch (err: unknown) {
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
