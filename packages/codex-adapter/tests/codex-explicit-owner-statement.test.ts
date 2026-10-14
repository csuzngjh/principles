/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-07 — the explicit Owner pain-report entry
 * (`PD记录痛苦：<反馈原文>` in the CURRENT Codex user message), driven through
 * the REAL production surfaces: processHookInvocation → governance admission →
 * durable diagnostician-task enqueue. No test doubles on the production path.
 *
 * A17 pins: only the exact prefix on the current prompt triggers it; quoted /
 * mid-message / model text never does; the same observation key dedups
 * replay to ONE canonical pain; ingestion-flag-off does not block the
 * explicit channel (no transcript content is read either way).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { processHookInvocation } from '../src/pd-hook.js';
import { parseOwnerStatementPrefix, MAX_OWNER_STATEMENT_CHARS } from '../src/ingestion/explicit-owner-statement.js';

const FIXTURES = new URL('./fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';

const dirs: string[] = [];

interface Workspace { root: string; codexHome: string; transcriptPath: string }

function makeWorkspace(ingestionEnabled: boolean): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-explicit-stmt-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features['codex_conversation_ingestion'].enabled = ingestionEnabled;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  // Canonical base tables (what `pd runtime init` creates in a real workspace).
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  trajectory.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
  trajectory.close();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-explicit-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROOT_ROLLOUT}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  return { root, codexHome, transcriptPath };
}

function promptPayload(ws: Workspace, prompt: string, turnId = TURN_1): string {
  return JSON.stringify({
    session_id: ROOT_SESSION,
    turn_id: turnId,
    transcript_path: ws.transcriptPath,
    cwd: ws.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function trajectoryOf(root: string): Database.Database {
  return new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
}

function stateDbTaskIds(root: string): string[] {
  const dbPath = path.join(root, '.pd', 'state.db');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT task_id FROM tasks WHERE task_kind = 'diagnostician'").all() as { task_id: string }[]).map((r) => r.task_id);
  } finally {
    db.close();
  }
}

describe('CR-07 prefix parse (deterministic, current-prompt only)', () => {
  it('accepts the exact fullwidth-colon prefix and extracts the statement', () => {
    expect(parseOwnerStatementPrefix('PD记录痛苦：重构前要先看已有实现')).toEqual({ matched: true, text: '重构前要先看已有实现' });
  });
  it('rejects non-prefix, quoted, and mid-message occurrences (A17)', () => {
    expect(parseOwnerStatementPrefix('请帮我修这个 bug')).toEqual({ matched: false });
    expect(parseOwnerStatementPrefix('他说"PD记录痛苦：xxx"')).toEqual({ matched: false });
    expect(parseOwnerStatementPrefix('prefix PD记录痛苦：xxx')).toEqual({ matched: false });
    expect(parseOwnerStatementPrefix(undefined)).toEqual({ matched: false });
  });
  it('rejects empty and over-limit statements without truncation', () => {
    expect(parseOwnerStatementPrefix('PD记录痛苦：')).toEqual({ matched: true, text: null, reason: 'statement_empty' });
    expect(parseOwnerStatementPrefix('PD记录痛苦：   ')).toEqual({ matched: true, text: null, reason: 'statement_empty' });
    expect(parseOwnerStatementPrefix(`PD记录痛苦：${'长'.repeat(MAX_OWNER_STATEMENT_CHARS + 1)}`)).toEqual({ matched: true, text: null, reason: 'statement_too_long' });
  });
});

describe('CR-07 explicit statement through the production hook', () => {
  it('records one pain + one diagnostician task and returns a receipt (A03 entry)', async () => {
    const ws = makeWorkspace(true);
    const result = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：不要在未核对调用方的情况下改公共接口'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_received:'))).toBe(true);
    const db = trajectoryOf(ws.root);
    const pains = db.prepare('SELECT canonical_pain_id, source FROM pain_events').all() as { canonical_pain_id: string; source: string }[];
    const markers = db.prepare('SELECT logical_observation_key, diagnostician_task_id FROM governance_signal_admissions').all() as { logical_observation_key: string; diagnostician_task_id: string }[];
    db.close();
    expect(pains).toHaveLength(1);
    expect(pains[0].source).toBe('user_correction');
    expect(markers).toHaveLength(1);
    expect(markers[0].logical_observation_key).toBe(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`);
    expect(markers[0].diagnostician_task_id).toContain(pains[0].canonical_pain_id);
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('replay of the same turn converges on the SAME canonical pain (A17 idempotency)', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, 'PD记录痛苦：同一个反馈'), { CODEX_HOME: ws.codexHome }, ws.root);
    const second = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：同一个反馈'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(second.exitCode).toBe(0);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get() as { n: number }).n).toBe(1);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('ordinary prompts never take the explicit path (A17)', async () => {
    const ws = makeWorkspace(true);
    const result = await processHookInvocation(promptPayload(ws, '这个做法不对，重新调查后再改'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_received'))).toBe(false);
    const db = trajectoryOf(ws.root);
    // The generic STRONG keyword gate stays the only admission path for
    // ordinary text — this fixture text is not a STRONG+high-precision match.
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('works with the conversation-ingestion flag OFF (no transcript content read)', async () => {
    const ws = makeWorkspace(false);
    const result = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：ingestion 关闭时也应记录'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_received:'))).toBe(true);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('missing transcript path rejects explicitly without recording', async () => {
    const ws = makeWorkspace(true);
    const payload = JSON.parse(promptPayload(ws, 'PD记录痛苦：无轨迹不应记录'));
    payload.transcript_path = null;
    const result = await processHookInvocation(JSON.stringify(payload), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_transcript_unavailable'))).toBe(true);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('an over-limit statement is rejected, never truncated', async () => {
    const ws = makeWorkspace(true);
    const result = await processHookInvocation(promptPayload(ws, `PD记录痛苦：${'超'.repeat(MAX_OWNER_STATEMENT_CHARS + 5)}`), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.some((line) => line.includes('owner_statement_statement_too_long'))).toBe(true);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
