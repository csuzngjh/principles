// PRI-1118 controlled-admission experiment launcher (design v1.2 §3.4 / §6).
//
// Two phases, deliberately separate so no host turn can happen before the
// preflight has passed:
//   --prepare   writes the frozen fixture/input/manifest/admission/config copy
//               under .tmp/aa-experiment/<runId>/ and stops. It starts no host.
//   --execute   re-reads that frozen plan, re-verifies every hash against the
//               P0 report, then runs the positive arm and the control arm once.
//
// The launcher owns the SHARED ledger (ledger.mjs) for both arms; the fake
// provider only reserves through it. No retry, no provider switch, no extra run.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalAdaptiveMappingSha256 } from '@principles/core/runtime-v2';
import {
  createExperimentLedger,
  createRunIdentity,
  fixtureBytes,
  sha256Hex,
} from './lib/ledger.mjs';
import { startFakeProvider } from './lib/fake-provider.mjs';

const SCENE_MARKER = '[PD-AA:delivery-review:v1]';
const HOST_TIMEOUT_MS = 45_000;
const OUTER_TIMEOUT_MS = 120_000;
const RUN_SCHEMA = 'pd-aa-controlled-admission-run/v1';
const ADMISSION_SCHEMA = 'pd-aa-controlled-admission/v2';
const MANIFEST_SCHEMA = 'pd-aa-controlled-admission-manifest/v1';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

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
  configSource,
  repoRoot,
  mappingIdentity,
  configSnapshot,
  sourceRef,
  toolName,
  sessionBinding,
  expectedSessionId,
  operator,
  purpose,
}) {
  const fixtureFile = join(workspaceDir, 'fixture.txt');
  const inputFile = join(runDir, 'input.txt');
  const manifestPath = join(runDir, 'manifest.json');
  const admissionPath = join(runDir, 'admission.json');
  const configPath = join(runDir, 'config.yaml');
  const controlInputFile = join(runDir, 'control-input.txt');

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(controlWorkspaceDir, { recursive: true });
  if (existsSync(fixtureFile)) unlinkSync(fixtureFile);
  writeFileSync(fixtureFile, fixtureBytes(identity.fixtureId));
  writeFileSync(inputFile, positiveInput(identity.fixtureId, fixtureFile), 'utf8');
  writeFileSync(controlInputFile, controlInput(), 'utf8');

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
    configSnapshot,
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
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    consumedAt: null,
    consumedBy: null,
  };
  writeFileSync(admissionPath, `${JSON.stringify(admission, null, 2)}\n`, 'utf8');

  copyFileSync(configSource, configPath);
  return { fixtureFile, inputFile, controlInputFile, manifestPath, admissionPath, configPath };
}

