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
    expect(conn.getSchemaVersion()).toBe('003');
  });

  it('adds nullable approval artifact binding through the existing additive migration', () => {
    const conn = makeConnection();
    const db = conn.getDb();
    const columns = db.prepare('PRAGMA table_info(approvals)').all() as { name: string; notnull: number }[];
    expect(columns.find((column) => column.name === 'artifact_digest')?.notnull).toBe(0);
    expect(conn.getSchemaVersion()).toBe('003');
  });

  it('repairs a pre-binding approvals table on reopen without rewriting old approval data', () => {
    const dir = path.join(os.tmpdir(), `pd-schema-approval-binding-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const first = new SqliteConnection(dir);
    const firstDb = first.getDb();
    firstDb.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-1', 'diagnosis', 'pending', 't', 't')").run();
    firstDb.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-1', 'principle', 'task-1', '[]', 'pending', '{}', 't', 't')").run();
    firstDb.prepare("INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at) VALUES ('approval-1', 'artifact-1', 'code_tool_hook', 'high', 'approved', 't')").run();
    firstDb.exec('ALTER TABLE approvals DROP COLUMN artifact_digest');
    first.close();

    const reopened = new SqliteConnection(dir);
    const reopenedDb = reopened.getDb();
    const columns = reopenedDb.prepare('PRAGMA table_info(approvals)').all() as { name: string }[];
    const row: unknown = reopenedDb.prepare('SELECT status, artifact_digest FROM approvals WHERE approval_id = ?').get('approval-1');
    expect(columns.some((column) => column.name === 'artifact_digest')).toBe(true);
    expect(row).toEqual({ status: 'approved', artifact_digest: null });
    reopened.close();
  });

  it('tracks version increments', () => {
    const conn = makeConnection();
    conn.getDb();
    expect(conn.getSchemaVersion()).toBe('003');
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
    expect(rows.length).toBe(4);
    expect(rows[0]?.version).toBe('000');
    expect(rows[1]?.version).toBe('001');
    expect(rows[2]?.version).toBe('002');
    expect(rows[3]?.version).toBe('003');
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
    expect(conn.getSchemaVersion()).toBe('003');
  });

  it('F12: does not duplicate "001" row on re-init', () => {
    const dir = path.join(os.tmpdir(), `pd-schema-version-f12-nodup-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const conn1 = new SqliteConnection(dir);
    conn1.getDb();
    expect(conn1.getSchemaVersion()).toBe('003');
    conn1.close();

    // Re-open: migrateSchema runs again, but should NOT insert another '001'
    const conn2 = new SqliteConnection(dir);
    conn2.getDb();
    const rows = conn2.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: string }[];
    conn2.close();

    expect(rows.length).toBe(4);
    expect(rows[0]?.version).toBe('000');
    expect(rows[1]?.version).toBe('001');
    expect(rows[2]?.version).toBe('002');
    expect(rows[3]?.version).toBe('003');
  });

  it('rebuilds a pre-003 activation_decisions table and preserves its rows', () => {
    const dir = path.join(os.tmpdir(), `pd-schema-auth-method-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);

    const first = new SqliteConnection(dir);
    const db = first.getDb();
    db.prepare(`INSERT INTO activation_decisions (
      decision_id, idempotency_key, subject_kind, activation_id, artifact_id, artifact_digest,
      decision, principal_kind, owner_id, policy_version, break_glass_reason,
      authentication_method, credential_id, operator_kind, operator_id, reason_code, note,
      evidence_snapshot_id, readiness_evaluation_id, evidence_snapshot_digest, decided_at
    ) VALUES ('d-legacy', 'd-legacy', 'activation', 'act-1', 'art-1', 'sha256:art-1',
      'continue_observing', 'break_glass', NULL, NULL, 'local_no_auth_emergency',
      'local_break_glass', NULL, NULL, NULL, 'legacy', NULL, NULL, NULL, NULL, 't')`).run();

    // Recreate the pre-003 CHECK shape under the original table name (a real
    // pre-003 database still owns `activation_decisions`), then forget the
    // 003 marker so the next open must rebuild it.
    const currentSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activation_decisions'").get() as { sql: string }).sql;
    const legacySql = currentSql.replace(/, 'local_owner_session'/g, '');
    db.exec('DROP TRIGGER IF EXISTS activation_decisions_no_update');
    db.exec('DROP TRIGGER IF EXISTS activation_decisions_no_delete');
    db.exec('DROP TABLE activation_decisions');
    db.exec(legacySql);
    db.exec(`INSERT INTO activation_decisions SELECT * FROM (
      SELECT 'd-legacy' AS decision_id, 'd-legacy' AS idempotency_key, 'activation' AS subject_kind,
             'act-1' AS activation_id, 'art-1' AS artifact_id, 'sha256:art-1' AS artifact_digest,
             'continue_observing' AS decision, 'break_glass' AS principal_kind, NULL AS owner_id,
             NULL AS policy_version, 'local_no_auth_emergency' AS break_glass_reason,
             'local_break_glass' AS authentication_method, NULL AS credential_id, NULL AS operator_kind,
             NULL AS operator_id, 'legacy' AS reason_code, NULL AS note, NULL AS evidence_snapshot_id,
             NULL AS readiness_evaluation_id, NULL AS evidence_snapshot_digest, 't' AS decided_at)`);
    db.prepare("DELETE FROM schema_version WHERE version = '003'").run();
    first.close();

    const reopened = new SqliteConnection(dir);
    const reopenedDb = reopened.getDb();
    const tableSql = (reopenedDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activation_decisions'").get() as { sql: string }).sql;
    expect(tableSql).toContain("'local_owner_session'");
    expect(reopenedDb.prepare("SELECT decision_id FROM activation_decisions WHERE decision_id = 'd-legacy'").get()).toEqual({ decision_id: 'd-legacy' });
    expect(reopenedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activation_decisions_pre_003'").get()).toBeUndefined();
    expect(reopened.getSchemaVersion()).toBe('003');
    reopened.close();
  });
});
