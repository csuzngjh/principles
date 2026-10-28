/**
 * pd pain explicit — CLI wiring and output contract (cli-1/cli-2/cli-5/cli-6/cli-7).
 *
 * Runs the REAL built CLI (dist/index.js) as a subprocess against an isolated
 * workspace: the live-turn context is produced by the real hook-side writer
 * (writeCurrentTurnContext from @principles/codex-adapter), the registration
 * goes through the real admission chain, and the assertions read the durable
 * result (trajectory.db marker, .pd/state.db diagnostician task).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { writeCurrentTurnContext, TURN_CONTEXT_FILENAME_PREFIX } from '@principles/codex-adapter';
import { processHookInvocation } from '@principles/codex-adapter/pd-hook';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const SESSION_B = '01b048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_B = '01b048ae-b344-7eb2-804b-a2fa34302fb3';
const OWNER_WORDS = '额度有限的任务应委派给低成本模型的子代理完成，而不是全部由高价模型自己执行';

const dirs: string[] = [];

interface Workspace { root: string; codexHome: string; transcriptPath: string }

function makeWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-explicit-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  (config.runtimeProfiles as Record<string, unknown>)['pd.default'] = {
    type: 'pi-ai', provider: 'test-provider', model: 'test-model',
    apiKeyEnv: 'PD_PAIN_EXPLICIT_TEST_KEY', baseUrl: 'http://127.0.0.1:8080/v1',
  };
  process.env.PD_PAIN_EXPLICIT_TEST_KEY = 'test-key';
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  trajectory.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
  trajectory.close();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-explicit-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROOT_ROLLOUT}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', session_id: ROOT_SESSION }) + '\n');
  return { root, codexHome, transcriptPath };
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

interface CliRun { code: number; stdout: string; stderr: string }

function runCli(args: string[], callerSessionId: string | null = ROOT_SESSION, callerThreadId: string | null = callerSessionId): CliRun {
  const env = { ...process.env };
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  if (callerSessionId !== null) env.CODEX_SESSION_ID = callerSessionId;
  if (callerThreadId !== null) env.CODEX_THREAD_ID = callerThreadId;
  try {
    const stdout = execFileSync('node', [getBuiltPdCliPath(), ...args], { encoding: 'utf8', env });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    if (error !== null && typeof error === 'object' && Object.hasOwn(error, 'status')) {
      return {
        code: Number(Reflect.get(error, 'status')),
        stdout: String(Reflect.get(error, 'stdout') ?? ''),
        stderr: String(Reflect.get(error, 'stderr') ?? ''),
      };
    }
    throw error;
  }
}

function turnContextFile(root: string, sessionId = ROOT_SESSION): string {
  const sessionKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return path.join(root, '.state', `${TURN_CONTEXT_FILENAME_PREFIX}${sessionKey}.json`);
}

function publishTurnContext(ws: Workspace, sessionId = ROOT_SESSION, turnId = TURN_1): void {
  const write = writeCurrentTurnContext({
    rawPayload: { session_id: sessionId, turn_id: turnId, transcript_path: ws.transcriptPath },
    workspaceDir: ws.root,
    env: { CODEX_HOME: ws.codexHome },
  });
  expect(write.ok).toBe(true);
  expect(fs.existsSync(turnContextFile(ws.root, sessionId))).toBe(true);
}

describe('pd pain explicit (command wiring, cli-7)', () => {
  it('registers under pain with the expected flags (pd pain explicit --help)', () => {
    const run = runCli(['pain', 'explicit', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('--statement');
    expect(run.stdout).toContain('--workspace');
    expect(run.stdout).toContain('--json');
  });
});

describe('pd pain explicit (json output contract, cli-1/cli-2)', () => {
  it('registers a real pain + task and prints exactly one JSON object', () => {
    const ws = makeWorkspace();
    publishTurnContext(ws);
    const run = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json']);
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout) as { status: string; disposition: string; painId: string; taskId: string };
    expect(result.status).toBe('received');
    expect(result.disposition).toBe('admitted');
    expect(result.painId).toMatch(/^pain_/);
    expect(result.taskId).toContain(result.painId);
    const trajectory = new Database(path.join(ws.root, '.state', 'trajectory.db'), { readonly: true });
    const markers = trajectory.prepare('SELECT logical_observation_key, task_payload_json FROM governance_signal_admissions').all() as { logical_observation_key: string; task_payload_json: string }[];
    trajectory.close();
    expect(markers).toHaveLength(1);
    expect(markers[0].logical_observation_key).toBe(`codex|${ROOT_ROLLOUT}|${TURN_1}|user`);
    expect((JSON.parse(markers[0].task_payload_json) as { correctionEvidence?: { channel?: string } }).correctionEvidence?.channel).toBe('codex_explicit_agent');
    const stateDb = new Database(path.join(ws.root, '.pd', 'state.db'), { readonly: true });
    const tasks = stateDb.prepare("SELECT task_id FROM tasks WHERE task_kind = 'diagnostician'").all() as { task_id: string }[];
    stateDb.close();
    expect(tasks).toHaveLength(1);
  });

  it('fails closed with a structured reason when no live turn context exists', () => {
    const ws = makeWorkspace();
    const run = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json']);
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout) as { status: string; reason: string; message: string; nextAction: string };
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('turn_context_missing');
    expect(result.nextAction.length).toBeGreaterThan(0);
    const trajectory = new Database(path.join(ws.root, '.state', 'trajectory.db'), { readonly: true });
    expect((trajectory.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    trajectory.close();
  });

  it('fails closed with turn_context_stale when the published context exceeds its freshness bound', () => {
    const ws = makeWorkspace();
    publishTurnContext(ws);
    const context = JSON.parse(fs.readFileSync(turnContextFile(ws.root), 'utf8')) as Record<string, unknown>;
    // 5h — beyond TURN_CONTEXT_MAX_AGE_MS (4h) enforced by the bridge.
    context.writtenAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    fs.writeFileSync(turnContextFile(ws.root), JSON.stringify(context));
    const run = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json']);
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout) as { status: string; reason: string; nextAction: string };
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('turn_context_stale');
    expect(result.nextAction.length).toBeGreaterThan(0);
    const trajectory = new Database(path.join(ws.root, '.state', 'trajectory.db'), { readonly: true });
    expect((trajectory.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    trajectory.close();
  });

  it('rejects a missing statement without recording anything', () => {
    const ws = makeWorkspace();
    publishTurnContext(ws);
    const run = runCli(['pain', 'explicit', '--workspace', ws.root, '--json']);
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout) as { status: string; reason: string };
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('statement_empty');
    const trajectory = new Database(path.join(ws.root, '.state', 'trajectory.db'), { readonly: true });
    expect((trajectory.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    trajectory.close();
  });
});

describe('pd pain explicit (host-bound session isolation)', () => {
  it('keeps interleaved sessions separate, ignores another session Stop, and never borrows its context', async () => {
    const ws = makeWorkspace();
    const hookEnv = { CODEX_HOME: ws.codexHome };
    const payload = (sessionId: string, turnId: string, event: 'UserPromptSubmit' | 'Stop') => JSON.stringify({
      session_id: sessionId,
      turn_id: turnId,
      transcript_path: ws.transcriptPath,
      cwd: ws.root,
      model: 'gpt-5.6-sol',
      permission_mode: 'bypassPermissions',
      hook_event_name: event,
      prompt: `显式反馈：${OWNER_WORDS}`,
      stop_hook_active: false,
    });

    await processHookInvocation(payload(SESSION_B, TURN_B, 'UserPromptSubmit'), hookEnv, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root, SESSION_B))).toBe(true);

    const aWithoutContext = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json'], ROOT_SESSION);
    expect(aWithoutContext.code).toBe(1);
    expect(JSON.parse(aWithoutContext.stdout)).toMatchObject({ status: 'failed', reason: 'turn_context_missing' });

    await processHookInvocation(payload(ROOT_SESSION, TURN_1, 'UserPromptSubmit'), hookEnv, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root, ROOT_SESSION))).toBe(true);
    expect(fs.existsSync(turnContextFile(ws.root, SESSION_B))).toBe(true);

    await processHookInvocation(payload(SESSION_B, TURN_B, 'Stop'), hookEnv, ws.root);
    expect(fs.existsSync(turnContextFile(ws.root, SESSION_B))).toBe(false);
    expect(fs.existsSync(turnContextFile(ws.root, ROOT_SESSION))).toBe(true);

    const a = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json'], ROOT_SESSION);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout)).toMatchObject({ status: 'received', logicalObservationKey: `codex|${ROOT_ROLLOUT}|${TURN_1}|user` });

    const bAfterStop = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json'], SESSION_B);
    expect(bAfterStop.code).toBe(1);
    expect(JSON.parse(bAfterStop.stdout)).toMatchObject({ status: 'failed', reason: 'turn_context_missing' });

    const trajectory = new Database(path.join(ws.root, '.state', 'trajectory.db'), { readonly: true });
    const sessions = trajectory.prepare('SELECT DISTINCT session_id FROM pain_events').all() as { session_id: string }[];
    trajectory.close();
    expect(sessions).toEqual([{ session_id: ROOT_SESSION }]);
  });

  it('rejects missing or conflicting host identity without reading any session file', () => {
    const ws = makeWorkspace();
    publishTurnContext(ws);
    const missing = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json'], null);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'failed', reason: 'caller_session_missing' });
    const conflict = runCli(['pain', 'explicit', '--statement', OWNER_WORDS, '--workspace', ws.root, '--json'], ROOT_SESSION, SESSION_B);
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stdout)).toMatchObject({ status: 'failed', reason: 'caller_session_conflict' });
    const trajectory = new Database(path.join(ws.root, '.state', 'trajectory.db'), { readonly: true });
    expect((trajectory.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number }).n).toBe(0);
    trajectory.close();
  });
});
