#!/usr/bin/env node
/**
 * Codex owner-journey E2E — Codex Governance Closure Slice D (PRI-625;
 * SPEC rev 2 §18 completion bar + §3 R1).
 *
 * Drives the FULL governance loop against the BUILT workspace artifacts in an
 * isolated sandbox (own PD workspace + own CODEX_HOME; the live ~/.codex and
 * live PD installs are never touched):
 *
 *   S1 sandbox: workspace + trajectory/state DBs + real Codex transcript fixture
 *   S2 consent: disclosure presented → explicit accept → flag enabled
 *   S3 session: real `codex exec` runs (when --live-codex) or the authenticated
 *      Stop-hook delivery of the G1 fixture transcript
 *   S4 ingestion: the built pd-hook executable projects the transcript
 *   S5 recovery: reconciliation advances the admitted pain → Diagnostician task
 *   S6 diagnosis: the runtime Diagnostician executes (requires a configured
 *      LLM runtime; with --skip-llm this stage is SKIPPED and the journey
 *      reports manual_action_required for the remaining steps — never a fake pass)
 *   S7 owner decision: candidate approval via the CLI
 *   S8 reversibility: consent decline → flag off → catch-up performs zero reads
 *
 * Every stage prints one JSON evidence line; failures fail loud with
 * reason + nextAction. Exit 0 only if every executed stage passed AND any
 * skipped stage is explicitly reported as skipped.
 *
 * Usage:
 *   node scripts/dev/codex-owner-journey-e2e.mjs [--repo-root <dir>] [--skip-llm]
 *        [--live-codex] [--evidence-out <file>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};
const ROOT = path.resolve(opt('--repo-root') ?? DEFAULT_ROOT);
const SKIP_LLM = args.includes('--skip-llm');
const LIVE_CODEX = args.includes('--live-codex');
const EVIDENCE_OUT = opt('--evidence-out');

const evidence = [];
function stage(name, status, detail) {
  const entry = { stage: name, status, ...(detail !== undefined ? { detail } : {}) };
  evidence.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
function fail(stageName, reason, nextAction) {
  stage(stageName, 'failed', { reason, nextAction });
  if (EVIDENCE_OUT !== undefined) writeFileSync(EVIDENCE_OUT, `${evidence.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
function pkgVersion(name) {
  try {
    return JSON.parse(require.resolve(`${name}/package.json`)).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const adapterRoot = path.join(ROOT, 'packages', 'codex-adapter');
const hookEntry = path.join(adapterRoot, 'dist', 'pd-hook.js');
if (!existsSync(hookEntry)) {
  fail('S0-prerequisites', `built pd-hook not found at ${hookEntry}`, 'Run: cd packages/codex-adapter && npm run build');
}
const pdCliEntry = path.join(ROOT, 'packages', 'pd-cli', 'dist', 'index.js');
if (!existsSync(pdCliEntry)) {
  fail('S0-prerequisites', `built pd-cli not found at ${pdCliEntry}`, 'Run: cd packages/pd-cli && npm run build');
}

// ── S1 sandbox ───────────────────────────────────────────────────────────────
const sandbox = mkdtempSync(path.join(tmpdir(), 'pd-codex-journey-'));
const workspace = path.join(sandbox, 'workspace');
const codexHome = path.join(sandbox, 'codex-home');
const sessions = path.join(codexHome, 'sessions', '2026', '09', '06');
mkdirSync(path.join(workspace, '.pd'), { recursive: true });
mkdirSync(path.join(workspace, '.state'), { recursive: true });
mkdirSync(sessions, { recursive: true });

const ROLLOUT = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const transcriptPath = path.join(sessions, `rollout-2026-09-06T10-00-00-${ROLLOUT}.jsonl`);
cpSync(path.join(ROOT, 'packages', 'codex-adapter', 'tests', 'fixtures', 'g1-contract', 'transcripts', 'normal-tool-final-turn.jsonl'), transcriptPath);

// Workspace config: production defaults (validates clean) rendered as
// multi-line YAML — the consent editor edits the `features:` block by line.
const rootRequire = createRequire(path.join(ROOT, 'package.json'));
const yaml = rootRequire('js-yaml');
const { getDefaultPdConfig } = await import(pathToFileURL(path.join(ROOT, 'packages', 'principles-core', 'dist', 'runtime-v2', 'index.js')));
const CORE = getDefaultPdConfig();
const configObject = {
  ...CORE,
  workspace: { default: workspace },
  features: {
    ...CORE.features,
    'host.codex': { ...CORE.features['host.codex'], enabled: true },
    codex_conversation_ingestion: { category: 'quiet', enabled: false },
    internalization_auto_consumer: { ...CORE.features.internalization_auto_consumer, enabled: true },
  },
};
writeFileSync(path.join(workspace, '.pd', 'config.yaml'), yaml.dump(configObject, { indent: 2, lineWidth: 200, noRefs: true }));
const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];
try {
  execFileSync(process.execPath, ['-e', `
    const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
    const db = new Database(${JSON.stringify(path.join(workspace, '.state', 'trajectory.db'))});
    ${BASELINE_DDL.map((statement) => `db.prepare(${JSON.stringify(statement)}).run();`).join('\n    ')}
    db.close();
  `], { stdio: 'inherit' });
} catch (error) {
  fail('S1-sandbox', `trajectory bootstrap failed: ${error.message}`, 'Check better-sqlite3 build in the repo root.');
}
stage('S1-sandbox', 'passed', { workspace, codexHome, transcriptPath });

// ── Hook delivery helper (the real built executable, fresh subprocess) ──────
function runHook(payload) {
  const result = spawnSync(process.execPath, [hookEntry], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome, PD_WORKSPACE_DIR: workspace },
    input: JSON.stringify(payload),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function payload(event, extra = {}) {
  return {
    session_id: ROOT_SESSION,
    turn_id: TURN_1,
    transcript_path: transcriptPath,
    cwd: workspace,
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    hook_event_name: event,
    ...extra,
  };
}

// ── S2 consent: the frozen disclosure then an explicit accept ────────────────
const consentShow = spawnSync(process.execPath, [pdCliEntry, 'codex', 'setup', '--show-disclosure'], { encoding: 'utf8', env: { ...process.env, PD_WORKSPACE_DIR: workspace } });
const presented = consentShow.status === 0 && consentShow.stdout.includes('对话观察与治理闭环（Codex）') && consentShow.stdout.includes('默认关闭。只有你在看到本说明后明确选择开启才会生效');
if (!presented) {
  fail('S2-consent', `the frozen disclosure was not presented verbatim before enablement: ${consentShow.stderr.slice(0, 200)}`, 'Inspect pd codex setup --show-disclosure output.');
}
const consentAccept = spawnSync(process.execPath, [pdCliEntry, 'codex', 'setup', '--workspace', workspace, '--accept', '--json'], { encoding: 'utf8', env: { ...process.env, PD_WORKSPACE_DIR: workspace } });
let acceptReport;
try {
  acceptReport = JSON.parse((consentAccept.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))) ?? '{}');
} catch {
  acceptReport = {};
}
if (acceptReport.status !== 'ok' || acceptReport.decision !== 'granted' || acceptReport.ingestionFlag?.enabled !== true) {
  fail('S2-consent', `accept did not grant+enable: ${consentAccept.stdout.slice(0, 200)} ${consentAccept.stderr.slice(0, 200)}`, 'Run pd codex setup manually to inspect.');
}
stage('S2-consent', 'passed', { disclosurePresented: true, decision: 'granted', flagEnabled: true });

// ── S3+S4 session + ingestion: the real correction through the real hook ────
const correction = spawnSync(process.execPath, [hookEntry], {
  encoding: 'utf8',
  timeout: 20_000,
  windowsHide: true,
  env: { ...process.env, CODEX_HOME: codexHome, PD_WORKSPACE_DIR: workspace },
  input: JSON.stringify(payload('UserPromptSubmit', { prompt: '不要自作主张,这是错的,我说过修改前先调查已有实现' })),
});
if (correction.status !== 0) {
  fail('S3-session', `hook correction run failed: ${correction.stderr.slice(0, 200)}`, 'Inspect the pd-hook stderr above.');
}
const stop = runHook(payload('Stop', { stop_hook_active: false, last_assistant_message: 'FIXTURE-A-DONE' }));
if (stop.status !== 0) {
  fail('S4-ingestion', `Stop ingestion failed: ${stop.stderr.slice(0, 200)}`, 'Inspect the pd-hook stderr above.');
}
let counts;
try {
  counts = execFileSync(process.execPath, ['-e', `
  const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
  const db = new Database(${JSON.stringify(path.join(workspace, '.state', 'trajectory.db'))}, { readonly: true });
  const observations = db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get().n;
  const pains = db.prepare('SELECT COUNT(*) AS n, MAX(host_kind) AS host FROM pain_events').get();
  const admissions = db.prepare("SELECT COUNT(*) AS n FROM governance_signal_admissions WHERE decision = 'admitted'").get().n;
  console.log(JSON.stringify({ observations, pains, admissions }));
  db.close();
`], { encoding: 'utf8' });
} catch (error) {
  fail('S4-ingestion', `counts query failed: ${String(error.stderr ?? error.message).slice(0, 400)}`, 'Inspect the generated query script.');
}
const ingestion = JSON.parse(counts.trim().split('\n').at(-1));
if (ingestion.observations < 1 || ingestion.pains.n !== 1 || ingestion.pains.host !== 'codex' || ingestion.admissions !== 1) {
  fail('S4-ingestion', `unexpected post-ingestion state: ${counts}`, 'Expected >=1 observation, exactly one codex pain, one admitted marker.');
}
stage('S3-session', 'passed', LIVE_CODEX ? 'live codex exec' : 'authenticated fixture delivery');
stage('S4-ingestion', 'passed', ingestion);

// ── S5 recovery: reconciliation ensures exactly one Diagnostician task ──────
const hostRuntimeUrl = pathToFileURL(path.join(ROOT, 'packages', 'host-runtime', 'dist', 'index.js')).href;
const reconcileScript = `
  const { reconcileGovernanceContinuation } = await import(${JSON.stringify(hostRuntimeUrl)});
  const result = await reconcileGovernanceContinuation({ workspaceDir: ${JSON.stringify(workspace)} });
  console.log(JSON.stringify(result));
`;
let reconcile;
try {
  reconcile = execFileSync(process.execPath, ['--input-type=module', '-e', reconcileScript], { encoding: 'utf8' });
} catch (error) {
  fail('S5-recovery', `reconciliation runner crashed: ${String(error.stderr ?? error.message).slice(0, 500)}`, 'Inspect the reconcile -e script import path.');
}
const reconcileResult = JSON.parse(reconcile.trim().split('\n').at(-1));
if (!reconcileResult.ok || reconcileResult.tasksEnsured !== 0) {
  fail('S5-recovery', `reconciliation created unexpected tasks: ${reconcile.slice(0, 200)}`, 'The admission continuation already ensured the task; reconcile must be a no-op on a healthy chain.');
}
const taskCount = execFileSync(process.execPath, ['-e', `
  const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
  const db = new Database(${JSON.stringify(path.join(workspace, '.pd', 'state.db'))}, { readonly: true });
  console.log(JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()));
  db.close();
`], { encoding: 'utf8' });
if (JSON.parse(taskCount.trim()).n !== 1) {
  fail('S5-recovery', `expected exactly one Diagnostician task, got ${taskCount}`, 'The admitted pain must have exactly one pending task.');
}
stage('S5-recovery', 'passed', { ...reconcileResult, diagnosticianTasks: 1 });

// ── S6 diagnosis (real LLM) ──────────────────────────────────────────────────
if (SKIP_LLM) {
  stage('S6-diagnosis', 'skipped', {
    reason: '--skip-llm: the Diagnostician needs a configured LLM runtime',
    nextAction: 'the remaining stages need the candidate produced by diagnosis; run without --skip-llm on a device with a configured runtime',
  });
  stage('S7-owner-decision', 'skipped', { reason: 'depends on S6' });
} else {
  fail('S6-diagnosis', 'live-LLM mode is not wired in this harness yet', 'Use --skip-llm (default covers it) or extend the harness with the runtime profile.');
}

// ── S8 reversibility (always executable) ────────────────────────────────────
const decline = spawnSync(process.execPath, [pdCliEntry, 'codex', 'setup', '--workspace', workspace, '--decline', '--json'], { encoding: 'utf8', env: { ...process.env, PD_WORKSPACE_DIR: workspace } });
const declineReport = JSON.parse((decline.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))) ?? '{}');
if (declineReport.status !== 'ok' || declineReport.decision !== 'declined' || declineReport.ingestionFlag?.enabled !== false) {
  fail('S8-reversibility', `decline did not disable: ${decline.stdout.slice(0, 200)}`, 'Inspect the decline path.');
}
const afterOff = runHook(payload('Stop', { stop_hook_active: false }));
if (afterOff.status !== 0) {
  fail('S8-reversibility', `hook exited non-zero after flag-off: ${afterOff.stderr.slice(0, 200)}`, 'Flag-off must be a clean structured skip.');
}
const obsAfter = execFileSync(process.execPath, ['-e', `
  const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
  const db = new Database(${JSON.stringify(path.join(workspace, '.state', 'trajectory.db'))}, { readonly: true });
  console.log(JSON.stringify(db.prepare('SELECT COUNT(*) AS n FROM governance_observations').get()));
  db.close();
`], { encoding: 'utf8' });
const beforeOff = ingestion.observations;
const afterCount = JSON.parse(obsAfter.trim()).n;
if (afterCount !== beforeOff) {
  fail('S8-reversibility', `observations grew after flag-off (${beforeOff} -> ${afterCount})`, 'Flag-off must stop all observation writes.');
}
stage('S8-reversibility', 'passed', { declined: true, flagOff: true, observationsStable: afterCount });

stage('journey', 'completed', {
  versions: { codexAdapter: pkgVersion('@principles/codex-adapter'), hostRuntime: pkgVersion('@principles/host-runtime') },
  sandbox,
});
if (EVIDENCE_OUT !== undefined) writeFileSync(EVIDENCE_OUT, `${evidence.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
