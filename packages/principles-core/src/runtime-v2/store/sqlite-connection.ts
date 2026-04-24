/**
 * SQLite connection factory for PD Runtime v2 state store.
 *
 * Opens (or creates) the workspace-level DB at `<workspaceDir>/.pd/state.db`
 * with WAL journal mode and a 5-second busy timeout. Initializes the
 * tasks and runs tables on first open.
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

export class SqliteConnection {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(workspaceDir: string) {
    const pdDir = join(workspaceDir, '.pd');
    if (!fs.existsSync(pdDir)) {
      fs.mkdirSync(pdDir, { recursive: true });
    }
    this.dbPath = join(pdDir, 'state.db');
  }

  /** Returns the underlying better-sqlite3 Database instance. */
  getDb(): Database.Database {
    if (this.db) return this.db;

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    return this.db;
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
    // (CREATE TABLE IF NOT EXISTS only affects new DBs)
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    if (!taskColumns.some((c) => c.name === 'diagnostic_json')) {
      db.exec('ALTER TABLE tasks ADD COLUMN diagnostic_json TEXT');
    }

    // Migration: add sessionIdHint expression index (idempotent)
    // Runs after diagnostic_json column migration to avoid "no such column" error on existing DBs
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_session_id_hint ON tasks(json_extract(diagnostic_json, '$.sessionIdHint'))");
    } catch {
      // Index may already exist — ignore
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

    // Migration: rewrite runs FK with ON DELETE CASCADE (SQLite doesn't support ALTER FK)
    // Only needed for pre-existing runs tables that lack CASCADE.
    // Check runs_backup (old table) to determine if migration is needed.
    // fkInfo.length === 0 means no backup table exists yet (fresh DB).
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

    // M5: artifacts table — committed diagnostician output
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

    // M5: commits table — atomic commit records linking run to artifact
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

    // M5: principle_candidates table — extracted principle recommendations
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
        FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON principle_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_source_run_id ON principle_candidates(source_run_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_task_id ON principle_candidates(task_id);
    `);
  }

  /** Closes the underlying database connection. */
  close(): void {
    if (this.db) {
      // Checkpoint WAL before closing so all data is flushed to the main DB file.
      // TRUNCATE also shrinks the WAL file, preventing unbounded growth on Windows.
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
      this.db = null;
    }
  }
}
