import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BudgetExceededError,
  CUMULATIVE_LEDGER_SCHEMA,
  createExperimentLedger,
  createRunIdentity,
  fixtureBytes,
  readAttemptUsageFromRuns,
  sha256Hex,
} from '../dev/aa-controlled-admission/lib/ledger.mjs';
import { assertPlanInsideExperimentRoot, buildIsolatedHostEnv, isInsideRoot } from '../dev/aa-controlled-admission/lib/env-isolation.mjs';
import { startFakeProvider } from '../dev/aa-controlled-admission/lib/fake-provider.mjs';
import {
  buildHostConfig,
  hostConfigSha256,
  readHostConfig,
  selectLoopbackPort,
  validateHostConfigWiring,
  writeHostConfig,
  FAKE_MODEL_ID,
  FAKE_PROVIDER_ID,
  PLUGIN_ID,
} from '../dev/aa-controlled-admission/lib/host-config.mjs';
import {
  hostIdentity,
  resolveHostProfile,
  sha256File,
  verifyHostIdentity,
} from '../dev/aa-controlled-admission/lib/host-profile.mjs';
import {
  evaluatePositiveGate,
  runPositiveThenControl,
  verifyExecutionFrozen,
  verifyPlanIntegrity,
  writeFailureArtifacts,
} from '../dev/aa-controlled-admission/lib/gate.mjs';
import { readControlledWorkspaceTarget, seedControlledWorkspace } from '../dev/aa-controlled-admission/lib/workspace-seed.mjs';

const openProviders = [];
afterEach(async () => {
  while (openProviders.length > 0) await openProviders.pop().close();
});

function makeLedger(runId = 'aa-test') {
  return createExperimentLedger({ runId, fixtureId: `AA-FIXTURE-${runId}` });
}

async function post(baseUrl, body) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text.startsWith('data:') ? text : JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload, text };
}

