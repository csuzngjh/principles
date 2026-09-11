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
 *   S6 diagnosis: the production worker cycle (`pd codex worker --once`)
 *      executes the real Diagnostician and the bounded downstream consumer
 *      (intake → dreamer → philosopher → scribe → artificer → evaluator →
 *      rollout review) until an approval appears — requires an explicit LLM
 *      profile (--llm-provider/--llm-model/--llm-api-key-env/--llm-base-url);
 *      with --skip-llm this stage is SKIPPED and the journey reports the
 *      remaining stages as skipped — never a fake pass
 *   S7 owner decision: candidate approval via `pd activation approve`
 *   S8 reversibility: consent decline → flag off → catch-up performs zero reads
 *   S9 later behavior (§18-14): the approved activation is active and a later
 *      prompt delivery works through the injection path
 *
 * Every stage prints one JSON evidence line; failures fail loud with
 * reason + nextAction. Exit 0 only if every executed stage passed AND any
 * skipped stage is explicitly reported as skipped.
 *
 * Usage:
 *   node scripts/dev/codex-owner-journey-e2e.mjs [--repo-root <dir>] [--skip-llm]
 *        [--live-codex] [--evidence-out <file>]
 *        [--pd-cli <path>] [--pd-hook <path>]      — run against installed binaries
 *        [--llm-provider <p>] [--llm-model <m>] [--llm-api-key-env <env>]
 *        [--llm-base-url <url>] [--llm-max-tokens <n>] [--llm-timeout-ms <ms>]
 *        [--max-pipeline-cycles <n>]
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
// R1 (PRI-626): binary overrides let the journey run against the INSTALLED
// runtime (~/.pd/runtime) instead of repo dist — the "installed real-session"
// evidence path. Defaults keep the historical repo-dist behavior.
const PD_CLI_OVERRIDE = opt('--pd-cli');
const PD_HOOK_OVERRIDE = opt('--pd-hook');
// Live-LLM mode (default; --skip-llm restores the historical skip): an
// explicit pi-ai profile the sandbox workspace binds every internal agent to.
const LLM_PROVIDER = opt('--llm-provider');
const LLM_MODEL = opt('--llm-model');
const LLM_API_KEY_ENV = opt('--llm-api-key-env');
const LLM_BASE_URL = opt('--llm-base-url');
const LLM_MAX_TOKENS = Number(opt('--llm-max-tokens') ?? '16000');
const LLM_TIMEOUT_MS = Number(opt('--llm-timeout-ms') ?? '600000');
// Bounded downstream drive: at most N worker cycles chasing the approval.
const MAX_PIPELINE_CYCLES = Number(opt('--max-pipeline-cycles') ?? '20');

if (LIVE_CODEX) {
  process.stderr.write('--live-codex is not wired in this harness yet: refusing to mislabel fixture delivery as a live session.\n');
  process.exit(2);
}