async function prepare(options) {
  const identity = createRunIdentity(new Date());
  if (options.runId) identity.runId = options.runId;
  if (options.runId) identity.fixtureId = `AA-FIXTURE-${options.runId}`;
  const runDir = join(options.runRoot, identity.runId);
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
  if (!existsSync(options.configSource)) throw new Error(`config source not found: ${options.configSource}`);
  if (!options.toolName) throw new Error('--tool-name is required (from P0 runtime inspect)');
  if (!options.artifactId || !options.activationId) throw new Error('--artifact-id and --activation-id are required');
  if (!Number.isInteger(options.softTimeoutMs) || options.softTimeoutMs <= 0) throw new Error('--soft-timeout-ms must be a positive integer');
  const expiresAtMs = Date.parse(options.activationExpiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new Error('--activation-expires-at must be a future ISO timestamp');
  if (options.sessionBinding !== 'predeclared' && options.sessionBinding !== 'first_consumer') {
    throw new Error('--session-binding must be predeclared or first_consumer');
  }
  if (options.sessionBinding === 'predeclared' && !options.expectedSessionId) {
    throw new Error('--session-id is required when --session-binding=predeclared');
  }

  const workspaceDir = join(runDir, 'positive', 'workspace');
  const controlWorkspaceDir = join(runDir, 'control', 'workspace');
  const mappingIdentity = {
    artifactId: options.artifactId,
    activationId: options.activationId,
    softTimeoutMs: options.softTimeoutMs,
    expiresAtMs,
  };
  const files = writeRunFiles({
    runDir,
    identity,
    workspaceDir,
    controlWorkspaceDir,
    configSource: options.configSource,
    repoRoot: options.repoRoot,
    mappingIdentity,
    configSnapshot: {
      provider: 'local-fake-provider',
      baseUrl: '127.0.0.1',
      model: options.model,
      allowConversationAccess: true,
      toolName: options.toolName,
    },
    sourceRef: options.sourceRef,
    toolName: options.toolName,
    sessionBinding: options.sessionBinding,
    expectedSessionId: options.expectedSessionId,
    operator: options.operator,
    purpose: options.purpose,
  });
  const plan = {
    schemaVersion: 'pd-aa-experiment-plan/v1',
    runId: identity.runId,
    fixtureId: identity.fixtureId,
    runDir,
    startedAt: new Date().toISOString(),
    files,
    configSha256: sha256File(files.configPath),
    mappingIdentity,
  };
  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return plan;
}

async function executeArm({ arm, ledger, provider, stateDir, workspaceDir, configPath, inputFile, model, openclawBin, env, runDir }) {
  const turn = ledger.hostTurn(arm, { purpose: arm === 'positive' ? 'positive-host-turn' : 'control-host-turn' });
  const args = [
    'agent', 'exec',
    '--config', configPath,
    '--state-dir', stateDir,
    '--model', model,
    '--cwd', workspaceDir,
    '--timeout', String(Math.floor(HOST_TIMEOUT_MS / 1000)),
    '--json',
    '--message-file', inputFile,
  ];
  const startedAt = new Date().toISOString();
  const stdoutPath = join(runDir, `${arm}.host.stdout.json`);
  const stderrPath = join(runDir, `${arm}.host.stderr.txt`);
  mkdirSync(stateDir, { recursive: true });

  const child = spawn(openclawBin, args, {
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

  const outcome = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error: String(error?.message ?? error) }));
    child.on('close', (code, signal) => resolve({ code, signal, error: null }));
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
    providerPort: provider.port,
    providerBaseUrl: provider.baseUrl,
  };
}

