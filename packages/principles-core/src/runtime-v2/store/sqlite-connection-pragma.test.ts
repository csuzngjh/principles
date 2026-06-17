/**
 * PRI-140: SQLite WAL & Busy Timeout Configuration tests.
 *
 * TDD tests verifying:
 * 1. Writable connections apply WAL / busy_timeout / synchronous = NORMAL
 * 2. Data survives reconnect under WAL
 * 3. Readonly connections never create .pd dir or mutate schema
 * 4. Pragma failures throw PDRuntimeError (not silent)
 * 5. getPragmaReport() reports actual SQLite configuration
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { SqliteConnection } from './sqlite-connection.js';
import { PDRuntimeError } from '../error-categories.js';

const TMP = path.join(os.tmpdir(), `pd-pri140-${process.pid}`);

function freshDir(label: string): string {
  const dir = path.join(TMP, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows */ }
});

// -- 1. Writable connection applies required pragmas --

describe('PRI-140: writable connection pragmas', () => {
  it('sets journal_mode=WAL, busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON', () => {
    const dir = freshDir('pragma-check');
    const conn = new SqliteConnection(dir);
    try {
      const db = conn.getDb();

      const journalMode = db.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');

      const busyTimeout = db.pragma('busy_timeout', { simple: true });
      expect(busyTimeout).toBe(5000);

      const synchronous = db.pragma('synchronous', { simple: true });
      expect(synchronous).toBe(1);

      const foreignKeys = db.pragma('foreign_keys', { simple: true });
      expect(foreignKeys).toBe(1);
    } finally {
      conn.close();
    }
  });
});

// -- 2. Reconnect retains data with WAL --

describe('PRI-140: reconnect data retention', () => {
  it('data survives close and reopen under WAL', () => {
    const dir = freshDir('reconnect');

    const conn1 = new SqliteConnection(dir);
    const db1 = conn1.getDb();
    db1.prepare(
      'INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('t-001', 'diagnostician', 'pending', new Date().toISOString(), new Date().toISOString());
    conn1.close();

    const conn2 = new SqliteConnection(dir);
    try {
      const db2 = conn2.getDb();
      const row = db2.prepare("SELECT * FROM tasks WHERE task_id = 't-001'").get() as { task_id: string } | undefined;
      expect(row).toBeDefined();
      expect((row as { task_id: string }).task_id).toBe('t-001');

      const journalMode = db2.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');
    } finally {
      conn2.close();
    }
  });
});

// -- 3. Readonly connection: no .pd creation, no schema mutation --

describe('PRI-140: readonly connection constraints', () => {
  it('does not create .pd directory when it does not exist', () => {
    const writableDir = freshDir('readonly-setup');
    const writer = new SqliteConnection(writableDir);
    writer.getDb();
    writer.close();

    const pdDir = path.join(writableDir, '.pd');
    expect(fs.existsSync(pdDir)).toBe(true);

    const readonlyConn = new SqliteConnection({ workspaceDir: writableDir, readonly: true });
    try {
      const db = readonlyConn.getDb();

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
      ).all();
      expect(tables.length).toBe(1);

      expect(() => {
        db.exec("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('x','y','z','a','b')");
      }).toThrow();
    } finally {
      readonlyConn.close();
    }
  });

  it('does not create .pd directory on a fresh path', () => {
    const freshPath = freshDir('readonly-fresh');
    const pdDir = path.join(freshPath, '.pd');

    expect(fs.existsSync(pdDir)).toBe(false);

    const readonlyConn = new SqliteConnection({ workspaceDir: freshPath, readonly: true });
    expect(() => readonlyConn.getDb()).toThrow();
    expect(fs.existsSync(pdDir)).toBe(false);
    readonlyConn.close();
  });
});

// -- 4. Pragma failure throws PDRuntimeError --

describe('PRI-140: pragma failure is loud', () => {
  it('throws PDRuntimeError when WAL pragma fails', () => {
    const dir = freshDir('pragma-fail');

    const origPragma = Database.prototype.pragma;

    Database.prototype.pragma = function (this: Database.Database, ...args: Parameters<Database.Database['pragma']>) {
      if (typeof args[0] === 'string' && args[0].includes('journal_mode')) {
        throw new Error('simulated pragma failure');
      }
      return origPragma.apply(this, args);
    };

    try {
      const conn = new SqliteConnection(dir);
      expect(() => conn.getDb()).toThrow(PDRuntimeError);
      conn.close();
    } finally {
      Database.prototype.pragma = origPragma;
    }
  });

  it('PDRuntimeError has storage_unavailable category', () => {
    const dir = freshDir('pragma-category');

    const origPragma = Database.prototype.pragma;
    Database.prototype.pragma = function (this: Database.Database, ...args: Parameters<Database.Database['pragma']>) {
      if (typeof args[0] === 'string' && args[0].includes('journal_mode')) {
        throw new Error('simulated pragma failure');
      }
      return origPragma.apply(this, args);
    };

    try {
      const conn = new SqliteConnection(dir);
      try {
        conn.getDb();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PDRuntimeError);
        expect((err as PDRuntimeError).category).toBe('storage_unavailable');
        expect((err as PDRuntimeError).message).toContain('pragma');
      }
      conn.close();
    } finally {
      Database.prototype.pragma = origPragma;
    }
  });
});

