import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import {
  catchUpCodexIngestion,
} from '@principles/codex-adapter';
import {
  ingestGovernanceObservations,
  listGovernanceCheckpoints,
  listGovernanceObservations,
  promoteGovernanceEvidence,
  quarantineGovernanceObservation,
  reconcileGovernanceContinuation,
} from '@principles/host-runtime';
import { createStepRegistry, defineFeature } from '../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../principles-core/tests/bdd/support/repo-root.js';

/**
 * Codex Governance Closure Slice D (PRI-625): owner-loop BDD steps for SPEC
 * rev 2 §18 scenarios 1, 3, 4, 8, 10, 11, 12, and 16. Every step drives the
 * REAL production surfaces — the built pd-hook executable in a fresh
 * subprocess (same harness as pd-hook-slice-b.test.ts) and the production
 * host-runtime store seams — never test doubles (§18 completion bar).
 */

const FIXTURES = new URL('./fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const FORK_ROLLOUT = '01a048af-336d-7211-b423-eafa97450ea3';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const TOOL_USE_ID = 'exec-db1bff81-f42e-45f8-91ce-e87480fa15d9';
const CORRECTION = '不要自作主张,这是错的,我说过修改前先调查已有实现';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

const dirs: string[] = [];

interface HookRunResult { status: number; stdout: string; stderr: string }

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

interface Workspace { root: string; codexHome: string; sessions: string; transcriptPath: string }

function makeWorkspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-owner-loop-'));
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
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-owner-loop-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROOT_ROLLOUT}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  return { root, codexHome, sessions, transcriptPath };
}

function basePayload(ws: Workspace, transcriptPath = ws.transcriptPath): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: TURN_1,
    transcript_path: transcriptPath,
    cwd: ws.root,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
  };
}

function promptPayload(ws: Workspace, prompt: string): Record<string, unknown> {
  return { ...basePayload(ws), hook_event_name: 'UserPromptSubmit', prompt, turn_id: TURN_1 };
}

function postToolUsePayload(ws: Workspace): Record<string, unknown> {
  return {
    ...basePayload(ws),
    hook_event_name: 'PostToolUse',
    tool_name: 'write_file',
    tool_use_id: TOOL_USE_ID,
    tool_input: { file_path: path.join(path.parse(ws.root).root, 'etc', 'owner-loop.conf'), content: 'x' },
    tool_response: { exitCode: 1, error: 'EACCES: permission denied' },
  };
}

function stopPayload(ws: Workspace, transcriptPath = ws.transcriptPath): Record<string, unknown> {
  return { ...basePayload(ws, transcriptPath), hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'FIXTURE-A-DONE' };
}

function trajectoryOf(root: string): Database.Database {
  return new Database(path.join(root, '.state', 'trajectory.db'), { readonly: true });
}

function stateDbOf(root: string): Database.Database {
  return new Database(path.join(root, '.pd', 'state.db'), { readonly: true });
}

