/**
 * SQLite connection factory for PD Runtime v2 state store.
 *
 * Opens (or creates) the workspace-level DB at `<workspaceDir>/.pd/state.db`
 * with WAL journal mode, 5-second busy timeout, and synchronous NORMAL.
 * Initializes the tasks and runs tables on first open.
 *
 * @example
 * const conn = new SqliteConnection('/path/to/workspace');
 * const db = conn.getDb();
 * // ... use db
 * conn.close();
 */
import Database from 'better-sqlite3';
import { join } from 'path';
import * as fs from 'fs';
import { PDRuntimeError } from '../error-categories.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface SqliteConnectionOptions {
  workspaceDir: string;
  readonly?: boolean;
}

export interface SqlitePragmaReport {
  journalMode: string;
  busyTimeout: number;
  synchronous: string;
  foreignKeys: boolean;
  healthy: boolean;
  issues: string[];
}

export class SqliteConnection {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private readonly readonlyMode: boolean;

  constructor(workspaceDirOrOpts: string | SqliteConnectionOptions) {
    const opts = typeof workspaceDirOrOpts === 'string'
      ? { workspaceDir: workspaceDirOrOpts }
      : workspaceDirOrOpts;
    const pdDir = join(opts.workspaceDir, '.pd');
    this.readonlyMode = opts.readonly ?? false;
    if (!this.readonlyMode && !fs.existsSync(pdDir)) {
      fs.mkdirSync(pdDir, { recursive: true });
    }
    this.dbPath = join(pdDir, 'state.db');
  }

  getDb(): Database.Database {
    if (this.db) return this.db;

    this.db = this.readonlyMode
      ? new Database(this.dbPath, { readonly: true })
      : new Database(this.dbPath);

    if (!this.readonlyMode) {
      try {
        // Set the pragmas
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        // Verify they were applied correctly
        const journalMode = this.db.pragma('journal_mode', { simple: true });
        if (String(journalMode).toLowerCase() !== 'wal') {
          throw new PDRuntimeError(
            'storage_unavailable',
            `Failed to set WAL journal mode (got: ${journalMode})`,
          );
        }

        const foreignKeys = this.db.pragma('foreign_keys', { simple: true });
        if (!foreignKeys) {
          throw new PDRuntimeError(
            'storage_unavailable',
            `Failed to enable foreign keys (got: ${foreignKeys})`,
          );
        }
      } catch (err) {
        const pdErr = err instanceof PDRuntimeError
          ? err
          : new PDRuntimeError(
              'storage_unavailable',
              `Required SQLite pragma failed: ${err instanceof Error ? err.message : String(err)}`,
              { originalError: err instanceof Error ? err.message : String(err) },
            );
        try { this.db?.close(); } catch { /* best-effort cleanup */ }
        this.db = null;
        throw pdErr;
      }
      try {
        this.initSchema();
      } catch { /* schema init may fail in restricted environments */ }
      try {
        this.migrateSchema();
      } catch { /* schema migration is non-fatal */ }
    }

    return this.db;
  }

  getPragmaReport(): SqlitePragmaReport {
    if (!this.db) {
      return {
        journalMode: 'none',
        busyTimeout: 0,
        synchronous: 'unknown',
        foreignKeys: false,
        healthy: false,
        issues: ['database not opened'],
      };
    }
    try {
      const issues: string[] = [];
      const journalMode = String(this.db.pragma('journal_mode', { simple: true }));
      const busyTimeout = Number(this.db.pragma('busy_timeout', { simple: true }));
      const synchronous = String(this.db.pragma('synchronous', { simple: true }));
      const foreignKeys = Boolean(this.db.pragma('foreign_keys', { simple: true }));

      if (journalMode !== 'wal') issues.push(`journal_mode is ${journalMode}, expected wal`);
      if (busyTimeout < 5000) issues.push(`busy_timeout is ${busyTimeout}, expected >= 5000`);
      if (!foreignKeys) issues.push('foreign_keys is OFF, expected ON');
      if (synchronous !== '1') issues.push(`synchronous is ${synchronous}, expected NORMAL`);

      return { journalMode, busyTimeout, synchronous, foreignKeys, healthy: issues.length === 0, issues };
    } catch {
      return { journalMode: 'error', busyTimeout: 0, synchronous: 'error', foreignKeys: false, healthy: false, issues: ['pragma read failed - database may be corrupted'] };
    }
  }

