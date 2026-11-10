#!/usr/bin/env node
// PRI-1163 controlled-host round-key run — launcher.
//
//   --prepare --pack <dir> [--npm-cache <dir>]
//       Freeze a NEW execution pack (official host copy, PUBLISHED candidate
//       plugin, six-principle fixture via the formal stores, configs, the two
//       frozen user inputs; writes manifest.json, approval.template.json and a
//       run-card excerpt). Runs the resolution probe (positive) and its
//       negative self-test OFFLINE. Starts no host and sends no request.
//   --verify --pack <dir> [--full] [--probe-selftest]
//       Offline re-verification of a frozen pack; --full re-hashes the staged
//       host tree; --probe-selftest re-runs the workspace-resolution probe
//       (positive + negative). Exit 0 only when every required check passed.
//   --execute --pack <dir> --approval <file>
//       The approved run ONLY: the approval file must bind the manifest
//       sha256, the card version and the frozen budgets. Re-runs every
//       preflight check, then runs R1 and — only if R1 passed — R2, each as
//       ONE host start with ONE provider request, under the shared fail-closed
//       ledger, then the production-containment audit decides `completed`.
//
// Budget semantics (same as PRI-1152): reaching a cap is not over budget; the
// NEXT attempt is refused before it is issued. A failed host start is still
// charged. No retry, no fallback, no second execute of the same pack.
//
// ENTRY (differs from PRI-1152 on purpose): `openclaw agent --local
// --session-id <pinned>` — the official normal-chat embedded entry WITH an
// explicit session id, so both rounds land in the SAME session and the
// persisted user_turns ordinal advances. PRI-1152's `agent exec` is
// intentionally NOT used: it runs an isolated per-invocation session.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  CARD_VERSION, ROUNDKEY_ENDPOINT_PATH, ROUNDKEY_FIXTURES, ROUNDKEY_INPUTS,
  ROUNDKEY_MODEL_ID, ROUNDKEY_PROVIDER, ROUNDKEY_ROUNDS, ROUNDKEY_RUN_BUDGET, ROUNDKEY_ROUND_BUDGETS,
  ROUNDKEY_SESSION_ID, buildRoundKeyHostConfig, buildRoundKeyPdConfigText, generateRoundKeyApiKey,
  roundKeyModelRef, sha256File, validateRoundKeyHostConfig, ROUNDKEY_PD_FEATURE_EXPECTATIONS,
} from './lib/roundkey-shape.mjs';
import { runWorkspaceResolutionProbe, buildProbeEnv } from './lib/roundkey-probe.mjs';
import { startPresenceEndpoint } from './lib/presence-endpoint.mjs';
import { createExperimentLedger } from './lib/ledger.mjs';
import { selectLoopbackPort } from './lib/host-config.mjs';
import { stageHost } from './lib/presence-pack.mjs';
import { buildAllowlistedHostEnv } from './lib/env-isolation.mjs';
import { SqliteActivationStateStore, SqliteConnection, SqlitePIArtifactStore, SqliteTaskStore } from '@principles/core/runtime';

const APPROVAL_SCHEMA = 'pd-round-key-run-approval/v1';
const EXPECTED_HOST_VERSION = '2026.11.1';
const EXPECTED_HOST_COMMIT = '4ffdd2047d192dd65554de3c8c46c0e0197c6e2a';
const PUBLISHED_BUNDLE_SHA256 = '7301253d09d3c4a900bc3a44b4b3430b835b71d47161e6fdc94d8ff725f6546d';
const ROUND_OUTER_TIMEOUT_MS = 180000;

// Machine paths are DERIVED at runtime (no absolute paths in committed code;
// every value can be overridden by CLI args for other workstations).
function deriveInstalledExtensionRoot() {
  return join(homedir(), '.openclaw', 'extensions', 'principles-disciple');
}
function deriveHostSource() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'npm', 'node_modules', 'openclaw');
}
function deriveDeclaredProductionWorkspace() {
  const fromEnv = process.env.PD_WORKSPACE_DIR ?? process.env.OPENCLAW_WORKSPACE;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  try {
    const declaration = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'principles-disciple.json'), 'utf8'));
    if (typeof declaration?.workspace === 'string' && declaration.workspace.trim()) return declaration.workspace;
  } catch { /* fall through */ }
  throw new Error('cannot derive the declared production workspace for the containment fence — pass --production-workspace');
}

