/**
 * Candidate Intake Contract — M7 schema and interface definitions.
 *
 * Defines the intake boundary: input/output schemas, the ledger entry
 * contract, the LedgerAdapter interface, and intake error codes.
 *
 * Implementation logic (CandidateIntakeService) lives in m7-03.
 *
 * Non-goals (M7):
 * - No pain signal auto-trigger (M8)
 * - No legacy evolution-worker deletion (M9)
 * - No promote to active principle
 * - No direct ledger write from SqliteDiagnosticianCommitter
 */
import { Type, type Static } from '@sinclair/typebox';

// ── Schema ────────────────────────────────────────────────────────────────

export const CandidateIntakeInputSchema = Type.Object({
  candidateId: Type.String({ minLength: 1 }),
  workspaceDir: Type.String({ minLength: 1 }),
});

export type CandidateIntakeInput = Static<typeof CandidateIntakeInputSchema>;

export const CandidateIntakeOutputSchema = Type.Object({
  candidateId: Type.String(),
  artifactId: Type.String(),
  ledgerRef: Type.String(),
  status: Type.Literal('consumed'),
});

export type CandidateIntakeOutput = Static<typeof CandidateIntakeOutputSchema>;

export const LedgerPrincipleEntrySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  text: Type.String(),
  triggerPattern: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  status: Type.Literal('probation'),
  evaluability: Type.Literal('weak_heuristic'),
  sourceRef: Type.String(),                          // candidate://<candidateId> — idempotency key
  artifactRef: Type.Optional(Type.String()),           // artifact://<artifactId> — traceability only
  taskRef: Type.Optional(Type.String()),              // task://<taskId> — traceability only
  createdAt: Type.String(),
});

export type LedgerPrincipleEntry = Static<typeof LedgerPrincipleEntrySchema>;

// ── Errors ───────────────────────────────────────────────────────────────

export const INTAKE_ERROR_CODES = {
  CANDIDATE_NOT_FOUND: 'candidate_not_found',
  CANDIDATE_ALREADY_CONSUMED: 'candidate_already_consumed',
  ARTIFACT_NOT_FOUND: 'artifact_not_found',
  LEDGER_WRITE_FAILED: 'ledger_write_failed',
  INPUT_INVALID: 'input_invalid',
} as const;

export class CandidateIntakeError extends Error {
  constructor(
    public readonly code: (typeof INTAKE_ERROR_CODES)[keyof typeof INTAKE_ERROR_CODES],
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CandidateIntakeError';
  }
}

// ── LedgerAdapter interface ─────────────────────────────────────────────────

/**
 * Abstraction for writing probation principles to the ledger.
 * Implementations write to file-based ledger (openclaw-plugin) or test doubles.
 */
export interface LedgerAdapter {
  /**
   * Write a probation principle entry to the ledger.
   *
   * The implementation (m7-02) must:
   * 1. Expand the 9-field LedgerPrincipleEntry into a full LedgerPrinciple
   *    by applying the documented default values.
   * 2. Call addPrincipleToLedger(stateDir, ledgerPrinciple).
   * 3. Return the LedgerPrincipleEntry as-is (passthrough for idempotency tracking).
   *
   * The stateDir is derived from workspaceDir.
   *
   * @param entry — Full LedgerPrincipleEntry with id and createdAt already populated
   *                by the intake service.
   * @returns The same entry (passthrough) for ledgerRef construction.
   * @throws CandidateIntakeError with code LEDGER_WRITE_FAILED if the write fails.
   */
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry;

  /**
   * Check if a ledger entry already exists for a given candidate.
   *
   * **Matching rule (D-11):** Scan `tree.principles` for an entry whose
   * `sourceRef` field matches `'candidate://<candidateId>'`.
   *
   * Matching is by `sourceRef` (candidate-level idempotency key), NOT by
   * `artifactId`. One artifact can produce multiple candidates (M5); each
   * candidate must have its own unique ledger entry retrievable by this method.
   *
   * This is used by the intake service for idempotency: if an entry
   * already exists for this candidate, the intake is a no-op (D-10).
   *
   * @param candidateId — The candidate ID to check for existing ledger entries.
   * @returns The existing LedgerPrincipleEntry if found, null otherwise.
   */
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null;
}
