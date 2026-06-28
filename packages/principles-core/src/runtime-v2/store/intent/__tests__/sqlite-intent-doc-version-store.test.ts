/**
 * SqliteIntentDocVersionStore tests (SPEC bilingual+lifecycle).
 *
 * Verifies saveVersion, listVersions (DESC order, lang isolation),
 * getVersion (null for unknown), getLatest, and rc-2 type-guard mapRow.
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: DB rows treated as unknown, mapped via guards
 * - EP-03 / ERR-002: write failures throw (fail loud)
 * - rc-2: no `as` bypass — all row fields validated element-wise
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SqliteConnection } from '../../sqlite-connection.js';
import { SqliteIntentDocVersionStore } from '../sqlite-intent-doc-version-store.js';
import { computeIntentContentHash } from '../../../intent/intent-doc.js';

function createTestConnection(): SqliteConnection {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-intent-doc-version-'));
  return new SqliteConnection(tmpDir);
}

describe('SqliteIntentDocVersionStore', () => {
  let connection = null as unknown as SqliteConnection;
  let store = null as unknown as SqliteIntentDocVersionStore;

  beforeEach(() => {
    connection = createTestConnection();
    connection.getDb();
    store = new SqliteIntentDocVersionStore(connection);
  });

  afterEach(() => {
    connection?.close();
  });

  it('saveVersion inserts a record and returns it', async () => {
    const content = '## 1. Why\ntest';
    const version = await store.saveVersion({ lang: 'zh-CN', content });
    expect(version.id).toBeTruthy();
    expect(version.contentHash).toBe(computeIntentContentHash(content));
    expect(version.contentSnapshot).toBe(content);
    expect(version.lang).toBe('zh-CN');
  });

  it('saveVersion stores optional reason', async () => {
    const version = await store.saveVersion({ lang: 'en', content: 'x', reason: 'first edit' });
    expect(version.reason).toBe('first edit');
  });

  it('saveVersion stores null reason when not provided', async () => {
    const version = await store.saveVersion({ lang: 'en', content: 'x' });
    expect(version.reason).toBeNull();
  });

  it('listVersions returns versions in DESC order by createdAt', async () => {
    await store.saveVersion({ lang: 'zh-CN', content: 'v1', reason: 'first' });
    await store.saveVersion({ lang: 'zh-CN', content: 'v2', reason: 'second' });
    const versions = await store.listVersions('zh-CN');
    expect(versions).toHaveLength(2);
    expect(versions[0]?.reason).toBe('second');
    expect(versions[1]?.reason).toBe('first');
  });

  it('listVersions isolates by lang', async () => {
    await store.saveVersion({ lang: 'zh-CN', content: 'zh' });
    await store.saveVersion({ lang: 'en', content: 'en' });
    expect(await store.listVersions('zh-CN')).toHaveLength(1);
    expect(await store.listVersions('en')).toHaveLength(1);
  });

  it('getVersion returns null for unknown id', async () => {
    expect(await store.getVersion('nonexistent')).toBeNull();
  });

  it('getLatest returns null on empty', async () => {
    expect(await store.getLatest('zh-CN')).toBeNull();
  });

  it('getLatest returns most recent version', async () => {
    await store.saveVersion({ lang: 'zh-CN', content: 'old' });
    await store.saveVersion({ lang: 'zh-CN', content: 'new' });
    const latest = await store.getLatest('zh-CN');
    expect(latest?.contentSnapshot).toBe('new');
  });

  it('mapRow returns null for malformed row (rc-2 compliance)', async () => {
    const db = connection.getDb();
    db.exec(`INSERT INTO intent_doc_versions (id, lang, content_hash, content_snapshot, created_at) VALUES ('bad', 'not-a-lang', 'hash', 'snap', '2026-01-01')`);
    const result = await store.getVersion('bad');
    expect(result).toBeNull();
  });
});
