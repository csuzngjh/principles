/**
 * Shared type definitions for database operations.
 * Kept separate to avoid circular dependencies between schema-definitions and migration-runner.
 */

/* eslint-disable no-unused-vars -- Reason: interface method param names are part of type signature */

/** Minimal interface for better-sqlite3 Database instances. */
export interface Db {
  exec(_sql: string): unknown;

  get<T = unknown>(_sql: string, ..._params: unknown[]): T | undefined;

  run(_sql: string, ..._params: unknown[]): unknown;
  close(): void;
}
