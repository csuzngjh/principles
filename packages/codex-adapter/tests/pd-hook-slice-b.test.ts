import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { createStepRegistry, defineFeature } from '../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../principles-core/tests/bdd/support/repo-root.js';

/**
 * Slice B production-path tests (PRI-623): the BUILT pd-hook executable with
 * `codex_conversation_ingestion` enabled, driving the real
 * observation → detection → admission → canonical pain → task → promotion
 * chain against a real workspace + CODEX_HOME transcript fixture. Every
 * subprocess invocation is a fresh process, so cross-invocation assertions
 * prove persisted (not process-local) correctness (SPEC §12).
 */

const FIXTURES = new URL('./fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const TOOL_USE_ID = 'exec-db1bff81-f42e-45f8-91ce-e87480fa15d9';
const ROLLOUT_UUID = '01a048ae-b2a5-71a1-9faf-0226980f98ff';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

const dirs: string[] = [];

interface SliceBWorkspace {
  root: string;
  codexHome: string;
  transcriptPath: string;
}

interface HookRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built hook executable in a fresh subprocess. Boundary-validated
 * entry path + argument-vector invocation (no shell), per the repository's
 * subprocess policy shape.
 */
async function runHookExecutable(codexHome: string, payloadJson: string): Promise<HookRunResult> {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = path.resolve(packageRoot, 'dist', 'pd-hook.js');
  if (!entry.startsWith(`${packageRoot}${path.sep}`) || !fs.statSync(entry).isFile()) {
    throw new Error(`hook entry not found or outside the package: ${entry}`);
  }
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const running = execFileAsync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    // execFile has no `input` option — feed the JSON payload on stdin.
    running.child.stdin?.end(payloadJson);
    const { stdout, stderr } = await running;
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { status: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? '' };
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

function sliceBWorkspace(): SliceBWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-slice-b-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  config.features['codex_conversation_ingestion'].enabled = true;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) trajectory.prepare(statement).run();
  trajectory.close();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-slice-b-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROLLOUT_UUID}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  return { root, codexHome, transcriptPath };
}

function basePayload(args: SliceBWorkspace): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: TURN_1,
    transcript_path: args.transcriptPath,
    cwd: args.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
  };
}

function userPromptPayload(args: SliceBWorkspace, prompt: string, turnId = TURN_1): Record<string, unknown> {
  return { ...basePayload(args), hook_event_name: 'UserPromptSubmit', prompt, turn_id: turnId };
}

function postToolUsePayload(args: SliceBWorkspace): Record<string, unknown> {
  return {
    ...basePayload(args),
    hook_event_name: 'PostToolUse',
    tool_name: 'write_file',
    tool_use_id: TOOL_USE_ID,
    tool_input: { file_path: path.join(path.parse(args.root).root, 'etc', 'slice-b-risky.conf'), content: 'x' },
    tool_response: { exitCode: 1, error: 'EACCES: permission denied' },
  };
}

function stopPayload(args: SliceBWorkspace): Record<string, unknown> {
  return { ...basePayload(args), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'FIXTURE-A-DONE' };
}

function trajectoryOf(root: string): Database.Database {
  return new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
}

function stateDbOf(root: string): Database.Database {
  return new Database(path.join(root, '.pd', 'state.db'), { readonly: true });
}

