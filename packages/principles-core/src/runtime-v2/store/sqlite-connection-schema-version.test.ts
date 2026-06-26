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

  it('returns "000" for fresh database', () => {
    const conn = makeConnection();
    conn.getDb();
    expect(conn.getSchemaVersion()).toBe('000');
  });

  it('tracks version increments', () => {
    const conn = makeConnection();
    conn.getDb();
    expect(conn.getSchemaVersion()).toBe('000');
    conn.setSchemaVersion('001');
    expect(conn.getSchemaVersion()).toBe('001');
    conn.setSchemaVersion('002');
    expect(conn.getSchemaVersion()).toBe('002');
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
    const rows = conn2.getDb().prepare('SELECT COUNT(*) as cnt FROM schema_version').all() as { cnt: number }[];
    conn2.close();

    expect(rows.length).toBe(1);
    expect(rows[0]?.cnt).toBe(1);
  });
});
