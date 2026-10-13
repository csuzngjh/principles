#!/usr/bin/env node
/**
 * Exit-code contract regression for the WorkBuddy E2E scripts (review §4/§6
 * remediation): EVERY failure path must persist e2e-results.json and exit
 * NON-ZERO — before the fix, bare `return`s on preflight/pack/injection
 * failures exited 0 (fake green, observed by the independent review).
 *
 * Method: each scenario runs a COPY of the REAL script with ONE injected
 * fault (exact-match textual patch or env), so the assertion covers the real
 * exit-path code, not a reimplementation. A drifting source fails the patch
 * precondition loudly. No LLM call is made (faults fire before the provider
 * boundary; the worker loop runs against stubs).
 *
 * Usage: node scripts/dev/workbuddy-probe/test-e2e-exit-codes.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const FULL_LEARNING = path.join(HERE, 'e2e-full-learning.mjs');
const INSTALLED = path.join(HERE, 'e2e-installed-product.mjs');
const ADAPTER_ENTRY = path.join(REPO, 'packages', 'workbuddy-adapter', 'dist', 'pd-hook.js');
const REPO_LINE = "const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');";

const failures = [];
let total = 0;

function makeCopy(sourcePath, patches, scenarioDir) {
  let src = fs.readFileSync(sourcePath, 'utf8');
  for (const [from, to] of [[REPO_LINE, `const REPO = ${JSON.stringify(REPO)};`], ...patches]) {
    if (!src.includes(from)) throw new Error(`patch precondition failed — source drifted, update this regression:\n  ${from}`);
    src = src.replace(from, to);
  }
  const copy = path.join(scenarioDir, 'script-copy.mjs');
  fs.writeFileSync(copy, src);
  return copy;
}

function runScenario({ name, script, patches = [], env = {}, setup, expectExit, expectVerdicts }) {
  total += 1;
  const scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-exit-code-${name}-`));
  const lab = path.join(scenarioDir, 'lab');
  fs.mkdirSync(lab, { recursive: true });
  const problems = [];
  let actualExit = null;
  try {
    let copy;
    try {
      copy = makeCopy(script, patches, scenarioDir);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      console.log(`[FAIL] ${name} — ${error.message.split('\n')[0]}`);
      return;
    }
    const setupEnv = setup ? setup(scenarioDir) : {};
    const result = spawnSync(process.execPath, [copy], {
      encoding: 'utf8', timeout: 180_000, windowsHide: true,
      env: { ...process.env, ...env, ...setupEnv, WB_E2E_LAB: lab },
    });
    actualExit = result.status;
    if (actualExit !== expectExit) problems.push(`exit=${actualExit} (expected ${expectExit})`);
    const labEntries = fs.existsSync(lab) ? fs.readdirSync(lab).filter((d) => d.startsWith('e2e-')) : [];
    const resultsPath = labEntries.length >= 1 ? path.join(lab, labEntries[0], 'e2e-results.json') : null;
    if (!resultsPath || !fs.existsSync(resultsPath)) {
      problems.push('e2e-results.json NOT written');
    } else {
      const recorded = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      if (!Array.isArray(recorded)) problems.push('e2e-results.json is not an array');
      else {
        for (const [step, verdict] of expectVerdicts) {
          const row = recorded.find((r) => r.step === step);
          if (!row) problems.push(`results missing step "${step}"`);
          else if (row.verdict !== verdict) problems.push(`step "${step}" verdict=${row.verdict} (expected ${verdict})`);
        }
      }
    }
  } finally {
    try { fs.rmSync(scenarioDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  if (problems.length > 0) failures.push(`${name}: ${problems.join('; ')}`);
  console.log(`[${problems.length === 0 ? 'PASS' : 'FAIL'}] ${name} — exit=${actualExit} (expected ${expectExit})${problems.length ? '; ' + problems.join('; ') : ''}`);
}

// ── S1 — missing credentials (full-learning preflight): BLOCKED → exit 2 ──
// (Empty override wins the env merge in runScenario; the script's
// `!process.env[LLM_KEY_ENV]` treats '' as absent.)
runScenario({
  name: 'missing-credentials-blocked-exit2',
  script: FULL_LEARNING,
  env: { AMD_RADEON_API_KEY: '' },
  expectExit: 2,
  expectVerdicts: [['preflight', 'BLOCKED']],
});

// ── S2 — missing adapter entry (full-learning preflight): FAIL → exit 1 ──
runScenario({
  name: 'missing-entry-fail-exit1',
  script: FULL_LEARNING,
  patches: [[
    `const ADAPTER_ENTRY = path.join(REPO, 'packages', 'workbuddy-adapter', 'dist', 'pd-hook.js');`,
    `const ADAPTER_ENTRY = path.join(REPO, 'packages', 'workbuddy-adapter', 'dist', 'pd-hook.MISSING.js');`,
  ]],
  expectExit: 1,
  expectVerdicts: [['preflight', 'FAIL']],
});

// ── S3 — pack failure (installed-product): FAIL → exit 1 (was exit 0, review §6) ──
runScenario({
  name: 'pack-failure-exit1',
  script: INSTALLED,
  patches: [[
    `[path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((c) => fs.existsSync(c))`,
    `[path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(() => false)`,
  ]],
  expectExit: 1,
  expectVerdicts: [['pack', 'FAIL']],
});

// ── S4 — no model request + worker subprocess non-zero (full-learning mid-run) ──
// Engine stub exits 3 without ever issuing a model request; the pd-cli stub
// exits 3 so every worker cycle fails; the deadline/gap are shortened so the
// bounded loop fails within seconds instead of 45 minutes. No LLM call happens.
if (!process.env.AMD_RADEON_API_KEY) {
  total += 1;
  console.log('[SKIP] engine-nonzero-no-requests-exit1 — AMD_RADEON_API_KEY not set in this shell; preflight would BLOCK before the mid-run faults are reachable');
} else if (!fs.existsSync(ADAPTER_ENTRY)) {
  total += 1;
  console.log('[SKIP] engine-nonzero-no-requests-exit1 — adapter dist missing (build packages/workbuddy-adapter first)');
} else {
  runScenario({
    name: 'engine-nonzero-no-requests-exit1',
    script: FULL_LEARNING,
    patches: [
      [
        `const PD_CLI = path.join(REPO, 'packages', 'pd-cli', 'dist', 'index.js');`,
        // LAB_ROOT = <scenarioDir>/lab/e2e-learn-<ts> → ../.. is the scenario
        // dir where setup() wrote cli-stub.cjs.
        `const PD_CLI = path.join(LAB_ROOT, '..', '..', 'cli-stub.cjs');`,
      ],
      [
        `const deadline = Date.now() + 45 * 60_000;`,
        `const deadline = Date.now() + 1_500;`,
      ],
      [
        `await new Promise((r2) => setTimeout(r2, 45_000));`,
        `await new Promise((r2) => setTimeout(r2, 50));`,
      ],
    ],
    setup: (scenarioDir) => {
      const engineStub = path.join(scenarioDir, 'engine-stub.cjs');
      fs.writeFileSync(engineStub, 'process.exit(3);\n');
      fs.writeFileSync(path.join(scenarioDir, 'cli-stub.cjs'), 'process.exit(3);\n');
      return { WB_ENGINE: engineStub };
    },
    expectExit: 1,
    expectVerdicts: [['real-failure-evidence', 'FAIL'], ['background-chain', 'FAIL']],
  });
}

console.log(`\nExit-code regression: ${total - failures.length}/${total} scenarios passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exitCode = 1;
}
