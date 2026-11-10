#!/usr/bin/env node
// PRI-1163 controlled-host round-key run — launcher (v2, PRI-1152/#2424 mechanisms).
//
//   --prepare --pack <dir> [--npm-cache <dir>] [--host-source <dir>]
//             [--candidate-source <dir>] [--production-workspace <dir>]
//       Freeze a NEW execution pack offline (official host copy, PUBLISHED
//       candidate plugin, six-principle fixture via the formal stores,
//       configs, the two frozen user inputs; manifest + approval template +
//       run-card excerpt). Runs the resolution probe (positive) and its
//       negative self-test OFFLINE. Starts no host and sends no request.
//   --verify --pack <dir> [--full] [--probe-selftest]
//       Offline re-verification. Exit 0 only when every required check passed.
//   --execute --pack <dir> --approval <file>
//       The approved run ONLY. The approval binds the card version, the
//       manifest sha256, the frozen budgets AND the frozen execution code
//       (the launcher scripts). Exclusive claim, per-round production fence,
//       byte-exact incremental evidence with stable failure codes; R2 starts
//       only if R1 passed the gate, the fence and evidence integrity; the
//       final record is written even on failure.
//
// Budget semantics (PRI-1152): reaching a cap is not over budget; the NEXT
// attempt is refused before it is issued. A failed host start is still
// charged. No retry, no fallback, no second execute of the same pack.
//
// ENTRY (differs from PRI-1152 on purpose): `openclaw agent --local
// --session-id <pinned>` — the official normal-chat embedded entry WITH an
// explicit session id, so both rounds land in the SAME session and the
// persisted user_turns ordinal advances.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import {
  CARD_VERSION, ROUNDKEY_ENDPOINT_PATH, ROUNDKEY_FIXTURES, ROUNDKEY_INPUTS,
  ROUNDKEY_MODEL_ID, ROUNDKEY_PROVIDER, ROUNDKEY_ROUNDS, ROUNDKEY_RUN_BUDGET, ROUNDKEY_ROUND_BUDGETS,
  ROUNDKEY_SESSION_ID, buildRoundKeyHostConfig, buildRoundKeyPdConfigText, generateRoundKeyApiKey,
  roundKeyModelRef, sha256File, validateRoundKeyHostConfig, ROUNDKEY_PD_FEATURE_EXPECTATIONS,
} from './lib/roundkey-shape.mjs';
import { runWorkspaceResolutionProbe, buildProbeEnv } from './lib/roundkey-probe.mjs';
import {
  readAppendedBytes, logEvidenceIntegrity, judgeRound, perRoundProductionFence,
  refuseRerun, validateApprovalBinding, envFingerprint,
} from './lib/roundkey-gate.mjs';
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

