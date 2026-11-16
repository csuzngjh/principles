import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import { isReleaseManagerTransactionId } from 'create-principles-disciple/update-console';
import { sendSuccess, sendError, sendMethodNotAllowed } from '../utils/response.js';
import { getPdHome } from '../utils/pd-home.js';
/** Historical authority values remain readable; only ReleaseManager writes new attempts. */
export const UPDATE_HISTORY_AUTHORITIES = ['release-manager', 'legacy-console-updater'] as const;

export type UpdateHistoryAuthority = (typeof UPDATE_HISTORY_AUTHORITIES)[number];

export const UPDATE_HISTORY_KINDS = [
  'update',
  'reinstall',
  'legacy_migration',
  'rollback',
  'refusal',
  'failure',
  'recovery',
  'unknown',
] as const;

export type UpdateHistoryKind = (typeof UPDATE_HISTORY_KINDS)[number];

interface UpdateHistoryEntry {
  id: string;
  timestamp: string;
  fromVersion: string;
  toVersion: string;
  success: boolean;
  kind: UpdateHistoryKind;
  backupPath?: string;
  reason?: string;
  nextAction?: string;
  /** PRI-702: authority that performed the mutation. Absent on pre-PRI-702 records. */
  authority?: UpdateHistoryAuthority;
  /**
   * PRI-702: the transaction journal id of the update, when one exists.
   * Correlates the Owner-facing event with the machine-recovery stream
   * (`~/.pd/transactions/<transactionId>.jsonl`) — the two stay separate
   * structures (ADR-0024 §2.5-2); this is a pointer, not a copy.
   */
  transactionId?: string;
}

function isHistoryKind(value: unknown): value is UpdateHistoryKind {
  return typeof value === 'string' && (UPDATE_HISTORY_KINDS as readonly string[]).includes(value);
}

function isHistoryAuthority(value: unknown): value is UpdateHistoryAuthority {
  return typeof value === 'string' && (UPDATE_HISTORY_AUTHORITIES as readonly string[]).includes(value);
}

function parseHistoryEntry(value: unknown): UpdateHistoryEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.timestamp !== 'string' ||
    typeof raw.fromVersion !== 'string' ||
    typeof raw.toVersion !== 'string' ||
    typeof raw.success !== 'boolean'
  ) return undefined;
  if (raw.kind !== undefined && !isHistoryKind(raw.kind)) return undefined;
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return undefined;
  if (raw.nextAction !== undefined && typeof raw.nextAction !== 'string') return undefined;
  if (raw.backupPath !== undefined && typeof raw.backupPath !== 'string') return undefined;
  if (raw.transactionId !== undefined && typeof raw.transactionId !== 'string') return undefined;
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    fromVersion: raw.fromVersion,
    toVersion: raw.toVersion,
    success: raw.success,
    // Pre-Phase-0 records did not identify their operation. The operation is
    // UNKNOWN — labeling them legacy_migration would claim a migration
    // happened, which the record cannot prove (unknown ≠ legacy_migration).
    kind: raw.kind === undefined ? 'unknown' : raw.kind,
    ...(typeof raw.backupPath === 'string' ? { backupPath: raw.backupPath } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw.nextAction === 'string' ? { nextAction: raw.nextAction } : {}),
    // An authority outside the closed vocabulary is dropped rather than
    // failing the whole entry: this stream is an Owner read model, and one
    // unknown writer must not hide every other record (rc-3).
    ...(isHistoryAuthority(raw.authority) ? { authority: raw.authority } : {}),
    ...(typeof raw.transactionId === 'string' ? { transactionId: raw.transactionId } : {}),
  };
}

function getHistoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', 'update-history.json');
}

/**
 * PRI-926: sort key for fact-time ordering. History rows span eras and
 * formats (legacy records, journal `at` values are loosely read), so string
 * comparison would mis-order mixed shapes like '…00Z' vs '…00.000Z' or
 * non-UTC offsets — compare parsed instants instead. Unparseable values take
 * a stable epoch fallback (sort oldest); they are never dropped.
 */