describe('experiment ledger — one numbering source', () => {
  it('allocates ids from the global sequence across both arms', () => {
    const ledger = makeLedger();
    expect(ledger.hostTurn('positive').id).toBe('turn-001');
    expect(ledger.hostTurn('control').id).toBe('turn-002');
    expect(ledger.http('positive').id).toBe('http-001');
    expect(ledger.http('positive').id).toBe('http-002');
    const controlRequest = ledger.http('control');
    expect(controlRequest.id).toBe('http-003');
    expect(controlRequest.endpointRequestId).toBe('http-003');
    expect(ledger.tool('positive', { name: 'read' }).id).toBe('tool-001');
    const snapshot = ledger.snapshot();
    expect(snapshot.used).toMatchObject({ hostTurns: 2, httpRequests: 3, toolCalls: 1, paidCalls: 0 });
    expect(snapshot.usedByArm.positive.httpRequests).toBe(2);
    expect(snapshot.usedByArm.control.httpRequests).toBe(1);
    expect(snapshot.withinBudget).toBe(true);
  });

  it('fails closed on the fourth HTTP request and the second control request', () => {
    const ledger = makeLedger();
    ledger.http('positive');
    ledger.http('positive');
    ledger.http('control');
    expect(() => ledger.http('control')).toThrow(BudgetExceededError);
    const afterArmViolation = makeLedger();
    afterArmViolation.http('control');
    expect(() => afterArmViolation.http('control')).toThrow(BudgetExceededError);
    expect(afterArmViolation.snapshot().violations).toHaveLength(1);
  });

  it('never records a paid call and refuses a second tool call', () => {
    const ledger = makeLedger();
    expect(() => ledger.paidCall('positive')).toThrow(BudgetExceededError);
    ledger.tool('positive');
    expect(() => ledger.tool('positive')).toThrow(BudgetExceededError);
    expect(ledger.snapshot().paidCalls).toEqual([]);
  });

  it('keeps one fixture id and one byte sequence', () => {
    const identity = createRunIdentity(new Date('2026-11-06T08:00:00.000Z'));
    expect(identity.runId).toBe('aa-20261106T080000Z');
    expect(identity.fixtureId).toBe('AA-FIXTURE-aa-20261106T080000Z');
    const bytes = fixtureBytes(identity.fixtureId);
    expect(bytes.toString('utf8')).toBe(`${identity.fixtureId}\n`);
    expect(sha256Hex(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('experiment ledger — cumulative across run directories', () => {
  it('carries the failed turn into a fresh run directory and continues the global ids', () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aa-budget-'));
    const failedRunDir = join(runRoot, 'aa-run-20261106T0941Z');
    mkdirSync(failedRunDir);
    const failed = makeLedger('aa-run-20261106T0941Z');
    failed.hostTurn('positive');
    writeFileSync(join(failedRunDir, 'ledger.json'), JSON.stringify(failed.snapshot(), null, 2));

    const bootstrap = readAttemptUsageFromRuns(runRoot);
    expect(bootstrap.usage.hostTurns).toBe(1);
    expect(bootstrap.sources).toEqual(['aa-run-20261106T0941Z']);

    const persistPath = join(runRoot, 'experiment-budget.json');
    const first = createExperimentLedger({
      runId: 'aa-run-first', fixtureId: 'AA-FIXTURE-run-first', persistPath, priorUsage: bootstrap.usage,
    });
    expect(first.snapshot().used.hostTurns).toBe(1);
    expect(first.hostTurn('positive').id).toBe('turn-002');

    // A NEW run directory (a fresh --prepare) reading the same cumulative file
    // must not start from zero.
    const second = createExperimentLedger({
      runId: 'aa-run-second', fixtureId: 'AA-FIXTURE-run-second', persistPath,
    });
    expect(second.snapshot().used.hostTurns).toBe(2);
    expect(second.hostTurn('control').id).toBe('turn-003');
    expect(existsSync(persistPath)).toBe(true);
  });

  it('fails closed on a malformed or budget-incompatible cumulative ledger instead of resetting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-budget-bad-'));
    const persistPath = join(dir, 'experiment-budget.json');
    writeFileSync(persistPath, '{not json', 'utf8');
    expect(() => createExperimentLedger({ runId: 'aa-bad', fixtureId: 'F', persistPath })).toThrow(/cannot read/);

    const incompatible = {
      schemaVersion: CUMULATIVE_LEDGER_SCHEMA,
      budget: { hostTurns: 2, httpRequests: 3, toolCalls: 1, paidCalls: 0 },
      used: { hostTurns: 1, httpRequests: 0, toolCalls: 0, paidCalls: 0 },
      records: { hostTurns: [], httpRequests: [], toolCalls: [], paidCalls: [] },
      violations: [],
    };
    writeFileSync(persistPath, JSON.stringify(incompatible), 'utf8');
    expect(() => createExperimentLedger({ runId: 'aa-bad', fixtureId: 'F', persistPath })).toThrow(/reconcile explicitly/);
  });
});

describe('environment isolation — inherited production paths', () => {
  function makeArmRoot() {
    const dir = mkdtempSync(join(tmpdir(), 'aa-env-'));
    const runDir = join(dir, 'run');
    const stateRoot = join(runDir, 'state');
    const positiveWorkspace = join(runDir, 'positive', 'workspace');
    const controlWorkspace = join(runDir, 'control', 'workspace');
    mkdirSync(positiveWorkspace, { recursive: true });
    mkdirSync(controlWorkspace, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    const configPath = join(runDir, 'config.json');
    writeFileSync(configPath, '{"plugins":{}}\n');
    const admissionPath = join(runDir, 'admission.json');
    writeFileSync(admissionPath, '{}\n');
    return { dir, runDir, stateRoot, positiveWorkspace, controlWorkspace, configPath, admissionPath };
  }

  // Absolute on every platform: the parent declares paths OUTSIDE the run
  // directory, never a Windows-only string that POSIX treats as relative.
  function productionEnvOutside(layout) {
    const outside = resolve(layout.dir, 'production');
    return {
      PD_WORKSPACE_DIR: join(outside, 'workspace'),
      OPENCLAW_WORKSPACE: join(outside, 'workspace'),
      PD_STATE_DIR: join(outside, 'state'),
      OPENCLAW_STATE_DIR: outside,
      OPENCLAW_CONFIG_PATH: join(outside, 'openclaw.json'),
      OPENCLAW_PROFILE: 'production',
      OPENCLAW_HOME: outside,
    };
  }

  it('keeps both arms inside their own root even when the parent declares production paths', () => {
    const layout = makeArmRoot();
    const productionEnv = productionEnvOutside(layout);
    const positive = buildIsolatedHostEnv({
      baseEnv: productionEnv,
      experimentRoot: layout.runDir,
      workspaceDir: layout.positiveWorkspace,
      stateDir: join(layout.stateRoot, 'positive'),
      configPath: layout.configPath,
      profile: 'aa-positive',
      admissionPath: layout.admissionPath,
    });
    const control = buildIsolatedHostEnv({
      baseEnv: productionEnv,
      experimentRoot: layout.runDir,
      workspaceDir: layout.controlWorkspace,
      stateDir: join(layout.stateRoot, 'control'),
      configPath: layout.configPath,
      profile: 'aa-control',
    });

    expect(positive.env.PD_WORKSPACE_DIR).toBe(resolve(layout.positiveWorkspace));
    expect(control.env.PD_WORKSPACE_DIR).toBe(resolve(layout.controlWorkspace));
    for (const isolation of [positive, control]) {
      expect(isolation.env.OPENCLAW_WORKSPACE).toBeUndefined();
      expect(isolation.env.PD_STATE_DIR).toBeUndefined();
      expect(isolation.env.OPENCLAW_HOME).toBeUndefined();
      expect(isolation.env.OPENCLAW_CONFIG_PATH).toBe(resolve(layout.configPath));
      for (const path of [
        isolation.resolved.workspaceDir,
        isolation.resolved.pdStateDbPath,
        isolation.resolved.pdStateDir,
        isolation.resolved.hostStateDir,
        isolation.resolved.hostConfigPath,
      ]) {
        expect(isInsideRoot(layout.runDir, path)).toBe(true);
      }
      expect(isolation.removedFromParent).toEqual(expect.arrayContaining(['PD_WORKSPACE_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_STATE_DIR']));
    }
    expect(positive.resolved.admissionFile).not.toBeNull();
    expect(isInsideRoot(layout.runDir, positive.resolved.admissionFile)).toBe(true);
    expect(control.resolved.admissionFile).toBeNull();
  });

  it('refuses before any write when a resolved path escapes the experiment root', () => {
    const layout = makeArmRoot();
    const outsideWorkspace = resolve(layout.dir, 'production', 'workspace');
    expect(() => buildIsolatedHostEnv({
      baseEnv: productionEnvOutside(layout),
      experimentRoot: layout.runDir,
      workspaceDir: outsideWorkspace,
      stateDir: join(layout.stateRoot, 'positive'),
      configPath: layout.configPath,
      profile: 'aa-positive',
    })).toThrow(/environment escape/);
  });

  it('refuses a plan whose workspace, state or config escapes the run directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-plan-escape-'));
    const frozen = makeFrozenExperiment(join(dir, 'experiment'));
    expect(assertPlanInsideExperimentRoot({ runDir: frozen.runDir, plan: frozen.plan }).checked.length).toBeGreaterThan(0);
    expect(() => assertPlanInsideExperimentRoot({
      runDir: frozen.runDir,
      plan: { ...frozen.plan, workspaceDir: join(dir, 'outside-workspace') },
    })).toThrow(/environment escape/);
    expect(() => assertPlanInsideExperimentRoot({
      runDir: frozen.runDir,
      plan: { ...frozen.plan, stateRoot: join(dir, 'outside-state') },
    })).toThrow(/environment escape/);
  });
});

