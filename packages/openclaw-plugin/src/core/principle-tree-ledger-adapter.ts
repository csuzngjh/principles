import { CandidateIntakeError, INTAKE_ERROR_CODES } from '@principles/core/runtime-v2';
import type { LedgerAdapter, LedgerPrincipleEntry } from '@principles/core/runtime-v2';
import { addPrincipleToLedger, loadLedger } from './principle-tree-ledger.js';
import type { LedgerPrinciple } from './principle-tree-ledger.js';

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;

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
   * Queries both the in-memory Map (fast path for same-process repeat calls)
   * and the ledger file (for cross-process idempotency across CLI invocations).
   *
   * @returns The existing LedgerPrincipleEntry if found, null otherwise.
   */
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
    // Fast path: check in-memory Map (covers same-process repeat calls)
    const cached = this.#entryMap.get(candidateId);
    if (cached) return cached;

    // Cross-process path: check ledger file by derivedFromPainIds
    const ledger = loadLedger(this.#stateDir);
    const found = Object.values(ledger.tree.principles).find((p) =>
      p.derivedFromPainIds.includes(candidateId),
    );
    if (!found) return null;

    // Reconstruct LedgerPrincipleEntry from LedgerPrinciple fields
    // Note: sourceRef, artifactRef, taskRef are not stored in LedgerPrinciple,
    // so we cannot fully reconstruct the original LedgerPrincipleEntry.
    // Return minimal entry sufficient for idempotency signaling.
    return {
      id: found.id,
      title: '',
      status: 'probation' as const,
      sourceRef: `candidate://${candidateId}`,
      artifactRef: '',
      taskRef: '',
      text: found.text,
      triggerPattern: found.triggerPattern,
      action: found.action,
      evaluability: 'weak_heuristic' as const,
      createdAt: found.createdAt,
    } as LedgerPrincipleEntry;
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
   * - sourceRef/artifactRef/taskRef are NOT written to LedgerPrinciple (not stored)
   * - title is NOT written to LedgerPrinciple — intentionally excluded; title
   *   is available in LedgerPrincipleEntry but LedgerPrinciple has no title field
   *
   * @internal
   */
  #expandToLedgerPrinciple(entry: LedgerPrincipleEntry, candidateId: string): LedgerPrinciple {
    if (!VALID_EVALUABILITIES.includes(entry.evaluability as (typeof VALID_EVALUABILITIES)[number])) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.INPUT_INVALID,
        `Invalid evaluability value: ${entry.evaluability}. Must be one of: ${VALID_EVALUABILITIES.join(', ')}`,
      );
    }

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
