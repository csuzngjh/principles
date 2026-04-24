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
export declare class SqliteConnection {
    private db;
    private readonly dbPath;
    constructor(workspaceDir: string);
    /** Returns the underlying better-sqlite3 Database instance. */
    getDb(): Database.Database;
    private initSchema;
    /** Closes the underlying database connection. */
    close(): void;
}
//# sourceMappingURL=sqlite-connection.d.ts.map