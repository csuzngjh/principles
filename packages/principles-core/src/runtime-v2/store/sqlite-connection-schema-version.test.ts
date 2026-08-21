import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) {
      try { fs.rmSync(dir, { force: true, recursive: true }); } catch { /* ignore cleanup errors */ }
    }
  }
});

function makeConnection(): SqliteConnection {
  const dir = path.join(os.tmpdir(), `pd-schema-version-${process.pid}-${Date.now()}-${tempDirs.length}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return new SqliteConnection(dir);
}

describe('schema_version table (P2-10)', () => {
  it('creates schema_version table on init', () => {
    const conn = makeConnection();
    conn.getDb(); // trigger initSchema
    const tables = conn.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('returns "002" for fresh database after RuleCode safety migration', () => {
    // F12 (PRI-442): migrateSchema now records '001' after migrations are
    // applied. Previously this returned '000' (the seed) because
    // migrateSchema never called setSchemaVersion.
    const conn = makeConnection();
    conn.getDb();
    expect(conn.getSchemaVersion()).toBe('002');
  });

  it('tracks version increments', () => {
    const conn = makeConnection();
    conn.getDb();
    expect(conn.getSchemaVersion()).toBe('002');
    conn.setSchemaVersion('003');
    expect(conn.getSchemaVersion()).toBe('003');
  });

  it('persists version across reconnection', () => {
    const dir = path.join(os.tmpdir(), `pd-schema-version-persist-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const conn1 = new SqliteConnection(dir);
    conn1.getDb();
    conn1.setSchemaVersion('003');
    conn1.close();

    const conn2 = new SqliteConnection(dir);
    expect(conn2.getSchemaVersion()).toBe('003');
    conn2.close();
  });

  it('does not duplicate initial "000" row on re-init', () => {
    const dir = path.join(os.tmpdir(), `pd-schema-version-nodup-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const conn1 = new SqliteConnection(dir);
    conn1.getDb();
    conn1.close();

    const conn2 = new SqliteConnection(dir);
    conn2.getDb(); // triggers initSchema again — should not insert duplicate '000'
    // F12: also should not insert duplicate '001' (migrateSchema is idempotent)
    const rows = conn2.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: string }[];
    conn2.close();

    // Seed plus the legacy migration and RuleCode safety authority migration.
    expect(rows.length).toBe(3);
    expect(rows[0]?.version).toBe('000');
    expect(rows[1]?.version).toBe('001');
    expect(rows[2]?.version).toBe('002');
  });

  // PRI-442 F12: migrateSchema() must call setSchemaVersion('001') after
  // migrations are applied or verified. Previously the version stayed at
  // the seed '000' forever (rc-9: silent state drift).
  it('F12: records schema version "001" after migrateSchema runs', () => {
    const conn = makeConnection();
    conn.getDb(); // triggers initSchema + migrateSchema

    // After migrateSchema, the version should be '001' (not the seed '000')
    // because the principle_candidates table is created with migration columns
    // (recommendation_kind, trigger_pattern, action, abstracted_principle).
    expect(conn.getSchemaVersion()).toBe('002');
  });

  it('F12: does not duplicate "001" row on re-init', () => {
    const dir = path.join(os.tmpdir(), `pd-schema-version-f12-nodup-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const conn1 = new SqliteConnection(dir);
    conn1.getDb();
    expect(conn1.getSchemaVersion()).toBe('002');
    conn1.close();

    // Re-open: migrateSchema runs again, but should NOT insert another '001'
    const conn2 = new SqliteConnection(dir);
    conn2.getDb();
    const rows = conn2.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: string }[];
    conn2.close();

    expect(rows.length).toBe(3);
    expect(rows[0]?.version).toBe('000');
    expect(rows[1]?.version).toBe('001');
    expect(rows[2]?.version).toBe('002');
  });
});