async function invokeHook(ws: SliceBWorkspace, payload: Record<string, unknown>): Promise<HookRunResult> {
  return runHookExecutable(ws.codexHome, JSON.stringify(payload));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pd-hook Slice B admission (production executable, ingestion flag on)', () => {
  it('ordinary conversation → observations only, zero pain / zero task / zero quota', async () => {
    const ws = sliceBWorkspace();
    const result = await invokeHook(ws, userPromptPayload(ws, '帮我解释一下这个函数'));
    expect(result.status).toBe(0);
    // Live UserPromptSubmit answers in the exact Codex schema (prompt
    // injection passthrough when no principle is active); admission silence
    // is proven by the zero counts below, not by an empty stdout.
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
    const db = trajectoryOf(ws.root);
    const counts = {
      observations: db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get(),
      pains: db.prepare('SELECT COUNT(*) AS n FROM pain_events').get(),
      markers: db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get(),
      buckets: db.prepare('SELECT COUNT(*) AS n FROM governance_correction_rate_limits').get(),
    };
    db.close();
    expect(counts.observations).toEqual({ n: 1 });
    expect(counts.pains).toEqual({ n: 0 });
    expect(counts.markers).toEqual({ n: 0 });
    expect(counts.buckets).toEqual({ n: 0 });
    if (fs.existsSync(path.join(ws.root, '.pd', 'state.db'))) {
      const state = stateDbOf(ws.root);
      expect(state.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
      state.close();
    }
  });

  it('a real owner correction → exactly one canonical pain, one pending task, promotion tail armed', async () => {
    const ws = sliceBWorkspace();
    const result = await invokeHook(ws, userPromptPayload(ws, '不要自作主张,这是错的,我说过修改前先调查已有实现'));
    expect(result.status).toBe(0);

    const db = trajectoryOf(ws.root);
    const pain = db.prepare('SELECT canonical_pain_id, runtime_task_id, source FROM pain_events').get() as { canonical_pain_id: string; runtime_task_id: string | null; source: string } | undefined;
    const marker = db.prepare('SELECT canonical_pain_id, diagnostician_task_id FROM governance_signal_admissions').get() as { canonical_pain_id: string; diagnostician_task_id: string } | undefined;
    const tail = db.prepare('SELECT state FROM governance_pending_promotion_tails').get() as { state: string } | undefined;
    db.close();

    expect(pain).toBeDefined();
    expect(pain?.canonical_pain_id).toMatch(/^pain_host_[0-9a-f]{64}$/);
    expect(pain?.source).toBe('user_correction');
    expect(marker?.canonical_pain_id).toBe(pain?.canonical_pain_id);
    expect(tail?.state).toBe('pending');

    const state = stateDbOf(ws.root);
    const task = state.prepare("SELECT task_id, task_kind, status, input_ref FROM tasks WHERE task_kind = 'diagnostician'").get() as { task_id: string; status: string; input_ref: string } | undefined;
    state.close();
    expect(task).toMatchObject({ task_kind: 'diagnostician', status: 'pending', input_ref: pain?.canonical_pain_id });
    expect(task?.task_id).toBe(`diagnosis_${pain?.canonical_pain_id}`);
    expect(marker?.diagnostician_task_id).toBe(task?.task_id);
  });

  it('duplicate delivery in fresh processes → still exactly one pain and one task', async () => {
    const ws = sliceBWorkspace();
    const payload = userPromptPayload(ws, '不要自作主张,这是错的,我说过修改前先调查已有实现');
    await invokeHook(ws, payload);
    const second = await invokeHook(ws, payload);
    expect(second.status).toBe(0);

    const db = trajectoryOf(ws.root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count FROM governance_correction_rate_limits').get()).toEqual({ count: 1 });
    db.close();
    const state = stateDbOf(ws.root);
    expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    state.close();
  });

  it('one real tool failure via live PostToolUse + Stop transcript replay → one pain, one task', async () => {
    const ws = sliceBWorkspace();
    const live = await invokeHook(ws, postToolUsePayload(ws));
    expect(live.status).toBe(0);
    expect(JSON.parse(live.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });

    // The Stop replay ingests the fixture transcript: the same tool call
    // (item_completed CommandExecution with the same tool id) converges on the
    // live observation instead of duplicating it.
    const stop = await invokeHook(ws, stopPayload(ws));
    expect(stop.status).toBe(0);

    const db = trajectoryOf(ws.root);
    const counts = {
      pains: db.prepare('SELECT COUNT(*) AS n FROM pain_events').get(),
      calls: db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get(),
      markers: db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get(),
      toolObservations: db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE kind = 'tool_call'").get(),
    };
    db.close();
    expect(counts.pains).toEqual({ n: 1 });
    expect(counts.calls).toEqual({ n: 1 });
    expect(counts.markers).toEqual({ n: 1 });
    expect(counts.toolObservations).toEqual({ n: 1 });

    const state = stateDbOf(ws.root);
    expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    state.close();
  });

  it('the STRONG persisted bucket rate-limits the sixth distinct correction across fresh processes', async () => {
    const ws = sliceBWorkspace();
    for (let i = 1; i <= 5; i += 1) {
      const turnId = `${TURN_1.slice(0, 8)}-rate-${i}`;
      await invokeHook(ws, userPromptPayload(ws, `不要自作主张,第 ${i} 次这是错的`, turnId));
    }
    const db = trajectoryOf(ws.root);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 5 });
    db.close();
    // 6th distinct correction in a fresh subprocess → persisted bucket blocks it.
    await invokeHook(ws, userPromptPayload(ws, '不要自作主张,第六次这是错的', `${TURN_1.slice(0, 8)}-rate-6`));
    const after = trajectoryOf(ws.root);
    expect(after.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 5 });
    expect(after.prepare('SELECT count FROM governance_correction_rate_limits').get()).toEqual({ count: 5 });
    after.close();
  });
});

