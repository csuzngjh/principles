import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import { sendSuccess, sendMethodNotAllowed } from '../utils/response.js';

export const UPDATE_HISTORY_KINDS = [
  'update',
  'reinstall',
  'legacy_migration',
  'rollback',
  'refusal',
  'failure',
  'recovery',
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
}

function isHistoryKind(value: unknown): value is UpdateHistoryKind {
  return typeof value === 'string' && (UPDATE_HISTORY_KINDS as readonly string[]).includes(value);
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
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    fromVersion: raw.fromVersion,
    toVersion: raw.toVersion,
    success: raw.success,
    // Pre-Phase-0 records did not identify their operation. Preserve them as
    // legacy data rather than deriving intent from a version comparison.
    kind: raw.kind === undefined ? 'legacy_migration' : raw.kind,
    ...(typeof raw.backupPath === 'string' ? { backupPath: raw.backupPath } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw.nextAction === 'string' ? { nextAction: raw.nextAction } : {}),
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

export function appendUpdateHistory(
  workspaceDir: string,
  entry: Omit<UpdateHistoryEntry, 'id' | 'timestamp'>,
): void {
  const historyPath = getHistoryPath(workspaceDir);
  const history = loadHistory(historyPath);
  history.push({
    ...entry,
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
