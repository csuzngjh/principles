/**
 * Tests for acquireTrajectoryEvidenceFromDb — PRI-341 extraction behavior,
 * PRI-642 typed classification (the legacy array wrapper was removed with
 * its last production consumer).
 *
 * Uses real temporary SQLite DBs (trajectory.db) to validate evidence extraction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MAX_EVIDENCE_ENTRIES } from '@principles/core/runtime-v2';
import { acquireCodexToolFailureEvidenceFromDb, acquireTrajectoryEvidenceFromDb } from '../../src/commands/build-trajectory-evidence.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let stateDir: string;

function createStateDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trajectory-test-'));
  stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function createTrajectoryDb(): Database.Database {
  const dbPath = path.join(stateDir, 'trajectory.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT,
      updated_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      run_id TEXT,
      provider TEXT,
      model TEXT,
      raw_text TEXT,
      sanitized_text TEXT,
      blob_ref TEXT,
      stop_reason TEXT,
      thinking_blocks_count INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL DEFAULT 0,
      raw_excerpt TEXT,
      correction_detected INTEGER NOT NULL DEFAULT 0,
      correction_cue TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER,
      exit_code INTEGER,
      error_type TEXT,
      error_message TEXT,
      gfi_before REAL,
      gfi_after REAL,
      params_json TEXT NOT NULL DEFAULT '{}',
      result_preview TEXT,
      created_at TEXT NOT NULL
    )
  `);

  return db;
}

function insertAssistantTurn(
  db: Database.Database,
  sessionId: string,
  sanitizedText: string,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO assistant_turns (session_id, sanitized_text, created_at)
    VALUES (?, ?, ?)
  `).run(sessionId, sanitizedText, createdAt);
}

function insertUserTurn(
  db: Database.Database,
  sessionId: string,
  rawExcerpt: string,
  correctionDetected: boolean,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO user_turns (session_id, turn_index, raw_excerpt, correction_detected, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, 0, rawExcerpt, correctionDetected ? 1 : 0, createdAt);
}

function insertToolCall(
  db: Database.Database,
  sessionId: string,
  toolName: string,
  outcome: string,
  errorType: string | null,
  exitCode: number | null,
  createdAt: string,
  resultPreview?: string | null,
): void {
  db.prepare(`
    INSERT INTO tool_calls (session_id, tool_name, outcome, error_type, exit_code, duration_ms, params_json, result_preview, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, toolName, outcome, errorType, exitCode, 100, '{}', resultPreview ?? null, createdAt);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('acquireTrajectoryEvidenceFromDb — behavior via typed API (PRI-341 extraction, PRI-642 wrapper removal)', () => {
  beforeEach(() => {
    createStateDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /** Available-class entries, or the unavailable reason for assertions. */
  function acquire(sessionId: string | undefined) {
    return acquireTrajectoryEvidenceFromDb(stateDir, sessionId, tmpDir);
  }

  function entriesOf(sessionId: string) {
    const result = acquire(sessionId);
    expect(result.status).toBe('available');
    return result.status === 'available' ? result.entries : [];
  }

  function insertSession(db: Database.Database, sessionId: string): void {
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run(sessionId, '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
  }

  it('returns available entries (≤ MAX_EVIDENCE_ENTRIES) from assistant turns', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    insertAssistantTurn(db, '123', 'First assistant response about backups', '2026-01-01T10:00:00Z');
    insertAssistantTurn(db, '123', 'Second response about validation', '2026-01-01T10:01:00Z');
    insertAssistantTurn(db, '123', 'Third response about error handling', '2026-01-01T10:02:00Z');
    db.close();

    const entries = entriesOf('123');

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(MAX_EVIDENCE_ENTRIES);
    for (const entry of entries) {
      expect(entry.sourceRef).toBeTruthy();
      expect(entry.note).toBeTruthy();
    }
  });

  it('classifies an undefined session as session_not_found (no placeholder entries)', () => {
    const db = createTrajectoryDb();
    db.close();
    const result = acquire(undefined);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('session_not_found');
  });

  it('surfaces user correction turns with correctionDetected=true', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    insertUserTurn(db, '123', 'Please fix the backup logic', true, '2026-01-01T09:59:00Z');
    insertAssistantTurn(db, '123', 'I will fix the backup logic', '2026-01-01T10:00:00Z');
    db.close();

    const entries = entriesOf('123');

    const ownerEntry = entries.find(e => e.sourceRef.startsWith('owner_message:'));
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry!.note).toContain('fix the backup logic');
  });

  it('extracts failed tool_calls as evidence entries (PRI-358)', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    insertToolCall(db, '123', 'bash', 'failure', 'non_zero_exit', 1, '2026-01-01T10:00:00Z');
    insertToolCall(db, '123', 'write_file', 'success', null, 0, '2026-01-01T10:01:00Z');
    insertToolCall(db, '123', 'bash', 'failure', 'timeout', 124, '2026-01-01T10:02:00Z');
    db.close();

    const entries = entriesOf('123');

    const failureEntries = entries.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
    expect(failureEntries.length).toBe(2);
    expect(failureEntries[0].note).toContain('bash');
    expect(failureEntries[0].note).toContain('non_zero_exit');
    expect(failureEntries[1].note).toContain('timeout');
  });

  it('limits failed tool_calls to 3 entries', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    insertToolCall(db, '123', 'bash', 'failure', 'err1', 1, '2026-01-01T10:00:00Z');
    insertToolCall(db, '123', 'bash', 'failure', 'err2', 2, '2026-01-01T10:01:00Z');
    insertToolCall(db, '123', 'bash', 'failure', 'err3', 3, '2026-01-01T10:02:00Z');
    insertToolCall(db, '123', 'bash', 'failure', 'err4', 4, '2026-01-01T10:03:00Z');
    db.close();

    const entries = entriesOf('123');

    const failureEntries = entries.filter(e => e.sourceRef.startsWith('tool_call_failure:'));
    expect(failureEntries.length).toBe(3);
  });

  it('handles a missing tool_calls table gracefully (classified unavailable, no throw)', () => {
    const dbPath = path.join(stateDir, 'trajectory.db');
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_at TEXT, updated_at TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS assistant_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, sanitized_text TEXT, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS user_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL DEFAULT 0, raw_excerpt TEXT, correction_detected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)");
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)').run('123', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
    db.close();

    const result = acquire('123');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(['empty_trajectory', 'evidence_read_failed']).toContain(result.reasonCode);
  });

  it('includes resultPreview in tool failure evidence note', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    insertToolCall(db, '123', 'bash', 'failure', 'ENOENT', 1, '2026-01-01T10:00:00Z', 'Error: no such file or directory');
    db.close();

    const entries = entriesOf('123');

    const failureEntry = entries.find(e => e.sourceRef.startsWith('tool_call_failure:'));
    expect(failureEntry).toBeDefined();
    expect(failureEntry!.note).toContain('ENOENT');
    expect(failureEntry!.note).toContain('Error: no such file or directory');
  });

  it('includes truncation warning when stop_reason is length', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    db.prepare("INSERT INTO assistant_turns (session_id, sanitized_text, stop_reason, created_at) VALUES (?, ?, ?, ?)")
      .run('123', 'Partial output truncated...', 'length', '2026-01-01T10:00:00Z');
    db.close();

    const entries = entriesOf('123');

    const agentEntry = entries.find(e => e.sourceRef.startsWith('agent_turn:'));
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.note).toContain('Partial output truncated...');
    expect(agentEntry!.note).toContain('[TRUNCATED: output cut off by length limit]');
  });

  it('does not include truncation warning when stop_reason is end_turn', () => {
    const db = createTrajectoryDb();
    insertSession(db, '123');
    db.prepare("INSERT INTO assistant_turns (session_id, sanitized_text, stop_reason, created_at) VALUES (?, ?, ?, ?)")
      .run('123', 'Complete output', 'end_turn', '2026-01-01T10:00:00Z');
    db.close();

    const entries = entriesOf('123');

    const agentEntry = entries.find(e => e.sourceRef.startsWith('agent_turn:'));
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.note).toBe('Complete output');
    expect(agentEntry!.note).not.toContain('[TRUNCATED');
  });
});