describe('fake provider — budget enforced before the response', () => {
  it('serves the positive arm: tool call, then tool result, then stop', async () => {
    const ledger = makeLedger();
    const fixtureId = 'AA-FIXTURE-aa-test';
    const fixtureFile = join(mkdtempSync(join(tmpdir(), 'aa-fixture-')), 'fixture.txt');
    writeFileSync(fixtureFile, fixtureBytes(fixtureId));
    const provider = await startFakeProvider({
      ledger, arm: 'positive', fixtureFile, fixtureId, expectedToolName: 'read',
    });
    openProviders.push(provider);
    expect(provider.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);

    const first = await post(provider.baseUrl, {
      model: 'local-fake-model',
      stream: false,
      messages: [{ role: 'user', content: 'read the fixture' }],
    });
    expect(first.status).toBe(200);
    const body = JSON.parse(first.text);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('read');

    const second = await post(provider.baseUrl, {
      model: 'local-fake-model',
      stream: false,
      messages: [
        { role: 'user', content: 'read the fixture' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', name: 'read', content: fixtureId },
      ],
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.text).choices[0].finish_reason).toBe('stop');

    const third = await post(provider.baseUrl, { messages: [{ role: 'user', content: 'again' }] });
    expect(third.status).toBe(429);
    expect(JSON.parse(third.text).error.type).toBe('aa_budget_exceeded');

    const snapshot = ledger.snapshot();
    expect(snapshot.httpRequests.map((row) => row.id)).toEqual(['http-001', 'http-002']);
    expect(snapshot.httpRequests[0].userMessageSha256).toBe(sha256Hex('read the fixture'));
    expect(snapshot.toolCalls.map((row) => row.id)).toEqual(['tool-001']);
    expect(snapshot.violations).toHaveLength(1);
  });

  it('serves the control arm with one request only', async () => {
    const ledger = makeLedger();
    const provider = await startFakeProvider({ ledger, arm: 'control' });
    openProviders.push(provider);
    const first = await post(provider.baseUrl, { messages: [{ role: 'user', content: 'AA-DONE' }] });
    expect(first.status).toBe(200);
    const second = await post(provider.baseUrl, { messages: [{ role: 'user', content: 'again' }] });
    expect(second.status).toBe(429);
    expect(ledger.snapshot().httpRequests.map((row) => row.id)).toEqual(['http-001']);
  });

  it('requires the P0 tool name for the positive arm and records unknown hashes as null', async () => {
    const ledger = makeLedger();
    await expect(startFakeProvider({ ledger, arm: 'positive' })).rejects.toThrow(/tool name/);
    const provider = await startFakeProvider({
      ledger, arm: 'positive', fixtureFile: 'C:\\nope.txt', fixtureId: 'AA-FIXTURE-x', expectedToolName: 'read',
    });
    openProviders.push(provider);
    await post(provider.baseUrl, { messages: [{ role: 'assistant', content: 'no user message' }] });
    expect(ledger.snapshot().httpRequests[0].userMessageSha256).toBeNull();
  });
});

describe('launcher boundary — endpoint config wiring', () => {
  it('puts the runtime port into the effective config and the endpoint records the host request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-wiring-'));
    const workspaceDir = join(dir, 'workspace');
    const pluginRoot = join(dir, 'plugin');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    const mapping = {
      artifactId: 'artifact-1',
      activationId: 'activation-1',
      expiresAt: '2026-11-07T00:00:00.000Z',
      softTimeoutMs: 5000,
    };
    const port = await selectLoopbackPort();
    const config = buildHostConfig({ endpointPort: port, workspaceDir, pluginRoot, mapping, toolName: 'read' });
    const configPath = join(dir, 'config.json');
    writeHostConfig(configPath, config);

    const parsed = readHostConfig(configPath);
    expect(parsed.models.providers[FAKE_PROVIDER_ID].baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    expect(parsed.agents.defaults.model.primary).toBe(`${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID}`);
    expect(parsed.plugins.load.paths).toEqual([pluginRoot]);
    expect(parsed.plugins.entries[PLUGIN_ID].hooks).toEqual({ allowPromptInjection: true, allowConversationAccess: true });
    expect(parsed.tools.allow).toEqual(['read']);
    expect(validateHostConfigWiring(parsed, { pluginRoot, workspaceDir, mapping, toolName: 'read', endpointPort: port })).toEqual([]);

    const ledger = makeLedger('aa-wiring');
    const fixtureFile = join(workspaceDir, 'fixture.txt');
    writeFileSync(fixtureFile, fixtureBytes('AA-FIXTURE-aa-wiring'));
    const provider = await startFakeProvider({
      ledger,
      arm: 'positive',
      fixtureFile,
      fixtureId: 'AA-FIXTURE-aa-wiring',
      expectedToolName: 'read',
      port,
    });
    openProviders.push(provider);
    expect(provider.port).toBe(port);
    expect(provider.baseUrl).toBe(parsed.models.providers[FAKE_PROVIDER_ID].baseUrl);

    const response = await post(provider.baseUrl, {
      model: FAKE_MODEL_ID,
      stream: false,
      tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } } }],
      messages: [
        { role: 'system', content: '【ACTIVE BEHAVIOR DIRECTIVES】\n<directive id="artifact-1">watch delivery</directive>' },
        { role: 'user', content: 'read the fixture' },
      ],
    });
    expect(response.status).toBe(200);
    const observations = provider.observations();
    expect(observations).toHaveLength(1);
    expect(observations[0].toolDefinitions).toEqual(['read']);
    expect(observations[0].intervention.directivesBlockPresent).toBe(true);
    expect(observations[0].intervention.directiveIds).toEqual(['artifact-1']);
    expect(observations[0].model).toBe(FAKE_MODEL_ID);
  });
});

