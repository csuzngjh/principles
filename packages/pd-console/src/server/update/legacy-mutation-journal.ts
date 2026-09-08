/**
 * PRI-709 P0-3 — journal coverage for the legacy console updater (ADR-0024 D-2).
 *
 * PRI-698 Phase 0 Audit finding F-3: the console updater performed runtime
 * mutations with **zero** journal writes. Under ADR-0024 D-2 an unjournaled
 * runtime mutation is the one thing that must never happen, so the legacy
 * updater had to be brought under the SAME journal as the installer and the
 * ReleaseManager before the legacy path can be retired.
 *
 * Design rules (all load-bearing):
 *
 * - **No new journal implementation.** This module reuses
 *   `create-principles-disciple`'s `transaction-journal` — one JSONL file per
 *   transaction under `~/.pd/transactions/`, append + fsync, strict reader.
 *   Nothing here parses, formats or rotates journals.
 * - **The ReleaseManager path is never double-journaled.** ReleaseManager
 *   `apply-full` orchestrates the installer, which journals the whole
 *   lifecycle; the console dispatch for that path never reaches the legacy
 *   handlers this module wraps. When the ReleaseManager explicitly falls back
 *   to legacy, the legacy handler is the ONLY writer — one transaction per
 *   mutation, whichever authority served it.
 * - **Explicit degradation, never a blocked mutation.** The journal module is
 *   loaded dynamically: the console runs in installations where the
 *   create-principles-disciple dist may be absent (the same delivery-surface
 *   gap the ReleaseManager authority loader already handles). A missing module
 *   is reported and the mutation proceeds unjournaled — refusing the Owner's
 *   update would be worse than an unaudited one, and the gap is observable.
 * - **No fabricated digests.** The legacy updater does not verify signed
 *   release metadata, so its digest provenance is `fallback`: a synthetic
 *   sha256 over a literal marker, readable but explicitly NOT verifiable. It
 *   never claims `manifest` / `signed_channel` it cannot back.
 *
 * Transition strategy for legacy kinds:
 *
 *   apply / apply-full / rollback:  `planned` → `confirmed` | `failed`
 *
 * `planned` is appended immediately before the mutation (after all request
 * validation, so rejected requests leave no transaction); `confirmed` or
 * `failed` after it. `rolled_back` is NOT used for the rollback kind — a
 * rollback restores a previous deployment and is itself a forward transition
 * to a known-good state, whereas `rolled_back` means "this transaction was
 * undone".
 *
 * Two documented trade-offs (PRI-709 review, deliberate):
 *
 * - **`generation` stays at the standalone default `1`.** Legacy console
 *   transactions do not participate in the dual-slot generation lineage — they
 *   never move the active record — so recording a real `active.json.generation
 *   + 1` would CLAIM a lineage the console does not actually advance. Recovery
 *   is unaffected either way: `recoverUnfinishedTransaction` keys on
 *   `activeRecord.transactionId`, which a console transaction never matches, so
 *   it resolves to "the previously confirmed release stands".
 * - **The legacy path leaves `active.json` untouched.** The legacy updater
 *   replaces the runtime without the installer's dual-slot swap, so after a
 *   legacy `apply-full` the active record describes the PREVIOUS deployment.
 *   Making the console a second writer of the deployment identity would be a
 *   worse violation (one source of truth); the honest fix is retiring the
 *   legacy path (ADR-0024 D-1), which is exactly what this journal coverage
 *   unblocks.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ReleaseMetadataDigestSource,
  TransactionState,
} from 'create-principles-disciple/dist/update/transaction-journal.js';

/** Journal kinds the legacy console updater performs. */
export type LegacyMutationKind = 'apply' | 'apply-full' | 'rollback';

export interface LegacyMutationJournal {
  readonly transactionId: string;
  readonly journalPath: string;
  readonly releaseId: string;
  readonly productVersion: string;
  readonly releaseMetadataDigest: string;
}

export type LegacyJournalStatus =
  | { readonly journaled: true; readonly journal: LegacyMutationJournal }
  | { readonly journaled: false; readonly reason: string };

/** Journal port — the real implementation is the shared transaction journal. */
export interface LegacyJournalPort {
  appendJournalTransition(journalPath: string, transition: {
    readonly at: string;
    readonly from: TransactionState | null;
    readonly to: TransactionState;
    readonly transactionId: string;
    readonly releaseId: string;
    readonly productVersion: string;
    readonly releaseMetadataDigest: string;
    readonly releaseMetadataDigestSource: ReleaseMetadataDigestSource;
    readonly generation: number;
    readonly detail?: string;
  }): void;
}

export interface LegacyJournalOptions {
  /** `~/.pd` — the shared installation root (ADR-0023). */
  readonly pdHome: string;
  /** Installed runtime plugin dir; identity source of what is deployed. */
  readonly pluginDir: string;
  readonly kind: LegacyMutationKind;
  readonly now?: () => Date;
  /** Test seam; defaults to the dynamically imported shared journal. */
  readonly journal?: LegacyJournalPort;
}

/** Load the shared journal; `null` when the delivery surface lacks the module. */
async function loadJournalPort(): Promise<LegacyJournalPort | null> {
  try {
    const module = await import('create-principles-disciple/dist/update/transaction-journal.js');
    return { appendJournalTransition: module.appendJournalTransition };
  } catch {
    return null;
  }
}

/**
 * Product version of the currently installed runtime.
 *
 * Same rule as the installer (PRI-709 P0-2): the PRODUCT manifest is
 * `pluginDir/package.json`; `pd-cli` versions independently and is only a
 * fallback.
 */
