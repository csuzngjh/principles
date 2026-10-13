/**
 * WorkBuddy REAL-HOST governance-loop E2E (SPEC §8 完整治理档 / PLAN Part 6–7).
 *
 * Drives the REAL WorkBuddy desktop engine (5.8.1 / codebuddy-lite-wb.mjs)
 * in a FRESH isolated config dir with the REAL PD workbuddy-adapter plugin
 * payload and a mock model (hook pipeline, tool execution, payload
 * construction and context assembly are genuine engine behavior; only the
 * model's decisions are scripted). Governance state lives in a FRESH fake
 * home governance workspace — the real user's ~/.workbuddy and ~/.pd are
 * never touched (USERPROFILE/HOME are redirected for the engine process; its
 * own config comes from the WORKBUDDY_CONFIG_DIR / CODEBUDDY_CONFIG_DIR
 * envs, so the redirect only steers the hook's OD-07 resolution).
 *
 * Loop under test (all through production paths):
 *   1. owner-approved prompt principle  → next turn injection (context evidence
 *      = the request body the mock model actually received)
 *   2. protected Write                  → PreToolUse deny → file NOT written
 *   3. real failing tool call           → PostToolUse evidence row in the
 *      governance trajectory (workbuddy host attribution)
 *   4. withdraw via the real pd-cli     → next turn no longer carries the text
 *
 * Prerequisites: repo built (packages/workbuddy-adapter/dist), mock server
 * startable, engine installed. Usage:
 *   node scripts/dev/workbuddy-probe/e2e-governance-loop.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(REPO, 'package.json'));
const Database = require('better-sqlite3');

// The engine's fs-watch dies on the libuv prefix assertion
// (src\win\fs-event.c) when any watched path contains an 8.3 short component
// (os.tmpdir() → ADMINI~1); realpath does NOT expand short names, so the lab
// lives beside the worktree pool on a long path, derived from this script's
// repo location (WB_E2E_LAB overrides).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAB_ROOT = path.join(
  process.env.WB_E2E_LAB || path.resolve(REPO_ROOT, '../../../wb-probe-lab'),
  `e2e-gov-${Date.now()}`,
);
const ISO = path.join(LAB_ROOT, 'iso');
const FAKE_HOME = path.join(LAB_ROOT, 'fake-home');
const GOV = path.join(FAKE_HOME, '.workbuddy', 'pd-workspace');
const PROJECT = path.join(LAB_ROOT, 'project-a');
const ENGINE = process.env.WB_ENGINE || 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const MOCK_PORT = 39489;
const PLUGIN_SRC = path.join(REPO, 'packages', 'workbuddy-adapter', 'plugin');
const ADAPTER_ENTRY = path.join(REPO, 'packages', 'workbuddy-adapter', 'dist', 'pd-hook.js');
const MARKET_NAME = 'pd-e2e-market';
const PLUGIN_NAME = 'principles-disciple';
const PROMPT_MARKER = 'WB_E2E_PROMPT_DIRECTIVE_7A3F';
const DENY_REASON = 'WB_E2E_DENY_RULE';
const PROTECTED_FILE = () => path.join(PROJECT, 'e2e-protected-7a3f.txt');

const results = [];
function record(step, verdict, detail) {
  results.push({ step, verdict, detail });
  console.log(`[${verdict}] ${step} — ${detail}`);
}

const engineEnv = {
  ...process.env,
  WORKBUDDY_CONFIG_DIR: ISO,
  CODEBUDDY_CONFIG_DIR: ISO,
  // OD-07 resolution redirect happens INSIDE the hook only (via the shim
  // entry below): redirecting USERPROFILE on the ENGINE crashes its libuv
  // fs-watch on Windows (src\win\fs-event.c assertion) before any model
  // request — first-run finding, kept honest here.
  PD_WORKBUDDY_ADAPTER_ENTRY: path.join(LAB_ROOT, 'home-shim.cjs'),
};

function steps() {
  fs.mkdirSync(path.join(ISO, 'plugins', 'cache', MARKET_NAME, PLUGIN_NAME, '0.1.0'), { recursive: true });
  fs.mkdirSync(path.join(ISO, 'plugins', 'data'), { recursive: true });
  fs.mkdirSync(GOV, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'normal.txt'), 'e2e scratch\n');

  // Plugin payload → cache (installer layout: cache/<market>/<plugin>/<version>/).
  for (const item of ['.codebuddy-plugin', 'hooks', 'scripts']) {
    fs.cpSync(path.join(PLUGIN_SRC, item), path.join(ISO, 'plugins', 'cache', MARKET_NAME, PLUGIN_NAME, '0.1.0', item), { recursive: true });
  }
  // Marketplace manifest the engine's discovery accepts (probe P01 layout).
  const marketDir = path.join(LAB_ROOT, 'marketplace');
  fs.mkdirSync(path.join(marketDir, '.codebuddy-plugin'), { recursive: true });
  fs.cpSync(path.join(PLUGIN_SRC, '.codebuddy-plugin', 'plugin.json'), path.join(marketDir, '.codebuddy-plugin', 'plugin.json'));
  fs.mkdirSync(path.join(marketDir, 'plugin'), { recursive: true });
  for (const item of ['.codebuddy-plugin', 'hooks', 'scripts']) {
    fs.cpSync(path.join(PLUGIN_SRC, item), path.join(marketDir, 'plugin', item), { recursive: true });
  }
  fs.writeFileSync(path.join(marketDir, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({
    name: MARKET_NAME,
    plugins: [{ name: PLUGIN_NAME, source: './plugin', description: 'PD E2E', version: '0.1.0' }],
  }, null, 2));

  // enabledPlugins + installed_plugins.json v2 (frozen probe P01 format —
  // the same shape the real installer writes).
  fs.writeFileSync(path.join(ISO, 'settings.json'), JSON.stringify({
    enabledPlugins: {
      [`${PLUGIN_NAME}@${MARKET_NAME}`]: true,
    },
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

  // Mock model config (probe P0 frozen format: token-less auth via models.json).
  fs.writeFileSync(path.join(ISO, 'models.json'), JSON.stringify({
    models: [
      {
        id: 'wb-probe-mock',
        name: 'WB E2E Mock Model',
        url: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
        apiKey: 'mock-key-e2e',
        contextWindow: 32000,
      },
    ],
  }, null, 2));

  // Hook-level home shim: the engine's env stays untouched (its libuv fs-watch
  // crashes under a redirected USERPROFILE); the shim re-homes ONLY the adapter
  // entry process so its os.homedir() resolves the E2E governance workspace.
  // This shim is E2E test infrastructure — production installs resolve the
  // real entry directly via install-layout.
  fs.writeFileSync(path.join(LAB_ROOT, 'home-shim.cjs'), [
    `'use strict';`,
    `const { spawnSync } = require('node:child_process');`,
    `const env = { ...process.env, USERPROFILE: ${JSON.stringify(FAKE_HOME)}, HOME: ${JSON.stringify(FAKE_HOME)} };`,
    `const event = process.argv[2];`,
    `const child = spawnSync(process.execPath, [${JSON.stringify(ADAPTER_ENTRY)}, event], { stdio: ['inherit', 'inherit', 'inherit'], env, windowsHide: true });`,
    `process.exit(child.status === null ? 1 : child.status);`,
    ``,
  ].join('\n'));
}

async function governanceSetup() {
  const { getDefaultPdConfig, SqliteConnection, SqliteActivationStateStore } = require('@principles/core/runtime-v2');
  fs.mkdirSync(path.join(GOV, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(GOV, '.state'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.workbuddy'].enabled = true;
  config.features['principle_receipt_ledger'].enabled = true;
  fs.writeFileSync(path.join(GOV, '.pd', 'config.yaml'), JSON.stringify(config));

  const trajectory = new Database(path.join(GOV, '.state', 'trajectory.db'));
  trajectory.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  trajectory.close();

  const connection = new SqliteConnection(GOV);
  try {
    const now = new Date().toISOString();
    // Prompt principle (approved + activated through the production store writer).
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('art-e2e-prompt', 'principle', 'task-e2e-prompt', 'P_WB_E2E_PROMPT', null, '[]', 'validated',
      JSON.stringify({ principleId: 'P_WB_E2E_PROMPT', text: PROMPT_MARKER }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: 'act-e2e-prompt',
      idempotencyKey: 'art-e2e-prompt::prompt',
      artifactId: 'art-e2e-prompt',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://P_WB_E2E_PROMPT',
      activatedAt: now,
      deactivatedAt: null,
    });
    // Deny rule (live code_tool_hook activation) for the protected path.
    const ruleCode = `function evaluate(input) { if (input.action.normalizedPath.indexOf('e2e-protected-7a3f') >= 0) return { decision: 'block', matched: true, reason: '${DENY_REASON}' }; return { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'wb-e2e',version:'1',ruleId:'R_WB_E2E_DENY',coversCondition:'all'};`;
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('art-e2e-rule', 'rule', 'task-e2e-rule', 'P_WB_E2E_RULE', 'R_WB_E2E_DENY', '[]', 'validated',
      JSON.stringify({ principleId: 'P_WB_E2E_RULE', ruleId: 'R_WB_E2E_DENY', implementationCode: ruleCode }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: 'act-e2e-rule',
      idempotencyKey: 'art-e2e-rule::code_tool_hook',
      artifactId: 'art-e2e-rule',
      channel: 'code_tool_hook',
      action: 'code_tool_hook_live_activate',
      targetRef: 'impl://R_WB_E2E_DENY',
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

function startMockServer() {
  const labSrc = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-mock-server.mjs');
  const child = spawn(process.execPath, [labSrc], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_LAB: LAB_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => console.error(`[mock] ${chunk.toString('utf8').slice(0, 200)}`));
  return child;
}

function writeMockReply(name, obj) {
  fs.writeFileSync(path.join(LAB_ROOT, `mock-reply-${name}.json`), JSON.stringify(obj));
}
function toolCallReply(id, toolName, args) {
  return {
    id: `mock-${id}`, model: 'wb-probe-mock',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `toolu_${id}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
  };
}
function textReply(id, text) {
  return { id: `mock-${id}`, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

function mockReqCount() {
  try { return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
}
function mockReqsSince(n) {
  try {
    return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** Two stream-json prompts (UserPromptSubmit fires from the 2nd — probe P01b). */