// -- 5. getPragmaReport() diagnostics --

describe('PRI-140: getPragmaReport()', () => {
  it('reports healthy for correctly configured writable connection', () => {
    const dir = freshDir('report-healthy');
    const conn = new SqliteConnection(dir);
    try {
      conn.getDb();
      const report = conn.getPragmaReport();

      expect(report.healthy).toBe(true);
      expect(report.issues).toHaveLength(0);
      expect(report.journalMode).toBe('wal');
      expect(report.busyTimeout).toBe(5000);
      expect(report.synchronous).toBe('1');
      expect(report.foreignKeys).toBe(true);
    } finally {
      conn.close();
    }
  });

  it('reports unhealthy when db is not opened', () => {
    const dir = freshDir('report-not-opened');
    const conn = new SqliteConnection(dir);
    try {
      const report = conn.getPragmaReport();
      expect(report.healthy).toBe(false);
      expect(report.issues).toContain('database not opened');
    } finally {
      conn.close();
    }
  });
});

function tryGetPragmaError(conn: SqliteConnection): PDRuntimeError | undefined {
  try {
    conn.getDb();
  } catch (err) {
    if (err instanceof PDRuntimeError) {
      return err;
    }
    return undefined;
  }
}

// -- 6. Verification readback failure (pragma SET succeeds but readback returns unexpected value) --

describe('PRI-140: verification readback failure', () => {
  it('throws PDRuntimeError when foreign_keys readback returns false after SET succeeded', () => {
    const dir = freshDir('fk-readback-fail');
    const origPragma = Database.prototype.pragma;

    Database.prototype.pragma = function (this: Database.Database, ...args: Parameters<Database.Database['pragma']>) {
      // Only intercept foreign_keys readback; let all other calls (including SET) pass through
      if (typeof args[0] === 'string' && args[0] === 'foreign_keys' && typeof args[1] === 'object' && args[1] !== null && (args[1]).simple === true) {
        return 0;
      }
      return origPragma.apply(this, args);
    };

    try {
      const conn = new SqliteConnection(dir);
      expect(() => conn.getDb()).toThrow(PDRuntimeError);
      const err = tryGetPragmaError(conn);
      expect(err?.message).toContain('Failed to enable foreign keys');
    } finally {
      Database.prototype.pragma = origPragma;
    }
  });

  it('throws PDRuntimeError when journal_mode readback returns non-WAL value after SET succeeded', () => {
    const dir = freshDir('wal-readback-fail');
    const origPragma = Database.prototype.pragma;

    Database.prototype.pragma = function (this: Database.Database, ...args: Parameters<Database.Database['pragma']>) {
      // Only intercept journal_mode readback; let all other calls pass through
      if (typeof args[0] === 'string' && args[0] === 'journal_mode' && typeof args[1] === 'object' && args[1] !== null && (args[1]).simple === true) {
        return 'memory';
      }
      return origPragma.apply(this, args);
    };

    try {
      const conn = new SqliteConnection(dir);
      expect(() => conn.getDb()).toThrow(PDRuntimeError);
      const err = tryGetPragmaError(conn);
      expect(err?.message).toContain('got: memory');
    } finally {
      Database.prototype.pragma = origPragma;
    }
  });
});

// -- 7. getDb() does not cache broken connection after pragma failure --

describe('PRI-140: getDb() leak protection', () => {
  it('second getDb() after pragma failure also throws (no cached broken db)', () => {
    const dir = freshDir('leak-protection');

    const origPragma = Database.prototype.pragma;
    Database.prototype.pragma = function (this: Database.Database, ...args: Parameters<Database.Database['pragma']>) {
      if (typeof args[0] === 'string' && args[0].includes('journal_mode')) {
        throw new Error('simulated pragma failure');
      }
      return origPragma.apply(this, args);
    };

    try {
      const conn = new SqliteConnection(dir);
      expect(() => conn.getDb()).toThrow(PDRuntimeError);
      // Second call should also throw, not return cached broken connection
      expect(() => conn.getDb()).toThrow(PDRuntimeError);
      conn.close();
    } finally {
      Database.prototype.pragma = origPragma;
    }
  });
});
