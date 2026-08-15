/**
 * Principle Application Ledger writer (PRI-531, SPEC §5.3).
 *
 * Durable application history for the principle receipt feature. Writes to
 * {workspace}/.pd/state.db table `principle_applications` (created by core
 * SqliteConnection.initSchema — write-mode open self-installs it).
 *
 * Levels (SPEC §4 — Owner-approved semantics):
 *   effect   = rule_blocked / auto_correct_applied / self_reported
 *   presence = prompt_injected (deduped per session×principle)
 *
 * Never throws: ledger failures degrade to false + caller-side warn (rc-9) —
 * the hook decision (block/allow/inject) is NEVER affected by ledger writes.
 */
import { SqliteConnection } from '@principles/core/runtime-v2';
import Database from 'better-sqlite3';

export type PrincipleApplicationLevel = 'effect' | 'presence';
export type PrincipleApplicationKind =
  | 'rule_blocked'
  | 'auto_correct_applied'
  | 'self_reported'
  | 'prompt_injected';

export interface PrincipleApplicationInput {
  principleId: string;
  activationId?: string;
  ruleId?: string;
  channel: 'code_tool_hook' | 'prompt';
  level: PrincipleApplicationLevel;
  kind: PrincipleApplicationKind;
  sessionId?: string;
  toolName?: string;
  filePath?: string;
  digest?: string;
}

const RETENTION_DAYS = 90;
/** Retention sweep at most once per hour per process — injection/block volumes are low. */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const connections = new Map<string, SqliteConnection>();
let lastRetentionSweepAt = 0;

function getConnection(workspaceDir: string): SqliteConnection {
  let conn = connections.get(workspaceDir);
  if (!conn) {
    // Write mode: initSchema self-installs the table on first open.
    conn = new SqliteConnection(workspaceDir);
    connections.set(workspaceDir, conn);
  }
  return conn;
}

function sweepRetention(db: Database.Database): void {
  const now = Date.now();
  if (now - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) return;
  lastRetentionSweepAt = now;
  const cutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    db.prepare('DELETE FROM principle_applications WHERE created_at < ?').run(cutoff);
  } catch {
    // Best-effort retention; retried on the next sweep window.
  }
}

/**
 * Record one application event. Returns true when a row was written (or
 * deduped), false on failure — callers must surface the reason (rc-9).
 */
export function recordPrincipleApplication(
  workspaceDir: string,
  input: PrincipleApplicationInput,
): boolean {
  try {
    const db = getConnection(workspaceDir).getDb();
    sweepRetention(db);
    db.prepare(`
      INSERT OR IGNORE INTO principle_applications
        (principle_id, activation_id, rule_id, channel, level, kind,
         session_id, tool_name, file_path, digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.principleId,
      input.activationId ?? null,
      input.ruleId ?? null,
      input.channel,
      input.level,
      input.kind,
      input.sessionId ?? null,
      input.toolName ?? null,
      input.filePath ?? null,
      input.digest ?? null,
      new Date().toISOString(),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Presence rows for a prompt injection event — one per principle, deduped per
 * session×principle by the partial unique index (restarts included).
 * Returns the number of NEW rows written (0 when all were already present).
 */
export function recordInjectionPresence(
  workspaceDir: string,
  principleIds: readonly string[],
  sessionId: string | undefined,
  activationIds?: readonly string[],
): number {
  let written = 0;
  for (let i = 0; i < principleIds.length; i++) {
    const principleId = principleIds[i];
    if (typeof principleId !== 'string' || principleId.length === 0) continue;
    try {
      const db = getConnection(workspaceDir).getDb();
      sweepRetention(db);
      const result = db.prepare(`
        INSERT OR IGNORE INTO principle_applications
          (principle_id, activation_id, channel, level, kind, session_id, created_at)
        VALUES (?, ?, 'prompt', 'presence', 'prompt_injected', ?, ?)
      `).run(
        principleId,
        typeof activationIds?.[i] === 'string' ? activationIds[i] : null,
        sessionId ?? null,
        new Date().toISOString(),
      );
      const changes = typeof result === 'object' && result !== null
        ? ((result as { changes?: number }).changes ?? 0)
        : 0;
      written += changes > 0 ? 1 : 0;
    } catch {
      // Skip this principle's row; next injection retries (presence is
      // idempotent). Overall degradation is observable via absence + console
      // degraded state (rc-9 handled at caller level for the whole feature).
    }
  }
  return written;
}

/** Test hook: close cached connections and reset the retention sweep clock. */
export function clearPrincipleApplicationLedgerCache(): void {
  for (const conn of connections.values()) {
    try {
      conn.close();
    } catch {
      // already closed — ignore
    }
  }
  connections.clear();
  lastRetentionSweepAt = 0;
}