function writeJson(path, value, flag = 'w') {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag });
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function layoutOf(packRoot) {
  return {
    packRoot,
    manifestPath: join(packRoot, 'manifest.json'),
    hostRoot: join(packRoot, 'host'),
    candidateRoot: join(packRoot, 'candidate', 'principles-disciple'),
    candidateBundle: join(packRoot, 'candidate', 'principles-disciple', 'dist', 'bundle.js'),
    configPath: join(packRoot, 'config', 'openclaw.json'),
    hostLogPath: join(packRoot, 'logs', 'openclaw-host.log'),
    workspaceDir: join(packRoot, 'workspace'),
    pdConfigPath: join(packRoot, 'workspace', '.pd', 'config.yaml'),
    settingsPath: join(packRoot, 'workspace', '.openclaw', 'settings.json'),
    homeDir: join(packRoot, 'home'),
    tempDir: join(packRoot, 'tmp'),
    sessionStateDir: join(packRoot, 'state', 'session'),
    inputPath: (roundId) => join(packRoot, 'inputs', `${roundId}.txt`),
    preflightDir: join(packRoot, 'preflight'),
    runDir: join(packRoot, 'run'),
    budgetLedgerPath: join(packRoot, 'run', 'budget-ledger.json'),
    trajectoryPath: join(packRoot, 'workspace', '.state', 'trajectory.db'),
  };
}
function runEnvFor(layout) {
  const built = buildAllowlistedHostEnv({
    baseEnv: process.env,
    experimentRoot: layout.packRoot,
    homeDir: layout.homeDir,
    tempDir: layout.tempDir,
    workspaceDir: layout.workspaceDir,
    stateDir: layout.sessionStateDir,
    configPath: layout.configPath,
  });
  return built.resolved?.env ?? built;
}
function normalizePath(p) {
  return process.platform === 'win32' ? String(p).replace(/\//g, '\\').toLowerCase() : String(p);
}

// ─── prepare ──────────────────────────────────────────────────────────────────
async function prepare({ packRoot, npmCacheDir, hostSource: hostSourceArg, candidateSource: candidateSourceArg, productionWorkspace: productionWorkspaceArg }) {
  const hostSource = hostSourceArg ?? deriveHostSource();
  const installedExtensionRoot = candidateSourceArg ?? deriveInstalledExtensionRoot();
  const productionWorkspace = productionWorkspaceArg ?? deriveDeclaredProductionWorkspace();
  const productionTrajectory = join(productionWorkspace, '.state', 'trajectory.db');
  if (!packRoot || !isAbsolute(packRoot)) throw new Error('--pack must be an absolute path');
  if (existsSync(packRoot)) throw new Error(`pack already exists: ${packRoot}`);
  const packId = `rk-${nowStamp()}`;
  const layout = layoutOf(packRoot);
  mkdirSync(packRoot, { recursive: true });
  for (const dir of [dirname(layout.configPath), dirname(layout.hostLogPath), join(layout.workspaceDir, '.pd'),
    join(layout.workspaceDir, '.openclaw'), join(layout.workspaceDir, '.state', 'logs'),
    layout.homeDir, join(layout.homeDir, 'AppData', 'Roaming'), join(layout.homeDir, 'AppData', 'Local'),
    layout.tempDir, layout.sessionStateDir, layout.preflightDir, layout.runDir, dirname(layout.inputPath('R1'))]) {
    mkdirSync(dir, { recursive: true });
  }

  // 1. official host (tarball cross-check when the npm cache is supplied)
  const host = await stageHost({
    hostSource,
    packRoot,
    expectedVersion: EXPECTED_HOST_VERSION,
    expectedCommit: EXPECTED_HOST_COMMIT,
    npmCacheDir: npmCacheDir ?? null,
  });

  // 2. candidate = the PUBLISHED 3.1.3 plugin (byte-verified), with its native dep
  const installedBundle = join(installedExtensionRoot, 'dist', 'bundle.js');
  const bundleSha = sha256File(installedBundle);
  if (bundleSha !== PUBLISHED_BUNDLE_SHA256) {
    throw new Error(`installed bundle is not the verified published 3.1.3 bytes: ${bundleSha}`);
  }
  const candidateRoot = layout.candidateRoot;
  mkdirSync(candidateRoot, { recursive: true });
  for (const entry of ['dist', 'node_modules', 'templates', 'mcp', 'assets']) {
    const src = join(installedExtensionRoot, entry);
    if (existsSync(src)) cpSync(src, join(candidateRoot, entry), { recursive: true });
  }
  for (const file of ['package.json', 'openclaw.plugin.json', 'LICENSE', 'NOTICE']) {
    const src = join(installedExtensionRoot, file);
    if (existsSync(src)) cpSync(src, join(candidateRoot, file));
  }
  if (sha256File(layout.candidateBundle) !== PUBLISHED_BUNDLE_SHA256) throw new Error('staged candidate bundle drifted during copy');
  if (!existsSync(join(candidateRoot, 'node_modules', 'better-sqlite3', 'package.json'))) {
    throw new Error('candidate is missing its external dependency better-sqlite3');
  }

  // 3. configs, session settings (port frozen at prepare; free-then, not reserved)
  const endpointPort = await selectLoopbackPort();
  const fakeApiKey = generateRoundKeyApiKey();
  const frozenHostConfig = buildRoundKeyHostConfig({ endpointPort, pluginRoot: candidateRoot, fakeApiKey, hostLogPath: layout.hostLogPath });
  const configViolations = validateRoundKeyHostConfig(frozenHostConfig, { endpointPort, pluginRoot: candidateRoot, hostLogPath: layout.hostLogPath });
  if (configViolations.length > 0) throw new Error(`frozen host config invalid: ${configViolations.join('; ')}`);
  writeJson(layout.configPath, frozenHostConfig);
  writeFileSync(layout.pdConfigPath, buildRoundKeyPdConfigText(), 'utf8');
  writeJson(layout.settingsPath, { retry: { provider: { maxRetries: 0 } } });

  // 4. fixture: SIX synthetic principles through the formal stores
  const connection = new SqliteConnection({ workspaceDir: layout.workspaceDir });
  try {
    let index = 0;
    for (const fixture of ROUNDKEY_FIXTURES) {
      index += 1;
      const activatedAt = new Date(Date.parse('2026-11-10T00:00:00.000Z') + index * 60000).toISOString();
      const sourceTaskId = `task-${fixture.artifactId}`;
      await new SqliteTaskStore(connection).createTask({ taskId: sourceTaskId, taskKind: 'diagnosis', status: 'pending', attemptCount: 0, maxAttempts: 3 });
      await new SqlitePIArtifactStore(connection).createArtifact({
        artifactId: fixture.artifactId, artifactKind: 'principle', sourceTaskId, sourcePrincipleId: fixture.principleId,
        lineageArtifactIds: [], validationStatus: 'validated',
        contentJson: JSON.stringify({ principleId: fixture.principleId, text: fixture.text, language: 'zh' }),
        createdAt: activatedAt, updatedAt: activatedAt,
      });
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: fixture.activationId, idempotencyKey: `aa-prompt-${fixture.activationId}`, artifactId: fixture.artifactId,
        channel: 'prompt', action: 'prompt_activate', targetRef: layout.workspaceDir, activatedAt, promotedAt: activatedAt, deactivatedAt: null,
      });
    }
    const db = connection.getDb();
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not WAL */ }
  } finally {
    connection.close();
  }
  const approvals = new DatabaseSync(join(layout.workspaceDir, '.pd', 'state.db'), { readOnly: true }).prepare('SELECT COUNT(*) c FROM approvals').get().c;
  if (approvals !== 0) throw new Error('fixture workspace must have zero approvals rows');

  // 5. frozen inputs
  const inputs = {};
  for (const round of ROUNDKEY_ROUNDS) {
    const path = layout.inputPath(round.id);
    writeFileSync(path, ROUNDKEY_INPUTS[round.id], 'utf8');
    inputs[round.id] = { path, sha256: sha256File(path), text: ROUNDKEY_INPUTS[round.id] };
  }

  // 6. production baseline (readonly; the run session must not exist there)
  const prodDb = new DatabaseSync(productionTrajectory, { readOnly: true });
  prodDb.exec('PRAGMA busy_timeout=8000');
  const baselineTotal = prodDb.prepare('SELECT COUNT(*) c FROM user_turns').get().c;
  const baselineSession = prodDb.prepare('SELECT COUNT(*) c FROM user_turns WHERE session_id = ?').get(ROUNDKEY_SESSION_ID).c;
  prodDb.close();
  if (baselineSession !== 0) throw new Error('run session id already exists in production user_turns — refuse');

  // 7. resolution probe: positive (exact run env SHAPE, against a throwaway
  //    probe workspace so plugin startup writes never touch the frozen
  //    fixture state.db) + negative self-test (ambient-minus-pins replays the
  //    incident and must be refused on the production-root rule)
  const probeWorkspaceDir = join(packRoot, 'tmp', 'probe-ws');
  const probeStateDir = join(packRoot, 'tmp', 'probe-ws-state');
  mkdirSync(probeWorkspaceDir, { recursive: true });
  mkdirSync(probeStateDir, { recursive: true });
  const probeBase = { baseEnv: process.env, packRoot, homeDir: layout.homeDir, tempDir: layout.tempDir, workspaceDir: probeWorkspaceDir, stateDir: probeStateDir, configPath: layout.configPath };
  const positive = await runWorkspaceResolutionProbe({ packRoot, tmpDir: layout.tempDir, candidateBundlePath: layout.candidateBundle, probeEnv: buildProbeEnv(probeBase) });
  const negative = await runWorkspaceResolutionProbe({ packRoot, tmpDir: layout.tempDir, candidateBundlePath: layout.candidateBundle, probeEnv: buildProbeEnv(probeBase, { stripWorkspacePins: true }) });
  if (!positive.ok) throw new Error(`positive resolution probe FAILED: ${positive.reason}`);
  if (negative.ok) throw new Error('negative self-test unexpectedly resolved inside pack — the gate does not catch the incident condition');

  // 8. manifest (no self-hash field), approval template, run-card excerpt
  const rounds = ROUNDKEY_ROUNDS.map((round) => ({
    id: round.id,
    provider: ROUNDKEY_PROVIDER,
    api: 'openai-completions',
    endpointPath: ROUNDKEY_ENDPOINT_PATH,
    model: ROUNDKEY_MODEL_ID,
    modelRef: roundKeyModelRef(),
    sessionId: ROUNDKEY_SESSION_ID,
    stateDir: layout.sessionStateDir,
    inputPath: layout.inputPath(round.id),
    inputSha256: inputs[round.id].sha256,
    budget: ROUNDKEY_ROUND_BUDGETS[round.id],
    outerTimeoutMs: ROUND_OUTER_TIMEOUT_MS,
  }));
  const manifest = {
    schemaVersion: 'pd-round-key-pack/v1',
    cardVersion: CARD_VERSION,
    packId,
    createdAt: new Date().toISOString(),
    scope: 'Two consecutive genuine USER turns in ONE explicit session on the unmodified official OpenClaw normal-chat embedded entry (agent --local --session-id) with the PUBLISHED 3.1.3 plugin bundle: prove fair_rotation_v1 with an advancing selectionRoundOrdinal; non-user rounds and missing keys remain FIFO by design; A-line PRI-1119 identity untouched',
    source: { driver: 'scripts/dev/aa-controlled-admission/round-key-run.mjs' },
    node: { path: process.execPath, version: process.version, sha256: sha256File(process.execPath) },
    host,
    candidate: {
      root: candidateRoot,
      origin: installedExtensionRoot,
      bundleSha256: PUBLISHED_BUNDLE_SHA256,
      entry: 'package.json openclaw.extensions = ["./dist/bundle.js"]',
      pluginVersion: readJson(join(candidateRoot, 'package.json')).version,
    },
    session: { id: ROUNDKEY_SESSION_ID, stateDir: layout.sessionStateDir, entryArgs: ['agent', '--local', '--session-id', ROUNDKEY_SESSION_ID] },
    endpoint: { port: endpointPort, api: 'openai-completions', path: ROUNDKEY_ENDPOINT_PATH, provider: ROUNDKEY_PROVIDER, model: ROUNDKEY_MODEL_ID, fakeApiKeyFormat: 'pdroundkey-local-<32 hex>' },
    paths: {
      configPath: layout.configPath, pdConfigPath: layout.pdConfigPath, settingsPath: layout.settingsPath,
      hostLogPath: layout.hostLogPath, workspaceDir: layout.workspaceDir, trajectoryPath: layout.trajectoryPath,
    },
    fixture: { principles: ROUNDKEY_FIXTURES.map((f) => ({ principleId: f.principleId, activationId: f.activationId })), count: ROUNDKEY_FIXTURES.length, approvalsRows: approvals, stateDbSha256: sha256File(join(layout.workspaceDir, '.pd', 'state.db')) },
    pdFeatureExpectations: ROUNDKEY_PD_FEATURE_EXPECTATIONS,
    inputs,
    budgets: ROUNDKEY_RUN_BUDGET,
    roundBudgets: ROUNDKEY_ROUND_BUDGETS,
    rounds,
    productionBaseline: { trajectory: productionTrajectory, userTurnsTotal: baselineTotal, runSessionRows: baselineSession, recordedAt: new Date().toISOString() },
    probe: {
      positive: { ok: positive.ok, resolvedWorkspace: positive.resolvedWorkspace, trajectoryPath: positive.trajectoryPath, reason: positive.reason },
      negativeSelfTest: { refusedAsExpected: !negative.ok, reason: negative.reason },
      refusalRule: 'any resolved workspace/trajectory path outside the pack, or intersecting a production root, refuses the run BEFORE spawn',
    },
    publishedBundleSha256: PUBLISHED_BUNDLE_SHA256,
  };
  writeJson(layout.manifestPath, manifest);
  const manifestSha256 = sha256File(layout.manifestPath);
  writeJson(join(packRoot, 'approval.template.json'), {
    schemaVersion: APPROVAL_SCHEMA,
    cardVersion: CARD_VERSION,
    manifestSha256,
    budgets: ROUNDKEY_RUN_BUDGET,
    approvedBy: '',
    approvedAt: '',
    note: 'Approval binds EXACTLY this card version + manifest sha256 + budgets. Re-prepare invalidates it.',
  });
  const cardPath = join(packRoot, 'run-card.md');
  writeFileSync(cardPath, buildRunCardText(manifest, manifestSha256, positive), 'utf8');
  console.log(JSON.stringify({ ok: true, packId, manifestSha256, endpointPort, probePositive: positive.reason, cardPath }, null, 2));
}

