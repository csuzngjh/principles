import { CandidateIntakeError, INTAKE_ERROR_CODES } from '@principles/core/runtime-v2';
import type { LedgerAdapter, LedgerPrincipleEntry } from '@principles/core/runtime-v2';
import { addPrincipleToLedger } from './principle-tree-ledger.js';
import type { LedgerPrinciple } from './principle-tree-ledger.js';

/**
 * PrincipleTreeLedgerAdapter — bridges 11-field LedgerPrincipleEntry to 18+ field LedgerPrinciple.
 *
 * This adapter maintains an in-memory idempotency map. Create once and reuse
 * across calls within the same process lifetime. Do not create a new instance
 * per intake call.
 */
export class PrincipleTreeLedgerAdapter implements LedgerAdapter {
  #stateDir: string;
  #entryMap = new Map<string, LedgerPrincipleEntry>();

  constructor(opts: { stateDir: string }) {
    this.#stateDir = opts.stateDir;
  }

  /**
   * Write a probation entry to the ledger.
   *
   * Idempotency: if the same candidateId was already written, returns the
   * existing entry without writing again.
   *
   * @throws CandidateIntakeError with code LEDGER_WRITE_FAILED on write failure.
   */
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
    const candidateId = this.#extractCandidateId(entry.sourceRef);
    const existing = this.#entryMap.get(candidateId);
    if (existing) return existing;

    const ledgerPrinciple = this.#expandToLedgerPrinciple(entry, candidateId);

    try {
      addPrincipleToLedger(this.#stateDir, ledgerPrinciple);
    } catch (err) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED,
        `Failed to write principle ${entry.id} to ledger: ${String(err)}`,
        { cause: err },
      );
    }

    this.#entryMap.set(candidateId, entry);
    return entry;
  }

  /**
   * Check if a ledger entry already exists for a given candidate.
   *
   * @returns The existing LedgerPrincipleEntry if found, null otherwise.
   */
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
    return this.#entryMap.get(candidateId) ?? null;
  }

  /**
   * Extract candidateId from sourceRef by stripping the 'candidate://' prefix.
   *
   * @internal
   */
  #extractCandidateId(sourceRef: string): string {
    if (sourceRef.startsWith('candidate://')) {
      return sourceRef.slice('candidate://'.length);
    }
    return sourceRef;
  }

  /**
   * Expand an 11-field LedgerPrincipleEntry to an 18+ field LedgerPrinciple.
   *
   * Applies the field expansion table from CONTEXT.md:
   * - status: 'probation' → 'candidate'
   * - triggerPattern/action: pass through (empty string if absent)
   * - All defaults applied per CONTEXT.md expansion table
   * - sourceRef/artifactRef/taskRef are NOT written to LedgerPrinciple
   *
   * @internal
   */
  #expandToLedgerPrinciple(entry: LedgerPrincipleEntry, candidateId: string): LedgerPrinciple {
    const result: LedgerPrinciple = {
      id: entry.id,
      version: 1,
      text: entry.text,
      triggerPattern: entry.triggerPattern ?? '',
      action: entry.action ?? '',
      status: 'candidate',
      evaluability: entry.evaluability,
      priority: 'P1',
      scope: 'general',
      valueScore: 0,
      adherenceRate: 0,
      painPreventedCount: 0,
      derivedFromPainIds: [candidateId],
      ruleIds: [],
      conflictsWithPrincipleIds: [],
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    };
    return result;
  }
}
