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
 * Agent-loop model decisions are scripted by the local mock server (genuine
 * engine behavior); everything governance-side is the real product stack.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const results = [];
const startedAt = new Date().toISOString();
function record(step, verdict, detail) {
  results.push({ step, verdict, detail });
  console.log(`[${verdict}] ${step} — ${detail}`);
}

/** THE single exit path (review §4): persists results, prints the summary and
 * sets the exit code (FAIL→1, BLOCKED→2, PASS→0). Every early return and the
 * crash handler route through here — the former bare `return`s exited 0 with
 * steps unrecorded (fake green). */
function finalize() {
  const failed = results.filter((r) => r.verdict === 'FAIL');
  const blocked = results.filter((r) => r.verdict === 'BLOCKED');
  console.log(`\nFull-learning E2E: ${results.filter((r) => r.verdict === 'PASS').length} PASS, ${failed.length} FAIL, ${blocked.length} BLOCKED (started ${startedAt})`);
  try {
    fs.mkdirSync(LAB_ROOT, { recursive: true });
    fs.writeFileSync(path.join(LAB_ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(`results persist failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = failed.length === 0 && blocked.length === 0 ? 0 : blocked.length > 0 ? 2 : 1;
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

function pendingApproval() {
  let db;
  try {
    db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
    return db.prepare("SELECT approval_id, artifact_id, channel, status FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC").all();
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

async function main() {
  if (!fs.existsSync(ADAPTER_ENTRY) || !fs.existsSync(PD_CLI)) {
    record('preflight', 'FAIL', 'build packages/workbuddy-adapter and packages/pd-cli first');
    return finalize();
  }
  if (!process.env[LLM_KEY_ENV]) {
    record('preflight', 'BLOCKED', `${LLM_KEY_ENV} not set — real LLM unavailable; full-learning acceptance BLOCKED (not mocked)`);
    return finalize();
  }
  steps();
  governanceSetup();
  record('preflight', 'PASS', `lab ${LAB_ROOT}; real LLM profile via env (key never logged)`);

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
    record('real-failure-evidence', engineRan && toolRow ? 'PASS' : 'FAIL',
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
      record('real-eligible-signal', 'FAIL',
        `inconclusive experiment: the engine never issued the Write (requests=${wReqList.length}) — mock/feeder problem, not engine evidence; stderr=${(run.stderr || '').slice(-200)}`);
    } else if (writePain) {
      record('real-eligible-signal', 'PASS',
        `real Write failure recorded AND admission-eligible: tool_calls=${JSON.stringify(writeToolRow)} pain=${JSON.stringify(writePain)} (PostToolUse/Failure post-event observed on this build)`);
    } else if (writeToolRow) {
      record('real-eligible-signal', 'PASS',
        `POLICY-EXCLUDED (still PASS): the real Write failure reached the adapter (tool_calls=${JSON.stringify(writeToolRow)}) but the admission trigger produced no pain — excluded by the admission policy (production WRITE_TOOLS set + trigger.shouldCreateDiagnosticTask), not by a wiring gap; chain below uses SYNTHETIC-PROTOCOL input (evidence class 2)`);
    } else {
      record('real-eligible-signal', 'BLOCKED',
        `engine produced the Write failure but fired no post-event the hook could observe (tool_calls=none) — engine 2.161.0 (SHA-256 1b1a01bc…) returns Write failures without PostToolUse/PostToolUseFailure until the Failure subscription is wired; probe-write-failure-shapes.mjs is the evidence. Chain below uses SYNTHETIC-PROTOCOL input through the real entry (evidence class 2).`);
    }

    // ── Evidence class 2: SYNTHETIC-PROTOCOL eligible signal through the REAL entry ──
    const synth = deliverSyntheticWriteFailure('e2e1');
    await new Promise((r) => setTimeout(r, 500));
    traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const synthPain = traj.prepare("SELECT canonical_pain_id, score, host_kind, runtime_task_id FROM pain_events WHERE host_kind = 'workbuddy' ORDER BY id DESC").get();
    traj.close();
    record('eligible-signal-synthetic', synth.status === 0 && synthPain ? 'PASS' : 'FAIL',
      `synthetic Write-failure PostToolUse via real dist entry: status=${synth.status} pain=${JSON.stringify(synthPain)} stderr=${(synth.stderr || '').slice(-200)}`);
    if (!synthPain) return finalize();

    // ── Background chain: worker cycles until a pending approval exists ──
    let approval = null;
    let lastCycle = null;
    const deadline = Date.now() + 45 * 60_000; // real LLM: diagnosis chain + provider rate-limit backoff
    let cycles = 0;
    while (Date.now() < deadline) {
      cycles += 1;
      const r = pdCli(['workbuddy', 'worker', '--once', '--workspace', GOV, '--json']);
      let parsed = {};
      try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* non-JSON */ }
      lastCycle = { exit: r.status, mode: parsed.mode, admission: parsed.report?.admission, diagnostician: parsed.report?.diagnostician, downstreamSkip: parsed.report?.downstream?.skipReason, stderrTail: (r.stderr || '').slice(-300) };
      const pending = pendingApproval();
      if (pending.length > 0) { approval = pending[0]; break; }
      if (parsed.mode === 'paused') break;
      // Real-LLM provider rate limits: a full diagnostician run is a large
      // completion. Respect the provider with a long inter-cycle gap — the
      // deadline budget accounts for this (cycles are minutes apart).
      await new Promise((r2) => setTimeout(r2, 45_000));
    }
    record('background-chain', approval ? 'PASS' : 'FAIL',
      approval
        ? `pending approval after ${cycles} REAL worker cycles (real LLM diagnostician): ${JSON.stringify(approval)}`
        : `no pending approval after ${cycles} cycles; last=${JSON.stringify(lastCycle).slice(0, 700)}`);
    if (!approval) return finalize();

    // ── Owner approves through the REAL product entry ──
    const approve = pdCli(['activation', 'approve', '--approval-id', approval.approval_id, '--workspace', GOV, '--decided-by', 'wb-e2e-test-owner', '--json'], 120_000);
    let approveResult = {};
    try { approveResult = JSON.parse(approve.stdout || '{}'); } catch { /* keep raw */ }
    const approvedOk = approve.status === 0 && approveResult.ok === true;
    record('owner-approval', approvedOk ? 'PASS' : 'FAIL',
      `pd activation approve exit=${approve.status} ok=${approveResult.ok === true} activationId=${approveResult.activationId ?? '-'} stdout=${(approve.stdout || '').slice(0, 200)} stderr=${(approve.stderr || '').slice(-200)}`);
    if (!approvedOk) return finalize();

    // ── Next REAL engine turn carries the approved principle ──
    // PRODUCTION read contract (prompt-activation-reader-contract): the chain
    // artifact is the FULL ScribeOutput — resolved body = content.text falling
    // back to content.principleDraft.statement. The former root-level
    // `content.statement` read probed an EMPTY string for real drafts (the
    // scribe persists no root statement), which would fail the injection check
    // below even on a correct chain.
    let db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
    const artifactRow = db.prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?').get(approval.artifact_id);
    const activationRow = approveResult.activationId
      ? db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE activation_id = ?').get(approveResult.activationId)
      : db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations ORDER BY activated_at DESC LIMIT 1').get();
    db.close();
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
    record('next-turn-injection', learned && activationMatches ? 'PASS' : 'FAIL',
      `roundRan=${postRan} requests=${postReqs.length}; probe=${JSON.stringify(probe.slice(0, 90))} (source=${statementSource}); activationMatchesApprovedArtifact=${activationMatches} activation=${JSON.stringify(activationRow)}; stderr=${(run.stderr || '').slice(-200)}`);

    // ── Withdraw through the product entry; next turn stops ──
    const withdraw = pdCli(['activation', 'deactivate', '--activation-id', activationRow.activation_id, '--workspace', GOV], 60_000);
    const withdrawOk = withdraw.status === 0 && /Deactivated/i.test(withdraw.stdout || '');
    record('withdraw', withdrawOk ? 'PASS' : 'FAIL',
      `exit=${withdraw.status} stdout=${(withdraw.stdout || '').slice(0, 120)}`);
    before = mockReqCount();
    writeMockReply('e', textReply('learn5', 'ok'));
    writeMockReply('f', textReply('learn6', 'done'));
    run = runTwoPrompts('post-withdraw', 'another question', 'and another');
    const wReqs = mockReqsSince(before);
    const wRan = wReqs.length > 0 && wReqs.some((r) => JSON.stringify(r.body ?? '').includes('another question'));
    const stillThere = wReqs.some((r) => probe.length > 0 && JSON.stringify(r.body ?? '').includes(probe));
    record('post-withdraw', wRan && !stillThere ? 'PASS' : 'FAIL',
      `roundRan=${wRan} requests=${wReqs.length}; statementStillInjected=${stillThere}`);
  } finally {
    mock.kill();
  }

  finalize();
}

main().catch((error) => {
  console.error('Full-learning E2E crashed:', error);
  record('crash', 'FAIL', (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1000));
  finalize();
});
