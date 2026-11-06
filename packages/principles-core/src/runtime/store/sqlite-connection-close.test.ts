/**
 * SqliteConnection close() regression tests.
 *
 * Verifies that close() is safe to call even when:
 * 1. getDb() was never called
 * 2. getDb() failed (threw before this.db was set)
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from './sqlite-connection.js';

describe('SqliteConnection.close', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-sqlite-conn-test-${process.pid}-${Date.now()}`);

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  it('close() is safe when getDb() was never called', () => {
    const testDir = path.join(tmpDir, 'never-opened');
    fs.mkdirSync(testDir, { recursive: true });
    const conn = new SqliteConnection(testDir);
    expect(() => conn.close()).not.toThrow();
  });

  it('close() is safe when connection initialization failed', () => {
    const testDir = path.join(tmpDir, 'init-fail');
    fs.mkdirSync(testDir, { recursive: true });
    const conn = new SqliteConnection(testDir);
    expect(() => conn.close()).not.toThrow();
  });

  it('close() is safe on fresh connection with no db file', () => {
    const testDir = path.join(tmpDir, 'no-db-file');
    fs.mkdirSync(testDir, { recursive: true });
    const conn = new SqliteConnection(testDir);
    expect(() => conn.close()).not.toThrow();
  });

  it('close() works normally after successful getDb()', () => {
    const testDir = path.join(tmpDir, 'normal-close');
    fs.mkdirSync(testDir, { recursive: true });
    const conn = new SqliteConnection(testDir);
    conn.getDb();
    expect(() => conn.close()).not.toThrow();
  });

  it('close() can be called multiple times safely', () => {
    const testDir = path.join(tmpDir, 'double-close');
    fs.mkdirSync(testDir, { recursive: true });
    const conn = new SqliteConnection(testDir);
    conn.getDb();
    conn.close();
    expect(() => conn.close()).not.toThrow();
  });
});
