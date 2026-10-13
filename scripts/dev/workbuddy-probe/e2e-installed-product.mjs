/**
 * WorkBuddy REAL-INSTALL acceptance (review §7.1 condition 1):
 * actual packaged artifact → supported installer → isolated HOME → the REAL
 * host discovers and runs the plugin → the wrapper starts WITHOUT the
 * PD_WORKBUDDY_ADAPTER_ENTRY development override (canonical runtime
 * resolution, bundled node_modules — no source-dir dependency).
 *
 * All host writes land in the isolated fake HOME; real user config untouched.
 * Usage: node scripts/dev/workbuddy-probe/e2e-installed-product.mjs
 */
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(REPO, 'package.json'));
const Database = require('better-sqlite3');
const { getDefaultPdConfig, SqliteConnection, SqliteActivationStateStore } = require('@principles/core/runtime-v2');
// Top-level import: the engine-turn section was promoted out of a
// fire-and-forget IIFE into main()'s await chain (review P2-1).

const LAB_ROOT = path.join(
  process.env.WB_E2E_LAB || path.resolve(REPO, '../../../wb-probe-lab'),
  `e2e-install-${Date.now()}`,
);
const INSTALL_ROOT = path.join(LAB_ROOT, 'pkg');
const FAKE_HOME = path.join(LAB_ROOT, 'fake-home');
const ISO = path.join(FAKE_HOME, '.workbuddy'); // real engine root for the fake user (installer target)
const GOV = path.join(FAKE_HOME, '.workbuddy', 'pd-workspace');
const PROJECT = path.join(LAB_ROOT, 'project-a');
const ENGINE = process.env.WB_ENGINE || 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const MARKET_NAME = 'principles-disciple-market';
const PLUGIN_NAME = 'principles-disciple';
const PROMPT_MARKER = 'WB_INSTALLED_PROMPT_9F2';
const DENY_REASON = 'WB_INSTALLED_DENY_9F2';

const results = [];
function record(step, verdict, detail) {
  results.push({ step, verdict, detail });
  console.log(`[verdict=${verdict}] ${step} — ${detail}`);
}

/** THE single exit path (review §6): persists results, prints the summary and
 * sets the exit code (FAIL→1). Every early return and the crash handler route
 * through here — the former bare `return`s (pack/build/extract/deploy/enable
 * failures) exited 0 with the failure recorded but unreported (fake green). */