function factTimeMs(timestamp: string): number {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

function loadHistory(historyPath: string): UpdateHistoryEntry[] {
  if (fs.existsSync(historyPath)) {
    try {
      const raw = fs.readFileSync(historyPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((entry) => {
          const parsedEntry = parseHistoryEntry(entry);
          return parsedEntry === undefined ? [] : [parsedEntry];
        });
      }
    } catch (err) {
      console.warn(`[update-history] Failed to parse update history file (${historyPath}):`, err instanceof Error ? err.message : err);
    }
  }
  return [];
}

/** Append new ReleaseManager attempts without rewriting historical records. */
export function appendUpdateHistory(
  workspaceDir: string,
  entry: Omit<UpdateHistoryEntry, 'id' | 'timestamp'>,
): void {
  const historyPath = getHistoryPath(workspaceDir);
  const history = loadHistory(historyPath);
  history.push({
    ...entry,
    authority: entry.authority ?? 'release-manager',
    id: `update-${Date.now()}`,
    timestamp: new Date().toISOString(),
  });
  // Keep last 50 entries
  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

// ── Prune ledger (Owner deletion intent) ────────────────────────────────────

/** Default retention for an Owner cleanup: the newest 5 entries stay. */
export const UPDATE_HISTORY_PRUNE_KEEP_DEFAULT = 5;
const UPDATE_HISTORY_PRUNE_KEEP_MAX = 50;
const PRUNED_LEDGER_FILENAME = 'update-history-pruned.json';

function getPrunedLedgerPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pd', PRUNED_LEDGER_FILENAME);
}

/**
 * Load the prune ledger — transactionIds the Owner explicitly removed and
 * must NOT be re-derived from `~/.pd/transactions` journals. Corrupt or
 * partially malformed ledgers degrade to their valid prefix (console.warn,
 * never throw): a broken ledger must not make reconcile resurrect rows or
 * break the history read path.
 */
function loadPrunedTransactionIds(ledgerPath: string): string[] {
  if (!fs.existsSync(ledgerPath)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    if (!Array.isArray(parsed)) {
      console.warn(`[update-history] Prune ledger is not an array (${ledgerPath}); ignoring it`);
      return [];
    }
    return parsed.flatMap((value) => (typeof value === 'string' && value.length > 0 ? [value] : []));
  } catch (err) {
    console.warn(`[update-history] Failed to read prune ledger (${ledgerPath}):`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * PRI-853 (ADR-0024 D-7, SPEC §12.1): reconcile the Owner-facing history from
 * the transaction journal. With apply running in the detached bootstrap
 * executor, the initiating Console may be dead when an update reaches a
 * terminal state — the journal is the durable fact, and this derives any
 * missing history entries from it (idempotent by transactionId; append-only).
 *
 * PRI-926 truthfulness rules:
 * - Only journals in the ReleaseManager update domain
 *   (`isReleaseManagerTransactionId`) are Owner-facing update facts —
 *   installer/test transactions sharing ~/.pd/transactions/ never synthesize
 *   rows, and rows previously projected from outside the domain are dropped
 *   (a wrongly-projected row of this read model, not Owner data).
 * - A synthesized row carries the journal's own truth: fromVersion from the
 *   planned line's `preUpdateProductVersion` (absence stays 'unknown' — the
 *   honest gap for pre-PRI-926 journals, rc-9), and the timestamp of the
 *   journal's first line, never the scan moment.
 * - The synthesized id is deterministic (`reconciled-<transactionId>`), so a
 *   row evicted by the 50-entry cap cannot resurrect under a fresh id; merged
 *   rows are ordered by fact time.
 */
export function reconcileUpdateHistoryFromJournals(workspaceDir: string, pdHome: string): void {
  const transactionsDir = path.join(pdHome, 'transactions');
  if (!fs.existsSync(transactionsDir)) return;
  const historyPath = getHistoryPath(workspaceDir);
  // Rows the Owner pruned deliberately stay pruned: the ledger records that
  // deletion intent, otherwise reconcile would re-derive those rows from the
  // still-present journals on every startup — the read model must honor the
  // Owner's cleanup instead of silently resurrecting it.
  const prunedTransactionIds = new Set(loadPrunedTransactionIds(getPrunedLedgerPath(workspaceDir)));
  const loaded = loadHistory(historyPath);
  // A row WITHOUT a transactionId has no domain evidence either way — realtime
  // and legacy records stay untouched. A transactionId OUTSIDE the update
  // domain proves the row was projected from a non-update journal.
  const history = loaded.filter((entry) =>
    entry.transactionId === undefined || isReleaseManagerTransactionId(entry.transactionId),
  );
  const changedByCleanup = history.length !== loaded.length;
  const journaledIds = new Set(
    history
      .filter((entry) => typeof entry.transactionId === 'string' && entry.transactionId.length > 0)
      .map((entry) => entry.transactionId as string),
  );
  const terminalKind: Record<string, { kind: UpdateHistoryEntry['kind']; success: boolean; toVersion: string }> = {
    confirmed: { kind: 'update', success: true, toVersion: '' },
    rolled_back: { kind: 'rollback', success: true, toVersion: 'previous' },
    failed: { kind: 'failure', success: false, toVersion: 'failed' },
    refused: { kind: 'refusal', success: false, toVersion: '' },
  };
  let added = 0;
  for (const entry of fs.readdirSync(transactionsDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const transactionId = entry.slice(0, -'.jsonl'.length);
    if (!isReleaseManagerTransactionId(transactionId)) continue;
    if (journaledIds.has(transactionId)) continue;
    if (prunedTransactionIds.has(transactionId)) continue;
    let lastState: string | null = null;
    let productVersion: string | null = null;
    let fromVersion: string | null = null;
    let firstAt: string | null = null;
    try {
      const raw = fs.readFileSync(path.join(transactionsDir, entry), 'utf-8');
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as { to?: unknown; productVersion?: unknown; at?: unknown; preUpdateProductVersion?: unknown };
        const { to: transitionTo, productVersion: transitionProductVersion } = parsed;
        if (typeof transitionTo === 'string') lastState = transitionTo;
        if (typeof transitionProductVersion === 'string') productVersion = transitionProductVersion;
        // First-line truth: the planned transition carries the transaction's
        // moment and the version the update started FROM (PRI-926).
        if (firstAt === null && typeof parsed.at === 'string' && parsed.at.length > 0) firstAt = parsed.at;
        if (fromVersion === null && typeof parsed.preUpdateProductVersion === 'string' && parsed.preUpdateProductVersion.length > 0) {
          fromVersion = parsed.preUpdateProductVersion;
        }
      }
    } catch {
      // unreadable journal — recovery diagnostics own that; skip for history
      continue;
    }
    // External input indexes a plain-object table — guard with Object.hasOwn
    // before the lookup (ERR-013: '__proto__' must not resolve a mapping).
    let mapping: (typeof terminalKind)[string] | undefined;
    if (lastState !== null && Object.hasOwn(terminalKind, lastState)) {
      mapping = terminalKind[lastState];
    }
    if (mapping === undefined) continue;
    history.push({
      fromVersion: fromVersion ?? 'unknown',
      toVersion: mapping.toVersion === '' ? (productVersion ?? 'unknown') : mapping.toVersion,
      success: mapping.success,
      kind: mapping.kind,
      authority: 'release-manager',
      transactionId,
      id: `reconciled-${transactionId}`,
      timestamp: firstAt ?? new Date().toISOString(),
    });
    added += 1;
  }
  if (added > 0 || changedByCleanup) {
    // Order by fact time (stable for equal instants), then keep the newest 50.
    history.sort((a, b) => factTimeMs(a.timestamp) - factTimeMs(b.timestamp));
    if (history.length > 50) {
      history.splice(0, history.length - 50);
    }
    const dir = path.dirname(historyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleUpdateHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  _subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  const historyPath = getHistoryPath(workspaceDir);
  const history = loadHistory(historyPath);
  sendSuccess(res, history);
}

// ── Owner history cleanup (POST /api/update/history/prune) ──────────────────

/**
 * Fact time of a journal = the first `at` on its lines (PRI-926: the planned
 * line carries the transaction's moment). Unreadable/undated journals return
 * null and are never covered by a cleanup window — a fact we cannot date is a
 * fact we cannot claim the Owner wanted gone.
 */
function journalFactTimeMs(journalPath: string): number | null {
  try {
    const raw = fs.readFileSync(journalPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as { at?: unknown };
      if (typeof parsed.at === 'string' && parsed.at.length > 0) {
        const ms = Date.parse(parsed.at);
        return Number.isNaN(ms) ? null : ms;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function collectJournalIdsOlderThan(pdHome: string, oldestKeptMs: number, alreadyPruned: ReadonlySet<string>): string[] {
  const transactionsDir = path.join(pdHome, 'transactions');
  if (!fs.existsSync(transactionsDir)) return [];
  const covered: string[] = [];
  try {
    for (const entry of fs.readdirSync(transactionsDir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const transactionId = entry.slice(0, -'.jsonl'.length);
      if (alreadyPruned.has(transactionId)) continue;
      if (!isReleaseManagerTransactionId(transactionId)) continue;
      const factMs = journalFactTimeMs(path.join(transactionsDir, entry));
      if (factMs !== null && factMs < oldestKeptMs) covered.push(transactionId);
    }
  } catch (err) {
    console.warn('[update-history] Cleanup window journal scan failed; ledger covers file rows only:', err instanceof Error ? err.message : err);
    return [];
  }
  return covered;
}

export interface UpdateHistoryPruneResult {
  /** Entries actually removed by this call (0 when the file was already within budget). */
  removed: number;
  /** Entries left in the history file after the prune. */
  remaining: number;
  /** Rolling pre-rewrite backup; absent when there was no file to back up. */
  backupPath?: string;
  /** transactionIds recorded into the prune ledger by this call. */
  prunedTransactionIds: string[];
}

/**
 * Owner-facing cleanup of the history read model: keep the newest `keep`
 * entries by fact time, remove the rest. The removed rows' transactionIds are
 * recorded in the prune ledger so `reconcileUpdateHistoryFromJournals` does
 * not resurrect them from the durable journals on the next startup. The
 * journals themselves (~/.pd/transactions, installer-owned) are never touched.
 *
 * Window closure: the 50-entry cap silently evicts old rows while their
 * journals survive, so a bare "removed rows" ledger would let restart re-derive
 * rows OLDER than the ones the Owner deleted — the cleaned list would grow
 * back. "Keep the newest 5" therefore covers every fact older than the kept
 * window: any ReleaseManager-domain journal whose first fact time precedes the
 * oldest kept row is ledgered too (pdHome read-only; absent/unreadable home
 * degrades to file-row-only cleanup with a console.warn, rc-9).
 *
 * Bounded mutation per docs/process/DATA_CLEANUP_GUIDELINES.md: the file is
 * backed up before the first rewrite (single rolling .bak-prune, no
 * accumulation), and the response carries the row accounting (removed /
 * remaining) instead of a bare ok.
 */
export function pruneUpdateHistory(workspaceDir: string, keep: number, pdHome?: string): UpdateHistoryPruneResult {
  const historyPath = getHistoryPath(workspaceDir);
  const history = loadHistory(historyPath);
  if (history.length <= keep) {
    return { removed: 0, remaining: history.length, prunedTransactionIds: [] };
  }

  // Newest-first by fact time; Array#sort is stable, so equal instants keep
  // file order. Nothing has been written yet — from here on the mutations are
  // committed (backup → rewrite → ledger append).
  const sortedDesc = [...history].sort((a, b) => factTimeMs(b.timestamp) - factTimeMs(a.timestamp));
  const kept = sortedDesc.slice(0, keep);
  const removedEntries = sortedDesc.slice(keep);

  let backupPath: string | undefined;
  if (fs.existsSync(historyPath)) {
    backupPath = `${historyPath}.bak-prune`;
    fs.copyFileSync(historyPath, backupPath);
  }
  // The file's canonical order stays ascending (oldest first) — readers and
  // reconcile rely on it; the UI sorts for display.
  const remainingAsc = [...kept].sort((a, b) => factTimeMs(a.timestamp) - factTimeMs(b.timestamp));
  fs.writeFileSync(historyPath, JSON.stringify(remainingAsc, null, 2));

  const prunedTransactionIds = Array.from(
    new Set(removedEntries.flatMap((entry) => (entry.transactionId ? [entry.transactionId] : []))),
  );
  // Journals older than the kept window join the ledger so a restart cannot
  // re-derive the cleanup away. Unparseable kept stamps sort at 0 — the window
  // floor then proves nothing and no journal is covered (honest fallback).
  const oldestKeptMs = Math.min(...kept.map((entry) => factTimeMs(entry.timestamp)));
  if (pdHome !== undefined && oldestKeptMs > 0) {
    prunedTransactionIds.push(...collectJournalIdsOlderThan(pdHome, oldestKeptMs, new Set(prunedTransactionIds)));
  }
  const prunedIds = Array.from(new Set(prunedTransactionIds));
  if (prunedIds.length > 0) {
    const ledgerPath = getPrunedLedgerPath(workspaceDir);
    const merged = Array.from(new Set([...loadPrunedTransactionIds(ledgerPath), ...prunedIds]));
    fs.writeFileSync(ledgerPath, JSON.stringify(merged, null, 2));
  }

  return {
    removed: removedEntries.length,
    remaining: remainingAsc.length,
    ...(backupPath !== undefined ? { backupPath } : {}),
    prunedTransactionIds: prunedIds,
  };
}

/**
 * `keep` arrives as the only mutation argument. Untrusted runtime input
 * (rc-1/rc-2): absent → documented default; present but not an integer in
 * [1, 50] → structured refusal, never a silent clamp (rc-3).
 */
function parsePruneKeep(url: string | undefined): { ok: true; keep: number } | { ok: false; reason: string; nextAction: string } {
  const raw = url !== undefined && url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('keep') : null;
  if (raw === null) return { ok: true, keep: UPDATE_HISTORY_PRUNE_KEEP_DEFAULT };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > UPDATE_HISTORY_PRUNE_KEEP_MAX) {
    return {
      ok: false,
      reason: 'invalid_keep',
      nextAction: `keep must be an integer between 1 and ${UPDATE_HISTORY_PRUNE_KEEP_MAX} (e.g. POST /api/update/history/prune?keep=5)`,
    };
  }
  return { ok: true, keep: parsed };
}

export async function handleUpdateHistoryPruneRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res);
    return;
  }
  // Validate BEFORE any side effect — a refused request must not touch the
  // history file, the backup, or the ledger (EP-02/ERR-183 preflight rule).
  const keep = parsePruneKeep(req.url);
  if (!keep.ok) {
    sendError(res, 400, keep.reason, keep.reason, { nextAction: keep.nextAction });
    return;
  }
  // The cleanup window covers journals too; an unresolvable pdHome degrades
  // the cleanup to its file rows (logged) rather than failing the mutation.
  let pdHome: string | undefined;
  try {
    ({ pdHome } = getPdHome());
  } catch (err) {
    console.warn('[update-history] pdHome unresolvable; cleanup window covers file rows only:', err instanceof Error ? err.message : err);
  }
  const result = pruneUpdateHistory(workspaceDir, keep.keep, pdHome);
  sendSuccess(res, result);
}
