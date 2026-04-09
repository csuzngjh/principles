#!/usr/bin/env node

/**
 * Database Migration CLI
 *
 * Usage:
 *   node scripts/db-migrate.mjs status              # Show migration status
 *   node scripts/db-migrate.mjs run [--db trajectory.db|central.db|workflow.db]
 *   node scripts/db-migrate.mjs rollback [--db trajectory.db|central.db|workflow.db]
 */

import { Database } from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths
const PROJECT_ROOT = join(__dirname, '..');
const STATE_DIR = process.env.STATE_DIR || join(PROJECT_ROOT, '..', '.state');

// We need to dynamically import the schema module since it's TypeScript
// For CLI, we'll use the compiled JS version
async function run() {
  let SchemaModule;
  try {
    SchemaModule = await import('../dist/core/schema/index.js');
  } catch {
    // Try running from source with tsx
    console.error('Schema module not found in dist/. Running from source...');
    console.error('Please build the plugin first: node esbuild.config.js --production');
    process.exit(1);
  }

  const { MigrationRunner, ensureDatabaseSchema, ALL_MIGRATIONS, DB_TYPES } = SchemaModule;

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Database Migration CLI

Usage:
  node scripts/db-migrate.mjs status              Show migration status for all databases
  node scripts/db-migrate.mjs run [--db <db>]     Run pending migrations
  node scripts/db-migrate.mjs rollback [--db <db>] Rollback latest migration

Options:
  --db <db>    Target database: trajectory.db, central.db, or workflow.db
               (default: all databases)
  --state-dir  Override state directory (default: .state/)

Examples:
  node scripts/db-migrate.mjs status
  node scripts/db-migrate.mjs run --db trajectory.db
  node scripts/db-migrate.mjs rollback --db central.db
`);
    return;
  }

  const dbFlag = args.indexOf('--db');
  const targetDb = dbFlag >= 0 ? args[dbFlag + 1] : null;

  const dbs = targetDb ? [targetDb] : DB_TYPES;

  for (const dbType of dbs) {
    if (!DB_TYPES.includes(dbType)) {
      console.error(`Unknown database: ${dbType}. Valid options: ${DB_TYPES.join(', ')}`);
      continue;
    }

    const dbPath = getDbPath(dbType);
    const db = new Database(dbPath);

    console.log(`\n=== ${dbType} (${dbPath}) ===`);

    switch (command) {
      case 'status':
        showStatus(db, dbType, ALL_MIGRATIONS, MigrationRunner);
        break;
      case 'run':
        runMigrations(db, dbType, ALL_MIGRATIONS, MigrationRunner);
        break;
      case 'rollback':
        rollbackMigration(db, dbType, ALL_MIGRATIONS, MigrationRunner);
        break;
      case 'ensure':
        console.log('Ensuring schema...');
        ensureDatabaseSchema(db, dbType);
        console.log('Schema ensured.');
        break;
      default:
        console.error(`Unknown command: ${command}`);
    }

    db.close();
  }
}

function getDbPath(dbType) {
  switch (dbType) {
    case 'trajectory.db':
      return join(STATE_DIR, 'trajectory.db');
    case 'central.db':
      return join(process.env.HOME, '.openclaw', '.central', 'aggregated.db');
    case 'workflow.db':
      return join(STATE_DIR, 'subagent_workflows.db');
    default:
      throw new Error(`Unknown database type: ${dbType}`);
  }
}

function showStatus(db, dbType, migrations, Runner) {
  const runner = new Runner(db);
  const current = runner.getCurrentVersion();
  const info = runner.getMigrationInfo(migrations, dbType);

  console.log(`Current version: ${current}`);
  console.log('');

  for (const m of info) {
    const status = m.applied ? '✅' : '⏳';
    console.log(`  ${status} ${m.id}-${m.name}`);
  }

  if (info.length === 0) {
    console.log('  No migrations defined for this database.');
  }
}

function runMigrations(db, dbType, migrations, Runner) {
  const runner = new Runner(db);

  // First ensure base schema
  console.log('Applying schema catalog...');
  runner.applySchemaCatalog(dbType);

  // Then run any additional migrations
  const dbMigrations = migrations.filter(m => m.db === dbType);
  if (dbMigrations.length > 0) {
    const applied = runner.runMigrations(dbMigrations, dbType);
    if (applied.length === 0) {
      console.log('All migrations already applied.');
    }
  }

  showStatus(db, dbType, migrations, Runner);
}

function rollbackMigration(db, dbType, migrations, Runner) {
  const runner = new Runner(db);
  const dbMigrations = migrations.filter(m => m.db === dbType);
  const rolledBack = runner.rollback(dbMigrations, dbType);

  if (rolledBack) {
    console.log(`Rolled back migration ${rolledBack}`);
  } else {
    console.log('No migrations to roll back.');
  }

  showStatus(db, dbType, migrations, Runner);
}

run().catch(err => {
  console.error('Migration CLI error:', err);
  process.exit(1);
});