// ── PRI-642 Scope A — typed acquisition from trajectory.db (SPEC §7.3) ───────

describe('acquireTrajectoryEvidenceFromDb — typed CLI acquisition (PRI-642 Scope A)', () => {
  beforeEach(() => {
    createStateDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns available with entries for a session that has turns', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    // Turn writers upsert the sessions row — mirror the real DB shape.
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run('real-session', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
    insertUserTurn(db, 'real-session', 'Owner correction', true, '2026-01-01T09:59:00Z');
    insertAssistantTurn(db, 'real-session', 'assistant text', '2026-01-01T10:00:00Z');
    db.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'real-session', tmpDir);

    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.some(e => e.sourceRef.startsWith('owner_message:'))).toBe(true);
    expect(result.entries.some(e => e.sourceRef.startsWith('agent_turn:'))).toBe(true);
  });

  it('returns unavailable/session_not_found for a session absent from the sessions table (SPEC 12.1.4)', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    insertAssistantTurn(db, 'other-session', 'unrelated', '2026-01-01T10:00:00Z');
    db.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'no-such-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('session_not_found');
  });

  it('returns unavailable/session_not_found for the "cli" and "unknown" sentinels', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    db.close();

    const cliResult = acquireTrajectoryEvidenceFromDb(stateDir, 'cli', tmpDir);
    const unknownResult = acquireTrajectoryEvidenceFromDb(stateDir, 'unknown', tmpDir);

    expect(cliResult.status).toBe('unavailable');
    expect(unknownResult.status).toBe('unavailable');
    if (cliResult.status !== 'unavailable' || unknownResult.status !== 'unavailable') return;
    expect(cliResult.reasonCode).toBe('session_not_found');
    expect(unknownResult.reasonCode).toBe('session_not_found');
  });

  it('returns unavailable/trajectory_unavailable when trajectory.db is missing', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'some-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('trajectory_unavailable');
  });

  it('returns unavailable/empty_trajectory when the session exists but has no turns or tool calls', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    db.prepare(`
      INSERT INTO sessions (session_id, started_at, updated_at)
      VALUES (?, ?, ?)
    `).run('quiet-session', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
    db.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'quiet-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('empty_trajectory');
  });

  it('returns a different reasonCode for unreadable DB vs empty trajectory (exec-prompt item 5)', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    db.close();
    // Corrupt the DB file after close so the read-only open fails.
    const dbPath = path.join(stateDir, 'trajectory.db');
    fs.writeFileSync(dbPath, Buffer.from('this is not a sqlite database at all'));

    const unreadable = acquireTrajectoryEvidenceFromDb(stateDir, 'some-session', tmpDir);

    const stateDir2 = createStateDir();
    const db2 = createTrajectoryDb();
    db2.close();

    expect(unreadable.status).toBe('unavailable');
    if (unreadable.status !== 'unavailable') return;
    // Unreadable DB must not share a reasonCode with a real-but-empty session.
    expect(unreadable.reasonCode).not.toBe('empty_trajectory');
    expect(unreadable.reasonCode).toBe('evidence_read_failed');
  });
});

