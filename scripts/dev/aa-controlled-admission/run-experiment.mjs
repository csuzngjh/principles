// PRI-1118 controlled-admission experiment launcher (design v1.2 §3.4 / §6).
//
// Two phases, deliberately separate so no host turn can happen before the
// preflight has passed:
//   --prepare   freezes the host config, fixture, input, manifest and admission
//               under artifacts/aa-controlled-admission/<runId>/ and stops. It
//               starts no host and consumes no turn budget.
//   --execute   re-reads that frozen plan, requires a READY P0 report for the
//               SAME host/config/state root/plugin bundle, runs the positive arm
//               once, applies the positive gate, and only then runs the control
//               arm exactly once.
//
// The launcher owns the SHARED ledger (ledger.mjs) for both arms; the fake
// provider only reserves through it. No retry, no provider switch, no extra run.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalAdaptiveMappingSha256 } from '@principles/core/runtime';
import {
  createExperimentLedger,
  createRunIdentity,
  fixtureBytes,
  readAttemptUsageFromRuns,
  reconcileLedgerBudget,
  sha256Hex,
} from './lib/ledger.mjs';
import { ADMISSION_SCHEMA, assertAdmissionReady } from './lib/admission.mjs';
import { startFakeProvider } from './lib/fake-provider.mjs';
import { assertPlanInsideExperimentRoot, buildIsolatedHostEnv } from './lib/env-isolation.mjs';
import { hostCommand, hostIdentity, resolveHostProfile, sha256File } from './lib/host-profile.mjs';
import {
  buildHostConfig,
  endpointBaseUrl,
  hostConfigSha256,
  selectLoopbackPort,
  writeHostConfig,
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
} from './lib/host-config.mjs';
import {
  evaluateControlGate,
  evaluatePositiveGate,
  runPositiveThenControl,
  verifyExecutionFrozen,
  verifyPlanIntegrity,
  writeFailureArtifacts,
} from './lib/gate.mjs';
import { readControlledWorkspaceTarget, seedControlledWorkspace } from './lib/workspace-seed.mjs';

const SCENE_MARKER = '[PD-AA:delivery-review:v1]';
const HOST_TIMEOUT_MS = 45_000;
const OUTER_TIMEOUT_MS = 120_000;
const RUN_SCHEMA = 'pd-aa-controlled-admission-run/v1';
const MANIFEST_SCHEMA = 'pd-aa-controlled-admission-manifest/v1';
const PLAN_SCHEMA = 'pd-aa-plan/v1';

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function positiveInput(fixtureId, fixtureFile) {
  return `${SCENE_MARKER}\n读取并报告夹具文件 ${fixtureFile} 的内容编号（${fixtureId}）。只允许调用一次只读工具。\n`;
}

function controlInput() {
  return `${SCENE_MARKER}\n不要调用任何工具，只回答：AA-DONE\n`;
}