  /**
   * Returns the current schema version of state.db.
   * Versions are stored as TEXT and compared lexicographically (e.g., '000' < '001').
   * Returns '000' for fresh databases or if the table is somehow missing.
   */
  getSchemaVersion(): string {
    const db = this.getDb();
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    if (!isRecord(row) || typeof row.version !== 'string') return '000';
    return row.version;
  }

  /**
   * Records a new schema version after a migration is applied.
   * Each call inserts a new row (append-only history for audit).
   */
  setSchemaVersion(version: string): void {
    const db = this.getDb();
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }

  private initSchema(): void {
    const db = this.db as Database.Database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        input_ref TEXT,
        result_ref TEXT,
        diagnostic_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_task_kind ON tasks(task_kind);
      CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires_at ON tasks(lease_expires_at);
    `);

    // Migration: add diagnostic_json column to existing tasks table
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!taskColumns.some((c) => c.name === 'diagnostic_json')) {
      db.exec('ALTER TABLE tasks ADD COLUMN diagnostic_json TEXT');
    }

    // Migration: add sessionIdHint expression index
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session_id_hint ON tasks(json_extract(diagnostic_json, '$.sessionIdHint'))");
    } catch {
      // Index may already exist
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        execution_status TEXT NOT NULL DEFAULT 'queued',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        reason TEXT,
        output_ref TEXT,
        input_payload TEXT,
        output_payload TEXT,
        error_category TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(execution_status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    `);

    // Migration: rewrite runs FK with ON DELETE CASCADE
    const fkInfo = db.prepare('PRAGMA foreign_key_list(runs_backup)').all() as { id: number; seq: number; from: string; to: string; on_delete: string }[];
    if (fkInfo.length > 0 && !fkInfo.some((fk) => fk.on_delete === 'CASCADE')) {
      db.exec(`
        ALTER TABLE runs RENAME TO runs_backup;
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          runtime_kind TEXT NOT NULL,
          execution_status TEXT NOT NULL DEFAULT 'queued',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          reason TEXT,
          output_ref TEXT,
          input_payload TEXT,
          output_payload TEXT,
          error_category TEXT,
          attempt_number INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
        );
        INSERT INTO runs SELECT * FROM runs_backup;
        DROP TABLE runs_backup;
      `);
    }

