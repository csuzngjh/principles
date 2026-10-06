import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import { isReleaseManagerTransactionId } from 'create-principles-disciple/update-console';
import { sendSuccess, sendMethodNotAllowed } from '../utils/response.js';
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
    // Order by fact time (stable for equal timestamps), then keep the newest 50.
    history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
