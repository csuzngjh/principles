/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 3 (P2): host attribution must
 * run through DEDUP and FACT UPGRADE, not just the reader. Real-storage
 * regressions against the production writers (recordVerifiedToolOutcomes +
 * the live PostToolUse handler), never hand-SQL-only assertions.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { recordVerifiedToolOutcomes } from '../src/production-pain-evidence.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-r3-dedup-'));
  mkdirSync(path.join(ws, '.state'), { recursive: true });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const CREATE = `CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT, project_dir TEXT, host_kind TEXT)`;

interface Row { id: number; session_id: string; tool_name: string; outcome: string; exit_code: number | null; tool_use_id: string | null; host_kind: string | null }

function rows(sessionId: string): Row[] {
  const db = new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, session_id, tool_name, outcome, exit_code, tool_use_id, host_kind FROM tool_calls WHERE session_id = ? ORDER BY id').all(sessionId) as Row[];
  } finally {
    db.close();
  }
}

function seedUnknownRow(sessionId: string, toolUseId: string, hostKind: string | null): void {
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at, tool_use_id, project_dir, host_kind) VALUES (?, 'Read', 'unknown', NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL, '2026-10-29T10:00:00.000Z', ?, NULL, ?)`).run(sessionId, toolUseId, hostKind);
  db.close();
}

describe('recordVerifiedToolOutcomes — host-scoped identity (review R3/P2)', () => {
  it('R3-red→green: a Codex final result must NOT upgrade or claim a WorkBuddy unknown row with the same session/call', () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(CREATE);
    db.close();
    seedUnknownRow('sess-collide', 'call-1', 'workbuddy');
    const results = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-collide', hostKind: 'codex', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 0, outputPreview: 'codex output' }] });
    expect(results[0]?.status).toBe('inserted');
    const all = rows('sess-collide');
    // Two independent records: the WorkBuddy unknown row is untouched, the
    // Codex fact lands as its OWN attributed row.
    expect(all).toHaveLength(2);
    const wb = all.find(row => row.host_kind === 'workbuddy');
    const codex = all.find(row => row.host_kind === 'codex');
    expect(wb).toMatchObject({ outcome: 'unknown', tool_use_id: 'call-1' });
    expect(codex).toMatchObject({ outcome: 'success', exit_code: 0, tool_use_id: 'call-1' });
  });

  it('R3: a legacy host_kind=NULL row with the same identity is never claimed — the attributed fact inserts separately', () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(CREATE);
    db.close();
    seedUnknownRow('sess-legacy', 'call-1', null);
    const results = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-legacy', hostKind: 'codex', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 1 }] });
    expect(results[0]?.status).toBe('inserted');
    const all = rows('sess-legacy');
    expect(all).toHaveLength(2);
    expect(all.find(row => row.host_kind === null)?.outcome).toBe('unknown');
    expect(all.find(row => row.host_kind === 'codex')?.outcome).toBe('failure');
  });

  it('same-host same-call upgrade still works and the final result is not overwritten by a later conflicting delivery', () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(CREATE);
    db.close();
    seedUnknownRow('sess-wb', 'call-1', 'workbuddy');
    const first = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-wb', hostKind: 'workbuddy', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 0 }] });
    expect(first[0]?.status).toBe('updated');
    const second = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-wb', hostKind: 'workbuddy', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 1 }] });
    expect(second[0]).toMatchObject({ status: 'skipped_final', reason: 'outcome_already_final' });
    const all = rows('sess-wb');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ outcome: 'success', exit_code: 0, host_kind: 'workbuddy' });
  });

  it('same-host same-call re-delivery of the SAME final outcome stays idempotent (no duplicate rows)', () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(CREATE);
    db.close();
    seedUnknownRow('sess-idem', 'call-1', 'codex');
    recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-idem', hostKind: 'codex', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 0 }] });
    const again = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-idem', hostKind: 'codex', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 0 }] });
    expect(again[0]).toMatchObject({ status: 'skipped_final' });
    expect(rows('sess-idem')).toHaveLength(1);
  });

  it('two hosts each delivering the same session/call once keep independent records (no swallowing)', () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(CREATE);
    db.close();
    const a = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-two', hostKind: 'workbuddy', outcomes: [{ toolUseId: 'call-9', toolName: 'Read', exitCode: 0 }] });
    const b = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-two', hostKind: 'codex', outcomes: [{ toolUseId: 'call-9', toolName: 'Read', exitCode: 2 }] });
    expect(a[0]?.status).toBe('inserted');
    expect(b[0]?.status).toBe('inserted');
    const all = rows('sess-two');
    expect(all).toHaveLength(2);
    expect(all.find(row => row.host_kind === 'workbuddy')).toMatchObject({ outcome: 'success' });
    expect(all.find(row => row.host_kind === 'codex')).toMatchObject({ outcome: 'failure', exit_code: 2 });
  });

  it('interleaved dual connections: alternating host writers do not lose each other\'s rows', () => {
    const dbA = new Database(path.join(ws, '.state', 'trajectory.db'));
    dbA.exec(CREATE);
    dbA.close();
    const connA = new Database(path.join(ws, '.state', 'trajectory.db'));
    const connB = new Database(path.join(ws, '.state', 'trajectory.db'));
    connA.pragma('busy_timeout = 5000');
    connB.pragma('busy_timeout = 5000');
    try {
      const insert = (conn: Database.Database, host: string, call: string) =>
        conn.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at, tool_use_id, project_dir, host_kind) VALUES (?, 'Read', 'unknown', NULL, NULL, NULL, NULL, NULL, NULL, '{}', NULL, ?, ?, NULL, ?)`)
          .run('sess-interleave', `2026-10-29T10:0${call}:00.000Z`, call, host);
      insert(connA, 'workbuddy', '1');
      insert(connB, 'codex', '2');
      insert(connA, 'workbuddy', '3');
      insert(connB, 'codex', '4');
    } finally {
      connA.close();
      connB.close();
    }
    const all = rows('sess-interleave');
    expect(all).toHaveLength(4);
    expect(all.filter(row => row.host_kind === 'workbuddy')).toHaveLength(2);
    expect(all.filter(row => row.host_kind === 'codex')).toHaveLength(2);
  });

  it('no-hostKind callers keep the historical match-any semantics (compat contract, explicit)', () => {
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec(CREATE);
    db.close();
    seedUnknownRow('sess-compat', 'call-1', 'codex');
    const results = recordVerifiedToolOutcomes({ workspaceDir: ws, sessionId: 'sess-compat', outcomes: [{ toolUseId: 'call-1', toolName: 'Read', exitCode: 0 }] });
    expect(results[0]?.status).toBe('updated');
    expect(rows('sess-compat')).toHaveLength(1);
  });
});