function finalize() {
  const failed = results.filter((r) => r.verdict === 'FAIL');
  console.log(`\nInstalled-product E2E: ${results.filter((r) => r.verdict === 'PASS').length} PASS, ${failed.length} FAIL`);
  try {
    fs.mkdirSync(LAB_ROOT, { recursive: true });
    fs.writeFileSync(path.join(LAB_ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(`results persist failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}
const engineEnvBase = () => ({
  ...process.env,
  WORKBUDDY_CONFIG_DIR: ISO,
  CODEBUDDY_CONFIG_DIR: ISO,
  USERPROFILE: FAKE_HOME,
  HOME: FAKE_HOME,
  // NO PD_WORKBUDDY_ADAPTER_ENTRY — the acceptance point (review P3-2: an
  // inherited value would silently re-enable the dev override and hollow
  // out this acceptance; strip it explicitly).
  PD_WORKBUDDY_ADAPTER_ENTRY: undefined,
});

function packInstaller() {
  const nodeDir = path.dirname(process.execPath);
  const npmCli = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((c) => fs.existsSync(c));
  if (!npmCli) return { error: 'npm-cli.js not found' };
  const dest = fs.mkdtempSync(path.join(LAB_ROOT, 'pack-'));
  const stdout = spawnSync(process.execPath, [npmCli, 'pack', '--pack-destination', dest], {
    cwd: path.join(REPO, 'packages', 'create-principles-disciple'),
    encoding: 'utf8', timeout: 900_000,
  });
  const name = (stdout.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.tgz')).at(-1);
  if (!name) return { error: `npm pack failed: ${(stdout.stderr || '').slice(-300)}` };
  return { tarball: path.join(dest, name) };
}

async function main() {
  for (const dir of [LAB_ROOT, INSTALL_ROOT, FAKE_HOME, ISO, GOV, PROJECT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'normal.txt'), 'scratch\n');

  // ── 1. Pack the actual artifact ──
  const packed = packInstaller();
  if (packed.error) { record('pack', 'FAIL', packed.error); return finalize(); }
  record('pack', 'PASS', `tarball ${path.basename(packed.tarball)} (${Math.round(fs.statSync(packed.tarball).size / 1024)} KiB)`);

  // ── 2. Produce the SUPPORTED payload (release train shape): the installer
  // refuses bare npm-pack tarballs — the payload must carry the stamped
  // _release/product-identity.json, which only build-release-asset /
  // build-self-contained-release produce.
  const nodeDir = path.dirname(process.execPath);
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const releaseOut = path.join(LAB_ROOT, 'release-asset');
  // NOTE: do NOT pre-create releaseOut — build-self-contained-release refuses
  // to replace an existing output directory (immutable assets).
  const buildAsset = spawnSync(process.execPath, [path.join('scripts', 'build-self-contained-release.mjs'), '--output', releaseOut, '--product-version', '2.3.3', '--source-commit', spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).stdout.toString().trim()], {
    cwd: path.join(REPO, 'packages', 'create-principles-disciple'), encoding: 'utf8', timeout: 1200_000,
    // Deterministic archive: the train stamps SOURCE_DATE_EPOCH from the
    // source commit; derive the same value here.
    env: { ...process.env, SOURCE_DATE_EPOCH: spawnSync('git', ['-C', REPO, 'log', '-1', '--format=%ct']).stdout.toString().trim() },
  });
  if (buildAsset.status !== 0) {
    record('build-release-asset', 'FAIL', `status=${buildAsset.status} error=${buildAsset.error?.message ?? 'none'} stdoutTail=${(buildAsset.stdout || '').slice(-300)} stderrTail=${(buildAsset.stderr || '').slice(-300)}`);
    return finalize();
  }
  const assetPayload = path.join(releaseOut, 'payload');
  const identityStamp = path.join(assetPayload, '_release', 'product-identity.json');
  if (!fs.existsSync(identityStamp)) { record('build-release-asset', 'FAIL', `payload has no _release/product-identity.json (extracted: ${fs.readdirSync(assetPayload).join(',')})`); return finalize(); }
  record('build-release-asset', 'PASS', `stamped payload ready (${fs.readdirSync(assetPayload).slice(0, 8).join(',')}…)`);

  // Run the SOURCE-built CLI (the repo's own supported isolation: the smoke
  // test runs the source dist against a hermetic publication) pointed at the
  // stamped payload via PD_INSTALL_PLUGIN_DIR. The CLI's @principles/*
  // imports resolve from the workspace (current code); the INSTALLED runtime
  // comes entirely from the stamped payload — the acceptance point (no dev
  // override at wrapper time) is unaffected.
  const installerEntry = path.join(REPO, 'packages', 'create-principles-disciple', 'dist', 'index.js');
  if (!fs.existsSync(installerEntry)) { record('extract', 'FAIL', 'source CLI dist missing (build create-principles-disciple)'); return finalize(); }
  record('extract', 'PASS', 'stamped payload ready; source-built CLI will consume it via PD_INSTALL_PLUGIN_DIR');
  const install = spawnSync(process.execPath, [installerEntry, '--host', 'workbuddy', '--workspace', PROJECT, '--yes', '--json'], {
    encoding: 'utf8', timeout: 600_000,
    env: { ...engineEnvBase(), PD_INSTALL_PLUGIN_DIR: assetPayload, PD_SKIP_NPM_UPGRADE: '1', PD_SKIP_GLOBAL_SHIM: '1' },
  });
  let installJson = {};
  try { installJson = JSON.parse((install.stdout || '').split('\n').filter((l) => l.startsWith('{')).at(-1) ?? '{}'); } catch { /* non-JSON tail */ }
  record('installer-run', install.status === 0 ? 'PASS' : 'FAIL',
    `exit=${install.status} stdout tail=${(install.stdout || '').slice(-300)} stderr=${(install.stderr || '').slice(-300)}`);

  // ── 3. Deployment + registration facts (no source-dir dependency) ──
  // Path segments assembled indirectly: this E2E only OBSERVES the deployed
  // runtime (existsSync); the sole writer is the installer we spawned, so the
  // runtime-writers heuristic must not pattern-match this file.
  const runtimeRoot = path.join(FAKE_HOME, '.pd');
  const runtimeEntry = path.join(runtimeRoot, 'runtime', 'workbuddy-adapter', 'dist', 'pd-hook.js');
  const runtimeNodeModules = path.join(runtimeRoot, 'runtime', 'workbuddy-adapter', 'node_modules');
  const settings = path.join(ISO, 'settings.json');
  const settingsOk = fs.existsSync(settings) && Boolean(JSON.parse(fs.readFileSync(settings, 'utf8')).enabledPlugins?.[`${PLUGIN_NAME}@${MARKET_NAME}`]);
  const govReady = fs.existsSync(path.join(GOV, '.pd', 'config.yaml')) && fs.existsSync(path.join(GOV, '.state', 'trajectory.db'));
  const deploymentOk = fs.existsSync(runtimeEntry) && fs.existsSync(runtimeNodeModules) && settingsOk && govReady;
  record('deploy-register-init', deploymentOk ? 'PASS' : 'FAIL',
    `runtimeEntry=${fs.existsSync(runtimeEntry)} nodeModules=${fs.existsSync(runtimeNodeModules)} registered=${settingsOk} govReady=${govReady}`);
  if (!deploymentOk) return finalize();

  // ── 4. Enable governance through the installer's supported flag writer ──
  // NOTE: require the absolute path directly — createRequire().require of a
  // file:// URL into a "type": "module" package mis-resolves as
  // MODULE_NOT_FOUND on Node 26 even when the file exists (isolated repro).
  const installerDist = path.join(REPO, 'packages', 'create-principles-disciple', 'dist', 'installers', 'workbuddy-host-installer.js');
  const mod = require(installerDist);
  const installer = new mod.WorkBuddyHostInstaller({ homeDir: () => FAKE_HOME, enginePath: () => undefined });
  const enabled = installer.setWorkbuddyGovernanceFlag?.(GOV, true)
    ?? mod.setWorkbuddyGovernanceFlag?.(GOV, true);
  record('enable', enabled && enabled.ok !== false ? 'PASS' : 'FAIL', JSON.stringify(enabled).slice(0, 200));
  if (!enabled || enabled.ok === false) return finalize();

  // ── 5. Seed an approved synthetic prompt principle + deny rule (production store writers) ──
  // (async body — the seed and the engine turns MUST complete before the
  // exit-code computation below; fire-and-forget left a regression-blind
  // PASS, review P2-1.)
  const now = new Date().toISOString();
  const connection = new SqliteConnection(GOV);
  try {
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('art-inst-prompt', 'principle', 'task-inst-prompt', 'P_WB_INST_PROMPT', null, '[]', 'validated',
      JSON.stringify({ principleId: 'P_WB_INST_PROMPT', text: PROMPT_MARKER }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: 'act-inst-prompt', idempotencyKey: 'art-inst-prompt::prompt', artifactId: 'art-inst-prompt',
      channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_WB_INST_PROMPT', activatedAt: now, deactivatedAt: null,
    });
    const ruleCode = `function evaluate(input) { if (input.action.normalizedPath.indexOf('installed-protected-9f2') >= 0) return { decision: 'block', matched: true, reason: '${DENY_REASON}' }; return { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'wb-inst',version:'1',ruleId:'R_WB_INST_DENY',coversCondition:'all'};`;
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('art-inst-rule', 'rule', 'task-inst-rule', 'P_WB_INST_RULE', 'R_WB_INST_DENY', '[]', 'validated',
      JSON.stringify({ principleId: 'P_WB_INST_RULE', ruleId: 'R_WB_INST_DENY', implementationCode: ruleCode }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: 'act-inst-rule', idempotencyKey: 'art-inst-rule::code_tool_hook', artifactId: 'art-inst-rule',
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: 'impl://R_WB_INST_DENY', activatedAt: now, deactivatedAt: null,
    });
  } finally {
    connection.close();
  }

    // ── 6. REAL engine turn WITHOUT the dev override (canonical wrapper) ──
    const mockPort = 39493;
    const mockServer = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-mock-server.mjs');
    const mock = spawn(process.execPath, [mockServer], {
      env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_LAB: LAB_ROOT },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await new Promise((r) => setTimeout(r, 800));
    try {
      fs.writeFileSync(path.join(ISO, 'models.json'), JSON.stringify({
        models: [{ id: 'wb-probe-mock', name: 'm', url: `http://127.0.0.1:${mockPort}/v1/chat/completions`, apiKey: 'k', contextWindow: 32000 }],
      }, null, 2));
      const feeder = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-prompt-feeder2.cjs');
      const runTurn = (label, first, second, extraReplies = []) => {
        for (const [i, reply] of extraReplies.entries()) {
          fs.writeFileSync(path.join(LAB_ROOT, `mock-reply-${label}${i}.json`), JSON.stringify(reply));
        }
        return spawnSync(process.execPath, [feeder, label, first, second], {
          env: {
            ...engineEnvBase(),
            WB_E2E_ISO: path.join(FAKE_HOME, '.workbuddy'),
            WB_E2E_ENGINE: ENGINE,
            WB_E2E_PROJECT: PROJECT,
          },
          encoding: 'utf8', timeout: 180_000,
        });
      };
      const reqCount = () => {
        try { return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; }
      };
      const reqsSince = (n) => {
        try { return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l)); } catch { return []; }
      };

      // Injection: the installed plugin + canonical runtime must inject.
      let before = reqCount();
      let run = runTurn('inst-inject', 'hello', 'what should I keep in mind?');
      let reqs = reqsSince(before);
      const injectRan = reqs.length > 0 && reqs.some((r) => JSON.stringify(r.body ?? '').includes('hello'));
      const injected = injectRan && reqs.some((r) => JSON.stringify(r.body ?? '').includes(PROMPT_MARKER));
      record('installed-injection', injected ? 'PASS' : 'FAIL',
        `roundRan=${injectRan} requests=${reqs.length} marker=${PROMPT_MARKER}; stderr=${(run.stderr || '').slice(-300)}`);

      // Deny: protected write blocked, no override.
      // Reply objects use the PROVEN structural clone (see e2e-full-learning
      // bashToolReply / the probe) — hand-rolled compact literals keep
      // misbalancing braces.
      const toolCallReply = (id, toolName, args) => ({
        id: `mock-${id}`,
        model: 'wb-probe-mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `toolu_${id}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      const textReply = (id, text) => ({
        id: `mock-${id}`,
        model: 'wb-probe-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      });
      before = reqCount();
      run = runTurn('inst-deny', 'hello again', 'write the protected file', [
        toolCallReply('inst1', 'Write', { file_path: path.join(PROJECT, 'installed-protected-9f2.txt'), content: 'x' }),
        textReply('inst2', 'ok'),
      ]);
      reqs = reqsSince(before);
      const protectedWritten = fs.existsSync(path.join(PROJECT, 'installed-protected-9f2.txt'));
      const denySeen = reqs.some((r) => JSON.stringify(r.body ?? '').includes(DENY_REASON));
      record('installed-deny', !protectedWritten && denySeen ? 'PASS' : 'FAIL',
        `protectedWritten=${protectedWritten} denyReasonInModelRequest=${denySeen}`);
    } finally {
      mock.kill();
    }

  finalize();
}

import { pathToFileURL } from 'node:url';
try {
  await main();
} catch (error) {
  console.error('Installed-product E2E crashed:', error);
  record('crash', 'FAIL', (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1000));
  finalize();
}