describe('launcher boundary — positive gate stops before control', () => {
  it('never invokes the control arm when the positive gate fails', async () => {
    let controlRuns = 0;
    const outcome = await runPositiveThenControl({
      runPositive: async () => ({ arm: 'positive', exitCode: 0, timedOut: false, spawnError: null, provider: [], anomalies: [] }),
      runControl: async () => { controlRuns += 1; return { arm: 'control' }; },
      evaluatePositive: () => ({ ok: false, failures: [{ id: 'http-count', status: 'FAIL' }] }),
      evaluateControl: () => ({ ok: true }),
    });
    expect(controlRuns).toBe(0);
    expect(outcome.stoppedAt).toBe('positive');
    expect(outcome.control).toBeNull();
  });

  it('fails the positive gate on a missing second request and on missing intervention evidence', () => {
    const ledger = makeLedger('aa-gate');
    ledger.hostTurn('positive');
    ledger.http('positive', { purpose: 'positive-request' });
    const arm = {
      arm: 'positive', exitCode: 0, timedOut: false, spawnError: null, anomalies: [],
      provider: [{ endpointRequestId: 'http-001', status: 200, finishReason: 'tool_calls', model: FAKE_MODEL_ID, toolDefinitions: ['read'], intervention: { directivesBlockPresent: false, directiveIds: [] } }],
    };
    const verdict = evaluatePositiveGate({
      arm,
      snapshot: ledger.snapshot(),
      manifest: { targetArtifactId: 'artifact-1', targetActivationId: 'activation-1' },
      toolName: 'read',
      model: FAKE_MODEL_ID,
      admission: { consumedAt: null, consumedBy: null, targetArtifactId: 'artifact-1', targetActivationId: 'activation-1' },
      expectedPrincipleId: 'principle-1',
    });
    expect(verdict.ok).toBe(false);
    const failed = verdict.failures.map((row) => row.id);
    expect(failed).toContain('http-count');
    expect(failed).toContain('tool-evidence');
    expect(failed).toContain('intervention');
    expect(failed).toContain('identity');
  });

  it('requires the frozen target directive id, not just any directives block', () => {
    const ledger = makeLedger('aa-target-directive');
    ledger.hostTurn('positive');
    ledger.http('positive', { purpose: 'positive-request' });
    ledger.http('positive', { purpose: 'positive-request' });
    const arm = {
      arm: 'positive', exitCode: 0, timedOut: false, spawnError: null, anomalies: [],
      provider: [
        { endpointRequestId: 'http-001', status: 200, finishReason: 'tool_calls', model: FAKE_MODEL_ID, toolDefinitions: ['read'], intervention: { directivesBlockPresent: true, directiveIds: ['other-principle'] } },
        { endpointRequestId: 'http-002', status: 200, finishReason: 'stop', model: FAKE_MODEL_ID, toolDefinitions: ['read'], intervention: { directivesBlockPresent: true, directiveIds: ['other-principle'] } },
      ],
    };
    const snapshot = ledger.snapshot();
    const verdict = evaluatePositiveGate({
      arm,
      snapshot,
      manifest: { targetArtifactId: 'artifact-1', targetActivationId: 'activation-1' },
      toolName: 'read',
      model: FAKE_MODEL_ID,
      admission: { consumedAt: '2026-11-06T00:00:00.000Z', consumedBy: { sessionId: 's-1', hookInvocationId: 'h-1' }, targetArtifactId: 'artifact-1', targetActivationId: 'activation-1' },
      expectedPrincipleId: 'principle-1',
    });
    expect(verdict.failures.map((row) => row.id)).toContain('intervention');
  });

  it('persists failure, ledger and cleanup on an abnormal path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-failure-'));
    const ledger = makeLedger('aa-failure');
    const paths = writeFailureArtifacts({
      runDir: dir,
      phase: 'positive-gate',
      error: new Error('gate failed'),
      snapshot: ledger.snapshot(),
      cleanup: { providers: [], admission: 'absent', status: 'stopped-before-control' },
    });
    expect(existsSync(paths.failurePath)).toBe(true);
    expect(existsSync(paths.ledgerPath)).toBe(true);
    expect(existsSync(paths.cleanupPath)).toBe(true);
    expect(JSON.parse(readFileSync(paths.failurePath, 'utf8')).error.stopBeforeControl).toBe(true);
  });
});

