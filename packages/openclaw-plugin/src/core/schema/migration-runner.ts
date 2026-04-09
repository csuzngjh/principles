/**
 * Migration Runner — Executes and tracks schema migrations.
 *
 * Each migration is versioned. The runner reads the current version from
 * the `schema_version` table and only executes migrations with higher IDs.
 *
 * Usage:
 *   const runner = new MigrationRunner(db);
 *   runner.run(allMigrations.filter(m => m.db === 'trajectory.db'));
 */

import type { Migration } from './schema-definitions.js';
import { getCatalog, DB_TYPES, type DbType } from './schema-definitions.js';
import type { Db } from './db-types.js';

export class MigrationRunner {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Run all pending migrations for a given database type.
   * @returns Array of migration names that were applied
   */
  runMigrations(migrations: Migration[], dbType: DbType): string[] {
    // Ensure schema_version table exists before anything else
    this.ensureVersionTable();

    const currentVersion = this.getCurrentVersion();
    const applied: string[] = [];

    // Filter to pending migrations (higher ID than current)
    const pending = migrations
      .filter(m => m.id > currentVersion)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const migration of pending) {
      // eslint-disable-next-line no-console -- Migration logging is intentional
      console.log(`[MigrationRunner] Applying ${migration.id}-${migration.name}...`);
      try {
        migration.up(this.db);
        this.setVersion(migration.id);
        applied.push(`${migration.id}-${migration.name}`);
      } catch (err) {
        throw new Error(
          `Migration ${migration.id}-${migration.name} failed: ${String(err)}`
        );
      }
    }

    if (applied.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[MigrationRunner] Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }

    return applied;
  }

  /**
   * Apply all schema definitions (tables, indexes, views, FTS) for a database.
   * This is a convenience method that creates everything from the schema catalog.
   * Used for initial setup when no migrations exist yet.
   */
  applySchemaCatalog(dbType: DbType): void {
    this.ensureVersionTable();

    const catalog = getCatalog(dbType);

    // Tables
    for (const [key, table] of Object.entries(catalog.tables)) {
      try {
        this.db.exec(table.ddl);
      } catch (err) {
        throw new Error(`Failed to create table ${key}: ${String(err)}`);
      }
      // Indexes
      for (const indexDdl of table.indexes ?? []) {
        try {
          this.db.exec(indexDdl);
        } catch (err) {
          throw new Error(`Failed to create index for ${key}: ${String(err)}`);
        }
      }
    }

    // Views
    for (const [key, view] of Object.entries(catalog.views)) {
      try {
        this.db.exec(view.ddl);
      } catch (err) {
        throw new Error(`Failed to create view ${key}: ${String(err)}`);
      }
    }

    // FTS5 virtual tables
    for (const [key, fts] of Object.entries(catalog.fts)) {
      try {
        this.db.exec(fts.ddl);
      } catch (err) {
        throw new Error(`Failed to create FTS table ${key}: ${String(err)}`);
      }
    }
  }

  /**
   * Get the current migration version.
   * Returns '000' if no version is set (fresh database).
   */
  getCurrentVersion(): string {
    try {
      const row = this.db.get<{ version: string }>(
        'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
      );
      return row?.version ?? '000';
    } catch {
      return '000';
    }
  }

  /**
   * Get all available migration info for a database type.
   */
  getMigrationInfo(migrations: Migration[], dbType: DbType): Array<{
    id: string;
    name: string;
    applied: boolean;
  }> {
    const currentVersion = this.getCurrentVersion();
    return migrations
      .filter(m => m.db === dbType)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(m => ({
        id: m.id,
        name: m.name,
        applied: m.id <= currentVersion,
      }));
  }

  /**
   * Rollback the latest migration (if down migration is defined).
   */
  rollback(migrations: Migration[], dbType: DbType): string | null {
    const currentVersion = this.getCurrentVersion();
    if (currentVersion === '000') return null;

    const migration = migrations.find(
      m => m.db === dbType && m.id === currentVersion
    );
    if (!migration) return null;
    if (!migration.down) {
      throw new Error(`Migration ${migration.id}-${migration.name} has no down migration`);
    }

    // eslint-disable-next-line no-console
    console.log(`[MigrationRunner] Rolling back ${migration.id}-${migration.name}...`);
    migration.down(this.db);

    // Set version to previous migration
    const previousMigrations = migrations
      .filter(m => m.db === dbType && m.id < currentVersion)
      .sort((a, b) => b.id.localeCompare(a.id));
    const newVersion = previousMigrations[0]?.id ?? '000';
    this.setVersion(newVersion);

    // eslint-disable-next-line no-console
    console.log(`[MigrationRunner] Rolled back to ${newVersion}`);
    return migration.id;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private ensureVersionTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT NOT NULL DEFAULT '000'
      )
    `);
    // Ensure at least one row exists
    const count = this.db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM schema_version');
    if (!count || count.cnt === 0) {
      this.db.exec("INSERT INTO schema_version (version) VALUES ('000')");
    }
  }

  private setVersion(version: string): void {
    this.db.exec(`UPDATE schema_version SET version = '${version}'`);
  }
}

/**
 * Factory: create a MigrationRunner and apply schema catalog for a given database.
 * This is the main entry point for database classes.
 */
export function ensureDatabaseSchema(db: Db, dbType: DbType): void {
  const runner = new MigrationRunner(db);
  runner.applySchemaCatalog(dbType);
}

// Re-export types
export type { Migration, DbType, TableDefinition, ViewDefinition, FtsDefinition, SchemaCatalog } from './schema-definitions.js';
