/**
 * WorkBuddy FULL-LEARNING E2E (SPEC §8 完整学习档; review R2/R3 remediation).
 *
 * TWO EVIDENCE CLASSES, KEPT DISTINCT (Owner mandate):
 *
 * 1. REAL-HOST evidence: the REAL WorkBuddy engine produces a real failing
 *    tool call; the hook records it (tool_calls, outcome=failure, attributed).
 *    Whether a REAL failure is admission-eligible is MEASURED, not assumed
 *    (review §4): the script drives a real Write-THROWN failure (invalid
 *    drive — the proven thrown shape in probe-write-failure-shapes.mjs) and
 *    classifies from the trajectory store — pain row → PASS (admitted);
 *    tool_calls row without pain → PASS (policy-excluded, evidence recorded);
 *    no post-event at all → BLOCKED on evidence (engine 2.161.0 SHA-256
 *    1b1a01bc… fired no post-event for Write failures with the four-event
 *    baseline; the PostToolUseFailure subscription is landing separately).
 *    Bash failures (PostToolUse, exitCode) remain evidence-only under the
 *    frozen cross-host WRITE_TOOLS admission policy.
 *
 * 2. SYNTHETIC-PROTOCOL evidence (legitimate protocol-shaped input through
 *    the REAL dist entry — the same class the independent review's R2 lab
 *    used): a Write-failure PostToolUse payload drives the REAL chain end to
 *    end — admission → diagnostician (REAL LLM, the live PD channel) →
 *    downstream → pending proposal → Owner approves via the REAL product
 *    entry (`pd activation approve`) → the next REAL engine turn carries the
 *    approved statement → withdrawal stops it.
 *
 * IDENTITY-CHAIN CORRELATION + CHANNEL DISPATCH (P2 remediation): the
 * acceptance surface is correlated BY IDS from this scenario's own synthetic
 * pain — admission (canonical_pain_id) → diagnostician task →
 * principle_candidates (task_id or diag_router input_ref) → chain tasks
 * (pi_metadata.correlationId) → pi_artifacts (source_task_id) → approvals
 * (artifact_id). Never a queue-wide pending[0] pick. Each candidate is then
 * verified on ITS production channel:
 *   - prompt            → approve → principleDraft.statement injection → withdraw;
 *   - code_tool_hook    → approve → durable approval/activation row (production
 *                         writer action, shadow by default; NO injection
 *                         assertion, NO live promotion);
 *   - implementation    → not_internalizable intake refusal is the policy
 *                         terminal: recorded explicitly as POLICY (never a
 *                         provider BLOCKED, never an injection PASS).
 * A chain whose candidates are ALL policy-terminal ends there honestly;
 * prompt legs are recorded SKIP (not FAIL) only when no prompt-channel
 * candidate exists. Empty chain / missing correlation / approve failure /
 * failed assertions are FAIL (nonzero); ONLY runs.error_category='rate_limit'
 * is BLOCKED.
 *
 * SCENARIO CONTRACT (round-4 R2 remediation, Owner mandate): the script runs
 * THREE separately declared acceptance scenarios via `--scenario` (default
 * full-principle-learning) — 完整原则学习 (full principle learning), 规则通道
 * (rule channel), 政策拒绝 (policy refusal). Each scenario declares its
 * REQUIRED step set and exit contract in the shared pure module
 * `lib/learning-scenario-contract.mjs` (imported by this script AND by the
 * regression tests — one source of truth for "what counts as success").
 * Success is NEVER derived from "no FAIL rows" or a dynamic PASS count:
 *   - FULL requires, from THIS run's identity chain: an actionable
 *     prompt-channel candidate → proposal → real approval (exit 0 + ok) →
 *     next-turn REAL injection of the approved statement → real deactivate →
 *     post-withdraw stop. Missing ANY required leg (empty queue, no prompt
 *     candidate, all-policy-terminal, rule-only, missing correlation,
 *     approval failure) → FAIL, non-zero exit, explicit reason.
 *   - RULE verifies the durable shadow activation row on its own channel and
 *     never asserts prompt injection.
 *   - POLICY proves the not_internalizable terminal honestly (POLICY rows)
 *     and its output states explicitly that full learning did NOT run; a
 *     policy refusal is NOT a provider BLOCKED.
 * BLOCKED (exit 2) comes ONLY from persisted evidence: runs.error_category=
 * 'rate_limit' on the chain's diagnostician task (or an unset provider key at
 * preflight). Ordinary execution failures are never generalized into rate
 * limits. The engine-capability probe (`real-eligible-signal`) is recorded
 * BLOCKED with `blocking: false` BY DECLARATION — its scope is the evidence-
 * class-1 observation; the acceptance chain's declared evidence class is
 * SYNTHETIC-PROTOCOL input (evidence class 2), so the probe stays visible
 * without owning the scenario exit.
 *
 * Agent-loop model decisions are scripted by the local mock server (genuine
 * engine behavior); everything governance-side is the real product stack.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  EXIT_CODES,
  SCENARIOS,
  SCENARIO_IDS,
  STEPS,
  VERDICTS,
  evaluateScenario,
  formatEvaluationReport,
  resolveScenarioId,
} from './lib/learning-scenario-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(REPO, 'package.json'));
const Database = require('better-sqlite3');
const { getDefaultPdConfig } = require('@principles/core/runtime-v2');

const LAB_ROOT = path.join(
  process.env.WB_E2E_LAB || path.resolve(REPO, '../../../wb-probe-lab'),
  `e2e-learn-${Date.now()}`,
);
const ISO = path.join(LAB_ROOT, 'iso');
const FAKE_HOME = path.join(LAB_ROOT, 'fake-home');
const GOV = path.join(FAKE_HOME, '.workbuddy', 'pd-workspace');
const PROJECT = path.join(LAB_ROOT, 'project-a');
const ENGINE = process.env.WB_ENGINE || 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const MOCK_PORT = 39491;
const PLUGIN_SRC = path.join(REPO, 'packages', 'workbuddy-adapter', 'plugin');
const ADAPTER_ENTRY = path.join(REPO, 'packages', 'workbuddy-adapter', 'dist', 'pd-hook.js');
const PD_CLI = path.join(REPO, 'packages', 'pd-cli', 'dist', 'index.js');
const MARKET_NAME = 'pd-e2e-market';
const PLUGIN_NAME = 'principles-disciple';
const LLM_KEY_ENV = 'AMD_RADEON_API_KEY';

// ── Scenario selection (--scenario, default full-principle-learning) ─────────
/** undefined = flag not given (→ default); null = flag given WITHOUT a value
 * (usage error, rc-3 — never silently resolve to the default). */