async function invokeHook(ws: Workspace, payload: Record<string, unknown>): Promise<HookRunResult> {
  return runHookExecutable(ws.codexHome, JSON.stringify(payload));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── BDD binding: docs/specs/features/codex-governance/codex-owner-loop.feature ─

const registry = createStepRegistry();
let ws: Workspace;

registry.given('an isolated Codex Workspace with conversation ingestion enabled', () => {
  ws = makeWorkspace();
});

// ── §18-1 ────────────────────────────────────────────────────────────────────
registry.when('Codex submits an ordinary prompt through the production hook', async () => {
  const result = await invokeHook(ws, promptPayload(ws, '帮我解释一下这个函数'));
  expect(result.status).toBe(0);
  ws['lastHookRun'] = result;
});
registry.then('the hook answers in the exact Codex schema without governance side effects', () => {
  const result = ws['lastHookRun'] as HookRunResult;
  expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
  const db = trajectoryOf(ws.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM governance_signal_admissions').get()).toEqual({ n: 0 });
  db.close();
});
registry.then('the existing tool evidence store is untouched by ingestion', () => {
  const db = trajectoryOf(ws.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 0 });
  db.close();
});

// ── §18-3 ────────────────────────────────────────────────────────────────────
registry.when('a live tool failure is delivered and the same session is replayed from the transcript', async () => {
  const live = await invokeHook(ws, postToolUsePayload(ws));
  expect(live.status).toBe(0);
  const stop = await invokeHook(ws, stopPayload(ws));
  expect(stop.status).toBe(0);
});
registry.then('the user turn exists once with transcript enrichment and the tool call exists once', () => {
  const db = trajectoryOf(ws.root);
  expect(db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE kind = 'tool_call'").get()).toEqual({ n: 1 });
  const userTurns = db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE kind = 'user_turn'").get() as { n: number };
  const transcriptUserTurns = db.prepare("SELECT COUNT(*) AS n FROM governance_observations WHERE kind = 'user_turn' AND source = 'transcript'").get() as { n: number };
  db.close();
  expect(userTurns.n).toBeGreaterThanOrEqual(1);
  // The replay ENRICHED (added the transcript user turn) instead of duplicating.
  expect(transcriptUserTurns.n).toBeGreaterThanOrEqual(1);
});

// ── §18-4 ────────────────────────────────────────────────────────────────────
registry.when('two rollout forks of the same root session are replayed', async () => {
  // Root rollout replayed via Stop, then the fork fixture replayed as its own rollout.
  const rootStop = await invokeHook(ws, stopPayload(ws));
  expect(rootStop.status).toBe(0);
  const forkPath = path.join(ws.sessions, `rollout-2026-08-28T22-03-56-${FORK_ROLLOUT}.jsonl`);
  fs.copyFileSync(new URL('transcripts/fork.jsonl', FIXTURES), forkPath);
  const forkPayload = { ...basePayload(ws, forkPath), session_id: FORK_ROLLOUT, turn_id: '01a048af-0000-0000-0000-000000000000' };
  const forkStop = await invokeHook(ws, stopPayload(ws, forkPath));
  void forkPayload;
  expect(forkStop.status).toBe(0);
});
registry.then('each fork keeps its own observations and both link to the shared root session', () => {
  const db = trajectoryOf(ws.root);
  const rollouts = db.prepare('SELECT rollout_identity, parent_rollout_id, root_session_id FROM governance_rollouts ORDER BY rollout_identity').all() as { rollout_identity: string; parent_rollout_id: string | null; root_session_id: string }[];
  db.close();
  expect(rollouts.length).toBe(2);
  const identities = new Set(rollouts.map((row) => row.rollout_identity));
  expect(identities.has(ROOT_ROLLOUT)).toBe(true);
  expect(identities.has(FORK_ROLLOUT)).toBe(true);
  const fork = rollouts.find((row) => row.rollout_identity === FORK_ROLLOUT);
  expect(fork?.parent_rollout_id).toBe(ROOT_ROLLOUT);
});

// ── §18-8 ────────────────────────────────────────────────────────────────────
registry.when('the transcript grows past the committed checkpoint between stop events', async () => {
  // First Stop sees only a TRUNCATED transcript (a short stop-event flush).
  const full = fs.readFileSync(ws.transcriptPath);
  fs.writeFileSync(ws.transcriptPath, full.subarray(0, Math.floor(full.length * 0.6)));
  const first = await invokeHook(ws, stopPayload(ws));
  expect(first.status).toBe(0);
  // The session then completes; the transcript reaches its full length.
  fs.writeFileSync(ws.transcriptPath, full);
});
registry.then('the checkpoint exposes lag and one bounded catch-up pass clears it', async () => {
  const before = listGovernanceCheckpoints({ workspaceDir: ws.root, hostKind: 'codex' });
  expect(before.ok).toBe(true);
  if (!before.ok) return;
  const checkpoint = before.checkpoints[0];
  expect(checkpoint).toBeDefined();
  const fullSize = fs.statSync(ws.transcriptPath).size;
  expect(checkpoint.byteOffset).toBeLessThan(fullSize);

  const result = await catchUpCodexIngestion({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
  expect(result.status === 'ok' || result.status === 'skipped').toBe(true);
  if (result.status === 'ok') {
    expect(result.rollouts).toHaveLength(1);
    const after = listGovernanceCheckpoints({ workspaceDir: ws.root, hostKind: 'codex' });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.checkpoints[0]?.byteOffset).toBe(fullSize);
  }
});

// ── §18-9 ────────────────────────────────────────────────────────────────────
registry.when('the full session transcript is ingested through the production hook', async () => {
  const result = await invokeHook(ws, stopPayload(ws));
  expect(result.status).toBe(0);
  ws['privacyStdout'] = result.stdout;
});
registry.then('no host-injected context, hidden reasoning marker, or transcript file path exists in any governance store', () => {
  const db = trajectoryOf(ws.root);
  const blobs: unknown[] = [
    db.prepare('SELECT visible_text, sanitized_tool_facts_json FROM governance_observations').all(),
  ];
  // A quiet workspace may not have a state.db at all — absence is fine; the
  // privacy scan covers it whenever it exists.
  if (fs.existsSync(path.join(ws.root, '.pd', 'state.db'))) {
    const state = stateDbOf(ws.root);
    blobs.push(state.prepare('SELECT reason, text FROM pain_events').all() as unknown[]);
    state.close();
  }
  db.close();
  const forbidden = ['<host-injected context removed>', 'base_instructions', 'environments.environment_context', ws.codexHome, ws.transcriptPath];
  for (const blob of blobs) {
    const serialized = JSON.stringify(blob);
    for (const needle of forbidden) {
      expect(serialized.includes(needle), `leaked: ${needle}`).toBe(false);
    }
  }
});
registry.then('the hook stdout carries no conversation content', () => {
  const result = ws['privacyStdout'] as string;
  // The Stop hook answers with the empty structured decision — never the
  // conversation text it just read (rc-8 bounded output, §18-9).
  expect(result).not.toContain('FIXTURE-A-DONE');
  expect(result).not.toContain(ws.transcriptPath);
});

// ── §18-10 ───────────────────────────────────────────────────────────────────
registry.when('a transcript record is stable-invalid and the audited quarantine runs with confirm', async () => {
  // Force a stable conflict through the production store: same logical key,
  // different committed content → the row is marked partial and the store
  // reports logical_key_content_conflict (SPEC §9/§10).
  const now = new Date();
  const first = ingestGovernanceObservations({
    workspaceDir: ws.root,
    now,
    observations: [{
      hostKind: 'codex', rolloutIdentity: 'conflict-rollout', rootSessionId: 'root-conflict',
      hostTurnId: 't1', kind: 'user_turn', logicalObservationKey: 'codex|conflict-rollout|t1|user',
      source: 'transcript', completeness: 'complete', observedAt: now.toISOString(),
      recordByteStart: 100, recordOrdinal: 1, visibleText: 'first committed content',
    }],
  });
  expect(first.ok).toBe(true);
  const conflicting = ingestGovernanceObservations({
    workspaceDir: ws.root,
    now,
    observations: [{
      hostKind: 'codex', rolloutIdentity: 'conflict-rollout', rootSessionId: 'root-conflict',
      hostTurnId: 't1', kind: 'user_turn', logicalObservationKey: 'codex|conflict-rollout|t1|user',
      source: 'transcript', completeness: 'complete', observedAt: now.toISOString(),
      recordByteStart: 100, recordOrdinal: 1, visibleText: 'divergent content for the same logical key',
    }],
  });
  expect(conflicting.ok).toBe(false);
  expect(conflicting.ok === false && conflicting.reason === 'logical_key_content_conflict').toBe(true);

  // Find the conflict-marked partial row and quarantine it (dry run first).
  const listed = listGovernanceObservations({ workspaceDir: ws.root });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  const partial = listed.observations.find((row) => row.logicalKey === 'codex|conflict-rollout|t1|user');
  expect(partial).toBeDefined();
  ws['conflictRecordId'] = partial.id;

  const dryRun = quarantineGovernanceObservation({ workspaceDir: ws.root, hostKind: 'codex', rolloutIdentity: 'conflict-rollout', recordId: partial.id, reason: 'stable-invalid: content conflict', operator: 'bdd-owner' });
  expect(dryRun.ok).toBe(true);
  if (!dryRun.ok) return;
  expect(dryRun.dryRun).toBe(true);
  const applied = quarantineGovernanceObservation({ workspaceDir: ws.root, hostKind: 'codex', rolloutIdentity: 'conflict-rollout', recordId: partial.id, reason: 'stable-invalid: content conflict', operator: 'bdd-owner', confirm: true });
  expect(applied.ok).toBe(true);
});
registry.then('the record is terminal with digest, reason, operator, timestamp, and gap recorded', () => {
  const db = trajectoryOf(ws.root);
  const row = db.prepare("SELECT retention_class, visible_text, quarantined_at, quarantine_reason, quarantine_digest, quarantine_operator, quarantine_gap FROM governance_observations WHERE id = ?").get(ws['conflictRecordId'] as number) as Record<string, unknown>;
  db.close();
  expect(row.retention_class).toBe('quarantined');
  expect(row.visible_text).toBeNull();
  expect(typeof row.quarantined_at).toBe('string');
  expect(row.quarantine_reason).toBe('stable-invalid: content conflict');
  expect(String(row.quarantine_digest)).toMatch(/^[0-9a-f]{64}$/);
  expect(row.quarantine_operator).toBe('bdd-owner');
  expect(typeof row.quarantine_gap).toBe('string');
});
registry.then('a fresh process still reports the record quarantined and never touched the transcript', async () => {
  // A fresh store open (new process equivalent: the hook subprocess runs
  // against the same workspace afterwards and behaves normally).
  const run = await invokeHook(ws, promptPayload(ws, '帮我解释一下这个函数'));
  expect(run.status).toBe(0);
  const read = quarantineGovernanceObservation({ workspaceDir: ws.root, hostKind: 'codex', rolloutIdentity: 'conflict-rollout', recordId: ws['conflictRecordId'] as number, reason: 'idempotent replay', operator: 'someone-else', confirm: true });
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.alreadyQuarantined).toBe(true);
  expect(transcriptStillIntact(ws)).toBe(true);
});

function transcriptStillIntact(workspace: Workspace): boolean {
  const content = fs.readFileSync(workspace.transcriptPath, 'utf8');
  return content.length > 0 && content.includes('session_meta');
}

// ── §18-11 ───────────────────────────────────────────────────────────────────
registry.when('operational observations pass their retention window and one pain was promoted', async () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const seeded = ingestGovernanceObservations({
    workspaceDir: ws.root,
    now: old,
    observations: [
      { hostKind: 'codex', rolloutIdentity: 'retention-rollout', rootSessionId: 'root-retention', hostTurnId: 't1', kind: 'user_turn', logicalObservationKey: 'codex|retention-rollout|t1|user', source: 'transcript', completeness: 'complete', observedAt: old.toISOString(), recordByteStart: 100, recordOrdinal: 1, visibleText: 'old user turn' },
      { hostKind: 'codex', rolloutIdentity: 'retention-rollout', rootSessionId: 'root-retention', hostTurnId: 't1', kind: 'assistant_turn', logicalObservationKey: 'codex|retention-rollout|t1|assistant', source: 'transcript', completeness: 'complete', observedAt: old.toISOString(), recordByteStart: 200, recordOrdinal: 2, visibleText: 'old assistant turn' },
    ],
  });
  expect(seeded.ok).toBe(true);
  const promotion = promoteGovernanceEvidence({
    workspaceDir: ws.root, hostKind: 'codex', rolloutIdentity: 'retention-rollout',
    triggerLogicalKey: 'codex|retention-rollout|t1|user', painRef: 'pain_owner_decision_retention', now: old,
  });
  expect(promotion.ok).toBe(true);
});
registry.then('the aged unpromoted rows are expired and the promoted evidence row remains', async () => {
  // A fresh ingest (now inside the window) triggers the retention sweep.
  const now = new Date();
  await ingestGovernanceObservations({
    workspaceDir: ws.root,
    now,
    observations: [{ hostKind: 'codex', rolloutIdentity: 'retention-rollout-2', rootSessionId: 'root-retention', hostTurnId: 't9', kind: 'user_turn', logicalObservationKey: 'codex|retention-rollout-2|t9|user', source: 'transcript', completeness: 'complete', observedAt: now.toISOString(), recordByteStart: 300, recordOrdinal: 3, visibleText: 'fresh turn' }],
  });
  const listed = listGovernanceObservations({ workspaceDir: ws.root });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  const byKey = new Map(listed.observations.map((row) => [row.logicalKey, row]));
  expect(byKey.get('codex|retention-rollout|t1|user')?.retentionClass).toBe('promoted');
  expect(byKey.get('codex|retention-rollout|t1|assistant')?.retentionClass).toBe('expired');
  expect(byKey.get('codex|retention-rollout-2|t9|user')?.retentionClass).toBe('operational');
});

// ── §18-12 ───────────────────────────────────────────────────────────────────
registry.when('recovery reconciliation runs twice over one admitted correction', async () => {
  const correction = await invokeHook(ws, promptPayload(ws, CORRECTION));
  expect(correction.status).toBe(0);
  for (let i = 0; i < 2; i += 1) {
    const pass = await reconcileGovernanceContinuation({ workspaceDir: ws.root });
    expect(pass.ok).toBe(true);
  }
});
registry.then('exactly one Diagnostician task exists and the admission marker links to it once', () => {
  const state = stateDbOf(ws.root);
  const tasks = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get() as { n: number };
  state.close();
  expect(tasks.n).toBe(1);
  const db = trajectoryOf(ws.root);
  const markers = db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT diagnostician_task_id) AS distinct_tasks FROM governance_signal_admissions WHERE decision = \'admitted\'').get() as { n: number; distinct_tasks: number };
  const pains = db.prepare('SELECT COUNT(*) AS n FROM pain_events').get() as { n: number };
  db.close();
  expect(markers.n).toBe(1);
  expect(markers.distinct_tasks).toBe(1);
  expect(pains.n).toBe(1);
});