function buildRunCardText(manifest, manifestSha256, positive) {
  return `# PRI-1163 round-key run pack ${manifest.packId}

- cardVersion: ${CARD_VERSION}
- manifestSha256: ${manifestSha256}
- published bundle: ${manifest.publishedBundleSha256} (staged copy verified)
- session: ${manifest.session.id} (ONE explicit session, both rounds)
- entry: node <pack>/host/node_modules/openclaw/openclaw.mjs agent --local --session-id ${manifest.session.id} --message-file <input> --model ${manifest.rounds[0].modelRef} --json
- endpoint: 127.0.0.1:${manifest.endpoint.port}${manifest.endpoint.path} (${manifest.endpoint.api}, fake key; port free at prepare, not reserved)
- budgets: ${JSON.stringify(manifest.budgets)} (per round ${JSON.stringify(manifest.roundBudgets)})
- acceptance: R1 fair_rotation_v1 with integer ordinal k1; R2 fair_rotation_v1 with ordinal == k1+1 and rotationStartIndex advanced; user_turns rows for the session = 2 with consecutive turn_index; the plugin's own trigger lines classify BOTH rounds as user rounds; exactly 1 host start and 1 provider request per round; candidate bytes unchanged; production containment (baseline total ${manifest.productionBaseline.userTurnsTotal} must never DECREASE and must never contain the run session).
- resolution probe (prepare-time): ${positive.reason}
`;
}