const DRIVER_DIR = dirname(fileURLToPath(import.meta.url));
const EXECUTION_CODE_FILES = [
  'round-key-run.mjs',
  'lib/roundkey-shape.mjs',
  'lib/roundkey-probe.mjs',
  'lib/roundkey-gate.mjs',
  'lib/presence-endpoint.mjs',
  'lib/ledger.mjs',
  'lib/host-config.mjs',
  'lib/presence-pack.mjs',
  'lib/env-isolation.mjs',
];
function collectExecutionCode() {
  return {
    trustBoundary: 'Drift check, not tamper-proofing: the launcher verifies itself (PRI-1152 #2424 pattern); detects edits/rebuilds/branch switches made after prepare.',
    scripts: EXECUTION_CODE_FILES.map((relative) => {
      const path = join(DRIVER_DIR, relative);
      return { path: `scripts/dev/aa-controlled-admission/${relative.replace(/\\/g, '/')}`, sha256: sha256File(path) };
    }),
  };
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
    evidenceDir: join(packRoot, 'run', 'evidence'),
    budgetLedgerPath: join(packRoot, 'run', 'budget-ledger.json'),
    claimPath: join(packRoot, 'run', 'claim.json'),
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
function cardVersion() {
  return CARD_VERSION;
}

// ─── prepare ──────────────────────────────────────────────────────────────────
async function prepare({ packRoot, npmCacheDir, hostSource: hostSourceArg, candidateSource: candidateSourceArg, productionWorkspace: productionWorkspaceArg }) {
  if (!packRoot || !isAbsolute(packRoot)) throw new Error('--pack must be an absolute path');
  if (existsSync(packRoot)) throw new Error(`pack already exists: ${packRoot}`);
  const packId = `rk-${nowStamp()}`;
  const layout = layoutOf(packRoot);
  mkdirSync(packRoot, { recursive: true });
  for (const dir of [dirname(layout.configPath), dirname(layout.hostLogPath), join(layout.workspaceDir, '.pd'),
    join(layout.workspaceDir, '.openclaw'), join(layout.workspaceDir, '.state', 'logs'),
    layout.homeDir, join(layout.homeDir, 'AppData', 'Roaming'), join(layout.homeDir, 'AppData', 'Local'),
    layout.tempDir, layout.sessionStateDir, layout.preflightDir, layout.runDir, layout.evidenceDir, dirname(layout.inputPath('R1'))]) {
    mkdirSync(dir, { recursive: true });
  }

  const hostSource = hostSourceArg ?? deriveHostSource();
  const installedExtensionRoot = candidateSourceArg ?? deriveInstalledExtensionRoot();
  const productionWorkspace = productionWorkspaceArg ?? deriveDeclaredProductionWorkspace();
  const productionTrajectory = join(productionWorkspace, '.state', 'trajectory.db');

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
  if (sha256File(installedBundle) !== PUBLISHED_BUNDLE_SHA256) {
    throw new Error(`installed bundle is not the verified published 3.1.3 bytes: ${sha256File(installedBundle)}`);
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

  // 7. resolution probe: positive (SHAPE of the run env, throwaway probe
  //    workspace so plugin startup writes never touch the frozen fixture)
  //    + negative self-test (ambient-minus-pins replays the incident)
  const probeWorkspaceDir = join(packRoot, 'tmp', 'probe-ws');
  const probeStateDir = join(packRoot, 'tmp', 'probe-ws-state');
  mkdirSync(probeWorkspaceDir, { recursive: true });
  mkdirSync(probeStateDir, { recursive: true });
  const probeBase = { baseEnv: process.env, packRoot, homeDir: layout.homeDir, tempDir: layout.tempDir, workspaceDir: probeWorkspaceDir, stateDir: probeStateDir, configPath: layout.configPath };
  const positive = await runWorkspaceResolutionProbe({ packRoot, tmpDir: layout.tempDir, candidateBundlePath: layout.candidateBundle, probeEnv: buildProbeEnv(probeBase), declaredWorkspace: productionWorkspace });
  const negative = await runWorkspaceResolutionProbe({ packRoot, tmpDir: layout.tempDir, candidateBundlePath: layout.candidateBundle, probeEnv: buildProbeEnv(probeBase, { stripWorkspacePins: true }), declaredWorkspace: productionWorkspace });
  if (!positive.ok) throw new Error(`positive resolution probe FAILED: ${positive.reason}`);
  if (negative.ok) throw new Error('negative self-test unexpectedly resolved inside pack — the gate does not catch the incident condition');

  // 8. env parity: the probe env SHAPE must fingerprint-equal the spawn env
  //    (same builder, same inputs). Both are derived from the pack layout, so
  //    the fingerprints differ only in the workspace/state dir names — record
  //    the SPAWN-env fingerprint and the PROBE-env fingerprint separately and
  //    assert at execute time that a rebuilt spawn env still matches.
  const spawnEnv = runEnvFor(layout);
  const spawnEnvFingerprint = envFingerprint(spawnEnv);
  const probeRunShapeEnv = buildProbeEnv(probeBase);
  const probeEnvFingerprint = envFingerprint(probeRunShapeEnv);

  // 9. manifest (no self-hash field), approval template, run-card excerpt
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
    schemaVersion: 'pd-round-key-pack/v2',
    cardVersion: cardVersion(),
    packId,
    createdAt: new Date().toISOString(),
    scope: 'Two consecutive genuine USER turns in ONE explicit session on the unmodified official OpenClaw normal-chat embedded entry (agent --local --session-id) with the PUBLISHED 3.1.3 plugin bundle: prove fair_rotation_v1 with an advancing selectionRoundOrdinal; non-user rounds and missing keys remain FIFO by design; A-line PRI-1119 identity untouched',
    source: { driver: 'scripts/dev/aa-controlled-admission/round-key-run.mjs' },
    executionCode: collectExecutionCode(),
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
    envParity: { spawnEnvFingerprint, probeEnvFingerprint, rule: 'at execute time the rebuilt spawn env must fingerprint-match the manifest; the probe ran under the same builder' },
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
    cardVersion: manifest.cardVersion,
    manifestSha256,
    budgets: ROUNDKEY_RUN_BUDGET,
    executionCode: manifest.executionCode,
    approvedBy: '',
    approvedAt: '',
    note: 'Approval binds EXACTLY this card version + manifest sha256 + budgets + execution code. Re-prepare or ANY launcher-script change invalidates it.',
  });
  const cardPath = join(packRoot, 'run-card.md');
  writeFileSync(cardPath, buildRunCardText(manifest, manifestSha256, positive), 'utf8');
  console.log(JSON.stringify({ ok: true, packId, manifestSha256, endpointPort, probePositive: positive.reason, cardPath }, null, 2));
}

