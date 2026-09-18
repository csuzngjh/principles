/**
 * PrincipleTreeLedgerAdapter — bridges LedgerAdapter interface to principle-tree-ledger.ts.
 *
 * Lives in principles-core/runtime-v2 so pd-cli can use the same adapter
 * as openclaw-plugin without depending on openclaw-plugin private code.
 */

import { addPrincipleToLedger, loadLedger, updatePrinciple } from '../../principle-tree-ledger.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../candidate-intake.js';

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;

function extractCandidateIdStatic(sourceRef: string): string {
  if (sourceRef.startsWith('candidate://')) {
    return sourceRef.slice('candidate://'.length);
  }
  return sourceRef;
}

function expandToLedgerPrincipleStatic(entry: LedgerPrincipleEntry, candidateId: string) {
  if (!VALID_EVALUABILITIES.includes(entry.evaluability)) {
    throw new Error(
      `Invalid evaluability value: ${entry.evaluability}. Must be one of: ${VALID_EVALUABILITIES.join(', ')}`,
    );
  }

  return {
    id: entry.id,
    version: 1,
    text: entry.text,
    triggerPattern: entry.triggerPattern ?? '',
    action: entry.action ?? '',
    status: 'candidate' as const,
    evaluability: entry.evaluability,
    priority: 'P1' as const,
    scope: 'general' as const,
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: [candidateId],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
}

/**
 * PrincipleTreeLedgerAdapter — bridges 11-field LedgerPrincipleEntry to ledger file.
 *
 * Maintains an in-memory idempotency map. Create once and reuse
 * across calls within the same process lifetime.
 */
export class PrincipleTreeLedgerAdapter implements LedgerAdapter {
  readonly #stateDir: string;
  readonly #entryMap = new Map<string, LedgerPrincipleEntry>();

  constructor(opts: { stateDir: string }) {
    this.#stateDir = opts.stateDir;
  }

  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
    const candidateId = extractCandidateIdStatic(entry.sourceRef);
    const existing = this.#entryMap.get(candidateId);
    if (existing) return existing;

    const ledgerPrinciple = expandToLedgerPrincipleStatic(entry, candidateId);
    addPrincipleToLedger(this.#stateDir, ledgerPrinciple);
    this.#entryMap.set(candidateId, entry);
    return entry;
  }

  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
    const cached = this.#entryMap.get(candidateId);
    if (cached) return cached;

    const ledger = loadLedger(this.#stateDir);
    const found = Object.values(ledger.tree.principles).find((p) =>
      p.derivedFromPainIds.includes(candidateId),
    );
    if (!found) return null;

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
    };
  }

  /**
   * Owner Decision Experience v1 Phase A (§9.1): plural ledger lookup for
   * identity binding. Governance publication requires a UNIQUE ledger target —
   * `existsForCandidate` intentionally returns the first match (legacy intake
   * idempotency semantics), which cannot distinguish "exactly one" from
   * "several". Returns every ledger principle referencing the candidate.
   */
  listForCandidate(candidateId: string): { id: string }[] {
    const ledger = loadLedger(this.#stateDir);
    return Object.values(ledger.tree.principles)
      .filter((p) => p.derivedFromPainIds.includes(candidateId))
      .map((p) => ({ id: p.id }));
  }

  /**
   * Owner Decision Experience v1 Phase A (§9.1): presence check by principle
   * id. A pre-existing artifact binding is only trusted when its target is a
   * real ledger principle ("验证目标确实存在").
   */
  hasPrinciple(principleId: string): boolean {
    const ledger = loadLedger(this.#stateDir);
    return Object.hasOwn(ledger.tree.principles, principleId);
  }

  /**
   * Bug-O L3 fix: upgrade a ledger principle's status to 'active' after the
   * corresponding approval+activation has been dispatched successfully.
   *
   * Called by ApprovalsConsoleModel.approve() after the activation is written
   * to SQLite. Returns ok:false (not throw) when the principle is missing or
   * the update fails, so the caller can surface a non-fatal warning without
   * rolling back the already-committed activation (rc-9-no-silent-fallback).
   */
  activatePrinciple(principleId: string): { ok: true } | { ok: false; reason: string } {
    try {
      updatePrinciple(this.#stateDir, principleId, {
        status: 'active',
        updatedAt: new Date().toISOString(),
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `ledger_activate_failed: ${message}` };
    }
  }
}