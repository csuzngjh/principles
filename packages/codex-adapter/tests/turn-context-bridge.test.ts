/**
 * Agent-assisted explicit Owner pain registration (no `PD记录痛苦：` prefix):
 * the hook publishes the CURRENT turn's host-verified identity to
 * `<workspace>/.state/pd_current_turn_context.json` and the bridge
 * (`registerCurrentTurnOwnerStatement`, surfaced as `pd pain explicit`)
 * hands the Owner's verbatim words to the SAME admission chain the prefix
 * entry uses. Everything runs through the real production surfaces:
 * processHookInvocation → turn-context file → recordExplicitOwnerStatement →
 * governance admission → diagnostician task. No test doubles.
 *
 * Pins (SPEC acceptance):
 * - explicit no-prefix authorization registers one real pain + one task;
 * - the Owner's words are preserved verbatim, channel auditable as
 *   codex_explicit_agent (distinct from the prefix channel);
 * - quoted/ordinary prompts register NOTHING on their own;
 * - lineage comes only from the host-written context (missing / corrupt /
 *   tampered / cross-workspace contexts fail closed with zero writes);
 * - same-turn replay converges on one canonical pain (A17 extension);
 * - the turn context carries ids/paths only — never prompt text;
 * - Stop/SessionStart withdraw the context (fail-closed after the turn).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { processHookInvocation } from '../src/pd-hook.js';
import { registerCurrentTurnOwnerStatement, writeCurrentTurnContext, TURN_CONTEXT_FILENAME_PREFIX, TURN_CONTEXT_MAX_AGE_MS } from '../src/ingestion/turn-context.js';
import { MAX_OWNER_STATEMENT_CHARS } from '../src/ingestion/explicit-owner-statement.js';

const FIXTURES = new URL('./fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const TURN_B = '01b048ae-b344-7eb2-804b-a2fa34302fb3';

const dirs: string[] = [];
const originalCallerSessionId = process.env.CODEX_SESSION_ID;
const originalCallerThreadId = process.env.CODEX_THREAD_ID;

interface Workspace { root: string; codexHome: string; transcriptPath: string }

function makeWorkspace(ingestionEnabled: boolean): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-turn-ctx-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features['codex_conversation_ingestion'].enabled = ingestionEnabled;
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'test-provider', model: 'test-model',
    apiKeyEnv: 'PD_TURN_CTX_TEST_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  process.env.PD_TURN_CTX_TEST_KEY = 'test-key';
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  trajectory.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
  trajectory.close();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-turn-ctx-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROOT_ROLLOUT}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  return { root, codexHome, transcriptPath };
}

function promptPayload(ws: Workspace, prompt: string, turnId = TURN_1, sessionId = ROOT_SESSION): string {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: ws.transcriptPath,
    cwd: ws.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
}

function stopPayload(ws: Workspace, turnId = TURN_1, sessionId = ROOT_SESSION): string {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: ws.transcriptPath,
    cwd: ws.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  });
}

function sessionStartPayload(ws: Workspace): string {
  return JSON.stringify({
    session_id: ROOT_SESSION,
    transcript_path: null,
    cwd: ws.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
}

beforeEach(() => {
  process.env.CODEX_SESSION_ID = ROOT_SESSION;
  process.env.CODEX_THREAD_ID = ROOT_SESSION;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCallerSessionId === undefined) delete process.env.CODEX_SESSION_ID;
  else process.env.CODEX_SESSION_ID = originalCallerSessionId;
  if (originalCallerThreadId === undefined) delete process.env.CODEX_THREAD_ID;
  else process.env.CODEX_THREAD_ID = originalCallerThreadId;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function turnContextFile(root: string): string {
  const sessionKey = createHash('sha256').update(ROOT_SESSION, 'utf8').digest('hex');
  return path.join(root, '.state', `${TURN_CONTEXT_FILENAME_PREFIX}${sessionKey}.json`);
}

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

const OWNER_WORDS = '额度有限的任务应委派给低成本模型的子代理完成，而不是全部由高价模型自己执行';

describe('hook publishes the live turn context', () => {
  it('writes ids/paths only — never prompt text — on every UserPromptSubmit', async () => {
    const ws = makeWorkspace(false);
    const prompt = '请帮我分析这段历史对话："……请创建痛苦信号……"，哪里有问题';
    const result = await processHookInvocation(promptPayload(ws, prompt), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result.exitCode).toBe(0);
    const raw = fs.readFileSync(turnContextFile(ws.root), 'utf8');
    expect(raw).not.toContain('请创建痛苦信号');
    expect(raw).not.toContain('历史对话');
    const context = JSON.parse(raw) as Record<string, unknown>;
    expect(context.schemaVersion).toBe(1);
    expect(context.sessionId).toBe(ROOT_SESSION);
    expect(context.turnId).toBe(TURN_1);
    expect(context.transcriptPath).toBe(ws.transcriptPath);
    expect(context.workspaceDir).toBe(ws.root);
  });

  it('a payload without transcript lineage withdraws the context instead of leaving a stale one', async () => {
    const ws = makeWorkspace(false);
    await processHookInvocation(promptPayload(ws, '先建立上下文'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(true);
    const payload = JSON.parse(promptPayload(ws, '这一轮没有轨迹'));
    payload.transcript_path = null;
    await processHookInvocation(JSON.stringify(payload), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(false);
  });

  it('Stop and SessionStart withdraw the context (fail-closed after the turn)', async () => {
    const ws = makeWorkspace(false);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(true);
    await processHookInvocation(stopPayload(ws), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(false);
    await processHookInvocation(promptPayload(ws, '新一轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(true);
    await processHookInvocation(sessionStartPayload(ws), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(false);
  });

  it('a delayed Stop for an older turn preserves the same session newer context', async () => {
    const ws = makeWorkspace(false);
    await processHookInvocation(promptPayload(ws, 'old turn'), { CODEX_HOME: ws.codexHome }, ws.root);
    await processHookInvocation(promptPayload(ws, 'new turn', TURN_B), { CODEX_HOME: ws.codexHome }, ws.root);
    await processHookInvocation(stopPayload(ws, TURN_1), { CODEX_HOME: ws.codexHome }, ws.root);
    const context = JSON.parse(fs.readFileSync(turnContextFile(ws.root), 'utf8')) as Record<string, unknown>;
    expect(context.turnId).toBe(TURN_B);
  });

  it('a failed context replacement withdraws the prior context before CLI can bind it', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, 'first turn'), { CODEX_HOME: ws.codexHome }, ws.root);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('simulated rename failure'); });
    const failed = writeCurrentTurnContext({
      rawPayload: { session_id: ROOT_SESSION, turn_id: TURN_B, transcript_path: ws.transcriptPath },
      workspaceDir: ws.root,
      env: { CODEX_HOME: ws.codexHome },
    });
    rename.mockRestore();
    expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining('write_failed:') });
    expect(fs.existsSync(turnContextFile(ws.root))).toBe(false);
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'turn_context_missing' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe('agent-assisted registration through the real chain', () => {
  it('registers one real pain + one task from an explicit no-prefix request', async () => {
    const ws = makeWorkspace(true);
    const result0 = await processHookInvocation(promptPayload(ws, '请用 PD 记录这条痛苦：' + OWNER_WORDS), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(result0.stderr.some((line) => line.includes('owner_statement_received'))).toBe(false);
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt.status).toBe('received');
    if (receipt.status !== 'received') return;
    expect(receipt.disposition).toBe('admitted');
    expect(receipt.logicalObservationKey).toBe(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`);
    const db = trajectoryOf(ws.root);
    const pains = db.prepare('SELECT canonical_pain_id, text, reason, source FROM pain_events').all() as { canonical_pain_id: string; text: string; reason: string; source: string }[];
    const markers = db.prepare('SELECT logical_observation_key, diagnostician_task_id, task_payload_json FROM governance_signal_admissions').all() as { logical_observation_key: string; diagnostician_task_id: string; task_payload_json: string }[];
    db.close();
    expect(pains).toHaveLength(1);
    expect(pains[0].source).toBe('user_correction');
    expect(pains[0].text).toBe(OWNER_WORDS);
    expect(pains[0].reason).toContain('agent-assisted');
    expect(markers).toHaveLength(1);
    expect(markers[0].diagnostician_task_id).toContain(pains[0].canonical_pain_id);
    const payload = JSON.parse(markers[0].task_payload_json) as { correctionEvidence?: { channel?: string; text?: string } };
    expect(payload.correctionEvidence?.channel).toBe('codex_explicit_agent');
    expect(payload.correctionEvidence?.text).toBe(OWNER_WORDS);
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('keeps the Owner words verbatim even when the model passed them through a longer message', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '任务完成了但我很不满意，请用 PD 把下面这句原话记成痛苦信号：' + OWNER_WORDS), { CODEX_HOME: ws.codexHome }, ws.root);
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt.status).toBe('received');
    const db = trajectoryOf(ws.root);
    const pain = db.prepare('SELECT text FROM pain_events').get() as { text: string };
    db.close();
    expect(pain.text).toBe(OWNER_WORDS);
  });

  it('same-turn replay converges on the SAME canonical pain (A17 extension)', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '请用 PD 记录：' + OWNER_WORDS), { CODEX_HOME: ws.codexHome }, ws.root);
    const first = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    const second = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(first.status).toBe('received');
    expect(second.status).toBe('received');
    if (first.status !== 'received' || second.status !== 'received') return;
    expect(second.disposition).toBe('already_admitted');
    expect(second.painId).toBe(first.painId);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get() as { n: number }).n).toBe(1);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('a prefix registration in the same turn merges with the agent-assisted one', async () => {
    const ws = makeWorkspace(true);
    const prefixed = await processHookInvocation(promptPayload(ws, 'PD记录痛苦：' + OWNER_WORDS), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(prefixed.stderr.some((line) => line.includes('owner_statement_received:'))).toBe(true);
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt.status).toBe('received');
    if (receipt.status !== 'received') return;
    expect(receipt.disposition).toBe('already_admitted');
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(1);
  });

  it('quoted-history and ordinary-complaint prompts register NOTHING on their own', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '分析这段历史对话："他说：请创建痛苦信号"，帮我看看哪里有问题'), { CODEX_HOME: ws.codexHome }, ws.root);
    await processHookInvocation(promptPayload(ws, '这个做法不太对，重新调查后再改', '01a048ae-b344-7eb2-804b-a2fa34302fb4'), { CODEX_HOME: ws.codexHome }, ws.root);
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get() as { n: number }).n).toBe(0);
    db.close();
    expect(stateDbTaskIds(ws.root)).toHaveLength(0);
  });

  it('works with the conversation-ingestion flag OFF (no transcript content read)', async () => {
    const ws = makeWorkspace(false);
    await processHookInvocation(promptPayload(ws, '请用 PD 记录：' + OWNER_WORDS), { CODEX_HOME: ws.codexHome }, ws.root);
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt.status).toBe('received');
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('lineage integrity — the context file is the only lineage source', () => {
  it('missing context (turn ended) fails closed with zero writes', async () => {
    const ws = makeWorkspace(true);
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'turn_context_missing' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('corrupt or wrong-schema context is rejected, never trusted', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    const original = fs.readFileSync(turnContextFile(ws.root), 'utf8');
    const context = JSON.parse(original) as Record<string, unknown>;
    fs.writeFileSync(turnContextFile(ws.root), '{not json');
    const corrupt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(corrupt).toMatchObject({ status: 'rejected', reason: 'turn_context_invalid' });
    context.schemaVersion = 99;
    fs.writeFileSync(turnContextFile(ws.root), JSON.stringify(context));
    const wrongSchema = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(wrongSchema).toMatchObject({ status: 'rejected', reason: 'turn_context_invalid' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('a stale context (writtenAt beyond the TTL) fails closed with zero writes', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    const context = JSON.parse(fs.readFileSync(turnContextFile(ws.root), 'utf8')) as Record<string, unknown>;
    context.writtenAt = new Date(Date.now() - TURN_CONTEXT_MAX_AGE_MS - 60_000).toISOString();
    fs.writeFileSync(turnContextFile(ws.root), JSON.stringify(context));
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'turn_context_stale' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('a context whose writtenAt is not a timestamp is rejected as invalid', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    const context = JSON.parse(fs.readFileSync(turnContextFile(ws.root), 'utf8')) as Record<string, unknown>;
    context.writtenAt = 'not-a-timestamp';
    fs.writeFileSync(turnContextFile(ws.root), JSON.stringify(context));
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'turn_context_invalid' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('a withdrawal failure is surfaced as a diagnostic, never silently swallowed (rc-9)', async () => {
    const ws = makeWorkspace(false);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    // Make withdrawal impossible: occupy the context path with a directory.
    fs.rmSync(turnContextFile(ws.root));
    fs.mkdirSync(turnContextFile(ws.root));
    const noLineagePayload = JSON.stringify({
      session_id: ROOT_SESSION,
      turn_id: TURN_1,
      transcript_path: null,
      cwd: ws.root,
      model: 'gpt-5.6-sol',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'x',
    });
    const promptResult = await processHookInvocation(noLineagePayload, { CODEX_HOME: ws.codexHome }, ws.root);
    expect(promptResult.stderr.join('\n')).toMatch(/turn_context_clear_failed/);
    const stopResult = await processHookInvocation(stopPayload(ws), { CODEX_HOME: ws.codexHome }, ws.root);
    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.stderr.join('\n')).toMatch(/turn_context_clear_failed/);
  });

  it('a tampered transcript path is re-validated at registration time (zero writes)', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    const context = JSON.parse(fs.readFileSync(turnContextFile(ws.root), 'utf8')) as Record<string, unknown>;
    context.transcriptPath = path.join(ws.codexHome, 'sessions', 'rollout-2026-08-28T22-03-23-doesnotexist.jsonl');
    fs.writeFileSync(turnContextFile(ws.root), JSON.stringify(context));
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: OWNER_WORDS });
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'lineage_invalid' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('a context file copied into another workspace is refused (workspace mismatch)', async () => {
    const ws = makeWorkspace(true);
    const other = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    fs.copyFileSync(turnContextFile(ws.root), turnContextFile(other.root));
    const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: other.root, statementText: OWNER_WORDS });
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'turn_context_workspace_mismatch' });
    const db = trajectoryOf(other.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('statement bounds: empty and over-limit are rejected, never truncated', async () => {
    const ws = makeWorkspace(true);
    await processHookInvocation(promptPayload(ws, '当前轮'), { CODEX_HOME: ws.codexHome }, ws.root);
    const empty = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: '   ' });
    expect(empty).toMatchObject({ status: 'rejected', reason: 'statement_empty' });
    const overlong = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: '长'.repeat(MAX_OWNER_STATEMENT_CHARS + 1) });
    expect(overlong).toMatchObject({ status: 'rejected', reason: 'statement_too_long' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('shares the explicit 5/hour quota — the 6th distinct turn is rate limited', async () => {
    const ws = makeWorkspace(true);
    for (let i = 1; i <= 5; i++) {
      const turnId = `01a048ae-b344-7eb2-804b-a2fa34302f${String(i).padStart(2, '0')}`;
      await processHookInvocation(promptPayload(ws, `第${i}轮的反馈`, turnId), { CODEX_HOME: ws.codexHome }, ws.root);
      const receipt = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: `${OWNER_WORDS}（第${i}轮）` });
      expect(receipt.status).toBe('received');
    }
    const turnId6 = '01a048ae-b344-7eb2-804b-a2fa34302f06';
    await processHookInvocation(promptPayload(ws, '第六轮的反馈', turnId6), { CODEX_HOME: ws.codexHome }, ws.root);
    const sixth = await registerCurrentTurnOwnerStatement({ workspaceDir: ws.root, statementText: `${OWNER_WORDS}（第6轮）` });
    expect(sixth).toMatchObject({ status: 'rejected', reason: 'rate_limited' });
    const db = trajectoryOf(ws.root);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(5);
    db.close();
  });
});