// ─── verify ───────────────────────────────────────────────────────────────────
async function verify({ packRoot, full, probeSelftest }) {
  const layout = layoutOf(packRoot);
  const manifest = readJson(layout.manifestPath);
  const checks = [];
  const check = (id, ok, detail) => { checks.push({ id, ok, detail }); if (!ok) console.error(`FAIL ${id}: ${detail}`); };
  check('manifest-integrity', (() => {
    const template = readJson(join(packRoot, 'approval.template.json'));
    return template.manifestSha256 === sha256File(layout.manifestPath);
  })(), 'approval template binds the CURRENT manifest file hash (re-prepare invalidates)');
  check('bundle-identity', sha256File(layout.candidateBundle) === PUBLISHED_BUNDLE_SHA256, 'staged candidate bundle equals the published 3.1.3 bytes');
  const hostConfig = readJson(layout.configPath);
  const cfgViolations = validateRoundKeyHostConfig(hostConfig, { endpointPort: manifest.endpoint.port, pluginRoot: layout.candidateRoot, hostLogPath: layout.hostLogPath });
  check('host-config', cfgViolations.length === 0, cfgViolations.join('; ') || 'structural validation passed');
  check('pd-config-features', (() => {
    const parsed = JSON.parse(readFileSync(layout.pdConfigPath, 'utf8'));
    return Object.entries(ROUNDKEY_PD_FEATURE_EXPECTATIONS).every(([flag, enabled]) => parsed.features?.[flag]?.enabled === enabled);
  })(), 'signal_collector enabled; background features off');
  for (const round of manifest.rounds) {
    check(`input-${round.id}`, sha256File(round.inputPath) === round.inputSha256, 'frozen input unchanged');
  }
  check('fixture-state-db', sha256File(join(layout.workspaceDir, '.pd', 'state.db')) === manifest.fixture.stateDbSha256, 'frozen fixture state.db unchanged');
  check('approval-template', existsSync(join(packRoot, 'approval.template.json')), 'present');
  check('run-dir-absent', !existsSync(layout.runDir) || readdirSync(layout.runDir).filter((f) => !f.startsWith('budget-ledger')).length === 0, 'pack not yet executed');
  if (full) {
    const hostFiles = readJson(join(packRoot, 'host-files.json'));
    check('host-tree-manifest', typeof hostFiles.treeSha256 === 'string' && hostFiles.treeSha256.length === 64, `host tree manifest present (${hostFiles.fileCount} files)`);
  }
  if (probeSelftest) {
    const declaredWorkspace = dirname(dirname(manifest.productionBaseline.trajectory));
    const probeWorkspaceDir = join(packRoot, 'tmp', 'probe-ws');
    const probeStateDir = join(packRoot, 'tmp', 'probe-ws-state');
    mkdirSync(probeWorkspaceDir, { recursive: true });
    mkdirSync(probeStateDir, { recursive: true });
    const probeBase = { baseEnv: process.env, packRoot, homeDir: layout.homeDir, tempDir: layout.tempDir, workspaceDir: probeWorkspaceDir, stateDir: probeStateDir, configPath: layout.configPath };
    const positive = await runWorkspaceResolutionProbe({ packRoot, tmpDir: layout.tempDir, candidateBundlePath: layout.candidateBundle, probeEnv: buildProbeEnv(probeBase), declaredWorkspace });
    check('probe-positive', positive.ok, positive.reason);
    const negative = await runWorkspaceResolutionProbe({ packRoot, tmpDir: layout.tempDir, candidateBundlePath: layout.candidateBundle, probeEnv: buildProbeEnv(probeBase, { stripWorkspacePins: true }), declaredWorkspace });
    check('probe-negative-refuses', !negative.ok, negative.reason);
  }
  const ok = checks.every((c) => c.ok);
  writeJson(join(layout.preflightDir, `verify-${nowStamp()}-${randomBytes(4).toString('hex')}.json`), { at: new Date().toISOString(), packId: manifest.packId, ok, checks });
  console.log(JSON.stringify({ ok, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length }));
  process.exit(ok ? 0 : 1);
}