function resolveInstalledProductVersion(pluginDir: string): string {
  for (const candidate of [path.join(pluginDir, 'package.json'), path.join(pluginDir, 'pd-cli', 'package.json')]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    } catch {
      // Identity falls back; an unjournaled-able version must not block a mutation.
    }
  }
  return 'unknown';
}

/**
 * Open one legacy transaction and append `planned` before the mutation runs.
 */
export async function openLegacyMutationJournal(
  options: LegacyJournalOptions,
): Promise<LegacyJournalStatus> {
  const port = options.journal ?? await loadJournalPort();
  if (port === null) {
    return { journaled: false, reason: 'journal_module_unavailable' };
  }

  const productVersion = resolveInstalledProductVersion(options.pluginDir);
  // Unverifiable by construction: the legacy updater never sees signed release
  // metadata, so the digest is a marker hash labelled `fallback`.
  const releaseMetadataDigest = createHash('sha256')
    .update(`legacy-console-updater-unverified:${options.kind}`)
    .digest('hex');
  const transactionId = `console-${options.kind}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const releaseId = `console-${options.kind}-${productVersion}-${releaseMetadataDigest.slice(0, 12)}`;
  const journal: LegacyMutationJournal = {
    transactionId,
    journalPath: path.join(options.pdHome, 'transactions', `${transactionId}.jsonl`),
    releaseId,
    productVersion,
    releaseMetadataDigest,
  };

  try {
    port.appendJournalTransition(journal.journalPath, {
      at: (options.now ?? (() => new Date))().toISOString(),
      from: null,
      to: 'planned',
      transactionId,
      releaseId,
      productVersion,
      releaseMetadataDigest,
      releaseMetadataDigestSource: 'fallback',
      generation: 1,
      detail: `actor=console-updater kind=${options.kind}`,
    });
  } catch (error) {
    return {
      journaled: false,
      reason: `journal_write_failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { journaled: true, journal };
}

/**
 * Maps a mutation's RESULT to its journal terminal state.
 *
 * PRI-709 review: the legacy updater reports failure as a VALUE —
 * `doApplyUpdate` / `doRollbackUpdate` / `doInlineFullUpdate` return
 * `{ success: false, message }` for ~30 distinct failure modes and only throw
 * for infrastructure errors. Terminal state decided on "did it throw" alone
 * would journal confirmed for most real failures. So: `success === true` is
 * `confirmed`, `success === false` is `failed` (with the reported message as
 * detail), and a non-object result (no contract) is treated as completed.
 * The HTTP response contract is untouched either way — this only decides what
 * the journal records.
 */
function toLegacyMutationOutcome(result: unknown): { readonly to: 'confirmed' | 'failed'; readonly detail: string } {
  if (typeof result !== 'object' || result === null) {
    return { to: 'confirmed', detail: 'completed' };
  }
  const record = result as { readonly success?: unknown; readonly message?: unknown; readonly reason?: unknown };
  if (!Object.hasOwn(record, 'success')) {
    return { to: 'confirmed', detail: 'completed' };
  }
  const detailParts = [record.message, record.reason]
    .filter((part): part is string => typeof part === 'string' && part.length > 0);
  const detail = detailParts.length > 0 ? detailParts.join('; ') : 'no detail reported';
  return { to: record.success === true ? 'confirmed' : 'failed', detail };
}

/**
 * Writes the terminal transition for an opened legacy transaction and reports
 * loud when it cannot land: the journal would then hold an unfinished
 * transaction, which is a governance gap (rc-9) even though the mutation's
 * real outcome must not be masked.
 */
async function appendLegacyOutcome(
  options: LegacyJournalOptions,
  status: LegacyJournalStatus,
  outcome: { readonly to: 'confirmed' | 'failed'; readonly detail: string },
): Promise<void> {
  if (!status.journaled) return;
  const port = options.journal ?? await loadJournalPort();
  if (port === null) return;
  try {
    port.appendJournalTransition(status.journal.journalPath, {
      at: (options.now ?? (() => new Date))().toISOString(),
      from: 'planned',
      to: outcome.to,
      transactionId: status.journal.transactionId,
      releaseId: status.journal.releaseId,
      productVersion: status.journal.productVersion,
      releaseMetadataDigest: status.journal.releaseMetadataDigest,
      releaseMetadataDigestSource: 'fallback',
      generation: 1,
      detail: `actor=console-updater kind=${options.kind} ${outcome.detail}`,
    });
  } catch (error) {
    console.warn(
      `[update] Legacy mutation "${options.kind}" finished as "${outcome.to}" but its terminal journal transition `
      + `could not be written (${error instanceof Error ? error.message : String(error)}). `
      + `Transaction ${status.journal.transactionId} stays unfinished and must be reconciled.`,
    );
  }
}

/**
 * Runs a legacy mutation under one journal transaction.
 *
 * `planned` is written before `run()`; `confirmed` / `failed` after — decided
 * by BOTH the thrown/not-thrown boundary and the updater's `success` result
 * shape (see `toLegacyMutationOutcome`). A journal failure never changes the
 * mutation's outcome — it is reported alongside it.
 */
export async function runLegacyJournaledMutation<T>(
  options: LegacyJournalOptions,
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly journal: LegacyJournalStatus }> {
  const opened = await openLegacyMutationJournal(options);
  try {
    const result = await run();
    const outcome = toLegacyMutationOutcome(result);
    await appendLegacyOutcome(options, opened, { to: outcome.to, detail: `${options.kind}: ${outcome.detail}` });
    return { result, journal: opened };
  } catch (error) {
    await appendLegacyOutcome(options, opened, {
      to: 'failed',
      detail: `${options.kind}: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }
}