async function execute({ runDir, openclawBin, model, toolName, p0ReportPath }) {
  if (!existsSync(runDir)) throw new Error(`run directory not found: ${runDir}`);
  const planPath = join(runDir, 'plan.json');
  if (!existsSync(planPath)) throw new Error('plan.json missing; run --prepare first');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(plan.files.manifestPath, 'utf8'));
  const admission = JSON.parse(readFileSync(plan.files.admissionPath, 'utf8'));
  const p0 = JSON.parse(readFileSync(p0ReportPath ?? join(runDir, 'p0.json'), 'utf8'));

  if (p0?.schemaVersion !== 'pd-aa-p0-preflight/v1' || p0.ready !== true) {
    throw new Error('P0 report is not ready; refusing to start a host turn');
  }
  if (p0.frozen?.fixtureSha256 !== manifest.fixtureSha256) throw new Error('P0 fixture hash does not match the frozen plan');
  if (p0.frozen?.inputSha256 !== manifest.inputSha256) throw new Error('P0 input hash does not match the frozen plan');
  if (p0.frozen?.manifestSha256 !== admission.manifestSha256) throw new Error('P0 manifest hash does not match the admission');
  if (!toolName) throw new Error('--tool-name is required (from P0 runtime inspect)');

  const ledger = createExperimentLedger({ runId: plan.runId, fixtureId: plan.fixtureId });
  const arms = {};
  const evidenceDir = join(runDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  try {
    // Positive arm first (design §6.1).
    const positiveProvider = await startFakeProvider({
      ledger,
      arm: 'positive',
      fixtureFile: manifest.fixtureFile,
      fixtureId: manifest.fixtureId,
      expectedToolName: toolName,
    });
    const positiveEnv = {
      ...process.env,
      PD_AA_ADMISSION_FILE: resolve(plan.files.admissionPath),
      PD_AA_EXPERIMENT_ROOT: resolve(runDir),
    };
    try {
      arms.positive = await executeArm({
        arm: 'positive',
        ledger,
        provider: positiveProvider,
        stateDir: join(runDir, 'positive', 'state'),
        workspaceDir: manifest.workspaceDir,
        configPath: plan.files.configPath,
        inputFile: manifest.inputFile,
        model,
        openclawBin,
        env: positiveEnv,
        runDir,
      });
    } finally {
      await positiveProvider.close();
    }

    // Control arm: same inputs, no admission file, no PD_AA_* environment.
    const controlProvider = await startFakeProvider({ ledger, arm: 'control' });
    const controlEnv = { ...process.env };
    delete controlEnv.PD_AA_ADMISSION_FILE;
    delete controlEnv.PD_AA_EXPERIMENT_ROOT;
    try {
      arms.control = await executeArm({
        arm: 'control',
        ledger,
        provider: controlProvider,
        stateDir: join(runDir, 'control', 'state'),
        workspaceDir: manifest.controlWorkspaceDir,
        configPath: plan.files.configPath,
        inputFile: manifest.controlInputFile,
        model,
        openclawBin,
        env: controlEnv,
        runDir,
      });
    } finally {
      await controlProvider.close();
    }
  } finally {
    // Copy the consumed admission into the evidence pack, then remove it from
    // the experiment root (design §6.7). The copy is the durable record.
    if (existsSync(plan.files.admissionPath)) {
      copyFileSync(plan.files.admissionPath, join(evidenceDir, 'admission-consumed.json'));
      unlinkSync(plan.files.admissionPath);
    }
  }

  const snapshot = ledger.snapshot();
  const record = {
    schemaVersion: RUN_SCHEMA,
    runId: plan.runId,
    fixtureId: plan.fixtureId,
    startedAt: plan.startedAt,
    endedAt: new Date().toISOString(),
    baseSha: typeof process.env.PD_AA_BASE_SHA === 'string' ? process.env.PD_AA_BASE_SHA : null,
    p0ReportPath: resolve(p0ReportPath ?? join(runDir, 'p0.json')),
    budget: snapshot.budget,
    armBudgets: snapshot.armBudgets,
    used: snapshot.used,
    usedByArm: snapshot.usedByArm,
    withinBudget: snapshot.withinBudget,
    violations: snapshot.violations,
    httpRequests: snapshot.httpRequests,
    toolCalls: snapshot.toolCalls,
    hostTurns: snapshot.hostTurns,
    paidCalls: 0,
    arms,
    // Request-level association is `unknown` by design; it is neither success
    // nor failure and must not be inferred from this run record.
    association: 'unknown',
  };
  writeFileSync(join(runDir, 'run-record.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'ledger.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return record;
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
  if (argv.includes('--prepare')) {
    const plan = await prepare({
      repoRoot,
      runRoot,
      runId: argValue(argv, 'run-id'),
      configSource: argValue(argv, 'config'),
      model: argValue(argv, 'model') ?? 'local-fake-model',
      toolName: argValue(argv, 'tool-name'),
      artifactId: argValue(argv, 'artifact-id'),
      activationId: argValue(argv, 'activation-id'),
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
      openclawBin: argValue(argv, 'openclaw-bin') ?? 'openclaw',
      model: argValue(argv, 'model') ?? 'local-fake-model',
      toolName: argValue(argv, 'tool-name'),
      p0ReportPath: argValue(argv, 'p0-report'),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  throw new Error('use --prepare or --execute');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
}

export { prepare, execute };