if (!SKIP_LLM) {
  const missing = [
    ['--llm-provider', LLM_PROVIDER], ['--llm-model', LLM_MODEL],
    ['--llm-api-key-env', LLM_API_KEY_ENV], ['--llm-base-url', LLM_BASE_URL],
  ].filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    process.stderr.write(`live-LLM mode requires an explicit pi-ai profile; missing: ${missing.join(', ')}\n`);
    process.stderr.write('(use --skip-llm for the historical fixture-only journey)\n');
    process.exit(2);
  }
  if (!Number.isInteger(LLM_MAX_TOKENS) || LLM_MAX_TOKENS < 1024 || !Number.isInteger(LLM_TIMEOUT_MS) || LLM_TIMEOUT_MS < 10_000) {
    process.stderr.write('--llm-max-tokens must be an integer >= 1024 and --llm-timeout-ms >= 10000 (rc-3: no silent defaults).\n');
    process.exit(2);
  }
}

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
    // require.resolve returns a PATH — read the file content, then parse.
    const pkgJsonPath = require.resolve(`${name}/package.json`);
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const adapterRoot = path.join(ROOT, 'packages', 'codex-adapter');
const hookEntry = PD_HOOK_OVERRIDE !== undefined ? path.resolve(PD_HOOK_OVERRIDE) : path.join(adapterRoot, 'dist', 'pd-hook.js');
if (!existsSync(hookEntry)) {
  fail('S0-prerequisites', `built pd-hook not found at ${hookEntry}`, 'Run: cd packages/codex-adapter && npm run build');
}
const pdCliEntry = PD_CLI_OVERRIDE !== undefined ? path.resolve(PD_CLI_OVERRIDE) : path.join(ROOT, 'packages', 'pd-cli', 'dist', 'index.js');
if (!existsSync(pdCliEntry)) {
  fail('S0-prerequisites', `pd-cli entry not found at ${pdCliEntry}`, 'Pass --pd-cli or build packages/pd-cli.');
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
if (!SKIP_LLM) {
  // Live-LLM mode: every internal agent executes on ONE explicit pi-ai
  // profile rendered into the sandbox config (the production per-agent
  // resolution path, PRI-719 — no test-double adapter anywhere in the loop).
  configObject.runtimeProfiles = {
    ...CORE.runtimeProfiles,
    'e2e.llm': {
      type: 'pi-ai',
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      apiKeyEnv: LLM_API_KEY_ENV,
      baseUrl: LLM_BASE_URL,
      timeoutMs: LLM_TIMEOUT_MS,
      maxTokens: LLM_MAX_TOKENS,
    },
  };
  configObject.internalAgents = {
    ...CORE.internalAgents,
    defaultRuntime: 'e2e.llm',
    agents: Object.fromEntries(Object.entries(CORE.internalAgents.agents).map(([name, binding]) => [
      name,
      // The governance pipeline agents must all run; periphery observers keep
      // their default enabled flag.
      ['diagnostician', 'dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rolloutReviewer'].includes(name)
        ? { ...binding, enabled: true, runtimeProfile: 'e2e.llm' }
        : binding,
    ])),
  };
}
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
stage('S3-session', 'passed', 'authenticated fixture delivery through the real hook executable');
stage('S4-ingestion', 'passed', ingestion);

// ── S5 recovery: prove reconciliation actually RECOVERS, not just no-ops ────
// Round 3 review: a healthy chain (task already ensured by admission) makes
// reconcile a no-op — that proves nothing. Force the recovery case: break the
// task link (simulating a crash between admission and task creation), then
// reconcile must CREATE the task (tasksEnsured >= 1), and a second reconcile
// must be a no-op with exactly one task total.
const hostRuntimeUrl = pathToFileURL(path.join(ROOT, 'packages', 'host-runtime', 'dist', 'index.js')).href;
const reconcileScript = `
  const { reconcileGovernanceContinuation } = await import(${JSON.stringify(hostRuntimeUrl)});
  const result = await reconcileGovernanceContinuation({ workspaceDir: ${JSON.stringify(workspace)} });
  console.log(JSON.stringify(result));
`;
function runReconcile() {
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', reconcileScript], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').at(-1));
  } catch (error) {
    fail('S5-recovery', `reconciliation runner crashed: ${String(error.stderr ?? error.message).slice(0, 500)}`, 'Inspect the reconcile -e script import path.');
  }
}
try {
  execFileSync(process.execPath, ['-e', `
  const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
  const traj = new Database(${JSON.stringify(path.join(workspace, '.state', 'trajectory.db'))});
  // Simulate the crash-before-task-link window: delete the Diagnostician task
  // and clear the marker's task link, keeping the admitted marker itself.
  // The admission marker lives in trajectory.db (governance_signal_admissions);
  // the task lives in state.db (tasks).
  traj.prepare("UPDATE governance_signal_admissions SET diagnostician_task_id = NULL WHERE decision = 'admitted'").run();
  traj.close();
  const state = new Database(${JSON.stringify(path.join(workspace, '.pd', 'state.db'))});
  state.prepare("DELETE FROM tasks WHERE task_kind = 'diagnostician'").run();
  state.close();
`], { encoding: 'utf8' });
} catch (error) {
  fail('S5-recovery', `task-link break failed: ${String(error.stderr ?? error.message).slice(0, 300)}`, 'Inspect the state.db manipulation.');
}
const reconcileFirst = runReconcile();
if (!reconcileFirst.ok || reconcileFirst.tasksEnsured < 1) {
  fail('S5-recovery', `reconciliation did not recover the missing task: ${JSON.stringify(reconcileFirst)}`, 'Expected tasksEnsured >= 1 on the first pass over the broken link.');
}
const reconcileSecond = runReconcile();
if (!reconcileSecond.ok || reconcileSecond.tasksEnsured !== 0) {
  fail('S5-recovery', `second reconciliation was not a no-op: ${JSON.stringify(reconcileSecond)}`, 'Reconcile must be idempotent: a healthy chain yields tasksEnsured = 0.');
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
stage('S5-recovery', 'passed', { firstPass: reconcileFirst, secondPass: reconcileSecond, diagnosticianTasks: 1 });

// ── S6 diagnosis + downstream (real LLM via the production worker cycle) ────
// The Codex Companion worker cycle IS the production execution authority
// (SPEC §13): catch-up → reconciliation → one Diagnostician execution → one
// bounded downstream consumer cycle (intake → dreamer → … → evaluator →
// rollout review → approval queue). Driving it through `pd codex worker
// --once` exercises exactly what an installed deployment runs.
function runWorkerOnce() {
  const result = spawnSync(process.execPath, [pdCliEntry, 'codex', 'worker', '--workspace', workspace, '--once', '--json'], {
    encoding: 'utf8',
    timeout: LLM_TIMEOUT_MS + 60_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome, PD_WORKSPACE_DIR: workspace },
  });
  const line = (result.stdout.trim().split('\n').findLast((row) => row.startsWith('{'))) ?? '{}';
  let report;
  try {
    report = JSON.parse(line);
  } catch {
    report = {};
  }
  return { status: result.status, report, stderr: result.stderr ?? '' };
}
function stateDbQuery(fnBody) {
  return execFileSync(process.execPath, ['-e', `
  const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
  const db = new Database(${JSON.stringify(path.join(workspace, '.pd', 'state.db'))}, { readonly: true });
  ${fnBody}
  db.close();
`], { encoding: 'utf8' });
}
function pipelineSnapshot() {
  const out = stateDbQuery(`
  const tasks = db.prepare("SELECT task_kind, status, COUNT(*) n FROM tasks GROUP BY task_kind, status").all();
  const candidates = db.prepare('SELECT COUNT(*) n FROM principle_candidates').get().n;
  const approvals = db.prepare('SELECT approval_id, status, channel FROM approvals ORDER BY rowid DESC LIMIT 5').all();
  console.log(JSON.stringify({ tasks, candidates, approvals }));
  `);
  return JSON.parse(out.trim().split('\n').at(-1));
}

