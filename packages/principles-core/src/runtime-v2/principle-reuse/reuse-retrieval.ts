/**
 * PRI-917 Slice 1 — read-only reuse retrieval over the existing Principle
 * Ledger.
 *
 * Reuses `loadLedger` (the single ledger authority) and the existing
 * principle-kind guard. Creates no repository, no database, no index, no
 * vector store, and no embedding service. It never writes: `derivedFromPainIds`,
 * the ledger schema, and `activation_decisions` are all untouched.
 *
 * @see docs/specs/PRI-917-reuse-before-create-v0.1.md (SPEC v0.2)
 */

import { existsSync, readFileSync } from 'fs';
import { getLedgerFilePathPublic, loadLedger } from '../../principle-tree-ledger.js';
import { isPrincipleLedgerEligibleKind } from '../store/candidate/recommendation-kind-resolver.js';
import { PRINCIPLE_STATUSES } from '../types/principle-enums.js';
import { isRecord } from '../candidate-intake.js';
import { selectReuseShortlist } from './reuse-shortlist.js';
import type {
  ReuseCandidateInput,
  ReusablePrinciple,
  ReuseShortlist,
  ReuseShortlistOptions,
} from './reuse-domain.js';

/**
 * Statuses a Principle may be reused into (SPEC §15).
 *
 * `active` and `candidate`/`probation` are included because that is where real
 * reusable knowledge lives — excluding `candidate` would leave almost nothing,
 * as the live ledger is overwhelmingly `candidate`. `archived` and `deprecated`
 * are excluded: reusing into a retired Principle would revive withdrawn
 * knowledge. Any unrecognised status is excluded fail-closed.
 */
export const REUSABLE_PRINCIPLE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'candidate',
  'probation',
]);

export function isReusablePrincipleStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  // Fail closed on a status outside the known enum: an unrecognised value is
  // treated as not reusable rather than optimistically reusable.
  if (!(PRINCIPLE_STATUSES as readonly string[]).includes(status)) return false;
  return REUSABLE_PRINCIPLE_STATUSES.has(status);
}

function assertLedgerReadable(stateDir: string): void {
  const filePath = getLedgerFilePathPublic(stateDir);
  if (!existsSync(filePath)) return; // no corpus yet — nothing to reuse
  const raw = readFileSync(filePath, 'utf-8');
  if (raw.trim() === '') return; // an empty document is an empty corpus
  // Throws on malformed JSON so the caller fails the gate rather than silently
  // treating unreadable knowledge as absent knowledge.
  JSON.parse(raw);
}

/**
 * Read every reusable Principle from the canonical ledger.
 *
 * Read-only: opens the ledger document and filters in memory. No caching is
 * introduced here — the corpus is small (order 10^2) and a cache would be a
 * second place where ledger truth could go stale.
 *
 * Fail-closed on an UNREADABLE corpus. The shared `loadLedger` deliberately
 * swallows a parse error and returns an empty store, which is indistinguishable
 * from "nothing has been learned yet" — and the write that follows would then
 * overwrite the unreadable file. Reporting that as an empty candidate set is
 * precisely the silent duplicate this whole path exists to prevent, so an
 * existing-but-unparseable ledger throws here instead.
 *
 * A genuinely MISSING ledger is not a failure: there is simply nothing to
 * reuse yet, and blocking the first write of a fresh workspace would be wrong.
 */
function normalizeLedgerEntry(entry: unknown): ReusablePrinciple | null {
  if (!isRecord(entry)) return null;
  const { id, text, triggerPattern, action, status } = entry;
  if (typeof id !== 'string' || id.length === 0) return null;
  return {
    id,
    text: typeof text === 'string' ? text : '',
    triggerPattern: typeof triggerPattern === 'string' ? triggerPattern : '',
    action: typeof action === 'string' ? action : '',
    status: typeof status === 'string' ? status : '',
  };
}

export function readReusablePrinciples(stateDir: string): ReusablePrinciple[] {
  assertLedgerReadable(stateDir);
  const store = loadLedger(stateDir);
  // The ledger is an untrusted document (rc-1/rc-2): validate each entry's
  // fields instead of asserting the shape, so a malformed entry is skipped
  // rather than flowing a non-string into the tokenizer as if it were text.
  const entries = Object.values(store.tree.principles) as unknown[];
  const reusable: ReusablePrinciple[] = [];
  for (const entry of entries) {
    const normalized = normalizeLedgerEntry(entry);
    if (normalized && isReusablePrincipleStatus(normalized.status)) reusable.push(normalized);
  }
  return reusable;
}

/**
 * Build the reuse shortlist for a candidate, from the canonical ledger.
 *
 * `recommendationKind` is checked with the SAME guard the intake write boundary
 * uses, so a non-principle candidate can never reach the reuse path (SPEC T6 —
 * the #1851 refusal semantics stay exactly as they are; this only makes the
 * reuse path refuse them too).
 */
export function buildReuseShortlist(
  input: ReuseCandidateInput,
  stateDir: string,
  options: ReuseShortlistOptions & { recommendationKind?: unknown } = {},
): ReuseShortlist {
  const { recommendationKind, ...shortlistOptions } = options;
  if (recommendationKind !== undefined && !isPrincipleLedgerEligibleKind(recommendationKind)) {
    return {
      candidates: [],
      eligibleCount: 0,
      consideredCount: 0,
      candidateKindEligible: false,
    };
  }
  return selectReuseShortlist(input, readReusablePrinciples(stateDir), shortlistOptions);
}
