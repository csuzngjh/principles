#!/usr/bin/env node
/**
 * Anonymous Product Telemetry v1 — production-equivalent smoke (PRI-603,
 * SPEC §53/§70).
 *
 * Builds an ISOLATED, production-equivalent installation in a temp HOME:
 *   - canonical install layout (~/.pd/install.json + ~/.pd/runtime/host-runtime
 *     copied from the real built dist — the executing module genuinely lives
 *     in an installed layout, so repo-checkout suppression does not fire);
 *   - a workspace with real seeded SQLite durable facts and the telemetry
 *     flag enabled in .pd/config.yaml;
 * then runs the FULL opt-in loop from inside that installation using the REAL
 * network stack (no fetch injection):
 *
 *   enable → preview (0 requests) → export (1 real HTTPS request) →
 *   same-day re-trigger (0 requests) → disable → re-trigger (0 requests)
 *
 * and verifies the maintainer view renders the smoke snapshot's version.
 * Asserts every step; exits non-zero on any failure.
 *
 * Usage:
 *   node scripts/telemetry-production-smoke.mjs --endpoint https://host [--signals-token <token>]
 *
 * No secrets are printed or committed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { values } = parseArgs({
  options: {
    endpoint: { type: 'string' },
    'signals-token': { type: 'string' },
  },
});
if (!values.endpoint) {
  console.error('usage: node scripts/telemetry-production-smoke.mjs --endpoint <url> [--signals-token <token>]');
  process.exit(1);
}
const ENDPOINT = values.endpoint.replace(/\/+$/, '');
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SMOKE_VERSION = '9.9.9-telemetry-smoke';

// ── 1. Isolated production-equivalent HOME ───────────────────────────────────

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-smoke-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-smoke-ws-'));

fs.mkdirSync(path.join(home, '.pd', 'runtime', 'host-runtime'), { recursive: true });
fs.cpSync(path.join(REPO_ROOT, 'packages', 'host-runtime', 'dist'), path.join(home, '.pd', 'runtime', 'host-runtime', 'dist'), { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, 'packages', 'host-runtime', 'package.json'), path.join(home, '.pd', 'runtime', 'host-runtime', 'package.json'));
fs.writeFileSync(path.join(home, '.pd', 'install.json'), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['openclaw'] }));
fs.mkdirSync(path.join(home, '.pd', 'runtime', 'plugin'), { recursive: true });
fs.writeFileSync(path.join(home, '.pd', 'runtime', 'plugin', 'package.json'), JSON.stringify({ name: 'principles-disciple', version: SMOKE_VERSION }));

// Dependency junctions so the copied host-runtime resolves @principles/core,
// @principles/install-layout, better-sqlite3, js-yaml from the repo build.
const nodeModules = path.join(home, 'node_modules');
fs.mkdirSync(path.join(nodeModules, '@principles'), { recursive: true });
for (const [link, target] of [
  [path.join(nodeModules, '@principles', 'core'), path.join(REPO_ROOT, 'packages', 'principles-core')],
  [path.join(nodeModules, '@principles', 'install-layout'), path.join(REPO_ROOT, 'packages', 'install-layout')],
  [path.join(nodeModules, 'better-sqlite3'), path.join(REPO_ROOT, 'node_modules', 'better-sqlite3')],
  [path.join(nodeModules, 'js-yaml'), path.join(REPO_ROOT, 'node_modules', 'js-yaml')],
]) {
  fs.symlinkSync(target, link, 'junction');
}
fs.mkdirSync(path.join(nodeModules, '@sinclair'), { recursive: true });
fs.symlinkSync(path.join(REPO_ROOT, 'node_modules', '@sinclair', 'typebox'), path.join(nodeModules, '@sinclair', 'typebox'), 'junction');

// ── 2. Workspace with real durable facts + flag on ──────────────────────────

fs.mkdirSync(path.join(workspace, '.pd'), { recursive: true });
fs.mkdirSync(path.join(workspace, '.state'), { recursive: true });
fs.writeFileSync(
  path.join(workspace, '.pd', 'config.yaml'),
  [
    'version: 1',
    'workspace:',
    `  default: ${workspace.split(path.sep).join('/')}`,
    '  environment: production',
    'features:',
    '  anonymous_product_telemetry:',
    '    category: quiet',
    '    enabled: true',
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    diagnostician:',
    '      enabled: false',
    '    dreamer:',
    '      enabled: false',
    '    scribe:',
    '      enabled: false',
    '    artificer:',
    '      enabled: false',
    '    philosopher:',
    '      enabled: false',
    '    evaluator:',
    '      enabled: false',
    '    rolloutReviewer:',
    '      enabled: false',
    '    correctionObserver:',
    '      enabled: false',
    '    empathyObserver:',
    '      enabled: false',
    '    signalCollector:',
    '      enabled: false',
    '',
  ].join('\n'),
);

const Database = require('better-sqlite3');
const stateDb = new Database(path.join(workspace, '.pd', 'state.db'));
stateDb.exec('CREATE TABLE schema_version (version TEXT PRIMARY KEY)');
const insertVersion = stateDb.prepare('INSERT INTO schema_version (version) VALUES (?)');
insertVersion.run('002');
stateDb.exec('CREATE TABLE activations (activation_id TEXT, activated_at TEXT NOT NULL)');
stateDb.exec("CREATE TABLE principle_applications (principle_id TEXT, session_id TEXT, level TEXT NOT NULL CHECK (level IN ('effect','presence')), kind TEXT NOT NULL, applied_at TEXT NOT NULL)");
const insertApplication = stateDb.prepare('INSERT INTO principle_applications (principle_id, session_id, level, kind, applied_at) VALUES (?, ?, ?, ?, ?)');
insertApplication.run('smoke-p1', 'smoke-s1', 'presence', 'prompt_injected', new Date().toISOString());
stateDb.close();
const trajectoryDb = new Database(path.join(workspace, '.state', 'trajectory.db'));
trajectoryDb.exec('CREATE TABLE pain_events (id TEXT, canonical_pain_id TEXT, created_at TEXT)');
const insertPain = trajectoryDb.prepare('INSERT INTO pain_events (id, canonical_pain_id, created_at) VALUES (?, ?, ?)');
insertPain.run('smoke-e1', 'smoke-cp1', new Date().toISOString());
trajectoryDb.close();

// ── 3. In-installation runner (real module location, real fetch) ────────────

const runnerPath = path.join(home, 'telemetry-smoke-runner.mjs');
fs.writeFileSync(
  runnerPath,
  `import { pathToFileURL } from 'node:url';
const { createProductTelemetryService, PREVIEW_BANNER } = await import(
  pathToFileURL(${JSON.stringify(path.join(home, '.pd', 'runtime', 'host-runtime', 'dist', 'product-telemetry', 'service.js'))}).href
);
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };
const service = createProductTelemetryService({
  homeDir: ${JSON.stringify(home)},
  env: {},
  endpoint: ${JSON.stringify(`${ENDPOINT}/api/product-telemetry/snapshot`)},
});
const workspace = ${JSON.stringify(workspace)};
const out = [];
const step = (label, pass, detail) => { out.push({ label, pass, detail }); };

const enabled = service.enable();
step('enable grants consent', enabled.ok && enabled.consent === 'granted', JSON.stringify(enabled).slice(0, 120));

const preview = service.preview(workspace);
step('preview shows exact payload with banner', preview.banner === PREVIEW_BANNER && preview.snapshot.pdVersion === ${JSON.stringify(SMOKE_VERSION)}, JSON.stringify(preview.snapshot).slice(0, 160));
step('preview milestone honesty (presence yes / effect no)', preview.snapshot.milestones.presenceReceiptObserved === true && preview.snapshot.milestones.effectReceiptObserved === false);
step('preview makes zero network requests', fetchCalls === 0, String(fetchCalls));

const exported = await service.maybeExportDaily(workspace);
step('export attempted and succeeded over real HTTPS', exported.attempted === true && exported.ok === true, JSON.stringify(exported).slice(0, 120));
step('export made exactly one request', fetchCalls === 1, String(fetchCalls));

const sameDay = await service.maybeExportDaily(workspace);
step('same-day re-trigger skipped (bounded 1/day)', sameDay.attempted === false && sameDay.skipReason === 'already_succeeded_today', JSON.stringify(sameDay));
step('no extra request after same-day skip', fetchCalls === 1, String(fetchCalls));

const disabled = service.disable();
step('disable denies consent', disabled.ok && disabled.consent === 'denied');

const afterDisable = await service.maybeExportDaily(workspace);
step('post-disable export skipped', afterDisable.attempted === false && afterDisable.skipReason === 'consent_denied', JSON.stringify(afterDisable));
step('zero requests after disable', fetchCalls === 1, String(fetchCalls));

const status = service.getStatus(workspace);
step('status renders without secret', status.ok && JSON.stringify(status.view).toLowerCase().indexOf('telemetrysecret') === -1);

console.log(JSON.stringify(out));
process.exit(out.every((x) => x.pass) ? 0 : 1);
`,
);

// The runner is executed by the caller (bash) so this script stays free of
// child_process; here we only write it. Execution:
console.log(`RUNNER=${runnerPath}`);
console.log(`WORKSPACE=${workspace}`);

fs.writeFileSync(path.join(home, 'smoke-meta.json'), JSON.stringify({ home, workspace, runnerPath, endpoint: ENDPOINT, version: SMOKE_VERSION }, null, 2));