// ─── execute (Owner-approved only) ────────────────────────────────────────────
async function execute({ packRoot, approvalPath }) {
  const layout = layoutOf(packRoot);
  const manifest = readJson(layout.manifestPath);
  const approval = readJson(approvalPath);
  const manifestSha256 = sha256File(layout.manifestPath);
  if (approval.schemaVersion !== APPROVAL_SCHEMA) throw new Error(`approval schema mismatch: ${approval.schemaVersion}`);
  if (approval.cardVersion !== CARD_VERSION) throw new Error(`approval cardVersion mismatch: ${approval.cardVersion}`);
  if (approval.manifestSha256 !== manifestSha256) throw new Error(`approval does not bind this manifest (${manifestSha256}) — re-prepare invalidates approvals`);
  if (JSON.stringify(approval.budgets) !== JSON.stringify(manifest.budgets)) throw new Error('approval budgets differ from the frozen manifest');
  if (!approval.approvedBy || !approval.approvedAt) throw new Error('approval is missing approvedBy/approvedAt');
  mkdirSync(layout.runDir, { recursive: true });
  const priorRun = readdirSync(layout.runDir).filter((f) => f.startsWith('result-'));
  if (priorRun.length > 0) throw new Error('pack already executed — one execution per pack');
  const pre = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify', '--pack', packRoot, '--full', '--probe-selftest'], { stdio: 'inherit' });
  if (pre.status !== 0) throw new Error('preflight before execute FAILED — see the preflight report');

  const ledger = createExperimentLedger({ runId: manifest.packId, fixtureId: 'pri1163-round-key', budget: manifest.budgets, armBudgets: manifest.roundBudgets, persistPath: layout.budgetLedgerPath });
  const endpoint = await startPresenceEndpoint({ ledger, port: manifest.endpoint.port, fakeApiKey: readJson(layout.configPath).models.providers[ROUNDKEY_PROVIDER].apiKey });
  const eventsSizesBefore = snapshotEventsSizes(layout.workspaceDir);
  const results = { packId: manifest.packId, approval: { by: approval.approvedBy, at: approval.approvedAt }, rounds: {}, containment: {}, decision: 'in_progress' };
  try {
    let previous = null;
    for (const round of manifest.rounds) {
      const judge = await runRound({ manifest, layout, round, ledger, endpoint, eventsSizesBefore, previous });
      results.rounds[round.id] = { ...judge, endpointObservations: judge.endpointObservations.length };
      if (!judge.ok) { results.decision = `failed_at_${round.id}`; break; }
      previous = judge;
    }
    if (results.decision === 'in_progress') {
      const containment = productionContainment(manifest);
      results.containment = containment;
      results.decision = containment.ok ? 'completed' : 'contained_pollution_detected';
    }
  } finally {
    try { await endpoint.close(); } catch { /* already closed */ }
    try { ledger.persist(); } catch { /* best effort */ }
  }
  writeJson(join(layout.runDir, `result-${nowStamp()}.json`), results);
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.decision === 'completed' ? 0 : 1);
}

