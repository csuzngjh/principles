/**
 * Shared type definitions for database operations.
 * Kept separate to avoid circular dependencies between schema-definitions and migration-runner.
 */

/** Minimal interface for better-sqlite3 Database instances. */
export interface Db {
  exec(sql: string): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(sql: string, ...params: unknown[]): unknown;
  close(): void;
}
