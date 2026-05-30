import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SqliteConfirmFirstStateStore } from '../activation/sqlite-confirm-first-state-store.js';
import { SqliteConnection } from '../store/sqlite-connection.js';

describe('SqliteConfirmFirstStateStore', () => {
  let tmpDir = '';
  let connection: SqliteConnection = null as unknown as SqliteConnection;
  let store: SqliteConfirmFirstStateStore = null as unknown as SqliteConfirmFirstStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cf-test-'));
    connection = new SqliteConnection(tmpDir);
    store = new SqliteConfirmFirstStateStore(connection);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsertDirective insert: inserts a new directive and getState returns correct record', () => {
    store.upsertDirective('sess-1', true, 'principle-abc');

    const record = store.getState('sess-1');

    expect(record).not.toBeNull();
    if (record) {
      expect(record.sessionId).toBe('sess-1');
      expect(record.directiveActive).toBe(true);
      expect(record.directivePrincipleId).toBe('principle-abc');
      expect(record.directiveSetAt).toBeTruthy();
      expect(record.lastSeenAt).toBeTruthy();
      expect(record.approvalActive).toBe(false);
      expect(record.approvalSetAt).toBeNull();
    }
  });

  it('upsertDirective update: updates directive while preserving approval fields', () => {
    store.upsertDirective('sess-2', true, 'p-old');
    store.upsertApproval('sess-2');

    store.upsertDirective('sess-2', false, 'p-new');

    const record = store.getState('sess-2');
    expect(record).not.toBeNull();
    if (record) {
      expect(record.directiveActive).toBe(false);
      expect(record.directivePrincipleId).toBe('p-new');
      expect(record.approvalActive).toBe(true);
      expect(record.approvalSetAt).not.toBeNull();
    }
  });

  it('upsertApproval on existing row: sets approval fields on a row with prior directive', () => {
    store.upsertDirective('sess-3', true, 'p-1');

    store.upsertApproval('sess-3');

    const record = store.getState('sess-3');
    expect(record).not.toBeNull();
    if (record) {
      expect(record.directiveActive).toBe(true);
      expect(record.directivePrincipleId).toBe('p-1');
      expect(record.approvalActive).toBe(true);
      expect(record.approvalSetAt).not.toBeNull();
    }
  });

  it('upsertApproval on non-existent row: creates row with directive_active=0', () => {
    store.upsertApproval('sess-4');

    const db = connection.getDb();
    const row = db.prepare('SELECT session_id, directive_active, approval_active FROM confirm_first_state WHERE session_id = ?').get('sess-4') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    if (row) {
      expect(row.session_id).toBe('sess-4');
      expect(row.directive_active).toBe(0);
      expect(row.approval_active).toBe(1);
    }
  });

  it('getState returns null for missing session', () => {
    const result = store.getState('nonexistent');

    expect(result).toBeNull();
  });

  it('deleteState: removes a specific session record', () => {
    store.upsertDirective('sess-5', true, 'p-del');

    store.deleteState('sess-5');

    expect(store.getState('sess-5')).toBeNull();
  });

  it('deleteAllState: removes all session records', () => {
    store.upsertDirective('sess-a', true, 'p-a');
    store.upsertDirective('sess-b', true, 'p-b');
    store.upsertDirective('sess-c', true, 'p-c');

    store.deleteAllState();

    expect(store.getAllState()).toEqual([]);
  });

  it('pruneStaleRows with old rows: deletes rows older than 30 days', () => {
    const db = connection.getDb();
    const oldDate = '2020-01-01T00:00:00Z';
    db.prepare(
      `INSERT INTO confirm_first_state (session_id, directive_active, directive_set_at, last_seen_at) VALUES (?, 1, ?, ?)`
    ).run('old-sess-1', oldDate, oldDate);
    db.prepare(
      `INSERT INTO confirm_first_state (session_id, directive_active, directive_set_at, last_seen_at) VALUES (?, 1, ?, ?)`
    ).run('old-sess-2', oldDate, oldDate);

    store.upsertDirective('fresh-sess', true, 'p-fresh');

    const pruned = store.pruneStaleRows();

    expect(pruned).toBe(2);
    expect(store.getState('old-sess-1')).toBeNull();
    expect(store.getState('old-sess-2')).toBeNull();
    expect(store.getState('fresh-sess')).not.toBeNull();
  });

  it('pruneStaleRows with > 500 rows: evicts oldest rows keeping only 500', () => {
    const db = connection.getDb();
    for (let i = 0; i < 502; i++) {
      const id = `sess-${String(i).padStart(4, '0')}`;
      db.prepare(
        `INSERT INTO confirm_first_state (session_id, directive_active, directive_set_at, last_seen_at) VALUES (?, 1, ?, ?)`
      ).run(id, '2026-05-30T00:00:00Z', '2026-05-30T00:00:00Z');
    }

    const pruned = store.pruneStaleRows();

    expect(pruned).toBe(2);
    const all = store.getAllState();
    expect(all).toHaveLength(500);
    expect(store.getState('sess-0000')).toBeNull();
    expect(store.getState('sess-0001')).toBeNull();
    expect(store.getState('sess-0002')).not.toBeNull();
  });

  it('concurrent upsertApproval: calling upsertApproval twice for same session yields single coherent row', () => {
    store.upsertApproval('sess-dup');
    store.upsertApproval('sess-dup');

    const db = connection.getDb();
    const rows = db.prepare('SELECT session_id, approval_active, approval_set_at FROM confirm_first_state WHERE session_id = ?').all('sess-dup') as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const [firstRow] = rows;
    if (firstRow) {
      expect(firstRow.session_id).toBe('sess-dup');
      expect(firstRow.approval_active).toBe(1);
      expect(firstRow.approval_set_at).toBeTruthy();
    }
  });

  it('fresh workspace: getState returns null without error on a new connection', () => {
    const freshTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cf-fresh-'));
    try {
      const freshConn = new SqliteConnection(freshTmpDir);
      const freshStore = new SqliteConfirmFirstStateStore(freshConn);

      const result = freshStore.getState('no-such-session');

      expect(result).toBeNull();
      freshConn.close();
    } finally {
      fs.rmSync(freshTmpDir, { recursive: true, force: true });
    }
  });

  it('getAllState: returns all inserted records', () => {
    store.upsertDirective('sess-g1', true, 'p-g1');
    store.upsertDirective('sess-g2', false, 'p-g2');
    store.upsertDirective('sess-g3', true, 'p-g3');

    const all = store.getAllState();

    expect(all).toHaveLength(3);
    const ids = all.map(r => r.sessionId).sort();
    expect(ids).toEqual(['sess-g1', 'sess-g2', 'sess-g3']);
  });
});
