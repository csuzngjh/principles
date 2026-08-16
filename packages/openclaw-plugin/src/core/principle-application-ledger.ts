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
import { loadFeatureFlagFromConfig } from './pd-config-loader.js';

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
 * Align activation ids with the actually-injected principle subset (PRI-531
 * review fix). Budget truncation can drop principles from the tail of the
 * full list — pairing by raw index would attach the wrong activation_id to a
 * presence row (rc-6-adjacent data pairing).
 */
export function alignActivationIds(
  principles: ReadonlyArray<{ principleId: string; activationId?: string }>,
  injectedIds: ReadonlySet<string>,
): string[] {
  return principles
    .filter(p => injectedIds.has(p.principleId))
    .map(p => p.activationId ?? '');
}

/**
 * Presence rows for a prompt injection event — one per principle, deduped per
 * session×principle by the partial unique index (restarts included).
 * Returns the number of NEW rows written (0 when all were already present).
 * Failures are warned via the optional logger (rc-9) — never thrown.
 */
export function recordInjectionPresence(
  workspaceDir: string,
  principleIds: readonly string[],
  sessionId: string | undefined,
  activationIds?: readonly string[],
  logger?: { warn?: (message: string) => void; info?: (message: string) => void },
): number {
  let written = 0;
  for (let i = 0; i < principleIds.length; i++) {
    const principleId = principleIds[i];
    if (typeof principleId !== 'string' || principleId.length === 0) continue;
    try {
      const db = getConnection(workspaceDir).getDb();
      sweepRetention(db);
      const activationId = activationIds?.[i];
      const result = db.prepare(`
        INSERT OR IGNORE INTO principle_applications
          (principle_id, activation_id, channel, level, kind, session_id, created_at)
        VALUES (?, ?, 'prompt', 'presence', 'prompt_injected', ?, ?)
      `).run(
        principleId,
        typeof activationId === 'string' && activationId.length > 0 ? activationId : null,
        sessionId ?? null,
        new Date().toISOString(),
      );
      const changes = typeof result === 'object' && result !== null
        ? ((result as { changes?: number }).changes ?? 0)
        : 0;
      written += changes > 0 ? 1 : 0;
    } catch (ledgerErr) {
      // rc-9: a skipped row is observable via this warn; the next injection
      // retries (presence writes are idempotent).
      logger?.warn?.(`[PD:ReceiptLedger] Presence row write failed for principle ${principleId}: ${String(ledgerErr)}`);
    }
  }
  return written;
}

/**
 * PRI-532 (SPEC §5.2): capture agent self-report 📌 lines from assistant text.
 * The directive template (flag on) instructs the agent to append
 * `📌 应用了你的原则「<directive id>」：<one clause>` — this helper scans the
 * final text, resolves the principleId from the marker (the directive id), and
 * writes one self_reported effect row per unique principle×session (partial
 * unique index). Never throws; failures warn via the optional logger (rc-9).
 *
 * Marker text is model output — treated as untrusted (rc-1): id and digest are
 * length-bounded and never parsed as anything richer than strings.
 */
const SELF_REPORT_MARKER = /📌\s*应用了你的原则「([^」]{1,200})」[：:](.{0,200})/gu;

/**
 * 60s flag cache keyed by workspaceDir (ERR-092: per-input-derived module
 * caches must be Map-keyed, not single-valued slots) — capture runs on every
 * llm_output turn, avoid a disk read each time.
 */
const selfReportFlagCache = new Map<string, { expiresAt: number; enabled: boolean }>();

function isSelfReportEnabled(workspaceDir: string, logger?: { warn?: (m: string) => void }): boolean {
  const now = Date.now();
  const cached = selfReportFlagCache.get(workspaceDir);
  if (cached && cached.expiresAt > now) {
    return cached.enabled;
  }
  const enabled = loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_self_report', logger).enabled;
  selfReportFlagCache.set(workspaceDir, { expiresAt: now + 60_000, enabled });
  return enabled;
}

export function recordSelfReportFromText(
  workspaceDir: string,
  text: unknown,
  sessionId: string | undefined,
  logger?: { warn?: (message: string) => void; info?: (message: string) => void },
): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  if (!isSelfReportEnabled(workspaceDir, logger)) return 0;

  let written = 0;
  for (const match of text.matchAll(SELF_REPORT_MARKER)) {
    const principleId = (match[1] ?? '').trim();
    if (principleId.length === 0) continue;
    const digest = (match[2] ?? '').trim().slice(0, 200);
    try {
      const db = getConnection(workspaceDir).getDb();
      sweepRetention(db);
      const result = db.prepare(`
        INSERT OR IGNORE INTO principle_applications
          (principle_id, channel, level, kind, session_id, digest, created_at)
        VALUES (?, 'prompt', 'effect', 'self_reported', ?, ?, ?)
      `).run(principleId, sessionId ?? null, digest, new Date().toISOString());
      const changes = typeof result === 'object' && result !== null
        ? ((result as { changes?: number }).changes ?? 0)
        : 0;
      written += changes > 0 ? 1 : 0;
    } catch (ledgerErr) {
      logger?.warn?.(`[PD:ReceiptLedger] self_report row write failed for principle ${principleId}: ${String(ledgerErr)}`);
    }
  }
  return written;
}

/** Test hook: close cached connections and reset the retention sweep clock. */
export function clearPrincipleApplicationLedgerCache(): void {
  selfReportFlagCache.clear();
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
