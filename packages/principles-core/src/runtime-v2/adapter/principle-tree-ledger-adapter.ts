/**
 * PrincipleTreeLedgerAdapter — bridges LedgerAdapter interface to principle-tree-ledger.ts.
 *
 * Lives in principles-core/runtime-v2 so pd-cli can use the same adapter
 * as openclaw-plugin without depending on openclaw-plugin private code.
 */

import {
  addPrincipleToLedger,
  createRuleCandidateBindingReview,
  mutateRuleCandidateBinding,
  appendReuseEvidence as appendReuseEvidenceToLedger,
  loadLedger,
  readLedgerFileState,
  updatePrinciple,
  validateReuseEvidenceEntry,
} from '../../principle-tree-ledger.js';
import { isCanonicalBindingPrincipleId } from '../principle-tree/rule-candidate-binding.js';
import type { CandidatePrincipleIdentityResolution, RuleCandidateBindingSources, RuleCandidateBindingReview, RuleCandidateBindingMutation, RuleCandidateBindingMutationResult } from '../types/rule-candidate-binding.js';
import { isRecord } from '../principle-tree/ledger-codec.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../candidate-intake.js';
import type { ReuseEvidenceEntry } from '../types/principle-schema.js';

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
  readonly #reviewSources?: RuleCandidateBindingSources;
  readonly #entryMap = new Map<string, LedgerPrincipleEntry>();

  constructor(opts: { stateDir: string; reviewSources?: RuleCandidateBindingSources }) {
    this.#stateDir = opts.stateDir;
    this.#reviewSources = opts.reviewSources;
  }

  /** One file snapshot; never combine availability and identity from separate reads. */
  resolveCandidatePrincipleIdentity(candidateId: string, candidateKind: unknown): CandidatePrincipleIdentityResolution {
    const unresolved = (reason: Extract<CandidatePrincipleIdentityResolution, { status: 'unresolved' }>['reason']): CandidatePrincipleIdentityResolution =>
      ({ status: 'unresolved', reason, nextAction: 'Review the candidate identity and current ledger evidence in the Owner Console.' });
    const state = readLedgerFileState(this.#stateDir);
    if (state.availability.status === 'unreadable') return unresolved(state.availability.corrupt ? 'ledger_corrupt' : 'ledger_unavailable');
    if (!candidateId.trim()) return unresolved('candidate_missing');
    if (candidateKind !== 'principle' && candidateKind !== 'rule') return unresolved('candidate_kind_invalid');
    const {tree} = state.ledger;
    const checkedAt = new Date().toISOString();
    if (candidateKind === 'rule') {
      const binding = Object.hasOwn(tree.ruleCandidateBindings ?? {}, candidateId) ? tree.ruleCandidateBindings?.[candidateId]?.revisions.at(-1) : undefined;
      if (!binding) return unresolved('missing');
      if (binding.action === 'revoke') return unresolved('binding_revoked');
      const target = Object.hasOwn(tree.principles, binding.principleId) ? tree.principles[binding.principleId] : undefined;
      if (!target) return unresolved('target_missing');
      if (!['candidate', 'probation', 'active'].includes(target.status)) return unresolved('target_ineligible');
      return { status: 'resolved', candidateId, principleId: binding.principleId, basis: 'owner_rule_binding', bindingRevision: binding.revision, decisionId: binding.decisionId, checkedAt };
    }
    const derived = new Set<string>();
    const reused = new Set<string>();
    for (const principle of Object.values(tree.principles)) {
      if (principle.derivedFromPainIds.includes(candidateId)) derived.add(principle.id);
      if (principle.reuseEvidence !== undefined && !Array.isArray(principle.reuseEvidence)) return unresolved('ledger_corrupt');
      for (const evidence of principle.reuseEvidence ?? []) {
        try { validateReuseEvidenceEntry(evidence); }
        catch { return unresolved('ledger_corrupt'); }
        if (evidence.candidateId === candidateId) reused.add(principle.id);
      }
    }
    const all = new Set([...derived, ...reused]);
    if (!all.size) return unresolved('missing');
    if (all.size > 1) return unresolved(derived.size && reused.size ? 'conflicting_authorities' : 'ambiguous');
    const [principleId] = all;
    if (!isCanonicalBindingPrincipleId(principleId)) return unresolved('target_ineligible');
    return { status: 'resolved', candidateId, principleId, basis: derived.size ? 'derived_candidate' : 'principle_reuse', checkedAt };
  }

  async createRuleCandidateBindingReview(candidateId: string, options: { search?: string; limit?: number } = {}): Promise<RuleCandidateBindingReview> {
    if (!this.#reviewSources) return { ok: false, reason: 'review_source_unavailable', nextAction: 'Connect the persisted candidate review sources.' };
    return createRuleCandidateBindingReview(this.#stateDir, candidateId, { ...options, sources: this.#reviewSources });
  }

  async mutateRuleCandidateBinding(input: RuleCandidateBindingMutation): Promise<RuleCandidateBindingMutationResult> {
    // Revocation intentionally never calls candidate sources, even after source deletion.
    return mutateRuleCandidateBinding(this.#stateDir, input, this.#reviewSources ?? { loadCandidateMaterial: async () => null });
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
   * PRI-917 PR3B Phase 2 — the reuse-side resolution lookup (LedgerAdapter
   * contract, see candidate-intake.ts). Scans `reuseEvidence[]` for the
   * candidate; never touches `derivedFromPainIds` / existsForCandidate.
   *
   * Entries on disk were shape-validated by the append writer; a record that
   * fails even the minimal read-side check cannot be a resolution and is
   * skipped rather than trusted (rc-2).
   */
  findReuseResolutionForCandidate(candidateId: string): { principleId: string; evidence: ReuseEvidenceEntry } | null {
    const ledger = loadLedger(this.#stateDir);
    for (const principle of Object.values(ledger.tree.principles)) {
      // rc-1/rc-3/rc-9: read-side defense — the writer validates, but the reader
      // must also guard against externally-modified ledger files. A non-array
      // reuseEvidence field (e.g. number, object) would cause for...of to throw
      // TypeError, which is not a structured error. Skip such entries.
      if (!Array.isArray(principle.reuseEvidence)) continue;
      for (const entry of principle.reuseEvidence) {
        if (isRecord(entry) && entry.candidateId === candidateId) {
          return { principleId: principle.id, evidence: entry };
        }
      }
    }
    return null;
  }

  /**
   * PRI-917 PR3B Phase 2 — persist one reuse resolution (LedgerAdapter
   * contract). Thin delegation to the core writer, which owns the lock, the
   * integrity guards, candidateId idempotency, and append-only semantics.
   */
  appendReuseEvidence(
    principleId: string,
    entry: ReuseEvidenceEntry,
  ): { principleId: string; reuseEvidence: ReuseEvidenceEntry[]; appended: boolean } {
    return appendReuseEvidenceToLedger(this.#stateDir, principleId, entry);
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
   * PRI-915: whether the ledger backing store is decidable right now. When
   * `false`, `hasPrinciple`/`listForCandidate` collapse the unreadable file to
   * an empty ledger, so their `false`/`[]` answers mean "cannot read", not
   * "non-member" — callers that would report data drift MUST consult this
   * first. A missing file is `true` (a true empty ledger), not an outage.
   */
  isAvailable(): boolean {
    return readLedgerFileState(this.#stateDir).availability.status !== 'unreadable';
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
export type { CandidatePrincipleIdentityResolution, CandidateIdentityReceipt } from '../types/rule-candidate-binding.js';
export { validateCandidateIdentityReceipt } from '../principle-tree/rule-candidate-binding.js';
