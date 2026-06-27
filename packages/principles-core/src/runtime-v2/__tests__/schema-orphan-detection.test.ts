/**
 * Schema Orphan Table Detection Test (PRI-475 / M2)
 *
 * Prevents recurrence of P3-12 (confirm_first_state orphan table): a table
 * whose CREATE TABLE DDL remains in sqlite-connection.ts but has no write
 * path (INSERT/REPLACE/UPDATE) in production code becomes an orphan —
 * it misleads new developers and accumulates schema debt.
 *
 * Approach:
 * 1. Read sqlite-connection.ts and extract all CREATE TABLE names.
 * 2. For each table, scan production source files (*.ts, excluding *.test.ts)
 *    for INSERT/REPLACE/UPDATE statements referencing that table.
 * 3. A table with no write path fails the test unless it is in the
 *    INTENTIONAL_EMPTY_TABLES allowlist (with a documented reason).
 *
 * This is a static source scan, not a runtime DB inspection, so it catches
 * tables whose DDL exists but whose store class was deleted (the P3-12 case).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// __dirname in vitest points to the source file location:
// .../packages/principles-core/src/runtime-v2/__tests__/
// sqlite-connection.ts is at .../packages/principles-core/src/runtime-v2/store/
const CONNECTION_FILE = path.resolve(__dirname, '../store/sqlite-connection.ts');
// PACKAGES_DIR is .../packages/ (contains all monorepo packages).
// From __tests__/ go up 4 levels: __tests__ -> runtime-v2 -> src -> principles-core -> packages
const PACKAGES_DIR = path.resolve(__dirname, '../../../..');

// Allowlist: tables that intentionally have no write path.
// Each entry MUST include a reason comment explaining why the table is empty.
const INTENTIONAL_EMPTY_TABLES: ReadonlySet<string> = new Set<string>([
  // (none currently — all tables have write paths)
  // To add an entry, append the table name and document why it is empty.
]);

/**
 * Extract table names from all CREATE TABLE IF NOT EXISTS statements
 * in sqlite-connection.ts.
 */
function extractCreatedTables(source: string): string[] {
  const tables: string[] = [];
  const pattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const [, tableName] = match;
    if (typeof tableName === 'string') {
      tables.push(tableName);
    }
  }
  return tables;
}

/**
 * Collect all production .ts source files under packages/ (excluding tests).
 * Returns absolute paths.
 */
function collectProductionSourceFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, dist, .trae, .git
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.trae' ||
          entry.name === '.git'
        ) {
          continue;
        }
        walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(PACKAGES_DIR);
  return results;
}

/**
 * Strip comments from TypeScript source so that commented-out SQL statements
 * are not counted as write paths (avoids false negatives in orphan detection).
 * Handles line comments (//) and block comments (slash-star ... star-slash).
 * Simplified: does not parse string literals, but SQL rarely contains //.
 */
function stripComments(source: string): string {
  // Strip block comments first (may span multiple lines)
  let result = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments
  result = result.replace(/\/\/.*$/gm, '');
  return result;
}

/**
 * Check whether a table name appears in any INSERT/REPLACE/UPDATE statement
 * in the given source file content. Comments are stripped first to avoid
 * false negatives from commented-out write paths.
 */
function hasWritePath(table: string, fileContents: string[]): boolean {
  // Match INSERT INTO <table>, INSERT OR IGNORE INTO <table>,
  // INSERT OR REPLACE INTO <table>, REPLACE INTO <table>,
  // UPDATE <table>
  const pattern = new RegExp(
    `(INSERT\\s+(OR\\s+(IGNORE|REPLACE)\\s+)?INTO|REPLACE\\s+INTO|UPDATE)\\s+${table}\\b`,
    'i',
  );
  return fileContents.some((content) => pattern.test(stripComments(content)));
}

describe('Schema orphan table detection (PRI-475 / M2)', () => {
  const connectionSource = fs.readFileSync(CONNECTION_FILE, 'utf-8');
  const createdTables = extractCreatedTables(connectionSource);
  const sourceFiles = collectProductionSourceFiles();
  const fileContents = sourceFiles.map((f) => {
    try {
      return fs.readFileSync(f, 'utf-8');
    } catch {
      return '';
    }
  });

  it('sqlite-connection.ts should define at least one table', () => {
    expect(createdTables.length).toBeGreaterThan(0);
  });

  it('confirm_first_state table should NOT exist (P3-12 regression guard)', () => {
    // P3-12: confirm_first_state was an orphan table whose store class was
    // deleted. The DDL was replaced with DROP IF EXISTS in PRI-473.
    // This test fails if someone re-adds the CREATE TABLE statement.
    expect(createdTables).not.toContain('confirm_first_state');
  });

  describe.each(createdTables)('table "%s" has a write path', (table) => {
    it(`${table} should have at least one INSERT/REPLACE/UPDATE in production code`, () => {
      const isAllowlisted = INTENTIONAL_EMPTY_TABLES.has(table);
      const hasWrite = hasWritePath(table, fileContents);

      if (isAllowlisted) {
        // Allowlisted tables are expected to have no write path.
        // If they gain one, that's fine — no assertion failure.
        return;
      }

      expect(hasWrite).toBe(true);
    });
  });

  it('INTENTIONAL_EMPTY_TABLES allowlist entries must all exist in schema', () => {
    // If an allowlisted table no longer exists in the schema, the allowlist
    // entry is stale and should be removed.
    for (const allowlisted of INTENTIONAL_EMPTY_TABLES) {
      expect(createdTables).toContain(allowlisted);
    }
  });
});