// ── BDD (SPEC §18 scenarios 5/6/7 + live+transcript convergence) ───────────

const registry = createStepRegistry();
let bddWs: SliceBWorkspace;
let bddPayload: Record<string, unknown>;

registry.given('an isolated Codex Workspace with conversation ingestion enabled', () => {
  bddWs = sliceBWorkspace();
});
registry.when('Codex submits an ordinary prompt through the production hook', () => {
  bddPayload = userPromptPayload(bddWs, '帮我解释一下这个函数');
});
registry.then('one governance observation exists and no pain or task was created', async () => {
  const result = await invokeHook(bddWs, bddPayload);
  expect(result.status).toBe(0);
  const db = trajectoryOf(bddWs.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 0 });
  db.close();
});
registry.then('no correction rate-limit quota was consumed', () => {
  const db = trajectoryOf(bddWs.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM governance_correction_rate_limits').get()).toEqual({ n: 0 });
  db.close();
});
registry.when('Codex submits a high-precision owner correction through the production hook', () => {
  bddPayload = userPromptPayload(bddWs, '不要自作主张,这是错的,我说过修改前先调查已有实现');
});
registry.then('exactly one canonical pain with a deterministic id exists', async () => {
  const result = await invokeHook(bddWs, bddPayload);
  expect(result.status).toBe(0);
  const db = trajectoryOf(bddWs.root);
  const pain = db.prepare('SELECT canonical_pain_id FROM pain_events').get() as { canonical_pain_id: string };
  db.close();
  expect(pain.canonical_pain_id).toMatch(/^pain_host_[0-9a-f]{64}$/);
});
registry.then('exactly one pending Diagnostician task linked to that pain exists', () => {
  const db = trajectoryOf(bddWs.root);
  const pain = db.prepare('SELECT canonical_pain_id, runtime_task_id FROM pain_events').get() as { canonical_pain_id: string; runtime_task_id: string };
  db.close();
  expect(pain.runtime_task_id).toBe(`diagnosis_${pain.canonical_pain_id}`);
  const state = stateDbOf(bddWs.root);
  const task = state.prepare("SELECT status, input_ref FROM tasks WHERE task_kind = 'diagnostician'").get() as { status: string; input_ref: string };
  state.close();
  expect(task.status).toBe('pending');
  expect(task.input_ref).toBe(pain.canonical_pain_id);
});
registry.then('the bounded evidence promotion window was armed for the correction turn', () => {
  const db = trajectoryOf(bddWs.root);
  expect(db.prepare('SELECT state FROM governance_pending_promotion_tails').get()).toEqual({ state: 'pending' });
  db.close();
});
registry.when('Codex submits a high-precision owner correction through the production hook twice', async () => {
  bddPayload = userPromptPayload(bddWs, '不要自作主张,这是错的,我说过修改前先调查已有实现');
  await invokeHook(bddWs, bddPayload);
  await invokeHook(bddWs, bddPayload);
});
registry.then('still exactly one canonical pain and one pending Diagnostician task exist', () => {
  const db = trajectoryOf(bddWs.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 1 });
  db.close();
  const state = stateDbOf(bddWs.root);
  expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
  state.close();
});
registry.when('Codex reports a failed write tool through the production hook', async () => {
  bddPayload = postToolUsePayload(bddWs);
  const result = await invokeHook(bddWs, bddPayload);
  expect(result.status).toBe(0);
});
registry.when('the Stop transcript replay of the same tool call is ingested', async () => {
  const result = await invokeHook(bddWs, stopPayload(bddWs));
  expect(result.status).toBe(0);
});
registry.then('exactly one tool pain and one pending Diagnostician task exist', () => {
  const db = trajectoryOf(bddWs.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 1 });
  db.close();
  const state = stateDbOf(bddWs.root);
  expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
  state.close();
});

defineFeature(fs.readFileSync(resolveFeaturePath('docs/specs/features/codex-governance/codex-signal-admission.feature'), 'utf8'), registry);
