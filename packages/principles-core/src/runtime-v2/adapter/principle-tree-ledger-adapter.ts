/**
 * PrincipleTreeLedgerAdapter — bridges LedgerAdapter interface to principle-tree-ledger.ts.
 *
 * Lives in principles-core/runtime-v2 so pd-cli can use the same adapter
 * as openclaw-plugin without depending on openclaw-plugin private code.
 */

import { addPrincipleToLedger, loadLedger } from '../../principle-tree-ledger.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../candidate-intake.js';

const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;

function extractCandidateIdStatic(sourceRef: string): string {
  if (sourceRef.startsWith('candidate://')) {
    return sourceRef.slice('candidate://'.length);
  }
  return sourceRef;
}

function expandToLedgerPrincipleStatic(entry: LedgerPrincipleEntry, candidateId: string) {
  if (!VALID_EVALUABILITIES.includes(entry.evaluability as (typeof VALID_EVALUABILITIES)[number])) {
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
    } as LedgerPrincipleEntry;
  }
}