function writeRunFiles({
  runDir,
  identity,
  workspaceDir,
  controlWorkspaceDir,
  hostConfig,
  repoRoot,
  pluginRoot,
  mappingIdentity,
  toolName,
  requestModel,
  endpointPort,
  pluginBundleSha256,
  sourceRef,
  sessionBinding,
  expectedSessionId,
  operator,
  purpose,
}) {
  const fixtureFile = join(workspaceDir, 'fixture.txt');
  const inputFile = join(runDir, 'input.txt');
  const manifestPath = join(runDir, 'manifest.json');
  const admissionPath = join(runDir, 'admission.json');
  const configPath = join(runDir, 'config.json');
  const controlInputFile = join(runDir, 'control-input.txt');

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(controlWorkspaceDir, { recursive: true });
  // writeFileSync truncates an existing fixture atomically enough for a fresh
  // run directory; an existsSync-then-unlink pair is a check-then-use race.
  writeFileSync(fixtureFile, fixtureBytes(identity.fixtureId));
  writeFileSync(inputFile, positiveInput(identity.fixtureId, fixtureFile), 'utf8');
  writeFileSync(controlInputFile, controlInput(), 'utf8');
  writeHostConfig(configPath, hostConfig);

  // Manifest shape is authoritative in packages/openclaw-plugin/src/hooks/
  // controlled-admission.ts (validateManifestDocument); extra fields are
  // evidence-only and ignored by the runtime.
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    targetArtifactId: mappingIdentity.artifactId,
    targetActivationId: mappingIdentity.activationId,
    sourceRef,
    fixtureFile,
    fixtureSha256: sha256File(fixtureFile),
    expectedToolName: toolName,
    expectedContentMarker: identity.fixtureId,
    configSnapshot: {
      configPath,
      configSha256: hostConfigSha256(configPath),
      provider: FAKE_PROVIDER_ID,
      baseUrl: endpointBaseUrl(endpointPort),
      endpointPort,
      model: requestModel,
      toolName,
      allowConversationAccess: true,
      pluginRoot: safeRealpath(pluginRoot),
      pluginBundleSha256,
    },
    runId: identity.runId,
    fixtureRef: identity.fixtureId,
    fixtureId: identity.fixtureId,
    fixtureBytes: fixtureBytes(identity.fixtureId).length,
    inputFile,
    inputSha256: sha256File(inputFile),
    controlInputFile,
    controlInputSha256: sha256File(controlInputFile),
    workspaceDir,
    controlWorkspaceDir,
    repoRoot: safeRealpath(repoRoot),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const manifestSha256 = sha256File(manifestPath);
  const admission = {
    schemaVersion: ADMISSION_SCHEMA,
    admissionId: `adm-${identity.runId}`,
    operator,
    purpose,
    experimentRoot: safeRealpath(runDir),
    inputPath: inputFile,
    inputSha256: manifest.inputSha256,
    manifestPath,
    manifestSha256,
    targetArtifactId: mappingIdentity.artifactId,
    targetActivationId: mappingIdentity.activationId,
    fixtureRef: identity.fixtureId,
    mappingSha256: canonicalAdaptiveMappingSha256({
      workspaceRealPath: safeRealpath(workspaceDir),
      artifactId: mappingIdentity.artifactId,
      activationId: mappingIdentity.activationId,
      softTimeoutMs: mappingIdentity.softTimeoutMs,
      expiresAtMs: mappingIdentity.expiresAtMs,
    }),
    sessionBinding,
    expectedSessionId: sessionBinding === 'predeclared' ? expectedSessionId : null,
    createdAt: new Date().toISOString(),
    expiresAt: mappingIdentity.expiresAt,
    consumedAt: null,
    consumedBy: null,
  };
  writeFileSync(admissionPath, `${JSON.stringify(admission, null, 2)}\n`, 'utf8');

  return { fixtureFile, inputFile, controlInputFile, manifestPath, manifestSha256, admissionPath, configPath };
}

const CONTROLLED_ADMISSION_MAX_WINDOW_MS = 15 * 60 * 1000;

/**
 * The PD plugin rejects an admission whose `expiresAt - createdAt` exceeds 15
 * minutes (`MAX_ADMISSION_LIFETIME_MS` in controlled-admission.ts). This is a
 * PD admission rule, NOT a host restriction. The earlier "host rule" wording
 * was a wrong attribution and must not be reused.
 */
export function activationExpiryWindowViolation(expiresAtMs, createdAtMs) {
  if (!Number.isFinite(expiresAtMs)) return 'must be a parseable ISO timestamp';
  if (expiresAtMs <= createdAtMs) return 'must be a future ISO timestamp';
  if (expiresAtMs - createdAtMs > CONTROLLED_ADMISSION_MAX_WINDOW_MS) {
    return 'must be within 15 minutes of the admission creation (PD controlled-admission rule)';
  }
  return null;
}

