#!/usr/bin/env node
/**
 * WorkBuddy Phase A retirement probe (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-
 * ARCHITECTURE-001 v0.3, Phase A).
 *
 * This file used to be the PTUF admission lab: it synthesized a real
 * PostToolUse failure, injected `painEnrichmentProvider` evidence and called
 * `hostRuntime.admitBareHostPains()` to observe the retired bare-pain
 * admission. Phase A deleted that API, so the lab is now a RETIREMENT check
 * against the current production entry points only:
 *
 *   - `processWorkbuddyHookInvocation` (the real per-event hook entry), and
 *   - `runWorkbuddyWorkspaceWorkerCycle` (the real companion worker cycle).
 *
 * It runs in an isolated temporary HOME (so OD-07 resolution lands in a
 * throwaway `.workbuddy/pd-workspace`) with a REAL SQLite trajectory store,
 * and asserts the Phase A contract:
 *
 *   1. a genuine WorkBuddy tool failure is consumed through the hook entry;
 *   2. the tool execution fact is recorded (EventLog + normalized row);
 *   3. `tool_calls` receives outcome/exit code/error attribution;
 *   4. NO automatic Tool Failure Pain is created (`pain_events` stays empty);
 *   5. NO Diagnostician task is created for the failure;
 *   6. the EventLog and tool facts are intact (nothing was "retired" away);
 *   7. governance continuation (`report.reconcile`) and the Phase B Stage-2
 *      correction step (`report.stage2`) still run.
 *
 * Run: `node scripts/dev/workbuddy-probe/verify-ptuf-admission-lab.mjs`
 * Exit code 0 = the retirement holds; non-zero = a regression.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDefaultPdConfig } from '@principles/core/runtime-v2';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import {
  processWorkbuddyHookInvocation,
  runWorkbuddyWorkspaceWorkerCycle,
} from '@principles/workbuddy-adapter';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  'packages',
  'workbuddy-adapter',
  'tests',
  'fixtures',
  'host-contract',
  'events',
);

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    process.stdout.write(`PASS  ${name}\n`);
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
    process.stdout.write(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`);
  }
}

function fixturePayload(name, overrides = {}) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
  if (typeof fixture.payload !== 'object' || fixture.payload === null || Array.isArray(fixture.payload)) {
    throw new Error(`fixture ${name} carries no payload object`);
  }
  return { ...Object.fromEntries(Object.entries(fixture.payload)), ...overrides };
}

function makeTrajectory(governance) {
  fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
  const db = new Database(path.join(governance, '.state', 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
}

function makeIsolatedWorkspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-phase-a-home-'));
  const governance = getWorkbuddyWorkspaceDir(home);
  const config = getDefaultPdConfig();
  if (config.features['host.workbuddy']) config.features['host.workbuddy'].enabled = true;
  fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), JSON.stringify(config));
  makeTrajectory(governance);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-wb-phase-a-project-'));
  return { home, governance, project };
}

function countRows(dbPath, table, where = '') {
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get();
    return typeof row?.n === 'number' ? row.n : 0;
  } finally {
    db.close();
  }
}

async function main() {
  const { home, governance, project } = makeIsolatedWorkspace();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    const payload = fixturePayload('post-tool-use-bash-exit7.json', { cwd: project });
    const result = await processWorkbuddyHookInvocation(
      JSON.stringify(payload),
      'PostToolUse',
      { HOME: home, USERPROFILE: home },
    );

    // 1 + 2: the real entry consumed the event and treated it as a failure.
    check('hook entry accepts a real PostToolUse failure', result.exitCode === 0, `exitCode=${result.exitCode}`);
    check('failure stays non-blocking on PostToolUse', result.stdout === null, `stdout=${JSON.stringify(result.stdout)}`);

    const trajectory = path.join(governance, '.state', 'trajectory.db');
    check('tool execution fact is recorded before any assertion', fs.existsSync(trajectory));

    // 3: normalized tool_facts row with error attribution.
    const db = new Database(trajectory, { readonly: true });
    let rows;
    try {
      rows = db.prepare(
        'SELECT session_id, tool_name, outcome, exit_code, error_message FROM tool_calls ORDER BY id',
      ).all();
    } finally {
      db.close();
    }
    check('exactly one tool_calls row is written', rows.length === 1, `rows=${rows.length}`);
    check('tool_calls keeps the failure outcome', rows[0]?.outcome === 'failure', `outcome=${rows[0]?.outcome}`);
    check('tool_calls keeps the real exit code', rows[0]?.exit_code === 7, `exit_code=${rows[0]?.exit_code}`);
    check('tool_calls keeps error attribution', typeof rows[0]?.error_message === 'string' && rows[0].error_message.length > 0);

    // 4 + 5: retirement contract — no automatic Pain, no Diagnostician work.
    check('no automatic Tool Failure Pain is created', countRows(trajectory, 'pain_events') === 0);
    check('no Diagnostician task is created',
      countRows(path.join(governance, '.pd', 'state.db'), 'tasks', " WHERE task_kind = 'diagnostician'") === 0);

    // 6: EventLog raw facts are still there.
    const logsDir = path.join(governance, '.state', 'logs');
    const logLines = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir)
        .filter((file) => file.startsWith('events_') && file.endsWith('.jsonl'))
        .flatMap((file) => fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean))
      : [];
    check('EventLog keeps the raw event line',
      logLines.some((line) => line.includes(payload.session_id)));

    // 7: the companion worker cycle (governance continuation + Stage 2).
    const cycle = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    check('worker cycle is not paused', cycle.mode !== 'paused', `mode=${cycle.mode}`);
    check('governance continuation reconcile still runs', typeof cycle.report?.reconcile === 'object' && cycle.report.reconcile !== null);
    check('Phase B Stage-2 correction step still runs', typeof cycle.report?.stage2 === 'object' && cycle.report.stage2 !== null);
    check('tool failures alone never pick a Diagnostician candidate', cycle.report?.diagnostician === null);
    check('the worker cycle adds no Pain either', countRows(trajectory, 'pain_events') === 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
}

main().then(
  () => {
    if (failures.length === 0) {
      process.stdout.write('\nPhase A retirement probe: OK\n');
      process.exit(0);
    }
    process.stdout.write(`\nPhase A retirement probe: ${failures.length} failure(s)\n`);
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exit(1);
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
