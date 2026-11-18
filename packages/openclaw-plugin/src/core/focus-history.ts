/**
 * Principle Context history support (SPEC v1.1 §8.2/§8.3).
 *
 * The legacy automatic-maintenance surface (auto/manual compression, template
 * recovery, working-memory extraction, prompt history injection) was retired
 * with Batch 1. What remains is the explicit-rollback support:
 *
 * - `getHistoryDir` — locates the existing `.history/` directory next to the
 *   focus file (the `status`/`history`/`rollback` subcommands scan it).
 * - `backupToHistory` — the one production backup path, used exclusively
 *   before an explicit rollback so the current bytes stay recoverable. It
 *   accepts the raw Buffer so an Owner file is preserved byte-for-byte even
 *   when it is not valid UTF-8.
 *
 * No cleanup, no archival, no automatic snapshots: nothing deletes or rewrites
 * Owner history (SPEC §8.2).
 */
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/io.js';
import { extractVersion, extractDate } from '@principles/core/prompt-builder';

function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errorStr = error instanceof Error ? error.message : String(error);
  console.error(`[focus-history] ${timestamp} ERROR: ${message}${errorStr ? ' - ' + errorStr : ''}`);
}

export function getHistoryDir(focusPath: string): string {
  return path.join(path.dirname(focusPath), '.history');
}

/**
 * Backs up the CURRENT raw bytes into `.history/` before an explicit rollback.
 * `content` may be a Buffer (byte-exact backup; version/date in the backup
 * name are a best-effort display label derived from a lossy UTF-8 decode) or a
 * string (historical call shape). Returns the backup path, or null when the
 * history directory cannot be created, a backup with the same name exists, or
 * the write fails — the caller keeps the original bytes either way.
 */
export function backupToHistory(focusPath: string, content: string | Buffer): string | null {
  try {
    const historyDir = getHistoryDir(focusPath);

    if (!fs.existsSync(historyDir)) {
      try {
        fs.mkdirSync(historyDir, { recursive: true });
      } catch (error) {
        logError(`Failed to create history directory: ${historyDir}`, error);
        return null;
      }
    }

    // Display label only: the bytes below are preserved verbatim.
    const asText = typeof content === 'string' ? content : content.toString('utf-8');
    const version = extractVersion(asText);
    const date = extractDate(asText);
    const timestamp = Date.now();
    const backupName = `CURRENT_FOCUS.v${version}.${date}.${timestamp}.md`;
    const backupPath = path.join(historyDir, backupName);

    if (fs.existsSync(backupPath)) {
      return null;
    }

    try {
      atomicWriteFileSync(backupPath, content);
      return backupPath;
    } catch (error) {
      logError(`Failed to write backup file: ${backupPath}`, error);
      return null;
    }
  } catch (error) {
    logError('Unexpected error in backupToHistory', error);
    return null;
  }
}
