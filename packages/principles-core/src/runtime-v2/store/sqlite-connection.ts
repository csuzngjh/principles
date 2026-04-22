/**
 * SqliteConnection stub.
 *
 * This is a placeholder for type use. The actual SqliteConnection implementation
 * is created by plan m2-01.
 *
 * @see m2-01-PLAN.md Task 1 for full implementation
 */
import type Database from 'better-sqlite3';

export class SqliteConnection {
  constructor(_workspaceDir: string) {
    throw new Error('SqliteConnection is not implemented yet — run m2-01 first');
  }

  getDb(): Database.Database {
    throw new Error('SqliteConnection is not implemented yet — run m2-01 first');
  }

  close(): void {
    throw new Error('SqliteConnection is not implemented yet — run m2-01 first');
  }
}
