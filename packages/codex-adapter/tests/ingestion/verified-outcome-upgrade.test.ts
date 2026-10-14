/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-01 — transcript verified-outcome upgrade
 * wiring (production orchestrator level).
 *
 * Proves the Stop ingestion path upgrades/inserts tool_calls rows with the
 * host-verified exit codes (the only authorized source of real exit codes on
 * Codex), including the exec→Bash host-name mapping, and that a pre-existing
 * unknown live row is upgraded rather than duplicated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestCodexConversation, setCodexTranscriptPortForTest } from '@principles/codex-adapter';

const FIXTURES = new URL('../fixtures/g1-contract/', import.meta.url);
const ROLLOUT_UUID = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TOOL_USE_ID = 'exec-db1bff81-f42e-45f8-91ce-e87480fa15d9';

let workspaceDir: string;
let codexHome: string;
let transcriptPath: string;

/** Fixture variant of the G1 final-turn transcript with a FAILED command (exit_code 1). */
function failingTranscript(): string {
  const source = fs.readFileSync(fs.realpathSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES)), 'utf8');
  return source
    .replace('"status":"completed"', '"status":"failed"')
    .replace(/"exit_code":\s*0/, '"exit_code": 1')
    .replace('"exit_code":0', '"exit_code":1');
}

function stopPayload(): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: '01a048ae-b344-7eb2-804b-a2fa34302fb3',
    transcript_path: transcriptPath,
    cwd: 'D:\\ws\\probe',
    hook_event_name: 'Stop',
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    stop_hook_active: false,
  };
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-verified-upgrade-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-verified-home-'));
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROLLOUT_UUID}.jsonl`);
});

afterEach(() => {
  setCodexTranscriptPortForTest(null);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});

function toolCallsRows(): Array<Record<string, unknown>> {
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
  try {
    return db.prepare('SELECT tool_name, outcome, exit_code, tool_use_id FROM tool_calls ORDER BY id').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe('CR-01 transcript verified-outcome upgrade (production orchestrator)', () => {
  it('inserts a verified success row for the fixture command (exit 0) with the Bash host name', () => {
    fs.copyFileSync(fs.realpathSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES)), transcriptPath);
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('ok');
    const rows = toolCallsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ tool_name: 'Bash', outcome: 'success', exit_code: 0, tool_use_id: TOOL_USE_ID });
  });

  it('inserts a verified failure row (exit 1) for a failed fixture command', () => {
    fs.writeFileSync(transcriptPath, failingTranscript());
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('ok');
    const rows = toolCallsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ tool_name: 'Bash', outcome: 'failure', exit_code: 1, tool_use_id: TOOL_USE_ID });
  });

  it('upgrades a pre-existing unknown live row instead of duplicating it', () => {
    // Live PostToolUse observation of the same call: text-only → unknown.
    const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
    db.exec('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT)');
    db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, exit_code, params_json, result_preview, created_at, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ROOT_SESSION, 'Bash', 'unknown', null, '{"invocation":"probe"}', 'probe raw text', new Date().toISOString(), TOOL_USE_ID);
    db.close();

    fs.writeFileSync(transcriptPath, failingTranscript());
    const result = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(result.status).toBe('ok');
    const rows = toolCallsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ tool_name: 'Bash', outcome: 'failure', exit_code: 1, tool_use_id: TOOL_USE_ID });
  });

  it('replaying the same Stop does not duplicate the verified row (idempotent)', () => {
    fs.writeFileSync(transcriptPath, failingTranscript());
    const first = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(first.status).toBe('ok');
    const second = ingestCodexConversation(stopPayload(), 'turn_complete', { workspaceDir, env: { CODEX_HOME: codexHome } });
    expect(second.status).toBe('ok');
    expect(toolCallsRows()).toHaveLength(1);
  });
});