function makeIsolatedHost(root, version = '2026.11.1') {
  const pkg = join(root, 'node_modules', 'openclaw');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'openclaw', version }));
  writeFileSync(join(pkg, 'openclaw.mjs'), '// isolated fake host\n');
  const fsSafe = join(root, 'node_modules', '@openclaw', 'fs-safe');
  mkdirSync(fsSafe, { recursive: true });
  writeFileSync(join(fsSafe, 'package.json'), JSON.stringify({ name: '@openclaw/fs-safe', version: '1.0.0' }));
  return { root, pkg };
}

function makeFrozenExperiment(dir, { toolName = 'read', port = 18082 } = {}) {
  const runDir = join(dir, 'run');
  const workspaceDir = join(runDir, 'positive', 'workspace');
  const controlWorkspaceDir = join(runDir, 'control', 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(controlWorkspaceDir, { recursive: true });
  mkdirSync(join(dir, 'plugin', 'dist'), { recursive: true });
  const pluginRoot = join(dir, 'plugin');
  const bundlePath = join(pluginRoot, 'dist', 'bundle.js');
  writeFileSync(bundlePath, '// bundle\n');
  const fixtureId = 'AA-FIXTURE-test';
  const fixtureFile = join(workspaceDir, 'fixture.txt');
  writeFileSync(fixtureFile, fixtureBytes(fixtureId));
  const inputFile = join(runDir, 'input.txt');
  writeFileSync(inputFile, 'input\n');
  const mapping = {
    artifactId: 'artifact-1',
    activationId: 'activation-1',
    expiresAt: '2026-11-07T00:00:00.000Z',
    softTimeoutMs: 5000,
  };
  const workspaceTarget = seedControlledWorkspace({
    workspaceDir,
    artifactId: mapping.artifactId,
    activationId: mapping.activationId,
    principleId: 'aa-principle-test',
    principleText: '只调用一次只读工具。',
  });
  const configPath = join(runDir, 'config.json');
  writeHostConfig(configPath, buildHostConfig({ endpointPort: port, workspaceDir, pluginRoot, mapping, toolName }));
  const configSha256 = hostConfigSha256(configPath);
  const manifestPath = join(runDir, 'manifest.json');
  const manifest = {
    schemaVersion: 'pd-aa-controlled-admission-manifest/v1',
    targetArtifactId: mapping.artifactId,
    targetActivationId: mapping.activationId,
    fixtureRef: fixtureId,
    fixtureId,
    fixtureFile,
    fixtureSha256: sha256File(fixtureFile),
    inputFile,
    inputSha256: sha256File(inputFile),
    expectedToolName: toolName,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const admissionPath = join(runDir, 'admission.json');
  const admission = {
    manifestSha256: sha256File(manifestPath),
    inputSha256: manifest.inputSha256,
    fixtureRef: fixtureId,
    targetArtifactId: mapping.artifactId,
    targetActivationId: mapping.activationId,
  };
  writeFileSync(admissionPath, JSON.stringify(admission, null, 2));
  const plan = {
    schemaVersion: 'pd-aa-plan/v1',
    runId: 'aa-test',
    fixtureId,
    fixtureRef: fixtureId,
    fixtureFile,
    fixtureSha256: manifest.fixtureSha256,
    configPath,
    configSha256,
    manifestPath,
    admissionPath,
    workspaceDir,
    controlWorkspaceDir,
    workspaceTarget,
    plugin: { rootDir: pluginRoot, bundlePath, bundleSha256: sha256File(bundlePath) },
    endpoint: { host: '127.0.0.1', port },
    stateRoot: join(runDir, 'state'),
    toolName,
    mapping,
  };
  return { runDir, workspaceDir, controlWorkspaceDir, workspaceTarget, pluginRoot, bundlePath, configPath, configSha256, manifestPath, manifest, admissionPath, admission, plan, mapping };
}

describe('launcher boundary — frozen files and isolated host', () => {
  it('seeds one target that the production stores resolve with the same principleId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-seed-'));
    const workspaceDir = join(dir, 'workspace');
    const target = seedControlledWorkspace({
      workspaceDir,
      artifactId: 'artifact-seed',
      activationId: 'activation-seed',
      principleId: 'principle-seed',
      principleText: '只调用一次只读工具。',
    });
    const read = await readControlledWorkspaceTarget({
      workspaceDir,
      artifactId: 'artifact-seed',
      activationId: 'activation-seed',
    });
    expect(read.ok).toBe(true);
    expect(read.principleId).toBe('principle-seed');
    expect(read.promptActivationCount).toBe(1);
    expect(read.stateDbSha256).toBe(target.stateDbSha256);
  });

  it('refuses a changed config, fixture or admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-frozen-'));
    const frozen = makeFrozenExperiment(dir);
    expect(verifyPlanIntegrity({ ...frozen })).toEqual([]);

    writeFileSync(frozen.configPath, `${readFileSync(frozen.configPath, 'utf8')}\n`, 'utf8');
    expect(verifyPlanIntegrity({ ...frozen })).toContain('frozen config sha256 changed');

    // Restore a byte-identical config so the next mutation is isolated.
    const restored = buildHostConfig({
      endpointPort: frozen.plan.endpoint.port,
      workspaceDir: frozen.workspaceDir,
      pluginRoot: frozen.pluginRoot,
      mapping: frozen.mapping,
      toolName: frozen.plan.toolName,
    });
    writeHostConfig(frozen.configPath, restored);
    expect(verifyPlanIntegrity({ ...frozen })).toEqual([]);

    writeFileSync(frozen.plan.fixtureFile, fixtureBytes('AA-FIXTURE-other'));
    expect(verifyPlanIntegrity({ ...frozen })).toContain('fixture file bytes changed');
    writeFileSync(frozen.plan.fixtureFile, fixtureBytes(frozen.plan.fixtureId));
    expect(verifyPlanIntegrity({ ...frozen })).toEqual([]);

    const admission = { ...frozen.admission, manifestSha256: 'deadbeef' };
    writeFileSync(frozen.admissionPath, JSON.stringify(admission, null, 2));
    expect(verifyPlanIntegrity({ ...frozen, admission })).toContain('manifest sha256 changed after admission was written');
  });

  it('refuses a positive workspace whose target state.db changed after freezing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-frozen-ws-'));
    const frozen = makeFrozenExperiment(dir);
    expect(verifyPlanIntegrity({ ...frozen })).toEqual([]);
    const stateDbPath = frozen.plan.workspaceTarget.stateDbPath;
    writeFileSync(stateDbPath, `${readFileSync(stateDbPath)}\n`);
    expect(verifyPlanIntegrity({ ...frozen })).toContain('workspace state.db changed after the plan was frozen');
  });

  it('resolves the isolated host from the prefix and refuses identity drift', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-host-'));
    makeIsolatedHost(dir);
    const first = resolveHostProfile({ hostRoot: dir, expectedVersion: '2026.11.1' });
    const second = resolveHostProfile({ hostRoot: dir });
    expect(first.ok).toBe(true);
    expect(first.healthy).toBe(true);
    expect(verifyHostIdentity(hostIdentity(first), hostIdentity(second))).toEqual([]);

    writeFileSync(first.cliPath, '// tampered host\n');
    const drifted = resolveHostProfile({ hostRoot: dir });
    const violations = verifyHostIdentity(hostIdentity(first), hostIdentity(drifted));
    expect(violations.some((row) => row.includes('cliSha256'))).toBe(true);

    const wrongVersion = resolveHostProfile({ hostRoot: dir, expectedVersion: '2026.9.2' });
    expect(wrongVersion.ok).toBe(false);
  });

  it('refuses to execute when the P0 report is from another host or bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-exec-frozen-'));
    const hostDir = join(dir, 'host');
    makeIsolatedHost(hostDir);
    const profile = resolveHostProfile({ hostRoot: hostDir });
    const frozen = makeFrozenExperiment(join(dir, 'experiment'));
    frozen.plan.host = { ...hostIdentity(profile), hostRoot: profile.hostRoot };
    const p0 = {
      schemaVersion: 'pd-aa-p0-preflight/v1',
      ready: true,
      host: hostIdentity(profile),
      bundle: { bundleSha256: frozen.plan.plugin.bundleSha256 },
      config: { configSha256: frozen.plan.configSha256 },
      endpoint: { port: frozen.plan.endpoint.port },
      stateRoot: frozen.plan.stateRoot,
      fixtureRef: frozen.plan.fixtureId,
      workspace: {
        principleId: frozen.plan.workspaceTarget.principleId,
        stateDbSha256: frozen.plan.workspaceTarget.stateDbSha256,
      },
    };
    const base = {
      plan: frozen.plan,
      p0,
      hostProfile: profile,
      configPath: frozen.configPath,
      manifestPath: frozen.manifestPath,
      bundlePath: frozen.plan.plugin.bundlePath,
    };
    expect(verifyExecutionFrozen(base)).toEqual([]);
    expect(verifyExecutionFrozen({ ...base, p0: { ...p0, bundle: { bundleSha256: 'other' } } }))
      .toContain('P0 plugin bundle differs from the frozen plan');
    expect(verifyExecutionFrozen({ ...base, p0: { ...p0, host: { ...p0.host, identitySha256: 'other' } } }))
      .toContain('P0 host identity differs from the frozen plan');
  });
});