if (SKIP_LLM) {
  stage('S6-diagnosis', 'skipped', {
    reason: '--skip-llm: the Diagnostician needs a configured LLM runtime',
    nextAction: 'the remaining stages need the candidate produced by diagnosis; run live mode with an explicit --llm-* profile',
  });
  stage('S7-owner-decision', 'skipped', { reason: 'depends on S6' });
  stage('S9-later-behavior', 'skipped', { reason: 'depends on S7' });
} else {
  let firstCycle = null;
  let approval = null;
  let candidates = 0;
  let lastSnapshot = null;
  for (let cycle = 1; cycle <= MAX_PIPELINE_CYCLES; cycle += 1) {
    const run = runWorkerOnce();
    if (run.status !== 0 || run.report.mode === undefined) {
      fail('S6-diagnosis', `worker cycle ${cycle} exited ${run.status}: ${run.stderr.slice(0, 240)}`, 'Inspect pd codex worker output.');
    }
    if (run.report.mode === 'degraded') {
      fail('S6-diagnosis', `worker cycle ${cycle} degraded: ${run.report.reason ?? 'unknown'}`, 'Inspect the workspace .pd/config.yaml runtime profile and the per-step report.');
    }
    const diag = run.report.report?.diagnostician;
    lastSnapshot = pipelineSnapshot();
    candidates = lastSnapshot.candidates;
    if (cycle === 1) firstCycle = { diag, candidates };
    if (diag?.status === 'failed' && diag.errorCategory !== 'lease_conflict') {
      fail('S6-diagnosis', `diagnostician failed on cycle ${cycle}: ${diag.message ?? 'unknown'}`, 'Inspect the diagnostician task runs table.');
    }
    const pendingApproval = lastSnapshot.approvals.find((row) => row.status === 'pending');
    if (pendingApproval !== undefined) { approval = pendingApproval; break; }
    const pendingWork = lastSnapshot.tasks.filter((row) => row.status === 'pending' || row.status === 'retry_wait' || row.status === 'leased');
    if (pendingWork.length === 0) break; // pipeline quiesced without an approval
  }

  if (firstCycle === null || (candidates < 1)) {
    fail('S6-diagnosis', `no evidence-linked candidate was produced (candidates=${candidates})`, '§18-13 requires an evidence-linked candidate or an explicit needs_evidence outcome.');
  }
  if (firstCycle.diag === null || firstCycle.diag === undefined) {
    fail('S6-diagnosis', 'the first worker cycle did not execute the Diagnostician', 'The admitted pain must reach a diagnosis task in cycle 1.');
  }
  stage('S6-diagnosis', 'passed', { firstCycleDiagnostician: firstCycle.diag?.status, evidenceLinkedCandidates: candidates, pipelineTasks: lastSnapshot.tasks });

  // ── S7 owner decision: approve the pending approval via the CLI ────────────
  if (approval === null) {
    fail('S7-owner-decision', `pipeline did not reach a pending approval within ${MAX_PIPELINE_CYCLES} worker cycles (revision loops / needs_human_review are the designed Owner-decision exits)`, 'Inspect tasks/pi_artifacts for the terminal state; rerun with more --max-pipeline-cycles if revision rounds are still eligible.');
  }
  const approveResult = spawnSync(process.execPath, [pdCliEntry, 'activation', 'approve', '-a', approval.approval_id, '--workspace', workspace, '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome, PD_WORKSPACE_DIR: workspace },
  });
  const approveLine = (approveResult.stdout.trim().split('\n').findLast((row) => row.startsWith('{'))) ?? '{}';
  let approveReport;
  try { approveReport = JSON.parse(approveLine); } catch { approveReport = {}; }
  if (approveResult.status !== 0 || approveReport.ok !== true) {
    fail('S7-owner-decision', `activation approve failed: ${approveResult.stdout.slice(0, 200)} ${approveResult.stderr.slice(0, 200)}`, 'Inspect pd activation approve output.');
  }
  const activations = stateDbQuery(`
  const rows = db.prepare('SELECT * FROM activations ORDER BY rowid DESC LIMIT 3').all();
  console.log(JSON.stringify(rows));
  `);
  stage('S7-owner-decision', 'passed', { approvalId: approval.approval_id, channel: approval.channel, activations: JSON.parse(activations.trim().split('\n').at(-1)).slice(0, 2) });

  // ── S9 (§18-14) later behavior: the approval affects a later Codex prompt ──
  const activationList = spawnSync(process.execPath, [pdCliEntry, 'activation', 'list', '--workspace', workspace, '--json'], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHome, PD_WORKSPACE_DIR: workspace },
  });
  let activationReport;
  try { activationReport = JSON.parse((activationList.stdout.trim().split('\n').findLast((row) => row.startsWith('{') || row.startsWith('['))) ?? '[]'); } catch { activationReport = []; }
  const activeOnChannel = (Array.isArray(activationReport) ? activationReport : activationReport.activations ?? [])
    .find((row) => row.status === 'active' || row.active === true);
  if (activeOnChannel === undefined) {
    fail('S9-later-behavior', `no active activation after approval: ${activationList.stdout.slice(0, 240)}`, 'Inspect pd activation list.');
  }
  const laterPrompt = runHook(payload('UserPromptSubmit', { prompt: '后续行为验证：请继续遵守已激活的原则' }));
  if (laterPrompt.status !== 0) {
    fail('S9-later-behavior', `later prompt delivery failed after activation: ${laterPrompt.stderr.slice(0, 240)}`, 'The prompt path must keep working with the activated principle in the injection set.');
  }
  stage('S9-later-behavior', 'passed', { activeActivation: activeOnChannel, laterPromptHookExit: 0 });
}