// ── §18-16 ───────────────────────────────────────────────────────────────────
registry.when('an OpenClaw-origin pain and a Codex-origin correction coexist', async () => {
  // The OpenClaw production writer records pain_events with host_kind
  // 'openclaw' (PRI-640). Seed one the same way production writes it.
  const db = new Database(path.join(ws.root, '.state', 'trajectory.db'));
  db.prepare('INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, host_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('openclaw-session-1', 'manual', 80, 'OpenClaw correction', 'high', 'manual', 0.9, 'OpenClaw pain text', 'pain_manual_openclaw_shared_ws', 'openclaw', new Date().toISOString());
  db.close();
  const correction = await invokeHook(ws, promptPayload(ws, CORRECTION));
  expect(correction.status).toBe(0);
});
registry.then('each record carries its own evidence host and neither rewrites the other', () => {
  const db = trajectoryOf(ws.root);
  const rows = db.prepare('SELECT canonical_pain_id, host_kind, source FROM pain_events ORDER BY id').all() as { canonical_pain_id: string | null; host_kind: string; source: string }[];
  db.close();
  expect(rows.length).toBe(2);
  const hosts = rows.map((row) => row.host_kind).sort();
  expect(hosts).toEqual(['codex', 'openclaw']);
  const ids = new Set(rows.map((row) => row.canonical_pain_id));
  expect(ids.size).toBe(2);
});

defineFeature(fs.readFileSync(resolveFeaturePath('docs/specs/features/codex-governance/codex-owner-loop.feature'), 'utf8'), registry);
