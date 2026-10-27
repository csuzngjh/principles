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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { writeCurrentTurnContext, TURN_CONTEXT_FILENAME } from '@principles/codex-adapter';
import { getBuiltPdCliPath } from '../helpers/pd-cli-path.js';

const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
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

function runCli(args: string[]): CliRun {
  try {
    const stdout = execFileSync('node', [getBuiltPdCliPath(), ...args], { encoding: 'utf8' });
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

function publishTurnContext(ws: Workspace): void {
  const write = writeCurrentTurnContext({
    rawPayload: { session_id: ROOT_SESSION, turn_id: TURN_1, transcript_path: ws.transcriptPath },
    workspaceDir: ws.root,
    env: { CODEX_HOME: ws.codexHome },
  });
  expect(write.ok).toBe(true);
  expect(fs.existsSync(path.join(ws.root, '.state', TURN_CONTEXT_FILENAME))).toBe(true);
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