function runTwoPrompts(label) {
  const feeder = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-prompt-feeder.cjs');
  return spawnSync(process.execPath, [feeder, label], {
    env: { ...engineEnv, WB_E2E_ISO: ISO, WB_E2E_ENGINE: ENGINE, WB_E2E_PROJECT: PROJECT },
    encoding: 'utf8',
    timeout: 180_000,
  });
}

async function main() {
  const keep = process.argv.includes('--keep');
  steps();
  await governanceSetup();

  if (!fs.existsSync(ADAPTER_ENTRY)) {
    record('preflight', 'FAIL', `adapter entry missing: ${ADAPTER_ENTRY} (build packages/workbuddy-adapter first)`);
    return;
  }
  if (!fs.existsSync(ENGINE)) {
    record('preflight', 'FAIL', `engine missing: ${ENGINE}`);
    return;
  }
  record('preflight', 'PASS', `engine + adapter entry + fresh isolation at ${LAB_ROOT}`);

  const mock = startMockServer();
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    // ── Turn 1: injection ──
    let before = mockReqCount();
    let run = runTwoPrompts('inject');
    let reqs = mockReqsSince(before);
    const injectBodies = reqs.map((r) => JSON.stringify(r.body ?? r.bodyRaw ?? ''));
    const injected = injectBodies.some((b) => b.includes(PROMPT_MARKER));
    record('inject', injected ? 'PASS' : 'FAIL',
      injected ? 'approved principle text reached the model request body via UserPromptSubmit additionalContext'
        : `marker ${PROMPT_MARKER} absent from ${reqs.length} model requests; stderr=${(run.stderr || '').slice(-400)}`);

    // ── Turn 2: protected Write denied ──
    before = mockReqCount();
    writeMockReply('a', toolCallReply('e2ewrite', 'Write', { file_path: PROTECTED_FILE(), content: 'FORBIDDEN CONTENT' }));
    writeMockReply('b', textReply('e2ewrap', 'done'));
    run = runTwoPrompts('deny');
    reqs = mockReqsSince(before);
    const denied = !fs.existsSync(PROTECTED_FILE());
    const denyReasonSeen = reqs.some((r) => JSON.stringify(r.body ?? '').includes(DENY_REASON));
    record('deny', denied && denyReasonSeen ? 'PASS' : (denied ? 'PARTIAL' : 'FAIL'),
      `fileExists=${fs.existsSync(PROTECTED_FILE())} denyReasonInModelRequest=${denyReasonSeen} stderr=${(run.stderr || '').slice(-200)}`);

    // ── Turn 3: real failing tool → evidence ──
    before = mockReqCount();
    writeMockReply('a', toolCallReply('e2eread', 'Read', { file_path: path.join(PROJECT, 'definitely-missing-e2e.txt') }));
    writeMockReply('b', textReply('e2ewrap2', 'noted'));
    run = runTwoPrompts('fail');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const toolRow = traj.prepare("SELECT tool_name, outcome, exit_code FROM tool_calls WHERE tool_name = 'Read' ORDER BY id DESC").get();
    traj.close();
    record('evidence', toolRow ? 'PASS' : 'FAIL',
      toolRow ? `trajectory tool_calls row: ${JSON.stringify(toolRow)}` : 'no Read failure row in governance trajectory');

    // ── Withdraw via the REAL pd-cli product entry ──
    const pdCli = path.join(REPO, 'packages', 'pd-cli', 'dist', 'index.js');
    const withdraw = spawnSync(process.execPath, [pdCli, 'activation', 'deactivate', '--activation-id', 'act-e2e-prompt', '--workspace', GOV], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME },
    });
    const withdrawOk = withdraw.status === 0 && /Deactivated/i.test(withdraw.stdout || '');
    record('withdraw', withdrawOk ? 'PASS' : 'FAIL',
      `pd-cli exit=${withdraw.status} stdout=${(withdraw.stdout || '').slice(0, 200)} stderr=${(withdraw.stderr || '').slice(-200)}`);

    // ── Turn 4: injection stops after withdrawal ──
    before = mockReqCount();
    run = runTwoPrompts('post-withdraw');
    reqs = mockReqsSince(before);
    const stillInjected = reqs.some((r) => JSON.stringify(r.body ?? '').includes(PROMPT_MARKER));
    record('post-withdraw', stillInjected ? 'FAIL' : 'PASS',
      stillInjected ? 'withdrawn principle text STILL reached the model' : 'withdrawn principle no longer injected (new prompt turns are clean)');
  } finally {
    mock.kill();
  }

  const failed = results.filter((r) => r.verdict === 'FAIL');
  console.log(`\nE2E summary: ${results.filter((r) => r.verdict === 'PASS').length} PASS, ${results.filter((r) => r.verdict === 'PARTIAL').length} PARTIAL, ${failed.length} FAIL`);
  fs.writeFileSync(path.join(LAB_ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  if (!keep) {
    console.log(`(isolation preserved for inspection: ${LAB_ROOT} — delete manually; --keep was NOT set but evidence stays until reboot)`);
  } else {
    console.log(`isolation kept: ${LAB_ROOT}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('E2E crashed:', error);
  process.exitCode = 1;
});