function parseScenarioArg(argv) {
  const flagIndex = argv.indexOf('--scenario');
  if (flagIndex >= 0) {
    const value = argv[flagIndex + 1];
    return value === undefined || value.startsWith('--') ? null : value;
  }
  const withValue = argv.find((a) => a.startsWith('--scenario='));
  return withValue ? withValue.slice('--scenario='.length) : undefined;
}
const RAW_SCENARIO = parseScenarioArg(process.argv);
const SCENARIO = RAW_SCENARIO === null ? null : resolveScenarioId(RAW_SCENARIO);
if (SCENARIO === null) {
  console.error(RAW_SCENARIO === null
    ? `--scenario requires a value — known: ${Object.values(SCENARIO_IDS).join(', ')} (aliases: full | rule | policy). Default: ${SCENARIO_IDS.FULL}`
    : `unknown --scenario '${RAW_SCENARIO}' — known: ${Object.values(SCENARIO_IDS).join(', ')} (aliases: full | rule | policy). Default: ${SCENARIO_IDS.FULL}`);
  process.exit(1);
}
console.log(`[scenario] ${SCENARIOS[SCENARIO].label} — required legs: ${Object.keys(SCENARIOS[SCENARIO].required).join(', ')}`);

const results = [];
const startedAt = new Date().toISOString();
function record(step, verdict, detail, options = {}) {
  if (typeof step !== 'string' || step.length === 0) {
    throw new Error(`record(): step must be a non-empty string (got ${JSON.stringify(step)}) — a mistyped STEPS constant must fail loud, not drift the contract (rc-3)`);
  }
  results.push({ step, verdict, detail, blocking: options.blocking !== false });
  console.log(`[${verdict}] ${step} — ${detail}${options.blocking === false ? " (non-blocking for the scenario's exit contract, by declaration)" : ''}`);
}

/** THE single exit path (review §4 + round-4 R2): the exit code comes from
 * the DECLARED scenario contract (lib/learning-scenario-contract.mjs — the
 * required-step set), never from "no FAIL rows" or a dynamic PASS count.
 * e2e-results.json stays the plain records array (the exit-code regression
 * parses it); the contract evaluation persists alongside as
 * e2e-evaluation.json. */