// ── PRI-783 review P1: the binding fact gates degrade vs refuse ─────────────
// 'verified' = the sessions table was queried and DID contain the id;
// 'unverified' = DB missing / unopenable / id absent / sessions table
// unreadable. Only verified bindings may degrade to a bound submission.

describe('acquisition binding fact (PRI-783 review P1)', () => {
  beforeEach(() => {
    createStateDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('session present with zero evidence → empty_trajectory, binding verified (degrade precondition)', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run('quiet-session', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
    insertUserTurn(db, 'quiet-session', 'ordinary message', false, '2026-01-01T09:01:00Z');
    db.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'quiet-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('empty_trajectory');
    expect(result.binding).toBe('verified');
  });

  it('id absent from sessions table → session_not_found, binding unverified', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    db.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'no-such-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('session_not_found');
    expect(result.binding).toBe('unverified');
  });

  it('missing trajectory.db → trajectory_unavailable, binding unverified', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'some-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('trajectory_unavailable');
    expect(result.binding).toBe('unverified');
  });

  it('corrupt DB (open fails) → evidence_read_failed, binding unverified', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const dbPath = path.join(stateDir, 'trajectory.db');
    fs.writeFileSync(dbPath, Buffer.from('this is not a sqlite database at all'));

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'some-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('evidence_read_failed');
    expect(result.binding).toBe('unverified');
  });

  it('session verified but evidence tables unreadable → evidence_read_failed, binding verified', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = createTrajectoryDb();
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run('readable-session', '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z');
    db.close();
    // Drop the evidence tables after the session row exists: the sessions
    // check passed, the evidence read cannot.
    const raw = new Database(path.join(stateDir, 'trajectory.db'));
    raw.exec('DROP TABLE user_turns');
    raw.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'readable-session', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('evidence_read_failed');
    expect(result.binding).toBe('verified');
  });

  it('sessions table missing entirely → nothing is verified (unverified even when the reason is evidence_read_failed)', async () => {
    const { acquireTrajectoryEvidenceFromDb } = await import('../../src/commands/build-trajectory-evidence.js');
    const db = new Database(path.join(stateDir, 'trajectory.db'));
    db.exec('CREATE TABLE user_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, raw_excerpt TEXT, correction_detected INTEGER NOT NULL DEFAULT 0, correction_cue TEXT, created_at TEXT NOT NULL)');
    db.close();

    const result = acquireTrajectoryEvidenceFromDb(stateDir, 'never-seen', tmpDir);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    // assistant_turns/tool_calls tables missing → readFailed → evidence_read_failed
    expect(result.reasonCode).toBe('evidence_read_failed');
    expect(result.binding).toBe('unverified');
  });
});