async function prepare(options) {
  const identity = createRunIdentity(new Date());
  if (options.runId) identity.runId = options.runId;
  if (options.runId) identity.fixtureId = `AA-FIXTURE-${options.runId}`;
  const runDir = join(options.runRoot, identity.runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
  if (!options.toolName) throw new Error('--tool-name is required (from P0 runtime inspect)');
  if (!options.artifactId || !options.activationId) throw new Error('--artifact-id and --activation-id are required');
  if (!Number.isInteger(options.softTimeoutMs) || options.softTimeoutMs <= 0) throw new Error('--soft-timeout-ms must be a positive integer');
  const expiresAtMs = Date.parse(options.activationExpiresAt);
  const expiryViolation = activationExpiryWindowViolation(expiresAtMs, Date.now());
  if (expiryViolation) throw new Error(`--activation-expires-at ${expiryViolation}`);
  if (options.sessionBinding !== 'predeclared' && options.sessionBinding !== 'first_consumer') {
    throw new Error('--session-binding must be predeclared or first_consumer');
  }
  if (options.sessionBinding === 'predeclared' && !options.expectedSessionId) {
    throw new Error('--session-id is required when --session-binding=predeclared');
  }

  // The isolated host (Owner decision option B): required, never guessed.
  const host = resolveHostProfile({ hostRoot: options.hostRoot });
  if (!host.ok) throw new Error(`isolated host unavailable: ${host.reason}`);
  if (!host.healthy) throw new Error('isolated host package is not healthy; refusing to freeze a plan');

  const pluginRoot = resolve(options.pluginRoot);
  const bundlePath = join(pluginRoot, 'dist', 'bundle.js');
  if (!existsSync(bundlePath)) throw new Error(`plugin bundle missing: ${bundlePath} (run npm run build:bundle)`);
  const pluginBundleSha256 = sha256File(bundlePath);

  // One loopback port is chosen ONCE and frozen; both arms and P0 use it. If it
  // is taken at execute time the run fails closed instead of re-binding.
  const endpointPort = Number.isInteger(options.endpointPort) ? options.endpointPort : await selectLoopbackPort();
  const workspaceDir = join(runDir, 'positive', 'workspace');
  const controlWorkspaceDir = join(runDir, 'control', 'workspace');
  const stateRoot = join(runDir, 'state');
  const mappingIdentity = {
    artifactId: options.artifactId,
    activationId: options.activationId,
    softTimeoutMs: options.softTimeoutMs,
    expiresAtMs,
    expiresAt: options.activationExpiresAt,
  };
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(controlWorkspaceDir, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });

  // The positive arm needs a real Runtime V2 target in its OWN isolated
  // workspace, otherwise the plugin cannot inject a directive and the run would
  // prove nothing. The control workspace stays empty on purpose.
  const principleId = options.principleId ?? `aa-principle-${identity.runId}`;
  const principleText = options.principleText
    ?? '读取夹具文件后才报告其内容编号；只调用一次只读工具，不重复读取。';
  const workspaceTarget = await seedControlledWorkspace({
    workspaceDir: safeRealpath(workspaceDir),
    artifactId: mappingIdentity.artifactId,
    activationId: mappingIdentity.activationId,
    principleId,
    principleText,
  });
  const seededCheck = await readControlledWorkspaceTarget({
    workspaceDir: safeRealpath(workspaceDir),
    artifactId: mappingIdentity.artifactId,
    activationId: mappingIdentity.activationId,
  });
  if (!seededCheck.ok || seededCheck.principleId !== principleId) {
    throw new Error(`seeded workspace target is not readable: ${seededCheck.reason ?? 'principle id mismatch'}`);
  }
  if (seededCheck.stateDbSha256 !== workspaceTarget.stateDbSha256) {
    throw new Error('seeded workspace state.db changed between seeding and verification');
  }
  writeFileSync(join(runDir, 'workspace-seed.json'), `${JSON.stringify({ ...workspaceTarget, verifiedBy: seededCheck }, null, 2)}\n`, 'utf8');

  const hostConfig = buildHostConfig({
    endpointPort,
    workspaceDir: safeRealpath(workspaceDir),
    pluginRoot: safeRealpath(pluginRoot),
    mapping: mappingIdentity,
    toolName: options.toolName,
  });

  const files = writeRunFiles({
    runDir,
    identity,
    workspaceDir,
    controlWorkspaceDir,
    hostConfig,
    repoRoot: options.repoRoot,
    pluginRoot,
    mappingIdentity,
    toolName: options.toolName,
    requestModel: options.requestModel,
    endpointPort,
    pluginBundleSha256,
    sourceRef: options.sourceRef,
    sessionBinding: options.sessionBinding,
    expectedSessionId: options.expectedSessionId,
    operator: options.operator,
    purpose: options.purpose,
  });

  // Validate the REAL file the plugin will read, not just the argv that built
  // it: creation time, expiry window, unconsumed state and hash bindings.
  const admissionCheck = assertAdmissionReady({
    admissionPath: files.admissionPath,
    manifestPath: files.manifestPath,
    plan: {
      runDir,
      inputFile: files.inputFile,
      inputSha256: sha256File(files.inputFile),
      manifestPath: files.manifestPath,
      manifestSha256: files.manifestSha256,
      fixtureRef: identity.fixtureId,
      mapping: mappingIdentity,
      sessionBinding: options.sessionBinding,
      expectedSessionId: options.expectedSessionId,
    },
  });
  writeFileSync(
    join(runDir, 'admission-file-check.json'),
    `${JSON.stringify({ phase: 'prepare', ...admissionCheck }, null, 2)}\n`,
    'utf8',
  );

  const plan = {
    schemaVersion: PLAN_SCHEMA,
    runId: identity.runId,
    fixtureId: identity.fixtureId,
    fixtureRef: identity.fixtureId,
    runDir,
    startedAt: new Date().toISOString(),
    configPath: files.configPath,
    configSha256: hostConfigSha256(files.configPath),
    endpoint: { host: '127.0.0.1', port: endpointPort, baseUrl: endpointBaseUrl(endpointPort) },
    host: { ...hostIdentity(host), hostRoot: host.hostRoot, packageDir: host.packageDir, fsSafePath: host.fsSafePath },
    plugin: { rootDir: safeRealpath(pluginRoot), bundlePath, bundleSha256: pluginBundleSha256 },
    stateRoot,
    workspaceDir: safeRealpath(workspaceDir),
    controlWorkspaceDir: safeRealpath(controlWorkspaceDir),
    workspaceTarget: {
      stateDbPath: workspaceTarget.stateDbPath,
      stateDbSha256: workspaceTarget.stateDbSha256,
      artifactId: workspaceTarget.artifactId,
      activationId: workspaceTarget.activationId,
      principleId: workspaceTarget.principleId,
      principleText,
      principleTextSha256: workspaceTarget.principleTextSha256,
    },
    toolName: options.toolName,
    model: `${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID}`,
    requestModel: options.requestModel,
    mapping: {
      artifactId: mappingIdentity.artifactId,
      activationId: mappingIdentity.activationId,
      expiresAt: mappingIdentity.expiresAt,
      softTimeoutMs: mappingIdentity.softTimeoutMs,
    },
    sessionBinding: options.sessionBinding,
    expectedSessionId: options.expectedSessionId,
    admissionSha256: admissionCheck.facts.fileSha256,
    admissionFile: admissionCheck.facts,
    fixtureFile: files.fixtureFile,
    fixtureSha256: sha256File(files.fixtureFile),
    inputFile: files.inputFile,
    inputSha256: sha256File(files.inputFile),
    controlInputFile: files.controlInputFile,
    manifestPath: files.manifestPath,
    manifestSha256: files.manifestSha256,
    admissionPath: files.admissionPath,
    files,
  };
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return plan;
}

