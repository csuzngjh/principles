import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import { sendSuccess, sendMethodNotAllowed } from '../utils/response.js';
import {
  LEGACY_MUTATION_AUTHORITY,
  RELEASE_MANAGER_AUTHORITY,
} from '../update/mutation-controller.js';

/**
 * PRI-702 (ADR-0024 D-7): which authority actually performed the mutation.
 *
 * The vocabulary is REUSED from the MutationController — the one place that
 * already names mutation authorities — so the history stream can never drift
 * into a second authority vocabulary. `legacy-migration` is deliberately not
 * listed: it writes the separate SPEC §12 stream (`<pdHome>/logs/history.jsonl`)
 * and must not be conflated with this Owner-facing one.
 *
 * The field is additive and optional. Records written before PRI-702 have no
 * `authority`; they are kept verbatim (no migration) and the reader never
 * fabricates a value for them.
 */
export const UPDATE_HISTORY_AUTHORITIES = [
  RELEASE_MANAGER_AUTHORITY,
  LEGACY_MUTATION_AUTHORITY,
] as const;

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

/**
 * PRI-702 (ADR-0024 D-7): the ONE Owner-facing update-history writer.
 *
 * Both mutation authorities append through this function — the legacy console
 * updater (every existing call site in `routes/update.ts`) and the
 * ReleaseManager-served apply-full dispatch. There is no second writer and no
 * authority-specific schema: callers differ only in the `authority` they pass.
 *
 * `authority` defaults to `legacy-console-updater` because that is the writer
 * that has owned this stream since before PRI-702; a caller that omits it is
 * by definition the legacy path. Every entry written from now on carries the
 * field explicitly, so PRI-701's legacy-usage census can read it directly.
 */
export function appendUpdateHistory(
  workspaceDir: string,
  entry: Omit<UpdateHistoryEntry, 'id' | 'timestamp'>,
): void {
  const historyPath = getHistoryPath(workspaceDir);
  const history = loadHistory(historyPath);
  history.push({
    ...entry,
    authority: entry.authority ?? LEGACY_MUTATION_AUTHORITY,
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
