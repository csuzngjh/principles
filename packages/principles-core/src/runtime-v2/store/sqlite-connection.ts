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
        FOREIGN KEY (task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(execution_status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
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
