/**
 * Schema Management — Unified database schema definitions and migrations.
 *
 * Usage:
 *   // In a database class constructor:
 *   import { ensureDatabaseSchema } from './schema';
 *   ensureDatabaseSchema(db, 'trajectory.db');
 *
 * CLI:
 *   node scripts/db-migrate.mjs status
 *   node scripts/db-migrate.mjs run
 */

export { MigrationRunner, ensureDatabaseSchema } from './migration-runner.js';
export { SCHEMAS, getCatalog, DB_TYPES } from './schema-definitions.js';
export { ALL_MIGRATIONS } from './migrations/index.js';

export type { Db } from './db-types.js';
export type {
  Migration,
  DbType,
  TableDefinition,
  ViewDefinition,
  FtsDefinition,
  SchemaCatalog,
} from './migration-runner.js';