function finalize() {
  const evaluation = evaluateScenario(SCENARIO, results);
  const passCount = results.filter((r) => r.verdict === VERDICTS.PASS).length;
  const failCount = results.filter((r) => r.verdict === VERDICTS.FAIL).length;
  const blockedCount = results.filter((r) => r.verdict === VERDICTS.BLOCKED).length;
  console.log(`\nFull-learning E2E [${SCENARIOS[SCENARIO].label}]: ${passCount} PASS, ${failCount} FAIL, ${blockedCount} BLOCKED (started ${startedAt})`);
  console.log(formatEvaluationReport(evaluation));
  try {
    fs.mkdirSync(LAB_ROOT, { recursive: true });
    fs.writeFileSync(path.join(LAB_ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(LAB_ROOT, 'e2e-evaluation.json'), JSON.stringify(evaluation, null, 2));
  } catch (error) {
    console.error(`results persist failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_CODES.FAIL;
    return;
  }
  process.exitCode = evaluation.exitCode;
}

const engineEnv = {
  ...process.env,
  WORKBUDDY_CONFIG_DIR: ISO,
  CODEBUDDY_CONFIG_DIR: ISO,
  PD_WORKBUDDY_ADAPTER_ENTRY: path.join(LAB_ROOT, 'home-shim.cjs'),
};

function steps() {
  for (const dir of [ISO, FAKE_HOME, GOV, PROJECT]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(ISO, 'plugins', 'cache', MARKET_NAME, PLUGIN_NAME, '0.1.0'), { recursive: true });
  for (const item of ['.codebuddy-plugin', 'hooks', 'scripts']) {
    fs.cpSync(path.join(PLUGIN_SRC, item), path.join(ISO, 'plugins', 'cache', MARKET_NAME, PLUGIN_NAME, '0.1.0', item), { recursive: true });
  }
  fs.writeFileSync(path.join(ISO, 'settings.json'), JSON.stringify({
    enabledPlugins: { [`${PLUGIN_NAME}@${MARKET_NAME}`]: true },
  }, null, 2));
  fs.writeFileSync(path.join(ISO, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      [`${PLUGIN_NAME}@${MARKET_NAME}`]: {
        scope: 'user',
        installPath: path.join(ISO, 'plugins', 'cache', MARKET_NAME, PLUGIN_NAME, '0.1.0'),
        version: '0.1.0',
        installedAt: new Date().toISOString(),
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(ISO, 'models.json'), JSON.stringify({
    models: [{ id: 'wb-probe-mock', name: 'WB Learn Mock', url: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, apiKey: 'mock-key', contextWindow: 32000 }],
  }, null, 2));
  fs.writeFileSync(path.join(LAB_ROOT, 'home-shim.cjs'), [
    `'use strict';`,
    `const { spawnSync } = require('node:child_process');`,
    `const env = { ...process.env, USERPROFILE: ${JSON.stringify(FAKE_HOME)}, HOME: ${JSON.stringify(FAKE_HOME)} };`,
    `const child = spawnSync(process.execPath, [${JSON.stringify(ADAPTER_ENTRY)}, process.argv[2]], { stdio: ['inherit', 'inherit', 'inherit'], env, windowsHide: true });`,
    `process.exit(child.status === null ? 1 : child.status);`,
    ``,
  ].join('\n'));
}

function governanceSetup() {
  const config = getDefaultPdConfig();
  config.features['host.workbuddy'].enabled = true;
  config.features['principle_receipt_ledger'].enabled = true;
  config.features['internalization_auto_consumer'].enabled = true;
  const keyEnv = LLM_KEY_ENV;
  if (!process.env[keyEnv]) throw new Error(`real LLM unavailable: ${keyEnv} not set (BLOCKED, not mockable)`);
  config.runtimeProfiles['pi-ai.real'] = {
    type: 'pi-ai',
    provider: 'openai',
    model: 'DeepSeek-V4-Flash-Vision-Exp',
    apiKeyEnv: keyEnv,
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    timeoutMs: 300000,
  };
  config.internalAgents.defaultRuntime = 'pi-ai.real';
  for (const agent of Object.keys(config.internalAgents.agents)) {
    config.internalAgents.agents[agent].runtimeProfile = 'pi-ai.real';
  }
  fs.mkdirSync(path.join(GOV, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(GOV, '.pd', 'config.yaml'), JSON.stringify(config));
  fs.mkdirSync(path.join(GOV, '.state'), { recursive: true });
  const trajectory = new Database(path.join(GOV, '.state', 'trajectory.db'));
  trajectory.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  trajectory.close();
}

function startMockServer() {
  const server = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-mock-server.mjs');
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_LAB: LAB_ROOT },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (c) => console.error(`[mock] ${c.toString('utf8').slice(0, 200)}`));
  return child;
}
function writeMockReply(name, obj) {
  fs.writeFileSync(path.join(LAB_ROOT, `mock-reply-${name}.json`), JSON.stringify(obj));
}
function bashToolReply(id, command) {
  return { id: `mock-${id}`, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `toolu_${id}`, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } }] }, finish_reason: 'tool_calls' }] };
}
function writeToolReply(id, filePath) {
  return { id: `mock-${id}`, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `toolu_${id}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: filePath, content: 'probe' }) } }] }, finish_reason: 'tool_calls' }] };
}
function textReply(id, text) {
  return { id: `mock-${id}`, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}
function mockReqCount() {
  try { return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
}
function mockReqsSince(n) {
  try { return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l)); } catch { return []; }
}
function runTwoPrompts(label, first, second) {
  const feeder = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-prompt-feeder2.cjs');
  return spawnSync(process.execPath, [feeder, label, first, second], {
    env: { ...engineEnv, WB_E2E_ISO: ISO, WB_E2E_ENGINE: ENGINE, WB_E2E_PROJECT: PROJECT },
    encoding: 'utf8',
    timeout: 180_000,
  });
}
function pdCli(args, timeoutMs = 420_000) {
  return spawnSync(process.execPath, [PD_CLI, ...args], {
    encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME },
  });
}

/** SYNTHETIC-PROTOCOL input: a real-shaped Write-failure PostToolUse payload
 * (frozen fixture shape, engine 2.161.0) delivered through the REAL dist
 * entry — evidence class 2, clearly labeled. */
function deliverSyntheticWriteFailure(tag) {
  const payload = JSON.stringify({
    session_id: `synth-${tag}`,
    transcript_path: path.join(GOV, 'synthetic.jsonl'),
    cwd: PROJECT,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: path.join(PROJECT, 'synthetic-protected.txt'), content: 'probe' },
    tool_response: { is_error: true, tool_error_code: '2002', exitCode: 1 },
    call_id: `toolu_synth_${tag}`,
    tool_use_id: `toolu_synth_${tag}`,
    agent_type: 'cli',
    permission_mode: 'bypassPermissions',
    client: 'CLI',
    version: '2.161.0',
    generation_id: `gen-synth-${tag}`,
    model: 'wb-probe-mock',
  });
  return spawnSync(process.execPath, [ADAPTER_ENTRY, 'PostToolUse'], {
    input: payload, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME },
  });
}