function buildRunCardText(manifest, manifestSha256, positive) {
  return `# PRI-1163 round-key run pack ${manifest.packId}

- cardVersion: ${manifest.cardVersion}
- manifestSha256: ${manifestSha256}
- executionCode scripts: ${manifest.executionCode.scripts.length} (bound; any change invalidates the approval)
- published bundle: ${manifest.publishedBundleSha256} (staged copy verified)
- session: ${manifest.session.id} (ONE explicit session, both rounds)
- entry: node <pack>/host/node_modules/openclaw/openclaw.mjs agent --local --session-id ${manifest.session.id} --message-file <input> --model ${manifest.rounds[0].modelRef} --json
- endpoint: 127.0.0.1:${manifest.endpoint.port}${manifest.endpoint.path} (${manifest.endpoint.api}, fake key; port free at prepare, not reserved)
- budgets: ${JSON.stringify(manifest.budgets)} (per round ${JSON.stringify(manifest.roundBudgets)})
- acceptance: R1 fair_rotation_v1 with integer ordinal k1; R2 fair_rotation_v1 with ordinal == k1+1 and rotationStartIndex advanced; user_turns rows for the session = 2 consecutive; plugin trigger lines classify BOTH rounds as user rounds; exactly 1 host start and 1 provider request per round; byte-exact evidence deltas with stable failure codes; per-round production fence (baseline ${manifest.productionBaseline.userTurnsTotal}, zero run-session rows) — fence/evidence failure stops R2; final record always written.
- resolution probe (prepare-time): ${positive.reason}
`;
}