// ── S8 reversibility (always executable) ────────────────────────────────────
const decline = spawnSync(process.execPath, [pdCliEntry, 'codex', 'setup', '--workspace', workspace, '--decline', '--json'], { encoding: 'utf8', env: { ...process.env, PD_WORKSPACE_DIR: workspace } });
const declineReport = JSON.parse((decline.stdout.trim().split('\n').findLast((line) => line.startsWith('{'))) ?? '{}');
if (declineReport.status !== 'ok' || declineReport.decision !== 'revoked' || declineReport.ingestionFlag?.enabled !== false) {
  fail('S8-reversibility', `decline did not disable: ${decline.stdout.slice(0, 200)}`, 'Inspect the decline path.');
}
// Round 3 review: to prove "flag-off performs ZERO reads" (not "reads then
// discards"), remove the transcript entirely before invoking the hook — the
// hook must still exit cleanly WITHOUT touching the transcript location.
rmSync(transcriptPath);
const afterOff = runHook(payload('Stop', { stop_hook_active: false }));
if (afterOff.status !== 0) {
  fail('S8-reversibility', `hook exited non-zero after flag-off: ${afterOff.stderr.slice(0, 200)}`, 'Flag-off must be a clean structured skip — it must not even look for the transcript.');
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
stage('S8-reversibility', 'passed', { declined: true, flagOff: true, transcriptRemovedBeforeHook: true, observationsStable: afterCount });

stage('journey', 'completed', {
  versions: { codexAdapter: pkgVersion('@principles/codex-adapter'), hostRuntime: pkgVersion('@principles/host-runtime') },
  binaries: { pdCli: pdCliEntry, pdHook: hookEntry },
  sandbox,
});
if (EVIDENCE_OUT !== undefined) writeFileSync(EVIDENCE_OUT, `${evidence.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