// ── Identity-chain correlation (P2 remediation) ─────────────────────────────
// The acceptance surface of THIS scenario's synthetic pain is correlated by
// IDs only: admission(trajectory, by canonical_pain_id) → diagnostician task
// → principle_candidates (task_id = top task or diag_router sub-task whose
// input_ref is the top task) → chain tasks (durable pi_metadata.correlationId
// = candidateId) → pi_artifacts(source_task_id) → approvals(artifact_id).
// No pending[0] queue-wide picking anywhere below. All reads are readonly and
// parameterized.
const POLICY_TERMINAL_KINDS = new Set(['implementation', 'defer']);

// The admission gate's durable threshold (evaluateAdmission): a candidate
// whose persisted confidence is below it can NEVER be admitted — no approval
// can ever appear for such a chain (rc-7: do not cycle on a terminal state).
const ADMISSION_CONFIDENCE_THRESHOLD = 0.5;

function readLearningChain(painId) {
  let admission;
  let traj;
  try {
    traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    admission = traj.prepare(
      "SELECT canonical_pain_id, diagnostician_task_id FROM governance_signal_admissions WHERE host_kind = 'workbuddy' AND canonical_pain_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(painId);
  } catch {
    return null; // trajectory store not readable yet — keep cycling
  } finally {
    try { traj?.close(); } catch { /* ignore */ }
  }
  if (!admission?.diagnostician_task_id) return null; // admission not persisted yet
  let db;
  try {
    db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
  } catch {
    return null;
  }
  const chain = {
    diagnosticianTaskId: admission.diagnostician_task_id,
    candidates: [],
    chainTasks: [],
    artifacts: [],
    approvals: [],
    pendingApprovals: [],
  };
  try {
    chain.candidates = db.prepare(
      `SELECT candidate_id, artifact_id, task_id, recommendation_kind, status, consumed_at, confidence
       FROM principle_candidates
       WHERE task_id = ?
          OR task_id IN (SELECT task_id FROM tasks WHERE task_kind = 'diag_router' AND input_ref = ?)`,
    ).all(chain.diagnosticianTaskId, chain.diagnosticianTaskId);
    for (const candidate of chain.candidates) {
      const tasks = db.prepare(
        `SELECT task_id, task_kind, status, json_extract(diagnostic_json, '$.pi_metadata.correlationId') AS candidate_id
         FROM tasks
         WHERE json_extract(diagnostic_json, '$.pi_metadata.correlationId') = ?`,
      ).all(candidate.candidate_id);
      chain.chainTasks.push(...tasks);
      for (const task of tasks) {
        chain.artifacts.push(...db.prepare(
          'SELECT artifact_id, artifact_kind, source_task_id FROM pi_artifacts WHERE source_task_id = ?',
        ).all(task.task_id));
      }
    }
    for (const artifact of chain.artifacts) {
      chain.approvals.push(...db.prepare(
        'SELECT approval_id, artifact_id, channel, status FROM approvals WHERE artifact_id = ?',
      ).all(artifact.artifact_id));
    }
    chain.pendingApprovals = chain.approvals.filter((a) => a.status === 'pending');
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return chain;
}

function candidateArtifactIds(chain, candidateId) {
  const taskIds = new Set(chain.chainTasks.filter((t) => t.candidate_id === candidateId).map((t) => t.task_id));
  return chain.artifacts.filter((a) => taskIds.has(a.source_task_id)).map((a) => a.artifact_id);
}

function candidateDisposition(chain, candidate) {
  const artifactIds = candidateArtifactIds(chain, candidate.candidate_id);
  const approval = chain.approvals.find((a) => artifactIds.includes(a.artifact_id));
  if (approval?.status === 'pending') return 'pending_approval';
  if (approval !== undefined) return 'decided';
  if (POLICY_TERMINAL_KINDS.has(candidate.recommendation_kind) && artifactIds.length === 0) return 'policy_terminal';
  return 'in_flight';
}

function chainSummary(chain) {
  return chain.candidates
    .map((c) => {
      const tasks = chain.chainTasks
        .filter((t) => t.candidate_id === c.candidate_id)
        .map((t) => `${t.task_kind}:${t.status}`)
        .join(',');
      const taskNote = tasks.length > 0 ? `;tasks=${tasks}` : '';
      return `${c.candidate_id}(kind=${c.recommendation_kind},status=${c.status},${candidateDisposition(chain, c)}${taskNote})`;
    })
    .join('; ');
}

/** Durable error-category authority for the chain's diagnostician task. */
function latestDiagnosticianCategory(diagTaskId) {
  try {
    const db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT error_category FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(diagTaskId);
      return row?.error_category ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function diagnosticianTaskStatus(diagTaskId) {
  try {
    const db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(diagTaskId);
      return row?.status ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

async function main() {
  if (!fs.existsSync(ADAPTER_ENTRY) || !fs.existsSync(PD_CLI)) {
    record(STEPS.PREFLIGHT, 'FAIL', 'build packages/workbuddy-adapter and packages/pd-cli first');
    return finalize();
  }
  if (!process.env[LLM_KEY_ENV]) {
    record(STEPS.PREFLIGHT, 'BLOCKED', `${LLM_KEY_ENV} not set — real LLM unavailable; full-learning acceptance BLOCKED (not mocked)`);
    return finalize();
  }
  steps();
  governanceSetup();
  record(STEPS.PREFLIGHT, 'PASS', `lab ${LAB_ROOT}; real LLM profile via env (key never logged)`);

  const mock = startMockServer();
  await new Promise((r) => setTimeout(r, 800));

  try {
    // ── Evidence class 1: REAL-host failure (Bash exit 7, real engine) ──
    let before = mockReqCount();
    writeMockReply('a', bashToolReply('learn1', 'exit 7'));
    writeMockReply('b', textReply('learn2', 'noted the failure'));
    let run = runTwoPrompts('fail', 'hello', 'please run the failing command');
    const reqs = mockReqsSince(before);
    await new Promise((r) => setTimeout(r, 800));
    let traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const toolRow = traj.prepare("SELECT tool_name, outcome, exit_code, session_id FROM tool_calls WHERE tool_name = 'Bash' AND outcome = 'failure' ORDER BY id DESC").get();
    const realPain = traj.prepare("SELECT canonical_pain_id, score FROM pain_events WHERE host_kind = 'workbuddy'").get();
    traj.close();
    const engineRan = reqs.some((r) => JSON.stringify(r.body ?? '').includes('exit 7'));
    // Policy fact (frozen cross-host semantics): Bash failures are
    // evidence-only — tool_calls YES, pain NO. Admissibility of real failures
    // on this engine build is BLOCKED (see header + protocol probe).
    record(STEPS.REAL_FAILURE_EVIDENCE, engineRan && toolRow ? 'PASS' : 'FAIL',
      `engineRan=${engineRan} requests=${reqs.length}; tool_calls=${JSON.stringify(toolRow)}; pain=${JSON.stringify(realPain) ?? 'none (Bash evidence-only per frozen policy)'} stderr=${(run.stderr || '').slice(-200)}`);

    // ── real-eligible-signal: MEASURED, not assumed (review §4) ──
    // Drive a REAL Write-THROWN failure (invalid drive — the proven thrown
    // shape in probe-write-failure-shapes.mjs) and observe whether the engine
    // fires a post-event the hook can see (PostToolUse/PostToolUseFailure).
    // The Write-failure subscription is landing separately; until it does this
    // step is BLOCKED on EVIDENCE (probe), never by assumption.
    const watermark = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const toolWatermark = watermark.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM tool_calls').get().m;
    const painWatermark = watermark.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM pain_events').get().m;
    watermark.close();
    before = mockReqCount();
    writeMockReply('w1', writeToolReply('learnw', 'Q:\\pd-e2e\\wb-e2e-nope.txt'));
    writeMockReply('w2', textReply('learnw2', 'noted the write failure'));
    run = runTwoPrompts('wfail', 'save the file now', 'continue');
    const wReqList = mockReqsSince(before);
    await new Promise((r) => setTimeout(r, 800));
    traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const writeToolRow = traj.prepare("SELECT tool_name, outcome, session_id FROM tool_calls WHERE tool_name = 'Write' AND outcome = 'failure' AND id > ?").get(toolWatermark);
    const writePain = traj.prepare("SELECT canonical_pain_id, score, host_kind FROM pain_events WHERE host_kind = 'workbuddy' AND id > ?").get(painWatermark);
    traj.close();
    const writeRoundRan = wReqList.some((r) => JSON.stringify(r.body ?? '').includes('save the file now'));
    if (!writeRoundRan) {
      record(STEPS.REAL_ELIGIBLE_SIGNAL, 'FAIL',
        `inconclusive experiment: the engine never issued the Write (requests=${wReqList.length}) — mock/feeder problem, not engine evidence; stderr=${(run.stderr || '').slice(-200)}`);
    } else if (writePain) {
      record(STEPS.REAL_ELIGIBLE_SIGNAL, 'PASS',
        `real Write failure recorded AND admission-eligible: tool_calls=${JSON.stringify(writeToolRow)} pain=${JSON.stringify(writePain)} (PostToolUse/Failure post-event observed on this build)`);
    } else if (writeToolRow) {
      record(STEPS.REAL_ELIGIBLE_SIGNAL, 'PASS',
        `POLICY-EXCLUDED (still PASS): the real Write failure reached the adapter (tool_calls=${JSON.stringify(writeToolRow)}) but the admission trigger produced no pain — excluded by the admission policy (production WRITE_TOOLS set + trigger.shouldCreateDiagnosticTask), not by a wiring gap; chain below uses SYNTHETIC-PROTOCOL input (evidence class 2)`);
    } else {
      record(STEPS.REAL_ELIGIBLE_SIGNAL, 'BLOCKED',
        `engine produced the Write failure but fired no post-event the hook could observe (tool_calls=none) — engine 2.161.0 (SHA-256 1b1a01bc…) returns Write failures without PostToolUse/PostToolUseFailure until the Failure subscription is wired; probe-write-failure-shapes.mjs is the evidence. Chain below uses SYNTHETIC-PROTOCOL input through the real entry (evidence class 2)`,
        { blocking: false });
    }

    // ── Evidence class 2: SYNTHETIC-PROTOCOL eligible signal through the REAL entry ──
    const synth = deliverSyntheticWriteFailure('e2e1');
    await new Promise((r) => setTimeout(r, 500));
    traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const synthPain = traj.prepare("SELECT canonical_pain_id, score, host_kind, runtime_task_id FROM pain_events WHERE host_kind = 'workbuddy' ORDER BY id DESC").get();
    traj.close();
    record(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, synth.status === 0 && synthPain ? 'PASS' : 'FAIL',
      `synthetic Write-failure PostToolUse via real dist entry: status=${synth.status} pain=${JSON.stringify(synthPain)} stderr=${(synth.stderr || '').slice(-200)}`);
    if (!synthPain) return finalize();

    // ── Background chain: worker cycles until THIS pain's chain reaches a
    // disposition (identity-chain correlated, never pending[0]) ──
    let chainSelection = null;      // chain with traceable pending approvals
    let policyTerminalChain = null; // every candidate at the policy refusal terminal
    let blockedRateLimit = null;    // provider rate limit (durable runs row)
    let chainDefect = null;         // terminal chain failure without rate limit
    let lastCycle = null;
    const deadline = Date.now() + 45 * 60_000; // real LLM: diagnosis chain + provider rate-limit backoff
    let cycles = 0;
    while (Date.now() < deadline) {
      cycles += 1;
      const r = pdCli(['workbuddy', 'worker', '--once', '--workspace', GOV, '--json']);
      let parsed = {};
      try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* non-JSON */ }
      lastCycle = { exit: r.status, mode: parsed.mode, admission: parsed.report?.admission, diagnostician: parsed.report?.diagnostician, downstreamSkip: parsed.report?.downstream?.skipReason, stderrTail: (r.stderr || '').slice(-300) };
      const chain = readLearningChain(synthPain.canonical_pain_id);
      if (chain !== null) {
        if (chain.pendingApprovals.length > 0) { chainSelection = chain; break; }
        // Policy terminal (rc-9): no approval row will EVER exist for this
        // chain — cycling to the deadline would be dishonest (rc-7).
        if (chain.candidates.length > 0 && chain.candidates.every((c) => candidateDisposition(chain, c) === 'policy_terminal')) {
          policyTerminalChain = chain;
          break;
        }
        // Admission terminal (rc-7): every actionable candidate's persisted
        // confidence is below the admission gate threshold — the gate can
        // never admit them, so the chain can never reach an approval. Classify
        // NOW with the root cause instead of burning the window.
        const actionable = chain.candidates.filter((c) => !POLICY_TERMINAL_KINDS.has(c.recommendation_kind));
        if (actionable.length > 0 && actionable.every((c) => c.confidence === null || c.confidence < ADMISSION_CONFIDENCE_THRESHOLD)) {
          chainDefect = `every actionable candidate is below the admission confidence threshold (${ADMISSION_CONFIDENCE_THRESHOLD}) — the admission gate can never admit them (needs_evidence), so no approval can ever be reached: ${chainSummary(chain)}`;
          break;
        }
        // Terminal diagnostician failure → classify NOW from the durable rows
        // instead of burning the window on a dead chain.
        if (diagnosticianTaskStatus(chain.diagnosticianTaskId) === 'failed') {
          const category = latestDiagnosticianCategory(chain.diagnosticianTaskId);
          if (category === 'rate_limit') blockedRateLimit = chain.diagnosticianTaskId;
          else chainDefect = `diagnostician task terminal-failed (error_category=${category ?? 'none'}); last=${JSON.stringify(lastCycle).slice(0, 400)}`;
          break;
        }
      }
      if (parsed.mode === 'paused') break;
      // Real-LLM provider rate limits: a full diagnostician run is a large
      // completion. Respect the provider with a long inter-cycle gap — the
      // deadline budget accounts for this (cycles are minutes apart).
      await new Promise((r2) => setTimeout(r2, 45_000));
    }
    if (blockedRateLimit !== null) {
      record(STEPS.BACKGROUND_CHAIN, 'BLOCKED',
        `the real LLM provider rate-limited the diagnostician (task=${blockedRateLimit}, runs.error_category=rate_limit) — chain verified up to the LLM boundary after ${cycles} cycles; re-run when the provider quota resets`);
      return finalize();
    }
    if (chainDefect !== null) {
      record(STEPS.BACKGROUND_CHAIN, 'FAIL', `chain defect, not a provider state: ${chainDefect}`);
      return finalize();
    }
    if (policyTerminalChain !== null) {
      record(STEPS.BACKGROUND_CHAIN, 'PASS',
        `chain reached its designed policy terminal after ${cycles} REAL worker cycles (diagnosis + intake complete): ${chainSummary(policyTerminalChain)}`);
      record(STEPS.POLICY_TERMINAL_CANDIDATES, 'POLICY',
        `not_internalizable intake refusal is the production terminal for these kinds (MVP-disabled channel; approvals row absent BY DESIGN): ${chainSummary(policyTerminalChain)}`);
      record(STEPS.NEXT_TURN_INJECTION, 'SKIP',
        'no approval exists for a policy-terminal chain — the injection leg did not run (policy classification, NOT a provider BLOCKED, NOT an injection PASS)');
      record(STEPS.WITHDRAW, 'SKIP', 'no activation was injected (policy-terminal chain), so there is nothing to withdraw');
      record(STEPS.POST_WITHDRAW, 'SKIP', 'no injection happened (policy-terminal chain), so no stop-of-injection turn is measurable');
      return finalize();
    }
    record(STEPS.BACKGROUND_CHAIN, chainSelection ? 'PASS' : 'FAIL',
      chainSelection
        ? `identity-chain approvals after ${cycles} REAL worker cycles (real LLM diagnostician), traceable to pain ${synthPain.canonical_pain_id} via task ${chainSelection.diagnosticianTaskId}`
        : `no identity-chain approval after ${cycles} cycles; last=${JSON.stringify(lastCycle).slice(0, 700)}`);
    if (!chainSelection) return finalize();

    // ── Denominator: every candidate's disposition is recorded ──
    record(STEPS.CHAIN_DISPOSITION, 'PASS',
      `candidates traceable to diagnostician task ${chainSelection.diagnosticianTaskId}: ${chainSummary(chainSelection)}`);
    const policyCandidates = chainSelection.candidates.filter((c) => candidateDisposition(chainSelection, c) === 'policy_terminal');
    if (policyCandidates.length > 0) {
      record(STEPS.POLICY_TERMINAL_CANDIDATES, 'POLICY',
        `not_internalizable terminal (approvals absent BY DESIGN, not a provider BLOCKED): ${policyCandidates.map((c) => `${c.candidate_id}(kind=${c.recommendation_kind})`).join(', ')}`);
    }

    // ── Channel dispatch (P2): each candidate is verified on ITS channel ──
    const promptApproval = chainSelection.pendingApprovals.find((a) => a.channel === 'prompt');
    for (const row of chainSelection.pendingApprovals) {
      if (row.channel !== 'prompt' && row.channel !== 'code_tool_hook') {
        record(STEPS.CHAIN_DISPOSITION, 'FAIL', `unexpected approval channel '${row.channel}' for artifact ${row.artifact_id} (unknown channel is a chain defect, rc-3)`);
      }
    }
    // The primary approval drives the classic legs; prefer the prompt channel.
    const approval = promptApproval ?? chainSelection.pendingApprovals[0];

    // ── Owner approves through the REAL product entry (ALL chain approvals) ──
    const approveResults = [];
    for (const row of chainSelection.pendingApprovals) {
      const approve = pdCli(['activation', 'approve', '--approval-id', row.approval_id, '--workspace', GOV, '--decided-by', 'wb-e2e-test-owner', '--json'], 120_000);
      let approveResult = {};
      try { approveResult = JSON.parse(approve.stdout || '{}'); } catch { /* keep raw */ }
      approveResults.push({ row, exit: approve.status, ok: approveResult.ok === true, activationId: approveResult.activationId, stdout: (approve.stdout || '').slice(0, 200), stderr: (approve.stderr || '').slice(-200) });
    }
    const primaryResult = approveResults.find((a) => a.row.approval_id === approval.approval_id);
    const approvedOk = Boolean(primaryResult) && primaryResult.exit === 0 && primaryResult.ok;
    record(STEPS.OWNER_APPROVAL, approvedOk ? 'PASS' : 'FAIL',
      `pd activation approve (${approval.channel} channel, artifact=${approval.artifact_id}) exit=${primaryResult?.exit} ok=${primaryResult?.ok === true} activationId=${primaryResult?.activationId ?? '-'} stdout=${primaryResult?.stdout ?? ''} stderr=${primaryResult?.stderr ?? ''}`);
    if (!approvedOk) return finalize();

    // ── code_tool_hook (rule) approvals: durable row verification ONLY ──
    // No prompt-injection assertion and no live promotion — the production
    // RuleHostWriter persists the shadow action; the read action is asserted,
    // never hardcoded (P2 channel dispatch).
    for (const result of approveResults.filter((a) => a.row.channel === 'code_tool_hook')) {
      if (!(result.exit === 0 && result.ok)) {
        record(STEPS.RULE_APPROVAL_ACTIVATION, 'FAIL', `approve failed for ${result.row.approval_id}: exit=${result.exit} stderr=${result.stderr}`);
        continue;
      }
      let hookApproval = null;
      let hookActivation = null;
      try {
        const db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
        try {
          hookApproval = db.prepare('SELECT status FROM approvals WHERE approval_id = ?').get(result.row.approval_id) ?? null;
          hookActivation = db.prepare('SELECT activation_id, channel, action, deactivated_at FROM activations WHERE artifact_id = ?').get(result.row.artifact_id) ?? null;
        } finally {
          db.close();
        }
      } catch (error) {
        record(STEPS.RULE_APPROVAL_ACTIVATION, 'FAIL', `durable read failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const hookOk = hookApproval?.status === 'approved'
        && hookActivation !== null
        && hookActivation.channel === 'code_tool_hook'
        && typeof hookActivation.action === 'string' && hookActivation.action.startsWith('code_tool_hook_')
        && hookActivation.deactivated_at === null;
      record(STEPS.RULE_APPROVAL_ACTIVATION, hookOk ? 'PASS' : 'FAIL',
        `code_tool_hook candidate verified on ITS channel (no prompt assertion, no live promotion): approvals.status=${hookApproval?.status} activation=${JSON.stringify(hookActivation)}`);
    }

    // ── Prompt-channel legs: injection + withdrawal through the REAL engine ──
    // R2: these rows stay SKIP when no prompt-channel approval exists (channel
    // dispatch), but the SCENARIO CONTRACT now decides what that means — for
    // full-principle-learning a rule-only chain is a missing-required-leg
    // FAIL (non-zero, explicit reason), for rule-channel it is irrelevant,
    // and for policy-refusal the POLICY rows above are the acceptance.
    if (!promptApproval) {
      record(STEPS.NEXT_TURN_INJECTION, 'SKIP',
        `no prompt-channel approval in this chain (channels=${chainSelection.pendingApprovals.map((a) => a.channel).join(',')}) — the prompt injection leg did not run (P2 channel dispatch); scenario contract classifies this`);
      record(STEPS.WITHDRAW, 'SKIP', 'withdrawal belongs to the prompt-channel injection chain (no prompt activation in this chain)');
      record(STEPS.POST_WITHDRAW, 'SKIP', 'no prompt activation was injected, so no stop-of-injection turn is measurable');
      return finalize();
    }

    // PRODUCTION read contract (prompt-activation-reader-contract): the chain
    // artifact is the FULL ScribeOutput — resolved body = content.text falling
    // back to content.principleDraft.statement. The former root-level
    // `content.statement` read probed an EMPTY string for real drafts (the
    // scribe persists no root statement), which would fail the injection check
    // below even on a correct chain.
    let db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
    const artifactRow = db.prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?').get(promptApproval.artifact_id);
    const activationRow = primaryResult.activationId
      ? db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE activation_id = ?').get(primaryResult.activationId)
      : db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE artifact_id = ?').get(promptApproval.artifact_id);
    db.close();
    if (!activationRow) {
      record(STEPS.NEXT_TURN_INJECTION, 'FAIL',
        `no live activation found for the approved prompt artifact ${promptApproval.artifact_id} (activationId=${primaryResult.activationId ?? '-'}) — approve reported ok but the activation row is missing`);
      return finalize();
    }
    let statementText = '';
    let statementSource = 'none';
    try {
      const content = JSON.parse(artifactRow?.content_json ?? '{}');
      if (typeof content.text === 'string' && content.text.length > 0) {
        statementText = content.text;
        statementSource = 'content.text';
      } else if (content.principleDraft && typeof content.principleDraft.statement === 'string' && content.principleDraft.statement.length > 0) {
        statementText = content.principleDraft.statement;
        statementSource = 'principleDraft.statement';
      }
    } catch { statementText = ''; }
    const activationMatches = Boolean(activationRow) && activationRow.artifact_id === approval.artifact_id;
    const probe = statementText.split(/\s+/).filter((w) => w.length > 4).slice(0, 4).join(' ');
    before = mockReqCount();
    writeMockReply('c', textReply('learn3', 'understood'));
    writeMockReply('d', textReply('learn4', 'acknowledged'));
    run = runTwoPrompts('post-approval', 'what should I keep in mind now?', 'summarize your guidance');
    const postReqs = mockReqsSince(before);
    const postRan = postReqs.length > 0 && postReqs.some((r) => JSON.stringify(r.body ?? '').includes('keep in mind'));
    const learned = postRan && probe.length > 0 && postReqs.some((r) => JSON.stringify(r.body ?? '').includes(probe));
    record(STEPS.NEXT_TURN_INJECTION, learned && activationMatches ? 'PASS' : 'FAIL',
      `roundRan=${postRan} requests=${postReqs.length}; probe=${JSON.stringify(probe.slice(0, 90))} (source=${statementSource}); activationMatchesApprovedArtifact=${activationMatches} activation=${JSON.stringify(activationRow)}; stderr=${(run.stderr || '').slice(-200)}`);

    // ── Withdraw through the product entry; next turn stops ──
    const withdraw = pdCli(['activation', 'deactivate', '--activation-id', activationRow.activation_id, '--workspace', GOV], 60_000);
    const withdrawOk = withdraw.status === 0 && /Deactivated/i.test(withdraw.stdout || '');
    record(STEPS.WITHDRAW, withdrawOk ? 'PASS' : 'FAIL',
      `exit=${withdraw.status} stdout=${(withdraw.stdout || '').slice(0, 120)}`);
    before = mockReqCount();
    writeMockReply('e', textReply('learn5', 'ok'));
    writeMockReply('f', textReply('learn6', 'done'));
    run = runTwoPrompts('post-withdraw', 'another question', 'and another');
    const wReqs = mockReqsSince(before);
    const wRan = wReqs.length > 0 && wReqs.some((r) => JSON.stringify(r.body ?? '').includes('another question'));
    const stillThere = wReqs.some((r) => probe.length > 0 && JSON.stringify(r.body ?? '').includes(probe));
    record(STEPS.POST_WITHDRAW, wRan && !stillThere ? 'PASS' : 'FAIL',
      `roundRan=${wRan} requests=${wReqs.length}; statementStillInjected=${stillThere}`);
  } finally {
    mock.kill();
  }

  finalize();
}

main().catch((error) => {
  console.error('Full-learning E2E crashed:', error);
  record(STEPS.CRASH, 'FAIL', (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1000));
  finalize();
});