// ─── verify ───────────────────────────────────────────────────────────────────
async function verify({ packRoot, full, probeSelftest }) {
  const layout = layoutOf(packRoot);
  const manifest = readJson(layout.manifestPath);
  const checks = [];
  const check = (id, ok, detail) => { checks.push({ id, ok: ok === true, detail }); if (ok !== true) console.error(`FAIL ${id}: ${detail}`); };
  check('manifest-integrity', (() => {
    const template = readJson(join(packRoot, 'approval.template.json'));
    return template.manifestSha256 === sha256File(layout.manifestPath);
  })(), 'approval template binds the CURRENT manifest file hash (re-prepare invalidates)');
  check('execution-code', (() => {
    const now = collectExecutionCode();
    return JSON.stringify(now.scripts) === JSON.stringify(manifest.executionCode?.scripts);
  })(), 'launcher scripts match the frozen execution code (drift -> re-freeze)');
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
  check('approval-template', (() => {
    const template = readJson(join(packRoot, 'approval.template.json'));
    return JSON.stringify(template.executionCode) === JSON.stringify(manifest.executionCode) && JSON.stringify(template.budgets) === JSON.stringify(manifest.budgets);
  })(), 'approval template binds execution code and frozen budgets');
  check('run-dir-absent', !existsSync(layout.claimPath) && !existsSync(layout.budgetLedgerPath) && !(existsSync(layout.runDir) && readdirSync(layout.runDir).some((f) => f.startsWith('result-') || f === 'run-record.json')), 'pack not yet executed (no claim, ledger or result)');
  check('env-parity', (() => {
    const rebuilt = envFingerprint(runEnvFor(layout));
    return rebuilt === manifest.envParity?.spawnEnvFingerprint;
  })(), 'rebuilt spawn env fingerprint equals the manifest record (probe ran under the same builder)');
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
  const manifestSha256 = sha256File(layout.manifestPath);
  const approval = readJson(approvalPath);
  const violations = validateApprovalBinding({ approval, manifest, manifestSha256, executionCodeNow: collectExecutionCode() });
  if (violations.length > 0) {
    writeJson(join(packRoot, `refusal-${nowStamp()}.json`), { status: 'refused-before-any-start', reason: 'approval', violations }, 'wx');
    console.error(JSON.stringify({ status: 'refused-before-any-start', reason: 'approval', violations }));
    process.exit(1);
  }
  const rerun = refuseRerun({
    runDirExists: existsSync(layout.runDir) && readdirSync(layout.runDir).some((f) => f.startsWith('result-') || f === 'run-record.json'),
    ledgerExists: existsSync(layout.budgetLedgerPath),
    claimExists: existsSync(layout.claimPath),
  });
  if (rerun.refused) {
    writeJson(join(packRoot, `refusal-${nowStamp()}.json`), { status: 'refused-before-any-start', reason: rerun.code, violations: [rerun] }, 'wx');
    console.error(JSON.stringify({ status: 'refused-before-any-start', reason: rerun.code, violations: [rerun] }));
    process.exit(1);
  }
  const pre = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--verify', '--pack', packRoot, '--full', '--probe-selftest'], { stdio: 'inherit' });
  if (pre.status !== 0) {
    writeJson(join(packRoot, `refusal-${nowStamp()}.json`), { status: 'refused-before-any-start', reason: 'verification', violations: ['preflight before execute FAILED — see the newest preflight report'] }, 'wx');
    process.exit(1);
  }
  // Exclusive claim: created 'wx' — a concurrent executor loses the race here.
  writeJson(layout.claimPath, { claimedAt: new Date().toISOString(), approvalFile: approvalPath, approvalSha256: sha256File(approvalPath), manifestSha256 }, { flag: 'wx' });

  const ledger = createExperimentLedger({ runId: manifest.packId, fixtureId: 'pri1163-round-key', budget: manifest.budgets, armBudgets: manifest.roundBudgets, persistPath: layout.budgetLedgerPath });
  const endpoint = await startPresenceEndpoint({ ledger, port: manifest.endpoint.port, fakeApiKey: readJson(layout.configPath).models.providers[ROUNDKEY_PROVIDER].apiKey });
  const record = { schemaVersion: 'pd-round-key-run-record/v2', packId: manifest.packId, manifestSha256, cardVersion: manifest.cardVersion, rounds: [], failures: [], stoppedAt: null, stopReasons: [], decision: 'in_progress' };
  try {
    const spawnEnv = runEnvFor(layout);
    if (envFingerprint(spawnEnv) !== manifest.envParity?.spawnEnvFingerprint) {
      record.failures.push({ step: 'env-parity', code: 'SPAWN_ENV_DRIFT', message: 'rebuilt spawn env fingerprint differs from the frozen manifest — refusing to start' });
      record.stoppedAt = 'env-parity';
      record.stopReasons.push('spawn_env_drift');
    }
    let fenceBefore = productionFacts(manifest.productionBaseline.trajectory);
    let previous = null;
    for (const round of endpoint && record.stoppedAt === null ? manifest.rounds : []) {
      const roundRecord = { id: round.id };
      record.rounds.push(roundRecord);
      writeJson(join(layout.evidenceDir, `${round.id}.environment.json`), { spawnEnv, fingerprint: envFingerprint(spawnEnv) }, 'wx');
      try {
        ledger.hostTurn(round.id, { purpose: `${round.id}-host-start` });
      } catch (error) {
        record.failures.push({ step: `budget:${round.id}`, code: 'BUDGET_REFUSED', message: String(error?.message ?? error) });
        record.stoppedAt = round.id;
        record.stopReasons.push('budget_refused');
        break;
      }
      endpoint.openRound({ arm: round.id, api: round.api });
      roundRecord.started = true;
      const eventsSizesBefore = snapshotEventsSizes(layout.workspaceDir);
      const hostLogSizeBefore = existsSync(layout.hostLogPath) ? statSync(layout.hostLogPath).size : 0;
      const trajBefore = userTurnsFacts(layout.trajectoryPath);
      const startedAt = new Date().toISOString();
      const host = await spawnHostRound({ manifest, layout, round, env: spawnEnv });
      const endedAt = new Date().toISOString();
      endpoint.closeRound?.();
      writeFileSync(join(layout.evidenceDir, `${round.id}.host.stdout.txt`), host.stdout, { encoding: 'utf8', flag: 'wx' });
      writeFileSync(join(layout.evidenceDir, `${round.id}.host.stderr.txt`), host.stderr, { encoding: 'utf8', flag: 'wx' });
      const endpointObservations = endpoint.roundObservations(round.id);
      writeJson(join(layout.evidenceDir, `${round.id}.endpoint.json`), endpointObservations, 'wx');

      // byte-exact evidence deltas
      const hostLogDelta = readAppendedBytes(layout.hostLogPath, hostLogSizeBefore);
      const eventsDelta = readEventsDelta(layout.workspaceDir, eventsSizesBefore, startedAt);
      const integrity = logEvidenceIntegrity({ hostLogDelta, eventFiles: eventsDelta.files });
      writeJson(join(layout.evidenceDir, `${round.id}.log-integrity.json`), integrity, 'wx');
      for (const step of integrity.steps) record.failures.push(step);

      const served = endpointObservations.filter((r) => r.decision === 'served');
      const refused = endpointObservations.filter((r) => r.decision === 'refused');
      let envelope = null;
      try { envelope = JSON.parse(host.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{')) ?? 'null'); } catch { /* no json */ }
      const gate = judgeRound({
        roundId: round.id, previous,
        hostExitCode: host.code, timedOut: host.timedOut, envelope,
        endpointServed: served.length, endpointRefused: refused.length,
        endpointPath: served[0]?.path, expectedEndpointPath: ROUNDKEY_ENDPOINT_PATH,
        hostLogDeltaText: hostLogDelta.text,
        events: eventsDelta.events.map((e) => e.entry),
        trajectoryIndexes: trajAfterIndexes(layout.trajectoryPath),
        candidateBundleOk: sha256File(layout.candidateBundle) === PUBLISHED_BUNDLE_SHA256,
        candidateRoot: layout.candidateRoot, workspaceDir: layout.workspaceDir,
        session: round.sessionId, fixtureIds: ROUNDKEY_FIXTURES.map((f) => f.principleId),
      });
      writeJson(join(layout.evidenceDir, `${round.id}.gate.json`), { ...gate, integritySteps: integrity.steps }, 'wx');
      Object.assign(roundRecord, {
        argv: host.argv, exitCode: host.code, timedOut: host.timedOut,
        gateOk: gate.ok, failedChecks: gate.violations.map((v) => v.code),
        ordinal: gate.ordinal, rotStart: gate.rotStart, policy: gate.policy, triggerObserved: gate.triggerObserved,
      });
      for (const v of gate.violations) record.failures.push(v);

      // per-round production fence — failure means R2 must not start
      const fenceAfter = productionFacts(manifest.productionBaseline.trajectory);
      const fence = perRoundProductionFence({ roundId: round.id, before: fenceBefore, after: fenceAfter });
      writeJson(join(layout.evidenceDir, `${round.id}.production-fence.json`), { before: fenceBefore, after: fenceAfter, ...fence }, 'wx');
      fenceBefore = fenceAfter;
      for (const v of fence.violations) record.failures.push(v);

      const stopReasons = [
        !gate.ok && 'round_gate_failed',
        !integrity.complete && 'evidence_incomplete',
        !fence.ok && 'production_fence_failed',
      ].filter(Boolean);
      if (stopReasons.length > 0) {
        record.stoppedAt = round.id;
        record.stopReasons.push(...stopReasons);
        break;
      }
      previous = gate;
    }

    // final production fence + decision
    if (record.stoppedAt === null) {
      const finalAfter = productionFacts(manifest.productionBaseline.trajectory);
      const finalFence = perRoundProductionFence({ roundId: 'final', before: { total: manifest.productionBaseline.userTurnsTotal, runSessionRows: 0 }, after: finalAfter });
      writeJson(join(layout.evidenceDir, 'final.production-fence.json'), { baseline: manifest.productionBaseline, after: finalAfter, ...finalFence }, 'wx');
      for (const v of finalFence.violations) record.failures.push(v);
      const allRoundsPassed = record.rounds.length === manifest.rounds.length && record.rounds.every((r) => r.gateOk === true);
      record.decision = allRoundsPassed && finalFence.ok && record.failures.length === 0 ? 'completed' : 'stopped';
      if (record.decision !== 'completed') record.stopReasons.push('final_gate_failed');
    } else {
      record.decision = 'stopped';
    }
  } catch (error) {
    record.error = String(error?.stack ?? error);
    record.stoppedAt ??= 'error';
    record.stopReasons.push('error');
    record.decision = 'stopped';
  } finally {
    try { await endpoint.close(); } catch (error) { record.endpointCloseError = String(error?.message ?? error); }
    try { ledger.persist(); } catch { /* best effort */ }
    // The final record is ALWAYS written, even after fence/evidence failures.
    writeJson(join(layout.runDir, 'run-record.json'), record, 'wx');
  }
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.decision === 'completed' ? 0 : 1);
}

function snapshotEventsSizes(workspaceDir) {
  const dir = join(workspaceDir, '.state', 'logs');
  const out = new Map();
  if (existsSync(dir)) for (const f of readdirSync(dir)) out.set(f, statSync(join(dir, f)).size);
  return out;
}
/** Byte-exact appended delta for every events file, parsed into entries. */
function readEventsDelta(workspaceDir, sizesBefore, sinceIso) {
  const dir = join(workspaceDir, '.state', 'logs');
  const files = [];
  const events = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('events_')) continue;
      const before = sizesBefore.get(f) ?? 0;
      const delta = readAppendedBytes(join(dir, f), before);
      files.push({ name: f, fromByte: delta.fromByte, bytes: delta.bytes, truncated: delta.truncated, shrunk: delta.shrunk, readError: delta.readError ?? null });
      for (const line of delta.text.split('\n')) {
        if (!line.includes('runtime_v2_prompt_activations_injected')) continue;
        try {
          const entry = JSON.parse(line);
          if (!sinceIso || entry.ts >= sinceIso) events.push({ file: f, entry });
        } catch { /* torn line: tolerated, never silently counted */ }
      }
    }
  }
  return { files, events };
}
function userTurnsFacts(dbPath, sessionId = ROUNDKEY_SESSION_ID) {
  if (!existsSync(dbPath)) return { exists: false, rows: 0, sessionRows: 0, indexes: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  const rows = db.prepare('SELECT COUNT(*) c FROM user_turns').get().c;
  const sessionRows = db.prepare('SELECT COUNT(*) c FROM user_turns WHERE session_id = ?').get(sessionId).c;
  db.close();
  return { exists: true, rows, sessionRows };
}
function trajAfterIndexes(dbPath) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000');
  const indexes = db.prepare('SELECT turn_index i FROM user_turns WHERE session_id = ? ORDER BY turn_index').all(ROUNDKEY_SESSION_ID).map((r) => r.i);
  db.close();
  return indexes;
}
function productionFacts(dbPath) {
  const facts = userTurnsFacts(dbPath);
  if (!facts.exists) return { total: null, runSessionRows: null, incomplete: true };
  return { total: facts.rows, runSessionRows: facts.sessionRows, incomplete: false };
}