async function executeArm({ arm, ledger, provider, stateDir, workspaceDir, plan, inputFile, env, runDir }) {
  const turn = ledger.hostTurn(arm, { purpose: arm === 'positive' ? 'positive-host-turn' : 'control-host-turn' });
  const { command, prefixArgs } = hostCommand(plan.host);
  const args = [
    ...prefixArgs,
    'agent', 'exec',
    '--config', plan.configPath,
    '--state-dir', stateDir,
    '--model', plan.model,
    '--cwd', workspaceDir,
    '--timeout', String(Math.floor(HOST_TIMEOUT_MS / 1000)),
    '--code-mode', 'direct',
    '--json',
    '--message-file', inputFile,
  ];
  const startedAt = new Date().toISOString();
  const stdoutPath = join(runDir, `${arm}.host.stdout.json`);
  const stderrPath = join(runDir, `${arm}.host.stderr.txt`);
  mkdirSync(stateDir, { recursive: true });

  const child = spawn(command, args, {
    cwd: workspaceDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false;
  let termination = 'none';
  const timer = setTimeout(() => {
    timedOut = true;
    termination = process.platform === 'win32' ? 'taskkill-tree' : 'sigkill';
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  }, OUTER_TIMEOUT_MS);

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const outcome = await new Promise((resolvePromise) => {
    child.on('error', (error) => resolvePromise({ code: null, signal: null, error: String(error?.message ?? error) }));
    child.on('close', (code, signal) => resolvePromise({ code, signal, error: null }));
  });
  clearTimeout(timer);

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  writeFileSync(stdoutPath, stdout, 'utf8');
  writeFileSync(stderrPath, stderr, 'utf8');

  return {
    arm,
    hostTurnId: turn.id,
    argv: args,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: outcome.code,
    signal: outcome.signal,
    spawnError: outcome.error,
    timedOut,
    termination,
    stdoutPath,
    stderrPath,
    stdoutSha256: sha256Hex(stdout),
    stderrSha256: sha256Hex(stderr),
    provider: provider.observations(),
    anomalies: provider.anomalies(),
    providerPort: provider.port,
    providerBaseUrl: provider.baseUrl,
  };
}

function writeEndpointEvidence(runDir, arm, provider) {
  const evidenceDir = join(runDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${arm}.endpoint-requests.json`);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 'pd-aa-endpoint-observations/v1',
    arm,
    port: provider.port,
    baseUrl: provider.baseUrl,
    observations: provider.observations(),
    anomalies: provider.anomalies(),
  }, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Record the paths a phase resolved BEFORE it can write anything. This file
 * survives an abnormal host exit, so an environment escape is diagnosable even
 * when the run record is never produced.
 */
function writeEnvironmentEvidence(runDir, arm, isolation) {
  const evidenceDir = join(runDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${arm}.environment.json`);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 'pd-aa-environment/v1',
    arm,
    resolved: isolation.resolved,
    removedFromParent: isolation.removedFromParent,
    insideExperimentRoot: true,
  }, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Remove single-consumer claim sidecars left by an abnormal plugin path. The
 * result is recorded so an abnormal exit still has a cleanup outcome.
 */
function sweepClaimArtifacts(runDir, cleanup) {
  cleanup.claimArtifactsRemoved = [];
  for (const name of readdirSync(runDir)) {
    if (!name.endsWith('.claim.lock') && !name.endsWith('.claim.tmp')) continue;
    try {
      unlinkSync(join(runDir, name));
      cleanup.claimArtifactsRemoved.push(name);
    } catch (error) {
      cleanup.claimArtifactsRemoved.push(`${name}:${String(error?.code ?? error)}`);
    }
  }
  return cleanup;
}

async function execute({ runDir, runRoot, p0ReportPath }) {
  if (!existsSync(runDir)) throw new Error(`run directory not found: ${runDir}`);
  const planPath = join(runDir, 'plan.json');
  let plan = null;
  try {
    if (!existsSync(planPath)) throw new Error('plan.json missing; run --prepare first');
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    // Even a plan that cannot be read leaves a durable failure artifact.
    error.evidence = writeFailureArtifacts({
      runDir,
      phase: 'plan-read',
      error,
      snapshot: null,
      cleanup: { status: 'refused-before-any-turn' },
    });
    throw error;
  }

  const cleanup = {
    providers: [],
    admission: 'not_attempted',
    stateDirs: [join(plan.stateRoot, 'positive'), join(plan.stateRoot, 'control')],
  };

  // Fail-closed BEFORE any write (including the cumulative ledger file): every
  // writable path the plan names must sit inside this run directory.
  try {
    assertPlanInsideExperimentRoot({ runDir, plan });
  } catch (error) {
    error.evidence = writeFailureArtifacts({
      runDir,
      phase: 'environment-escape',
      error,
      snapshot: null,
      cleanup: { ...cleanup, status: 'refused-before-any-turn' },
    });
    throw error;
  }

  // The plugin reads this FILE, so the file (not the argv that produced it) is
  // what must be valid: creation time, expiry, unconsumed state and hashes.
  // This runs before the cumulative ledger is even opened, so an invalid
  // admission cannot spend budget.
  let admissionCheck = null;
  try {
    admissionCheck = assertAdmissionReady({
      admissionPath: plan.admissionPath,
      manifestPath: plan.manifestPath,
      plan,
      expectedSha256: plan.admissionSha256 ?? null,
    });
    writeFileSync(
      join(runDir, 'admission-file-check-execute.json'),
      `${JSON.stringify({ phase: 'execute-before-host', ...admissionCheck }, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    error.evidence = writeFailureArtifacts({
      runDir,
      phase: 'admission-file',
      error,
      snapshot: null,
      cleanup: { ...cleanup, status: 'refused-before-any-turn' },
    });
    throw error;
  }

  const effectiveRunRoot = typeof runRoot === 'string' && runRoot.trim() ? runRoot : resolve(runDir, '..');
  const budgetLedgerPath = join(effectiveRunRoot, 'experiment-budget.json');
  const priorUsage = existsSync(budgetLedgerPath)
    ? null
    : readAttemptUsageFromRuns(effectiveRunRoot).usage;

  // The cumulative ledger lives in the run ROOT, not in this run directory, so
  // a fresh --prepare can never reset what earlier runs already spent.
  let ledger = null;
  try {
    ledger = createExperimentLedger({
      runId: plan.runId,
      fixtureId: plan.fixtureId,
      persistPath: budgetLedgerPath,
      priorUsage,
    });
  } catch (error) {
    error.evidence = writeFailureArtifacts({
      runDir,
      phase: 'budget-ledger',
      error,
      snapshot: null,
      cleanup: { ...cleanup, status: 'refused-before-any-turn' },
    });
    throw error;
  }
  const evidenceDir = join(runDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const finalizeAdmission = () => {
    if (cleanup.admission !== 'not_attempted') return;
    if (existsSync(plan.admissionPath)) {
      copyFileSync(plan.admissionPath, join(evidenceDir, 'admission-consumed.json'));
      unlinkSync(plan.admissionPath);
      cleanup.admission = 'copied-and-removed';
    } else {
      cleanup.admission = 'absent';
    }
  };

  try {
    const manifest = JSON.parse(readFileSync(plan.manifestPath, 'utf8'));
    const admission = JSON.parse(readFileSync(plan.admissionPath, 'utf8'));
    const p0 = JSON.parse(readFileSync(p0ReportPath ?? join(runDir, 'p0.json'), 'utf8'));

    const host = resolveHostProfile({ hostRoot: plan.host.hostRoot });
    if (!host.ok) throw new Error(`isolated host unavailable: ${host.reason}`);

    const frozenViolations = [...verifyExecutionFrozen({
      plan,
      p0,
      hostProfile: host,
      configPath: plan.configPath,
      manifestPath: plan.manifestPath,
      bundlePath: plan.plugin.bundlePath,
    }), ...verifyPlanIntegrity({
      plan,
      manifestPath: plan.manifestPath,
      manifest,
      admissionPath: plan.admissionPath,
      admission,
      configPath: plan.configPath,
    })];
    if (frozenViolations.length > 0) {
      throw Object.assign(new Error(`frozen experiment state changed: ${frozenViolations.join('; ')}`), { code: 'aa_frozen_state_changed' });
    }

    const runPositive = async () => {
      const stateDir = join(plan.stateRoot, 'positive');
      // Built BEFORE the provider and the host exist: an inherited production
      // path or an out-of-root plan path is refused before anything can be
      // written or bound.
      const isolation = buildIsolatedHostEnv({
        baseEnv: process.env,
        experimentRoot: runDir,
        workspaceDir: plan.workspaceDir,
        stateDir,
        configPath: plan.configPath,
        profile: `aa-positive-${plan.runId}`,
        admissionPath: plan.admissionPath,
      });
      const environmentPath = writeEnvironmentEvidence(runDir, 'positive', isolation);

      const provider = await startFakeProvider({
        ledger,
        arm: 'positive',
        fixtureFile: manifest.fixtureFile,
        fixtureId: manifest.fixtureId,
        expectedToolName: plan.toolName,
        expectedPrincipleText: plan.workspaceTarget?.principleText ?? null,
        port: plan.endpoint.port,
      });
      cleanup.providers.push('positive');
      try {
        const arm = await executeArm({
          arm: 'positive',
          ledger,
          provider,
          stateDir,
          workspaceDir: plan.workspaceDir,
          plan,
          inputFile: manifest.inputFile,
          env: isolation.env,
          runDir,
        });
        arm.environment = {
          path: environmentPath,
          resolved: isolation.resolved,
          removedFromParent: isolation.removedFromParent,
        };
        arm.endpointEvidencePath = writeEndpointEvidence(runDir, 'positive', provider);
        // Capture the consumed admission BEFORE the gate: the gate verdict must
        // be computed from the document the plugin actually wrote, and the
        // original file stays in place until the experiment is finalised.
        arm.admission = parseConsumedAdmission(plan.admissionPath, evidenceDir);
        return arm;
      } finally {
        await provider.close();
      }
    };

    const runControl = async () => {
      const stateDir = join(plan.stateRoot, 'control');
      const isolation = buildIsolatedHostEnv({
        baseEnv: process.env,
        experimentRoot: runDir,
        workspaceDir: plan.controlWorkspaceDir,
        stateDir,
        configPath: plan.configPath,
        profile: `aa-control-${plan.runId}`,
      });
      const environmentPath = writeEnvironmentEvidence(runDir, 'control', isolation);

      const provider = await startFakeProvider({
        ledger,
        arm: 'control',
        port: plan.endpoint.port,
      });
      cleanup.providers.push('control');
      try {
        const arm = await executeArm({
          arm: 'control',
          ledger,
          provider,
          stateDir,
          workspaceDir: plan.controlWorkspaceDir,
          plan,
          inputFile: manifest.controlInputFile,
          env: isolation.env,
          runDir,
        });
        arm.environment = {
          path: environmentPath,
          resolved: isolation.resolved,
          removedFromParent: isolation.removedFromParent,
        };
        arm.endpointEvidencePath = writeEndpointEvidence(runDir, 'control', provider);
        return arm;
      } finally {
        await provider.close();
      }
    };

    const outcome = await runPositiveThenControl({
      runPositive,
      runControl,
      evaluatePositive: (arm) => evaluatePositiveGate({
        arm,
        snapshot: ledger.snapshot(),
        manifest,
        plan,
        p0,
        toolName: plan.toolName,
        model: plan.requestModel,
        admission: arm.admission,
        expectedPrincipleId: plan.workspaceTarget?.principleId ?? null,
      }),
      evaluateControl: (arm) => evaluateControlGate({
        arm,
        snapshot: ledger.snapshot(),
        plan,
        p0,
        toolName: plan.toolName,
        model: plan.requestModel,
      }),
    });

    finalizeAdmission();
    sweepClaimArtifacts(runDir, cleanup);
    const snapshot = ledger.snapshot();
    if (outcome.stoppedAt === 'positive') {
      writeFailureArtifacts({
        runDir,
        phase: 'positive-gate',
        error: new Error(`positive gate failed: ${outcome.positiveGate.failures.map((row) => row.id).join(', ')}`),
        snapshot,
        cleanup: { ...cleanup, status: 'stopped-before-control' },
      });
    } else if (outcome.stoppedAt === 'control') {
      writeFailureArtifacts({
        runDir,
        phase: 'control-gate',
        error: new Error(`control gate failed: ${outcome.controlGate.failures.map((row) => row.id).join(', ')}`),
        snapshot,
        cleanup: { ...cleanup, status: 'control-ran-but-gate-failed' },
      });
    }

    const record = buildRecord({
      plan, snapshot, outcome, p0ReportPath, runDir, cleanup, budgetLedgerPath, admissionCheck,
    });
    writeFileSync(join(runDir, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    writeFileSync(join(runDir, 'ledger.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return record;
  } catch (error) {
    sweepClaimArtifacts(runDir, cleanup);
    const snapshot = ledger.snapshot();
    const artifacts = writeFailureArtifacts({
      runDir,
      phase: 'execute',
      error,
      snapshot,
      cleanup: { ...cleanup, status: 'failed' },
    });
    error.evidence = artifacts;
    throw error;
  } finally {
    // Copy the consumed admission into the evidence pack, then remove it from
    // the experiment root (design §6.7). The copy is the durable record.
    finalizeAdmission();
  }
}

/** Capture the consumed admission as evidence and return the parsed document. */
function parseConsumedAdmission(admissionPath, evidenceDir) {
  if (!existsSync(admissionPath)) return null;
  copyFileSync(admissionPath, join(evidenceDir, 'admission-consumed.json'));
  return JSON.parse(readFileSync(admissionPath, 'utf8'));
}

function buildRecord({ plan, snapshot, outcome, p0ReportPath, runDir, cleanup, budgetLedgerPath, admissionCheck }) {
  return {
    schemaVersion: RUN_SCHEMA,
    runId: plan.runId,
    fixtureId: plan.fixtureId,
    startedAt: plan.startedAt,
    endedAt: new Date().toISOString(),
    baseSha: typeof process.env.PD_AA_BASE_SHA === 'string' ? process.env.PD_AA_BASE_SHA : null,
    p0ReportPath: resolve(p0ReportPath ?? join(runDir, 'p0.json')),
    configPath: plan.configPath,
    configSha256: plan.configSha256,
    host: plan.host,
    plugin: plan.plugin,
    endpoint: plan.endpoint,
    stateRoot: plan.stateRoot,
    workspaceTarget: plan.workspaceTarget,
    toolName: plan.toolName,
    model: plan.model,
    budget: snapshot.budget,
    armBudgets: snapshot.armBudgets,
    budgetLedgerPath,
    budgetAudit: snapshot.budgetAudit ?? [],
    admissionFile: admissionCheck?.facts ?? plan.admissionFile ?? null,
    deliveryPath: outcome.positiveGate?.deliveryPath ?? null,
    used: snapshot.used,
    attempt: snapshot.attempt,
    usedByArm: snapshot.usedByArm,
    withinBudget: snapshot.withinBudget,
    violations: snapshot.violations,
    httpRequests: snapshot.httpRequests,
    toolCalls: snapshot.toolCalls,
    hostTurns: snapshot.hostTurns,
    paidCalls: 0,
    stoppedAt: outcome.stoppedAt,
    positiveGate: outcome.positiveGate,
    controlGate: outcome.controlGate,
    arms: {
      positive: outcome.positive,
      control: outcome.control,
    },
    cleanup,
    // Request-level association is `unknown` by design; it is neither success
    // nor failure and must not be inferred from this run record.
    association: 'unknown',
  };
}

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const repoRoot = argValue(argv, 'repo') ?? process.env.PD_AA_REPO_ROOT ?? process.cwd();
  // git-16: material that must survive the session lives under artifacts/;
  // only regenerable scratch goes to .tmp/. The run record IS the evidence.
  const runRoot = argValue(argv, 'run-root') ?? join(repoRoot, 'artifacts', 'aa-controlled-admission');
  // Explicit budget reconciliation: raises the caps of an existing cumulative
  // ledger without discarding usage. Approval and reason are mandatory, and the
  // audit entry is persisted in the same file.
  if (argv.includes('--reconcile-budget')) {
    const result = reconcileLedgerBudget({
      persistPath: join(runRoot, 'experiment-budget.json'),
      approvedBy: argValue(argv, 'approved-by'),
      reason: argValue(argv, 'reason'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (argv.includes('--prepare')) {
    const plan = await prepare({
      repoRoot,
      runRoot,
      runId: argValue(argv, 'run-id'),
      hostRoot: argValue(argv, 'host-root') ?? process.env.PD_AA_HOST_ROOT,
      pluginRoot: argValue(argv, 'plugin-root') ?? join(repoRoot, 'packages', 'openclaw-plugin'),
      endpointPort: argValue(argv, 'endpoint-port') ? Number.parseInt(argValue(argv, 'endpoint-port'), 10) : null,
      requestModel: argValue(argv, 'request-model') ?? FAKE_MODEL_ID,
      toolName: argValue(argv, 'tool-name'),
      artifactId: argValue(argv, 'artifact-id'),
      activationId: argValue(argv, 'activation-id'),
      principleId: argValue(argv, 'principle-id'),
      principleText: argValue(argv, 'principle-text'),
      softTimeoutMs: Number.parseInt(argValue(argv, 'soft-timeout-ms') ?? '', 10),
      activationExpiresAt: argValue(argv, 'activation-expires-at'),
      sessionBinding: argValue(argv, 'session-binding') ?? 'first_consumer',
      expectedSessionId: argValue(argv, 'session-id'),
      operator: argValue(argv, 'operator') ?? 'trae',
      purpose: argValue(argv, 'purpose') ?? 'delivery-review',
      sourceRef: argValue(argv, 'source-ref') ?? 'unknown',
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (argv.includes('--execute')) {
    const record = await execute({
      runDir: argValue(argv, 'run-dir') ?? join(runRoot, argValue(argv, 'run-id') ?? ''),
      runRoot,
      p0ReportPath: argValue(argv, 'p0-report'),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (record.stoppedAt !== null) process.exitCode = 1;
    return;
  }
  throw new Error('use --prepare, --execute or --reconcile-budget');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
}

export { prepare, execute };