    // M5: artifacts table
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_kind ON artifacts(artifact_kind);
    `);

    // M5: commits table
    db.exec(`
      CREATE TABLE IF NOT EXISTS commits (
        commit_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        artifact_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'committed',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_commits_task_id ON commits(task_id);
      CREATE INDEX IF NOT EXISTS idx_commits_artifact_id ON commits(artifact_id);
    `);

    // M5: principle_candidates table
    db.exec(`
      CREATE TABLE IF NOT EXISTS principle_candidates (
        candidate_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        confidence REAL,
        source_recommendation_json TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        recommendation_kind TEXT NOT NULL DEFAULT 'principle',
        trigger_pattern TEXT,
        action TEXT,
        abstracted_principle TEXT,
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_source_run_id ON principle_candidates(source_run_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_task_id ON principle_candidates(task_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_recommendation_kind ON principle_candidates(recommendation_kind);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS pi_artifacts (
        artifact_id TEXT PRIMARY KEY,
        artifact_kind TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        source_principle_id TEXT,
        source_rule_id TEXT,
        lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
        validation_status TEXT NOT NULL DEFAULT 'pending',
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pi_artifacts_source_task_id ON pi_artifacts(source_task_id);
      CREATE INDEX IF NOT EXISTS idx_pi_artifacts_artifact_kind ON pi_artifacts(artifact_kind);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_artifacts_idempotency ON pi_artifacts(source_task_id, artifact_kind);

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        confidence REAL,
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_note TEXT,
        rejection_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_channel ON approvals(channel);
    `);

    // Add context columns for user-facing descriptions (idempotent migration)
    const approvalCols = db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[];
    const existingApprovalCols = new Set(approvalCols.map((c: { name: string }) => c.name));
    const contextColumns = [
      'summary', 'trigger_reason',
      'confidence_explanation', 'effect_description', 'rejection_effect',
    ];
    for (const col of contextColumns) {
      if (!existingApprovalCols.has(col)) {
        db.exec('ALTER TABLE approvals ADD COLUMN ' + col + ' TEXT');
      }
    }

    // Story A (PRI-408): Add edit tracking columns for edit-then-approve flow
    const editColumns = [
      'edited_at',
      'edited_by',
      'edit_reason',
      'previous_artifact_id',
    ];
    for (const col of editColumns) {
      if (!existingApprovalCols.has(col)) {
        db.exec('ALTER TABLE approvals ADD COLUMN ' + col + ' TEXT');
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS activations (
        activation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        action TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        deactivated_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_idempotency ON activations(idempotency_key);
    `);

    // Migration: add deactivated_at column if missing (existing databases)
    {
      const activationCols = db.prepare("PRAGMA table_info(activations)").all() as { name: string }[];
      if (!activationCols.some(c => c.name === 'deactivated_at')) {
        db.exec('ALTER TABLE activations ADD COLUMN deactivated_at TEXT');
      }
    }

    // PRI-286: confirm_first_state table is orphaned (SqliteConfirmFirstStateStore class deleted).
    // Drop legacy table if exists; CREATE is no longer needed.
    db.exec(`
      DROP TABLE IF EXISTS confirm_first_state;
      DROP INDEX IF EXISTS idx_confirm_first_state_last_seen;
    `);

    // PRI-470: IntentDecisionRecord durable store (SPEC §21.7).
    // Stores immutable snapshots of source / evidenceStrength /
    // relatedIntentFields / evidenceRefs so the audit trail stays accurate
    // even if the underlying artifact is later modified.
    db.exec(`
      CREATE TABLE IF NOT EXISTS intent_decisions (
        id TEXT PRIMARY KEY,
        pain_id TEXT,
        task_id TEXT NOT NULL,
        run_id TEXT,
        intent_doc_hash TEXT,
        source TEXT NOT NULL,
        evidence_strength TEXT NOT NULL,
        related_intent_fields TEXT NOT NULL,
        owner_action TEXT NOT NULL,
        evidence_refs TEXT NOT NULL,
        note TEXT,
        source_snapshot TEXT NOT NULL,
        evidence_strength_snapshot TEXT NOT NULL,
        related_intent_fields_snapshot TEXT NOT NULL,
        evidence_refs_snapshot TEXT NOT NULL,
        resulting_candidate_id TEXT,
        resulting_rule_candidate_id TEXT,
        patch_proposal_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intent_decisions_pain_id ON intent_decisions(pain_id);
      CREATE INDEX IF NOT EXISTS idx_intent_decisions_task_id ON intent_decisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_intent_decisions_owner_action ON intent_decisions(owner_action);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_decisions_pain_hash_action
        ON intent_decisions(pain_id, intent_doc_hash, owner_action)
        WHERE pain_id IS NOT NULL;
    `);

    // P2-10: Minimal schema_version table for state.db migration tracking.
    // core cannot import plugin's MigrationRunner (dependency direction),
    // so this is a lightweight version that records schema version history.
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT NOT NULL DEFAULT '000',
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
    `);
    // Seed initial version '000' if table is empty (fresh database).
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM schema_version').get();
    if (!isRecord(countRow) || typeof countRow.cnt !== 'number' || countRow.cnt === 0) {
      db.prepare("INSERT INTO schema_version (version) VALUES ('000')").run();
    }
  }

  private migrateSchema(): void {
    const db = this.db as Database.Database;

    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='principle_candidates'"
    ).get();
    if (!tableExists) return;

    const columns = db.prepare('PRAGMA table_info(principle_candidates)').all() as { name: string }[];
    const existingNames = new Set(columns.map((c) => c.name));

    const candidateMigrations = [
      { name: 'recommendation_kind', sql: "ALTER TABLE principle_candidates ADD COLUMN recommendation_kind TEXT NOT NULL DEFAULT 'principle'" },
      { name: 'trigger_pattern', sql: 'ALTER TABLE principle_candidates ADD COLUMN trigger_pattern TEXT' },
      { name: 'action', sql: 'ALTER TABLE principle_candidates ADD COLUMN action TEXT' },
      { name: 'abstracted_principle', sql: 'ALTER TABLE principle_candidates ADD COLUMN abstracted_principle TEXT' },
    ];

    for (const migration of candidateMigrations) {
      if (!existingNames.has(migration.name)) {
        db.exec(migration.sql);
      }
    }

    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_candidates_recommendation_kind ON principle_candidates(recommendation_kind)");
    } catch {
      // index may already exist
    }
  }

  /** Closes the underlying database connection. */
  close(): void {
    if (!this.db) return;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
    } catch {
      // ignore errors during close (e.g., if db file was removed externally)
    } finally {
      this.db = null;
    }
  }
}