async function spawnHostRound({ manifest, layout, round, env }) {
  const argv = [
    join(manifest.hostRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
    'agent', '--local', '--session-id', round.sessionId,
    '--message-file', round.inputPath,
    '--model', round.modelRef,
    '--json',
  ];
  const startedAt = new Date().toISOString();
  const child = await new Promise((resolvePromise) => {
    let c;
    try {
      c = spawn(process.execPath, argv, { cwd: layout.workspaceDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolvePromise({ spawnError: String(error?.message ?? error) });
      return;
    }
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { c.kill('SIGKILL'); } catch { /* dead */ } }, round.outerTimeoutMs);
    c.stdout.on('data', (d) => { stdout += String(d); });
    c.stderr.on('data', (d) => { stderr += String(d); });
    c.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: `${stderr}${error}`, timedOut, argv }); });
    c.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr, timedOut, argv }); });
  });
  return { ...child, argv, startedAt, endedAt: new Date().toISOString() };
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
  console.error('usage: round-key-run.mjs --prepare|--verify|--execute --pack <dir> [--full] [--probe-selftest] [--approval <file>] [--npm-cache <dir>] [--host-source <dir>] [--candidate-source <dir>] [--production-workspace <dir>]');
  process.exit(2);
})().catch((error) => {
  console.error('FATAL', error?.message ?? error);
  process.exit(1);
});
