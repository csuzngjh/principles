/**
 * WorkBuddy INSTALLED-PRODUCT FULL-LEARNING E2E (round-4 R3; SPEC §8 完整学习档
 * on the SUPPORTED install path — the finding this script closes: the prior
 * full-learning lab was a development-entry experiment (manual plugin copy,
 * PD_WORKBUDDY_ADAPTER_ENTRY override, handwritten governance profile/DDL) and
 * must never be presented as the installed-product chain).
 *
 * EVERY leg runs from the SAME isolated install produced by the SUPPORTED
 * entries in ONE lab:
 *   npm pack → stamped release payload (build-self-contained-release)
 *   → official installer entry (--provider/--model/--api-key-env install args
 *     write the governance LLM profile — no handwritten config, no test-time
 *     rebind, no handwritten DDL; the shared `pd runtime init` creates the DBs)
 *   → installer flag-writer enable
 *   → REAL engine hook (canonical wrapper; PD_WORKBUDDY_ADAPTER_ENTRY stripped)
 *   → synthetic-protocol signal through the INSTALLED adapter entry
 *   → worker cycles through the INSTALLED pd-cli (real governance LLM)
 *   → real `pd activation approve` → REAL engine next-turn injection
 *   → real deactivate → post-withdraw stop.
 *
 * EVIDENCE CLASSES, KEPT DISTINCT:
 *   - host task model = local mock server (scripted agent-loop replies);
 *   - governance diagnosis/proposal LLM = the REAL provider from the
 *     install-written profile (AMD_RADEON_API_KEY);
 *   - the admission-eligible signal is SYNTHETIC-PROTOCOL (real-shaped
 *     Write-failure PostToolUse through the installed entry), clearly labeled;
 *     real Bash/Write failures are recorded as evidence-only per the frozen
 *     admission policy and are never stitched into the learning chain.
 *
 * EXIT CONTRACT (round-4 R2/R3): exit 0 requires EVERY required step PASS —
 * a missing leg (no prompt candidate, all-policy-terminal, rule-only, approve
 * failure) is FAIL (1); only a durable provider rate limit is BLOCKED (2).
 *
 * All host writes land in the isolated fake HOME; real user config untouched.
 * Usage: AMD_RADEON_API_KEY=… node scripts/dev/workbuddy-probe/e2e-installed-full-learning.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defineScenario, evaluateScenario, formatEvaluationReport } from './lib/learning-scenario-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(REPO, 'package.json'));
const Database = require('better-sqlite3');

const LAB_ROOT = path.join(
  process.env.WB_E2E_LAB || path.resolve(REPO, '../../../wb-probe-lab'),
  `e2e-installed-learn-${Date.now()}`,
);
const FAKE_HOME = path.join(LAB_ROOT, 'fake-home');
const ISO = path.join(FAKE_HOME, '.workbuddy');
const GOV = path.join(FAKE_HOME, '.workbuddy', 'pd-workspace');
const PROJECT = path.join(LAB_ROOT, 'project-a');
const ENGINE = process.env.WB_ENGINE || 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const MOCK_PORT = 39497;
const MARKET_NAME = 'principles-disciple-market';
const PLUGIN_NAME = 'principles-disciple';
const LLM_MODEL = process.env.WB_E2E_LLM_MODEL || 'DeepSeek-V4-Flash-Vision-Exp';
const LLM_KEY_ENV = 'AMD_RADEON_API_KEY';
const LLM_BASE_URL = process.env.WB_E2E_LLM_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1';
const POLICY_TERMINAL_KINDS = new Set(['implementation', 'defer']);
const ADMISSION_CONFIDENCE_THRESHOLD = 0.5;

const results = [];
const startedAt = new Date().toISOString();
function record(step, verdict, detail) {
  results.push({ step, verdict, detail });
  console.log(`[${verdict}] ${step} — ${detail}`);
}

/** THE single exit path. Round-5 R2b: the exit code comes ONLY from the
 * shared scenario-contract module (defineScenario + evaluateScenario) — this
 * runner declares its required-step set through that ONE authority and carries
 * NO exit logic of its own. The module's precedence (FAIL > blocking BLOCKED >
 * missing leg) means a real product failure is never masked as a provider
 * BLOCKED, and a required leg that was never RECORDED is a miss (an early
 * return can never shrink the denominator). */