// ── PRI-941 Option A — acquireCodexToolFailureEvidenceFromDb ───────────────

describe('acquireCodexToolFailureEvidenceFromDb (PRI-941 Option A)', () => {
  it('T1: failure rows → available with tool_call_failure entries (only failures consumed)', () => {
    createStateDir();
    const db = createTrajectoryDb();
    try {
      // success rows and conversation rows must NOT be consumed
      insertToolCall(db, 'sess-a', 'bash', 'success', null, 0, '2026-10-06T00:00:01Z');
      insertUserTurn(db, 'sess-a', 'please fix this', true, '2026-10-06T00:00:02Z');
      insertAssistantTurn(db, 'sess-a', 'assistant reply', '2026-10-06T00:00:03Z');
      insertToolCall(db, 'sess-a', 'write_file', 'failure', 'EACCES', 1, '2026-10-06T00:00:04Z', 'permission denied');
      insertToolCall(db, 'sess-a', 'bash', 'failure', 'ENOENT', 2, '2026-10-06T00:00:05Z');

      const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'sess-a');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      expect(result.entries.length).toBe(2);
      expect(result.entries[0]!.sourceRef).toContain('tool_call_failure:');
      expect(result.entries[0]!.note).toContain('Tool write_file failed: EACCES');
      expect(result.entries[0]!.note).toContain('permission denied');
      expect(result.entries[1]!.note).toContain('Tool bash failed: ENOENT');
      // boundary proof: no conversation-table content in the evidence
      expect(JSON.stringify(result.entries)).not.toContain('please fix this');
      expect(JSON.stringify(result.entries)).not.toContain('assistant reply');
    } finally {
      db.close();
    }
  });

  it('review (Codex P2 / Owner): a token straddling the legacy preview-slice(200) boundary is redacted BEFORE truncation', () => {
    createStateDir();
    const db = createTrajectoryDb();
    try {
      // The token STARTS at preview char ~191 and runs past char 200 — under
      // the old order (preview.slice(0,200) BEFORE sanitize) it was cut to a
      // 9-char fragment that no longer matches the sk-{20,} token pattern and
      // escaped redaction. The unsliced composition lets the sanitizer see
      // and redact the FULL token, then apply its own output bound.
      const padding = 'x'.repeat(160);
      const prefix = 'curl -H "Authorization: Bearer ';
      const secretToken = 'sk-TEST1234567890abcdefGHIJKLMNOPQRSTUVWXYZ123456';
      insertToolCall(
        db, 'sess-tok', 'bash', 'failure', 'EACCES', 1, '2026-10-06T00:00:06Z',
        `${padding}${prefix}${secretToken} https://api.example.com`,
      );
      expect((`${padding}${prefix}`).length).toBeLessThan(200);
      expect((`${padding}${prefix}${secretToken}`).length).toBeGreaterThan(200);

      const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'sess-tok');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      const note = result.entries[0]!.note;
      expect(note).not.toContain(secretToken);
      expect(note).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
      // The token was REDACTED (not silently dropped) and the sanitizer owns
      // the output bound.
      expect(note).toContain('___REDACTED___');
      expect(note.length).toBeLessThanOrEqual(215); // 200 + ___TRUNCATED___ marker
    } finally {
      db.close();
    }
  });

  it('T2a: zero failure rows → unavailable empty_trajectory (codex_tool_calls_empty)', () => {
    createStateDir();
    const db = createTrajectoryDb();
    try {
      insertToolCall(db, 'sess-b', 'bash', 'success', null, 0, '2026-10-06T00:00:01Z');
      const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'sess-b');
      expect(result).toEqual({
        status: 'unavailable',
        reasonCode: 'empty_trajectory',
        detail: 'codex_tool_calls_empty',
        binding: 'unverified',
      });
    } finally {
      db.close();
    }
  });

  it('review F2: unreadable tool_calls table → evidence_read_failed (not misreported as empty)', () => {
    createStateDir();
    const db = createTrajectoryDb();
    try {
      insertToolCall(db, 'sess-e', 'bash', 'failure', 'EACCES', 1, '2026-10-06T00:00:01Z');
      db.exec('DROP TABLE tool_calls');
      const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'sess-e');
      expect(result).toEqual({
        status: 'unavailable',
        reasonCode: 'evidence_read_failed',
        detail: 'codex_tool_calls_unreadable',
        binding: 'unverified',
      });
    } finally {
      db.close();
    }
  });

  it('T2b: trajectory.db missing → trajectory_unavailable', () => {
    createStateDir();
    const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'sess-c');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('trajectory_unavailable');
  });

  it('boundary: conversation rows present but zero failures still → empty_trajectory (conversation tables not a fallback)', () => {
    createStateDir();
    const db = createTrajectoryDb();
    try {
      insertUserTurn(db, 'sess-d', 'user correction text', true, '2026-10-06T00:00:01Z');
      insertAssistantTurn(db, 'sess-d', 'assistant text', '2026-10-06T00:00:02Z');
      const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'sess-d');
      expect(result.status).toBe('unavailable');
      if (result.status !== 'unavailable') return;
      expect(result.reasonCode).toBe('empty_trajectory');
    } finally {
      db.close();
    }
  });

  it('sentinel session id → session_not_found', () => {
    createStateDir();
    const result = acquireCodexToolFailureEvidenceFromDb(stateDir, 'cli');
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasonCode).toBe('session_not_found');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