function snapshotEventsSizes(workspaceDir) {
  const dir = join(workspaceDir, '.state', 'logs');
  const out = {};
  if (existsSync(dir)) for (const f of readdirSync(dir)) out[f] = statSync(join(dir, f)).size;
  return out;
}
function readEventsSince(workspaceDir, sizesBefore, sinceIso) {
  const dir = join(workspaceDir, '.state', 'logs');
  const lines = [];
  if (!existsSync(dir)) return lines;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('events_')) continue;
    const before = sizesBefore?.[f] ?? 0;
    const content = readFileSync(join(dir, f), 'utf8');
    const newPart = before > 0 ? content.slice(before) : content;
    for (const line of newPart.split('\n')) {
      if (!line.includes('runtime_v2_prompt_activations_injected')) continue;
      try { const e = JSON.parse(line); if (!sinceIso || e.ts >= sinceIso) lines.push(e); } catch { /* torn line */ }
    }
  }
  return lines;
}
function userTurnsFacts(dbPath, sessionId = ROUNDKEY_SESSION_ID) {
  if (!existsSync(dbPath)) return { exists: false, rows: 0, sessionRows: 0, indexes: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  const rows = db.prepare('SELECT COUNT(*) c FROM user_turns').get().c;
  const sessionRows = db.prepare('SELECT COUNT(*) c FROM user_turns WHERE session_id = ?').get(sessionId).c;
  const indexes = db.prepare('SELECT turn_index i FROM user_turns WHERE session_id = ? ORDER BY turn_index').all(sessionId).map((r) => r.i);
  db.close();
  return { exists: true, rows, sessionRows, indexes };
}

async function runRound({ manifest, layout, round, ledger, endpoint, eventsSizesBefore, previous }) {
  ledger.hostTurn(round.id, { purpose: `${round.id}-host-start` });
  endpoint.openRound({ arm: round.id, api: round.api });
  const env = runEnvFor(layout);
  const argv = [
    join(manifest.hostRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
    'agent', '--local', '--session-id', round.sessionId,
    '--message-file', round.inputPath,
    '--model', round.modelRef,
    '--json',
  ];
  const startedAt = new Date().toISOString();
  const host = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, argv, { cwd: layout.workspaceDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* dead */ } }, round.outerTimeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: `${stderr}${error}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut }); });
  });
  const endedAt = new Date().toISOString();
  try { endpoint.closeRound?.(); } catch { /* single-round shape */ }

  const observations = endpoint.roundObservations(round.id);
  const served = observations.filter((r) => r.decision === 'served');
  const refused = observations.filter((r) => r.decision === 'refused');
  // Each host start re-emits its own registration/explicit/trigger lines; the
  // LAST occurrence per pattern belongs to THIS round (the log is append-only).
  const hostLogDelta = existsSync(layout.hostLogPath) ? readFileSync(layout.hostLogPath, 'utf8') : '';
  const lastMatch = (regex) => { const all = [...hostLogDelta.matchAll(regex)]; return all.length > 0 ? all[all.length - 1] : null; };
  const events = readEventsSince(layout.workspaceDir, eventsSizesBefore, startedAt);
  const trajAfter = userTurnsFacts(layout.trajectoryPath);

  const violations = [];
  if (host.code !== 0 || host.timedOut) violations.push(`host-exit: code=${host.code} timedOut=${host.timedOut}`);
  let envelope = null;
  try { envelope = JSON.parse(host.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{')) ?? 'null'); } catch { /* no json */ }
  if (!envelope || envelope.ok !== true) violations.push('host-envelope: ok=true missing');
  if (envelope?.sessionId && envelope.sessionId !== round.sessionId) violations.push(`host-envelope sessionId mismatch: ${envelope.sessionId}`);
  if (served.length !== 1 || refused.length !== 0) violations.push(`endpoint-one-request: served=${served.length} refused=${refused.length}`);
  if (served[0] && served[0].path !== ROUNDKEY_ENDPOINT_PATH) violations.push('endpoint-api-path');
  const registration = lastMatch(/Principles Disciple Plugin registered\. \(Path: ([^)]+)\)/g);
  if (!registration || !normalizePath(registration[1]).startsWith(normalizePath(layout.candidateRoot))) {
    violations.push(`candidate-registration-source: ${registration ? registration[1] : 'missing'}`);
  }
  const explicit = lastMatch(/PD explicit workspace \(pd_env: ([^)]+)\)/g);
  if (!explicit || !normalizePath(explicit[1]).startsWith(normalizePath(layout.workspaceDir))) {
    violations.push(`explicit-workspace-line: ${explicit ? explicit[1] : 'missing'}`);
  }
  const trigger = lastMatch(/handleBeforePromptBuild called: workspaceDir=(true|false), trigger=([^,]+),/g);
  if (!trigger) violations.push('trigger-line: missing');
  else if (trigger[1] !== 'true') violations.push('workspaceDir=false in hook ctx');
  else if (!['user', 'undefined'].includes(trigger[2])) violations.push(`trigger-not-user-round: ${trigger[2]}`);
  if (events.length !== 1) violations.push(`events-exactly-one: ${events.length}`);
  const payload = events[0]?.data ?? {};
  if (events.length === 1) {
    if (payload.selectionPolicy !== 'fair_rotation_v1') violations.push(`policy: ${payload.selectionPolicy}`);
    if (!Number.isInteger(payload.selectionRoundOrdinal)) violations.push(`ordinal-missing: ${payload.selectionRoundOrdinal}`);
    if ((payload.principleIds ?? []).some((id) => !ROUNDKEY_FIXTURES.some((f) => f.principleId === id))) violations.push('payload principle outside fixture set');
  }
  const trajExpect = round.id === 'R1' ? 1 : 2;
  if (trajAfter.sessionRows !== trajExpect) violations.push(`user_turns session rows: ${trajAfter.sessionRows} (expected ${trajExpect})`);
  for (let i = 1; i < trajAfter.indexes.length; i++) {
    if (trajAfter.indexes[i] !== trajAfter.indexes[i - 1] + 1) violations.push(`user_turns indexes not consecutive: ${JSON.stringify(trajAfter.indexes)}`);
  }
  if (round.id === 'R2' && previous) {
    if (previous.ordinal === null || payload.selectionRoundOrdinal !== previous.ordinal + 1) {
      violations.push(`ordinal-advance: R1=${previous.ordinal} R2=${payload.selectionRoundOrdinal}`);
    }
    const n = ROUNDKEY_FIXTURES.length;
    if (Number.isInteger(previous.rotStart) && Number.isInteger(payload.rotationStartIndex)) {
      const expected = (previous.rotStart + 1) % n;
      if (payload.rotationStartIndex !== expected) violations.push(`rotation-advance: R1=${previous.rotStart} R2=${payload.rotationStartIndex} (expected ${expected})`);
    }
  }
  if (sha256File(layout.candidateBundle) !== PUBLISHED_BUNDLE_SHA256) violations.push('candidate-code-unchanged: bundle drifted');

  return {
    round: round.id, startedAt, endedAt, exitCode: host.code, timedOut: host.timedOut,
    envelopeSessionId: envelope?.sessionId ?? null,
    triggerObserved: trigger ? trigger[2] : null,
    policy: payload.selectionPolicy ?? null,
    ordinal: Number.isInteger(payload.selectionRoundOrdinal) ? payload.selectionRoundOrdinal : null,
    rotStart: Number.isInteger(payload.rotationStartIndex) ? payload.rotationStartIndex : null,
    selectedCount: (payload.principleIds ?? []).length,
    traj: trajAfter,
    endpointObservations: observations,
    violations,
    ok: violations.length === 0,
  };
}

function productionContainment(manifest) {
  const violations = [];
  const facts = userTurnsFacts(manifest.productionBaseline.trajectory, ROUNDKEY_SESSION_ID);
  if (!facts.exists) violations.push('production trajectory unreadable');
  if (facts.rows < manifest.productionBaseline.userTurnsTotal) {
    violations.push(`production user_turns total DECREASED: ${facts.rows} < baseline ${manifest.productionBaseline.userTurnsTotal}`);
  }
  if (facts.sessionRows !== 0) violations.push(`production has ${facts.sessionRows} rows for the run session`);
  return {
    ok: violations.length === 0,
    productionTotal: facts.rows,
    baseline: manifest.productionBaseline.userTurnsTotal,
    runSessionRowsInProduction: facts.sessionRows,
    violations,
  };
}

// ─── cli ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}
const has = (name) => args.includes(name);
const pack = argOf('--pack');
(async () => {
  if (has('--prepare')) return prepare({
    packRoot: pack,
    npmCacheDir: argOf('--npm-cache'),
    hostSource: argOf('--host-source'),
    candidateSource: argOf('--candidate-source'),
    productionWorkspace: argOf('--production-workspace'),
  });
  if (has('--verify')) return verify({ packRoot: pack, full: has('--full'), probeSelftest: has('--probe-selftest') });
  if (has('--execute')) return execute({ packRoot: pack, approvalPath: argOf('--approval') });
  console.error('usage: round-key-run.mjs --prepare|--verify|--execute --pack <dir> [--full] [--probe-selftest] [--approval <file>] [--npm-cache <dir>]');
  process.exit(2);
})().catch((error) => {
  console.error('FATAL', error?.message ?? error);
  process.exit(1);
});