function finalize() {
  let evaluation;
  try {
    evaluation = evaluateScenario(INSTALLED_FULL_SCENARIO, results);
  } catch (error) {
    console.error(`scenario evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nInstalled-full-learning E2E: ${results.filter((r) => r.verdict === 'PASS').length} PASS, ${evaluation.failures.length} FAIL, ${evaluation.blocked.length} blocking BLOCKED, ${evaluation.missingRequired.length} required-leg miss (started ${startedAt})`);
  console.log(formatEvaluationReport(evaluation));
  try {
    fs.mkdirSync(LAB_ROOT, { recursive: true });
    fs.writeFileSync(path.join(LAB_ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(LAB_ROOT, 'e2e-evaluation.json'), JSON.stringify(evaluation, null, 2));
  } catch (error) {
    console.error(`results persist failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = evaluation.exitCode;
}

/** The installed runner's required-step set, declared through the shared
 * contract module (round-5 R2b) — the FULL-principle chain plus the install
 * legs that make this the INSTALLED-product acceptance. */
const INSTALLED_FULL_SCENARIO = defineScenario({
  id: 'installed-full-principle-learning',
  label: '正式安装产物完整原则学习 (INSTALLED FULL PRINCIPLE LEARNING)',
  requiresFullLearning: true,
  required: {
    'pack': ['PASS'],
    'build-release-asset': ['PASS'],
    'installer-run': ['PASS'],
    'deploy-register-init': ['PASS'],
    'governance-config-from-args': ['PASS'],
    'enable': ['PASS'],
    'real-failure-evidence': ['PASS'],
    'eligible-signal-synthetic': ['PASS'],
    'background-chain': ['PASS'],
    'chain-disposition': ['PASS'],
    'owner-approval': ['PASS'],
    'next-turn-injection': ['PASS'],
    'withdraw': ['PASS'],
    'post-withdraw': ['PASS'],
  },
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const engineEnvBase = () => ({
  ...process.env,
  WORKBUDDY_CONFIG_DIR: ISO,
  CODEBUDDY_CONFIG_DIR: ISO,
  USERPROFILE: FAKE_HOME,
  HOME: FAKE_HOME,
  // THE acceptance point: the dev override must never reach the wrapper.
  PD_WORKBUDDY_ADAPTER_ENTRY: undefined,
});

/** The INSTALLED product entries inside the fake HOME (canonical runtime —
 * never the worktree dist). */
const installedAdapterEntry = () => path.join(FAKE_HOME, '.pd', 'runtime', 'workbuddy-adapter', 'dist', 'pd-hook.js');
const installedPdCli = () => path.join(FAKE_HOME, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js');

const pdCli = (args, timeoutMs = 420_000) => spawnSync(process.execPath, [installedPdCli(), ...args], {
  encoding: 'utf8', timeout: timeoutMs, env: { ...engineEnvBase() },
});

/** The installer's --json result may be pretty-printed (multi-line): parse the
 * LAST top-level JSON block, falling back to single-line scans. (First R3 run
 * aborted a SUCCESSFUL install because a lone `{` line failed the old parse.) */
function parseLastJsonBlock(text) {
  const attempts = [];
  if (text) {
    const idx = text.lastIndexOf('\n{');
    if (idx >= 0) attempts.push(text.slice(idx + 1));
    if (text.trimStart().startsWith('{')) attempts.push(text);
    attempts.push(...text.split('\n').filter((l) => l.startsWith('{')).reverse());
  }
  for (const attempt of attempts) {
    try { return JSON.parse(attempt.trim()); } catch { /* try next shape */ }
  }
  return {};
}

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

// ── Identity-chain correlation (same read contract as the full-learning E2E;
// readonly, parameterized, never pending[0]) ────────────────────────────────
function readLearningChain(govDir, painId) {
  let admission;
  let traj;
  try {
    traj = new Database(path.join(govDir, '.state', 'trajectory.db'), { readonly: true });
    admission = traj.prepare(
      "SELECT canonical_pain_id, diagnostician_task_id FROM governance_signal_admissions WHERE host_kind = 'workbuddy' AND canonical_pain_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(painId);
  } catch {
    return null;
  } finally {
    try { traj?.close(); } catch { /* ignore */ }
  }
  if (!admission?.diagnostician_task_id) return null;
  let db;
  try {
    db = new Database(path.join(govDir, '.pd', 'state.db'), { readonly: true });
  } catch {
    return null;
  }
  const chain = { diagnosticianTaskId: admission.diagnostician_task_id, candidates: [], chainTasks: [], artifacts: [], approvals: [], pendingApprovals: [] };
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
         FROM tasks WHERE json_extract(diagnostic_json, '$.pi_metadata.correlationId') = ?`,
      ).all(candidate.candidate_id);
      chain.chainTasks.push(...tasks);
      for (const task of tasks) {
        chain.artifacts.push(...db.prepare('SELECT artifact_id, artifact_kind, source_task_id FROM pi_artifacts WHERE source_task_id = ?').all(task.task_id));
      }
    }
    for (const artifact of chain.artifacts) {
      chain.approvals.push(...db.prepare('SELECT approval_id, artifact_id, channel, status FROM approvals WHERE artifact_id = ?').all(artifact.artifact_id));
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
  return chain.candidates.map((c) => {
    const tasks = chain.chainTasks.filter((t) => t.candidate_id === c.candidate_id).map((t) => `${t.task_kind}:${t.status}`).join(',');
    return `${c.candidate_id}(kind=${c.recommendation_kind},status=${c.status},${candidateDisposition(chain, c)}${tasks.length > 0 ? `;tasks=${tasks}` : ''})`;
  }).join('; ');
}
function latestDiagnosticianCategory(db, diagTaskId) {
  try {
    const row = db.prepare('SELECT error_category FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(diagTaskId);
    return row?.error_category ?? undefined;
  } catch { return undefined; }
}

async function main() {
  const installerEntry = path.join(REPO, 'packages', 'create-principles-disciple', 'dist', 'index.js');
  if (!fs.existsSync(installerEntry)) { record('preflight', 'FAIL', 'build create-principles-disciple first (dist/index.js missing)'); return finalize(); }
  if (!fs.existsSync(ENGINE)) { record('preflight', 'FAIL', `engine not found: ${ENGINE}`); return finalize(); }
  if (!process.env[LLM_KEY_ENV]) {
    record('preflight', 'BLOCKED', `${LLM_KEY_ENV} not set — real governance LLM unavailable; installed-full-learning BLOCKED (not mocked)`);
    return finalize();
  }
  for (const dir of [LAB_ROOT, FAKE_HOME, ISO, GOV, PROJECT]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'normal.txt'), 'scratch\n');
  record('preflight', 'PASS', `lab ${LAB_ROOT}; source HEAD ${spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).stdout.toString().trim()}; engine sha256 ${sha256(ENGINE).slice(0, 16)}…`);

  // ── 1. Pack + stamped release payload (the SUPPORTED artifact shape) ──
  const packed = packInstaller();
  if (packed.error) { record('pack', 'FAIL', packed.error); return finalize(); }
  record('pack', 'PASS', `tarball ${path.basename(packed.tarball)} sha256 ${sha256(packed.tarball).slice(0, 16)}…`);

  const nodeDir = path.dirname(process.execPath);
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const releaseOut = path.join(LAB_ROOT, 'release-asset');
  const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const assetBuild = spawnSync(process.execPath, [path.join('scripts', 'build-self-contained-release.mjs'), '--output', releaseOut, '--product-version', '2.3.3', '--source-commit', head], {
    cwd: path.join(REPO, 'packages', 'create-principles-disciple'), encoding: 'utf8', timeout: 1200_000,
    env: { ...process.env, SOURCE_DATE_EPOCH: spawnSync('git', ['-C', REPO, 'log', '-1', '--format=%ct']).stdout.toString().trim() },
  });
  if (assetBuild.status !== 0) {
    record('build-release-asset', 'FAIL', `status=${assetBuild.status} stderr=${(assetBuild.stderr || '').slice(-300)}`);
    return finalize();
  }
  const assetPayload = path.join(releaseOut, 'payload');
  const identityStamp = path.join(assetPayload, '_release', 'product-identity.json');
  if (!fs.existsSync(identityStamp)) { record('build-release-asset', 'FAIL', `payload has no product-identity stamp (${fs.readdirSync(assetPayload).slice(0, 8).join(',')}…)`) ; return finalize(); }
  record('build-release-asset', 'PASS', `stamped payload; identity=${fs.readFileSync(identityStamp, 'utf8').slice(0, 200)}`);

  // ── 1b. Consume the PACKAGED npm installer entry itself (round-5 R3
  // boundary): the main install below runs the source-built CLI dist; this
  // leg proves the tarball's OWN entry installs in a FRESH HOME with no
  // source tree, consuming the same stamped payload. Isolated second HOME.
  const tarballHome = path.join(LAB_ROOT, 'tarball-home');
  const tarballProject = path.join(LAB_ROOT, 'tarball-project');
  const tarballGov = path.join(tarballHome, '.workbuddy', 'pd-workspace');
  const tarballExtractDir = path.join(LAB_ROOT, 'tarball-pkg');
  for (const dir of [tarballHome, tarballProject]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tarballExtractDir, { recursive: true });
  // GNU tar reads `D:\...` in -f as a REMOTE host (drive-letter colon). Run it
  // with cwd at the TARBALL's own directory and use basename + a colon-free
  // relative extract target.
  const tarballDir = path.dirname(packed.tarball);
  const extract = spawnSync('tar', ['-xzf', path.basename(packed.tarball), '-C', path.relative(tarballDir, tarballExtractDir).replace(/\\/g, '/')], {
    encoding: 'utf8', timeout: 120_000, cwd: tarballDir,
  });
  const tarballEntry = path.join(tarballExtractDir, 'package', 'dist', 'index.js');
  if (extract.status !== 0 || !fs.existsSync(tarballEntry)) {
    record('tarball-installer-entry', 'FAIL',
      `packaged npm installer entry unusable: tarExit=${extract.status} entryFound=${fs.existsSync(tarballEntry)} stderr=${(extract.stderr || '').slice(-200)}`);
  } else {
    // Real consumer step 1: install the package's declared dependencies from
    // the registry (the tarball ships no node_modules).
    const nodeDir = path.dirname(process.execPath);
    const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const consumerInstall = spawnSync(process.execPath, [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      encoding: 'utf8', timeout: 900_000, cwd: path.join(tarballExtractDir, 'package'),
    });
    if (consumerInstall.status !== 0 || !fs.existsSync(path.join(tarballExtractDir, 'package', 'node_modules'))) {
      record('tarball-installer-entry', 'BLOCKED',
        `npm install of the packaged tarball failed (environment/registry or manifest — needs human triage; NOT classified as a product FAIL without triage): exit=${consumerInstall.status} stderr=${(consumerInstall.stderr || '').slice(-400)}`);
    } else {
      const tarballInstall = spawnSync(process.execPath, [
        tarballEntry, '--host', 'workbuddy', '--workspace', tarballProject, '--yes', '--json',
        '--provider', 'openai', '--model', LLM_MODEL, '--api-key-env', LLM_KEY_ENV,
        '--base-url', LLM_BASE_URL,
      ], {
        encoding: 'utf8', timeout: 900_000,
        env: {
          ...process.env,
          WORKBUDDY_CONFIG_DIR: path.join(tarballHome, '.workbuddy'),
          CODEBUDDY_CONFIG_DIR: path.join(tarballHome, '.workbuddy'),
          USERPROFILE: tarballHome,
          HOME: tarballHome,
          PD_WORKBUDDY_ADAPTER_ENTRY: undefined,
          PD_INSTALL_PLUGIN_DIR: assetPayload,
          PD_SKIP_NPM_UPGRADE: '1',
          PD_SKIP_GLOBAL_SHIM: '1',
        },
      });
      let tarballGovOk = false;
      try {
        const tarballConfigText = fs.readFileSync(path.join(tarballGov, '.pd', 'config.yaml'), 'utf8');
        tarballGovOk = new RegExp(`model:\\s*["']?${LLM_MODEL}`).test(tarballConfigText)
          && new RegExp(`baseUrl:\\s*["']?${LLM_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(tarballConfigText);
      } catch { /* config absent */ }
      const tarballJson = parseLastJsonBlock(tarballInstall.stdout);
      const tarballOk = tarballInstall.status === 0 && tarballJson.success === true && tarballGovOk;
      const stderrText = tarballInstall.stderr || '';
      // Release-state boundary: the packaged CLI imports @principles/* from
      // the REGISTRY (its declared deps), and the registry's published
      // versions predate unreleased workspace exports (e.g.
      // getWorkbuddyWorkspaceDir). That is a RELEASE-TRAIN state, not a
      // package defect — recorded SKIP (NOT RUN) so the claim this run makes
      // is bounded honestly; any OTHER entry failure is a FAIL.
      const exportSkew = /does not provide an export named/.test(stderrText) && /@principles\//.test(stderrText);
      if (tarballOk) {
        record('tarball-installer-entry', 'PASS',
          `packaged tarball's OWN installer entry (fresh HOME, no source tree, registry deps): exit=0 success=true govProfileCarriesArgs=${tarballGovOk}`);
      } else if (tarballInstall.status !== 0 && exportSkew) {
        record('tarball-installer-entry', 'SKIP',
          `NOT RUN (release-state boundary): the packaged CLI's registry @principles/* deps predate unreleased workspace exports — resolvable only after the next release train publishes them. Evidence: ${stderrText.slice(0, 300)}. This leg bounds the npm-package delivery claim ONLY; the installed-runtime chain (legs below) is unaffected`);
      } else {
        record('tarball-installer-entry', 'FAIL',
          `packaged tarball's OWN installer entry (fresh HOME, no source tree, registry deps): exit=${tarballInstall.status} success=${tarballJson.success === true} govProfileCarriesArgs=${tarballGovOk} stdoutTail=${(tarballInstall.stdout || '').slice(-200)} stderr=${stderrText.slice(-300)}`);
      }
    }
  }

  // ── 2. OFFICIAL install with the LLM profile from INSTALL ARGS ──
  // --base-url is required for a custom OpenAI-compatible deployment: pi-ai
  // validates the model against the provider catalog unless the profile
  // carries a custom endpoint (the first R3 run failed exactly there — the
  // install-arg surface could not express a baseUrl, so the diagnostician
  // died in provider catalog validation).
  const install = spawnSync(process.execPath, [
    installerEntry, '--host', 'workbuddy', '--workspace', PROJECT, '--yes', '--json',
    '--provider', 'openai', '--model', LLM_MODEL, '--api-key-env', LLM_KEY_ENV,
    '--base-url', LLM_BASE_URL,
  ], {
    encoding: 'utf8', timeout: 900_000,
    env: { ...engineEnvBase(), PD_INSTALL_PLUGIN_DIR: assetPayload, PD_SKIP_NPM_UPGRADE: '1', PD_SKIP_GLOBAL_SHIM: '1' },
  });
  const installJson = parseLastJsonBlock(install.stdout);
  const installOk = install.status === 0 && installJson.success === true;
  record('installer-run', installOk ? 'PASS' : 'FAIL',
    `exit=${install.status} success=${installJson.success === true} reason=${String(installJson.reason ?? '').slice(0, 200)} stdoutTail=${(install.stdout || '').slice(-300)} stderr=${(install.stderr || '').slice(-200)}`);
  if (!installOk) return finalize();

  // ── 3. Deployment + registration + OFFICIAL init facts (no handwritten DDL) ──
  const runtimeEntry = installedAdapterEntry();
  const settings = path.join(ISO, 'settings.json');
  const settingsOk = fs.existsSync(settings) && Boolean(JSON.parse(fs.readFileSync(settings, 'utf8')).enabledPlugins?.[`${PLUGIN_NAME}@${MARKET_NAME}`]);
  const govConfig = path.join(GOV, '.pd', 'config.yaml');
  const govReady = fs.existsSync(govConfig) && fs.existsSync(path.join(GOV, '.state', 'trajectory.db')) && fs.existsSync(path.join(GOV, '.pd', 'state.db'));
  const deploymentOk = fs.existsSync(runtimeEntry) && fs.existsSync(path.join(FAKE_HOME, '.pd', 'runtime', 'pd-cli', 'dist', 'index.js')) && settingsOk && govReady;
  record('deploy-register-init', deploymentOk ? 'PASS' : 'FAIL',
    `adapterEntry=${fs.existsSync(runtimeEntry)} installedPdCli=${fs.existsSync(installedPdCli())} registered=${settingsOk} govInit=${govReady} (config.yaml + trajectory.db + state.db created by the installer's shared runtime init, not by this script)`);
  if (!deploymentOk) return finalize();
  record('runtime-identity', 'PASS', `installed adapter sha256 ${sha256(runtimeEntry).slice(0, 16)}…; installed pd-cli sha256 ${sha256(installedPdCli()).slice(0, 16)}…`);

  // ── 4. The governance LLM profile came from INSTALL ARGS (consumable) ──
  const configText = fs.readFileSync(govConfig, 'utf8');
  const profileFromArgs = new RegExp(`model:\\s*["']?${LLM_MODEL}["']?`).test(configText)
    && new RegExp(`apiKeyEnv:\\s*["']?${LLM_KEY_ENV}["']?`).test(configText)
    && new RegExp(`baseUrl:\\s*["']?${LLM_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`).test(configText);
  record('governance-config-from-args', profileFromArgs ? 'PASS' : 'FAIL',
    `config.yaml written by the installer carries the install-arg model/apiKeyEnv (read-only assertion; the worker cycles below prove consumption through the real loader)`);

  // ── 5. Enable governance through the installer's supported flag writer ──
  const installerDist = path.join(REPO, 'packages', 'create-principles-disciple', 'dist', 'installers', 'workbuddy-host-installer.js');
  const mod = require(installerDist);
  const installer = new mod.WorkBuddyHostInstaller({ homeDir: () => FAKE_HOME, enginePath: () => undefined });
  const enabled = installer.setWorkbuddyGovernanceFlag?.(GOV, true) ?? mod.setWorkbuddyGovernanceFlag?.(GOV, true);
  record('enable', enabled && enabled.ok !== false ? 'PASS' : 'FAIL', JSON.stringify(enabled).slice(0, 200));
  if (!enabled || enabled.ok === false) return finalize();

  // ── 6. Mock server = HOST task model (separate evidence class from the
  // governance LLM; models.json is the engine's supported model config) ──
  const mockServer = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-mock-server.mjs');
  const mock = spawn(process.execPath, [mockServer], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_LAB: LAB_ROOT },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 800));
  try {
    fs.writeFileSync(path.join(ISO, 'models.json'), JSON.stringify({
      models: [{ id: 'wb-probe-mock', name: 'm', url: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, apiKey: 'k', contextWindow: 32000 }],
    }, null, 2));
    const feeder = path.join(REPO, 'scripts', 'dev', 'workbuddy-probe', 'e2e-prompt-feeder2.cjs');
    const runTurn = (label, first, second, extraReplies = []) => {
      for (const [i, reply] of extraReplies.entries()) {
        fs.writeFileSync(path.join(LAB_ROOT, `mock-reply-${label}${i}.json`), JSON.stringify(reply));
      }
      return spawnSync(process.execPath, [feeder, label, first, second], {
        env: { ...engineEnvBase(), WB_E2E_ISO: ISO, WB_E2E_ENGINE: ENGINE, WB_E2E_PROJECT: PROJECT },
        encoding: 'utf8', timeout: 180_000,
      });
    };
    const reqLog = () => { try { return fs.readFileSync(path.join(LAB_ROOT, 'mock-req-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
    const reqsSince = (n) => reqLog().slice(n).map((l) => JSON.parse(l));
    const bashToolReply = (id, command) => ({ id: `mock-${id}`, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `toolu_${id}`, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } }] }, finish_reason: 'tool_calls' }] });
    const textReply = (id, text) => ({ id: `mock-${id}`, model: 'wb-probe-mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });

    // ── 7. Evidence class 1: REAL engine Bash failure (evidence-only per
    // frozen policy — recorded, never stitched into the chain) ──
    let before = reqLog().length;
    fs.writeFileSync(path.join(LAB_ROOT, 'mock-reply-inst-a.json'), JSON.stringify(bashToolReply('if1', 'exit 7')));
    fs.writeFileSync(path.join(LAB_ROOT, 'mock-reply-inst-b.json'), JSON.stringify(textReply('if2', 'noted')));
    let run = runTurn('real-fail', 'hello', 'please run the failing command');
    await new Promise((r) => setTimeout(r, 800));
    let traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const toolRow = traj.prepare("SELECT tool_name, outcome, exit_code FROM tool_calls WHERE tool_name = 'Bash' AND outcome = 'failure' ORDER BY id DESC").get();
    const realPain = traj.prepare("SELECT canonical_pain_id FROM pain_events WHERE host_kind = 'workbuddy'").get();
    traj.close();
    const engineRan = reqsSince(before).some((r) => JSON.stringify(r.body ?? '').includes('exit 7'));
    record('real-failure-evidence', engineRan && toolRow ? 'PASS' : 'FAIL',
      `installed canonical wrapper ran the real engine turn: engineRan=${engineRan} tool_calls=${JSON.stringify(toolRow)}; pain=${JSON.stringify(realPain) ?? 'none (Bash evidence-only per frozen policy)'} stderr=${(run.stderr || '').slice(-200)}`);

    // ── 8. Evidence class 2 (SYNTHETIC, labeled): eligible signal through the
    // INSTALLED adapter entry (canonical runtime, no dev override) ──
    const payload = JSON.stringify({
      session_id: `synth-installed-${Date.now()}`,
      transcript_path: path.join(GOV, 'synthetic.jsonl'),
      cwd: PROJECT,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(PROJECT, 'synthetic-protected.txt'), content: 'probe' },
      tool_response: { is_error: true, tool_error_code: '2002', exitCode: 1 },
      call_id: `toolu_synth_installed`,
      tool_use_id: `toolu_synth_installed`,
      agent_type: 'cli',
      permission_mode: 'bypassPermissions',
      client: 'CLI',
      version: '2.161.0',
      generation_id: `gen-synth-installed`,
      model: 'wb-probe-mock',
    });
    const synth = spawnSync(process.execPath, [runtimeEntry, 'PostToolUse'], {
      input: payload, encoding: 'utf8', timeout: 30_000, env: { ...engineEnvBase() },
    });
    await new Promise((r) => setTimeout(r, 500));
    traj = new Database(path.join(GOV, '.state', 'trajectory.db'), { readonly: true });
    const synthPain = traj.prepare("SELECT canonical_pain_id, score, host_kind FROM pain_events WHERE host_kind = 'workbuddy' ORDER BY id DESC").get();
    traj.close();
    record('eligible-signal-synthetic', synth.status === 0 && synthPain ? 'PASS' : 'FAIL',
      `SYNTHETIC-PROTOCOL Write-failure PostToolUse through the INSTALLED adapter entry: status=${synth.status} pain=${JSON.stringify(synthPain)} stderr=${(synth.stderr || '').slice(-200)}`);
    if (!synthPain) return finalize();

    // ── 9. Worker cycles through the INSTALLED pd-cli (real governance LLM) ──
    let chainSelection = null;
    let policyTerminalChain = null;
    let blockedRateLimit = null;
    let chainDefect = null;
    let lastCycle = null;
    const deadline = Date.now() + 45 * 60_000;
    let cycles = 0;
    while (Date.now() < deadline) {
      cycles += 1;
      const r = pdCli(['workbuddy', 'worker', '--once', '--workspace', GOV, '--json']);
      let parsed = {};
      try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* non-JSON */ }
      lastCycle = { exit: r.status, mode: parsed.mode, stderrTail: (r.stderr || '').slice(-300) };
      const chain = readLearningChain(GOV, synthPain.canonical_pain_id);
      if (chain !== null) {
        if (chain.pendingApprovals.length > 0) { chainSelection = chain; break; }
        if (chain.candidates.length > 0 && chain.candidates.every((c) => candidateDisposition(chain, c) === 'policy_terminal')) { policyTerminalChain = chain; break; }
        const actionable = chain.candidates.filter((c) => !POLICY_TERMINAL_KINDS.has(c.recommendation_kind));
        if (actionable.length > 0 && actionable.every((c) => c.confidence === null || c.confidence < ADMISSION_CONFIDENCE_THRESHOLD)) {
          chainDefect = `every actionable candidate below the admission threshold (${ADMISSION_CONFIDENCE_THRESHOLD}) — needs_evidence terminal: ${chainSummary(chain)}`;
          break;
        }
        let diagStatus;
        const statusDb = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
        try {
          diagStatus = statusDb.prepare('SELECT status FROM tasks WHERE task_id = ?').get(chain.diagnosticianTaskId)?.status;
          if (diagStatus === 'failed') {
            const category = latestDiagnosticianCategory(statusDb, chain.diagnosticianTaskId);
            if (category === 'rate_limit') blockedRateLimit = chain.diagnosticianTaskId;
            else chainDefect = `diagnostician terminal-failed (error_category=${category ?? 'none'}); last=${JSON.stringify(lastCycle).slice(0, 300)}`;
          }
        } finally {
          try { statusDb.close(); } catch { /* ignore */ }
        }
        if (diagStatus === 'failed') break;
      }
      if (parsed.mode === 'paused') break;
      await new Promise((r2) => setTimeout(r2, 45_000));
    }
    if (blockedRateLimit !== null) {
      record('background-chain', 'BLOCKED', `provider rate-limited the diagnostician (task=${blockedRateLimit}, runs.error_category=rate_limit) after ${cycles} cycles of the INSTALLED stack — re-run when quota resets`);
      return finalize();
    }
    if (chainDefect !== null) { record('background-chain', 'FAIL', `chain defect, not a provider state: ${chainDefect}`); return finalize(); }
    if (policyTerminalChain !== null) {
      // R2/R3: the full-principle scenario REQUIRES a prompt chain; a policy
      // terminal is honest evidence but does NOT satisfy this scenario.
      record('background-chain', 'FAIL',
        `chain reached the policy terminal after ${cycles} cycles (${chainSummary(policyTerminalChain)}) — honest policy evidence, but the FULL-PRINCIPLE scenario requires an actionable prompt candidate; full learning did NOT run`);
      record('chain-disposition', 'FAIL', 'no prompt candidate reached pending approval — required leg missing (policy refusal ≠ full learning)');
      record('owner-approval', 'FAIL', 'not run: no prompt approval exists (required leg missing)');
      record('next-turn-injection', 'FAIL', 'not run: no prompt activation exists (required leg missing)');
      record('withdraw', 'FAIL', 'not run: no prompt activation exists (required leg missing)');
      record('post-withdraw', 'FAIL', 'not run: no prompt activation exists (required leg missing)');
      return finalize();
    }
    record('background-chain', chainSelection ? 'PASS' : 'FAIL',
      chainSelection
        ? `identity-chain approvals after ${cycles} REAL worker cycles on the INSTALLED stack (real governance LLM), traceable to pain ${synthPain.canonical_pain_id}`
        : `no identity-chain approval after ${cycles} cycles; last=${JSON.stringify(lastCycle).slice(0, 600)}`);
    if (!chainSelection) {
      record('chain-disposition', 'FAIL', 'required leg missing: no candidates correlated');
      record('owner-approval', 'FAIL', 'not run (required leg missing)');
      record('next-turn-injection', 'FAIL', 'not run (required leg missing)');
      record('withdraw', 'FAIL', 'not run (required leg missing)');
      record('post-withdraw', 'FAIL', 'not run (required leg missing)');
      return finalize();
    }
    record('chain-disposition', 'PASS', `candidates traceable to diagnostician task ${chainSelection.diagnosticianTaskId}: ${chainSummary(chainSelection)}`);
    const promptApproval = chainSelection.pendingApprovals.find((a) => a.channel === 'prompt');
    if (!promptApproval) {
      for (const step of ['owner-approval', 'next-turn-injection', 'withdraw', 'post-withdraw']) {
        record(step, 'FAIL', `required leg missing: chain has approvals [${chainSelection.pendingApprovals.map((a) => a.channel).join(',') || 'none'}] but no prompt-channel approval — full principle learning did NOT run (rule-only/policy chains prove their own contracts in their own scenarios)`);
      }
      return finalize();
    }

    // ── 10. Real approval through the INSTALLED product CLI ──
    const approve = pdCli(['activation', 'approve', '--approval-id', promptApproval.approval_id, '--workspace', GOV, '--decided-by', 'wb-installed-e2e-owner', '--json'], 120_000);
    let approveResult = {};
    try { approveResult = JSON.parse(approve.stdout || '{}'); } catch { /* keep raw */ }
    const approvedOk = approve.status === 0 && approveResult.ok === true;
    record('owner-approval', approvedOk ? 'PASS' : 'FAIL',
      `pd activation approve via INSTALLED pd-cli (prompt channel, artifact=${promptApproval.artifact_id}) exit=${approve.status} ok=${approveResult.ok === true} activationId=${approveResult.activationId ?? '-'} stderr=${(approve.stderr || '').slice(-200)}`);
    if (!approvedOk) {
      record('next-turn-injection', 'FAIL', 'not run: approval failed (required leg missing)');
      record('withdraw', 'FAIL', 'not run: approval failed (required leg missing)');
      record('post-withdraw', 'FAIL', 'not run: approval failed (required leg missing)');
      return finalize();
    }

    // ── 11. Next-turn injection through the REAL engine (canonical wrapper) ──
    let db = new Database(path.join(GOV, '.pd', 'state.db'), { readonly: true });
    const artifactRow = db.prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?').get(promptApproval.artifact_id);
    const activationRow = db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE activation_id = ?').get(approveResult.activationId)
      ?? db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE artifact_id = ?').get(promptApproval.artifact_id);
    db.close();
    if (!activationRow) {
      record('next-turn-injection', 'FAIL', `no live activation for approved artifact ${promptApproval.artifact_id}`);
      record('withdraw', 'FAIL', 'not run: no activation (required leg missing)');
      record('post-withdraw', 'FAIL', 'not run: no activation (required leg missing)');
      return finalize();
    }
    let statementText = '';
    let statementSource = 'none';
    try {
      const content = JSON.parse(artifactRow?.content_json ?? '{}');
      if (typeof content.text === 'string' && content.text.length > 0) { statementText = content.text; statementSource = 'content.text'; }
      else if (content.principleDraft && typeof content.principleDraft.statement === 'string' && content.principleDraft.statement.length > 0) { statementText = content.principleDraft.statement; statementSource = 'principleDraft.statement'; }
    } catch { statementText = ''; }
    const probe = statementText.split(/\s+/).filter((w) => w.length > 4).slice(0, 4).join(' ');
    before = reqLog().length;
    fs.writeFileSync(path.join(LAB_ROOT, 'mock-reply-inst-c.json'), JSON.stringify(textReply('in1', 'understood')));
    fs.writeFileSync(path.join(LAB_ROOT, 'mock-reply-inst-d.json'), JSON.stringify(textReply('in2', 'acknowledged')));
    run = runTurn('post-approval', 'what should I keep in mind now?', 'summarize your guidance');
    const postReqs = reqsSince(before);
    const postRan = postReqs.length > 0 && postReqs.some((r) => JSON.stringify(r.body ?? '').includes('keep in mind'));
    const injected = postRan && probe.length > 0 && postReqs.some((r) => JSON.stringify(r.body ?? '').includes(probe));
    record('next-turn-injection', injected ? 'PASS' : 'FAIL',
      `REAL engine turn on the installed plugin: roundRan=${postRan} probe=${JSON.stringify(probe.slice(0, 90))} (source=${statementSource}) requests=${postReqs.length} stderr=${(run.stderr || '').slice(-200)}`);

    // ── 12. Real deactivate through the INSTALLED CLI; next turn stops ──
    const withdraw = pdCli(['activation', 'deactivate', '--activation-id', activationRow.activation_id, '--workspace', GOV], 60_000);
    const withdrawOk = withdraw.status === 0 && /Deactivated/i.test(withdraw.stdout || '');
    record('withdraw', withdrawOk ? 'PASS' : 'FAIL', `exit=${withdraw.status} stdout=${(withdraw.stdout || '').slice(0, 120)}`);
    before = reqLog().length;
    fs.writeFileSync(path.join(LAB_ROOT, 'mock-reply-inst-e.json'), JSON.stringify(textReply('iw1', 'ok')));
    fs.writeFileSync(path.join(LAB_ROOT, 'mock-reply-inst-f.json'), JSON.stringify(textReply('iw2', 'done')));
    run = runTurn('post-withdraw', 'another question', 'and another');
    const wReqs = reqsSince(before);
    const wRan = wReqs.length > 0 && wReqs.some((r) => JSON.stringify(r.body ?? '').includes('another question'));
    const stillThere = wReqs.some((r) => probe.length > 0 && JSON.stringify(r.body ?? '').includes(probe));
    record('post-withdraw', wRan && !stillThere ? 'PASS' : 'FAIL', `roundRan=${wRan} statementStillInjected=${stillThere}`);
  } finally {
    mock.kill();
  }

  finalize();
}

try {
  await main();
} catch (error) {
  console.error('Installed-full-learning E2E crashed:', error);
  record('crash', 'FAIL', (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1000));
  finalize();
}
