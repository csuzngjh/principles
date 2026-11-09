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
  reconcileLedgerBudget,
  sha256Hex,
} from '../dev/aa-controlled-admission/lib/ledger.mjs';
import { assertPlanInsideExperimentRoot, buildIsolatedHostEnv, isInsideRoot } from '../dev/aa-controlled-admission/lib/env-isolation.mjs';
import { activationExpiryWindowViolation } from '../dev/aa-controlled-admission/run-experiment.mjs';
import { inspectAdmissionFile } from '../dev/aa-controlled-admission/lib/admission.mjs';
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
  evaluateToolExposure,
  evaluateToolPermission,
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

  it('reconciles caps explicitly: usage survives, the audit is recorded, shrinking below usage is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-budget-reconcile-'));
    const persistPath = join(dir, 'experiment-budget.json');
    const oldBudget = { hostTurns: 3, httpRequests: 3, toolCalls: 1, paidCalls: 0 };
    const persisted = {
      schemaVersion: CUMULATIVE_LEDGER_SCHEMA,
      budget: oldBudget,
      armBudgets: { positive: { hostTurns: 1, httpRequests: 2, toolCalls: 1, paidCalls: 0 }, control: { hostTurns: 1, httpRequests: 1, toolCalls: 0, paidCalls: 0 } },
      used: { hostTurns: 2, httpRequests: 2, toolCalls: 1, paidCalls: 0 },
      records: { hostTurns: [], httpRequests: [], toolCalls: [], paidCalls: [] },
      violations: [],
    };
    writeFileSync(persistPath, JSON.stringify(persisted), 'utf8');

    expect(() => reconcileLedgerBudget({ persistPath, approvedBy: 'Owner', reason: 'caps raised' }))
      .not.toThrow();
    const reconciled = JSON.parse(readFileSync(persistPath, 'utf8'));
    expect(reconciled.budget).toEqual({ hostTurns: 4, httpRequests: 5, toolCalls: 2, paidCalls: 0 });
    expect(reconciled.used).toEqual(persisted.used);
    expect(reconciled.budgetAudit).toHaveLength(1);
    expect(reconciled.budgetAudit[0]).toMatchObject({ approvedBy: 'Owner', reason: 'caps raised', used: persisted.used });

    // The run continues from carried-over usage, not from zero.
    const ledger = createExperimentLedger({ runId: 'aa-after-reconcile', fixtureId: 'F', persistPath });
    expect(ledger.snapshot().used.hostTurns).toBe(2);

    expect(() => reconcileLedgerBudget({
      persistPath,
      budget: { hostTurns: 1, httpRequests: 5, toolCalls: 2, paidCalls: 0 },
      approvedBy: 'Owner',
      reason: 'shrink',
    })).toThrow(/below already-used/);
    expect(() => reconcileLedgerBudget({ persistPath, approvedBy: '', reason: 'x' })).toThrow(/approvedBy/);
    expect(() => reconcileLedgerBudget({ persistPath, approvedBy: 'Owner', reason: '' })).toThrow(/reason/);
  });
});

describe('activation expiry window', () => {
  const now = Date.parse('2026-11-06T11:05:00Z');

  it('accepts a future expiry inside the PD 15-minute admission window', () => {
    expect(activationExpiryWindowViolation(now + 10 * 60 * 1000, now)).toBeNull();
  });

  it('rejects an expiry beyond the PD 15-minute admission window', () => {
    expect(activationExpiryWindowViolation(now + 16 * 60 * 1000, now)).toMatch(/within 15 minutes/);
    expect(activationExpiryWindowViolation(now + 16 * 60 * 1000, now)).toMatch(/PD controlled-admission/);
  });

  it('rejects a past or unparseable expiry', () => {
    expect(activationExpiryWindowViolation(now - 1000, now)).toMatch(/future/);
    expect(activationExpiryWindowViolation(Number.NaN, now)).toMatch(/parseable/);
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
      OPENCLAW_WORKSPACE_DIR: join(outside, 'workspace'),
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
      // The documented host workspace override must also be re-pointed inside
      // the arm root; `plugins inspect` has no `--cwd` to fall back on.
      expect(isolation.env.OPENCLAW_WORKSPACE_DIR).toBe(isolation.env.PD_WORKSPACE_DIR);
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
      expect(isolation.removedFromParent).toEqual(expect.arrayContaining(['PD_WORKSPACE_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_WORKSPACE_DIR', 'OPENCLAW_STATE_DIR']));
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

  it('refuses a plan whose workspace, state or config escapes the run directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-plan-escape-'));
    const frozen = await makeFrozenExperiment(join(dir, 'experiment'));
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

const FIXED_META_TOOLS = ['dispatch_action', 'tool_describe', 'tool_search'];

function fullDefinition(name, index = 0) {
  return {
    index,
    name,
    descriptionSha256: sha256Hex(`description:${name}`),
    description: `description:${name}`,
    parametersSha256: sha256Hex(`parameters:${name}`),
    parameters: { type: 'object', properties: {} },
    definitionSha256: sha256Hex(`definition:${name}`),
  };
}

function toolSurface(toolName = 'read') {
  return [toolName, ...FIXED_META_TOOLS].map((name, index) => fullDefinition(name, index));
}

function makePositiveGateFixture({
  consumed = true,
  principleId = 'principle-1',
  principleText = '只调用一次只读工具。',
  toolName = 'read',
} = {}) {
  const surface = toolSurface(toolName);
  const names = surface.map((definition) => definition.name);
  const observations = [
    {
      endpointRequestId: 'http-001', status: 200, finishReason: 'tool_calls', model: FAKE_MODEL_ID,
      toolDefinitions: names, toolDefinitionsFull: surface, toolCallAttempts: [],
      intervention: { directivesBlockPresent: true, directiveIds: [principleId] },
      principleBody: { present: true, directiveMatches: [], expectedSha256: sha256Hex(principleText) },
    },
    {
      endpointRequestId: 'http-002', status: 200, finishReason: 'stop', model: FAKE_MODEL_ID,
      toolDefinitions: names, toolDefinitionsFull: surface,
      toolCallAttempts: [{ toolCallId: 'call_1', name: toolName, argumentsSha256: 'args' }],
      intervention: { directivesBlockPresent: true, directiveIds: [principleId] },
      principleBody: { present: true, directiveMatches: [], expectedSha256: sha256Hex(principleText) },
      toolResultObserved: true, toolResultContainsFixture: true,
    },
  ];
  const snapshot = {
    withinBudget: true,
    usedByArm: { positive: { hostTurns: 1, httpRequests: 2, toolCalls: 1, paidCalls: 0 } },
    // The ledger is cumulative across runs; a historical row must neither fail
    // nor satisfy this run's invocation verdict.
    toolCalls: [
      { toolCallId: 'call_0', name: toolName, runId: 'aa-run-previous', arm: 'positive' },
      { toolCallId: 'call_1', name: toolName, runId: 'aa-run-test', arm: 'positive' },
    ],
    violations: [],
  };
  const plan = {
    runId: 'aa-run-test',
    host: { identitySha256: 'host-1' },
    toolName,
    fixtureRef: 'AA-FIXTURE-x',
    manifestSha256: 'manifest-sha',
    sessionBinding: 'predeclared',
    expectedSessionId: 'session-1',
    mapping: { artifactId: 'artifact-1', activationId: 'activation-1', expiresAt: '2026-11-06T11:15:00.000Z' },
    workspaceTarget: { principleText, principleTextSha256: sha256Hex(principleText) },
  };
  const p0 = {
    ready: true,
    host: { identitySha256: 'host-1' },
    toolExecutionPolicy: {
      ok: true,
      policyAllow: [toolName],
      oracle: { readAllowed: true, metaToolsDenied: true, allowedMetaTools: [], predicateFileSha256: 'predicate-sha' },
      dispatch: { catalogOnly: true, evidence: [{ id: 'dispatch-resolves-only-catalog', present: true }] },
    },
  };
  const admission = {
    createdAt: '2026-11-06T11:05:00.000Z',
    expiresAt: '2026-11-06T11:15:00.000Z',
    consumedAt: consumed ? '2026-11-06T11:06:00.000Z' : null,
    consumedBy: consumed ? { sessionId: 'session-1', hookInvocationId: 'hook-1' } : null,
    expectedSessionId: 'session-1',
    targetArtifactId: 'artifact-1',
    targetActivationId: 'activation-1',
    // The plugin rewrites the admission into its own fixed field set, which has
    // no fixtureRef; fixture identity is bound through the manifest hash.
    manifestSha256: 'manifest-sha',
  };
  const manifest = { targetArtifactId: 'artifact-1', targetActivationId: 'activation-1', fixtureRef: 'AA-FIXTURE-x' };
  const arm = { arm: 'positive', exitCode: 0, timedOut: false, spawnError: null, anomalies: [], provider: observations };
  return { arm, snapshot, plan, p0, admission, manifest, toolName, principleId };
}

describe('launcher boundary — positive gate stops before control', () => {
  it('passes only when admission is consumed, identity matches and the target body reached the endpoint', () => {
    const fixture = makePositiveGateFixture();
    const verdict = evaluatePositiveGate({ ...fixture, model: FAKE_MODEL_ID, expectedPrincipleId: fixture.principleId });
    expect(verdict.ok).toBe(true);
    expect(verdict.deliveryPath).toBe('controlled');
    expect(verdict.checks.map((row) => row.id)).toEqual(expect.arrayContaining([
      'tool-exposure', 'tool-permission', 'tool-invocation',
      'admission-consumed', 'admission-identity', 'target-body',
    ]));
  });

  it('counterexample: native delivery succeeded but the controlled admission was refused — never a controlled pass', () => {
    const fixture = makePositiveGateFixture({ consumed: false });
    const arm = {
      ...fixture.arm,
      activationLink: { association: 'strong_run' },
      nativeDelivery: { delivered: true, association: 'strong_run' },
    };
    const verdict = evaluatePositiveGate({ ...fixture, arm, model: FAKE_MODEL_ID, expectedPrincipleId: fixture.principleId });
    expect(verdict.ok).toBe(false);
    expect(verdict.deliveryPath).toBe('native_not_controlled');
    expect(verdict.nativeDeliveryObserved).toBe(true);
    expect(verdict.failures.map((row) => row.id)).toContain('admission-consumed');
    expect(verdict.failures.map((row) => row.id)).toContain('admission-identity');
  });

  it('fails the invocation layer when a fixed meta tool was actually called, without exempting it by name', () => {
    const fixture = makePositiveGateFixture();
    const arm = {
      ...fixture.arm,
      provider: [
        fixture.arm.provider[0],
        {
          ...fixture.arm.provider[1],
          toolCallAttempts: [{ toolCallId: 'call_1', name: 'dispatch_action', argumentsSha256: 'args' }],
        },
      ],
    };
    const snapshot = {
      ...fixture.snapshot,
      toolCalls: [{ toolCallId: 'call_1', name: 'dispatch_action' }],
    };
    const verdict = evaluatePositiveGate({ ...fixture, arm, snapshot, model: FAKE_MODEL_ID, expectedPrincipleId: fixture.principleId });
    expect(verdict.ok).toBe(false);
    const invocation = verdict.failures.find((row) => row.id === 'tool-invocation');
    expect(invocation).toBeTruthy();
    expect(invocation.evidence.metaToolAttempts).toHaveLength(1);
    // The exposure layer still accepts the meta tool in the definitions: the
    // failure is about the CALL, not the NAME.
    expect(verdict.failures.map((row) => row.id)).not.toContain('tool-exposure');
  });

  it('fails the exposure and permission layers independently of the invocation layer', () => {
    const fixture = makePositiveGateFixture();
    const exposure = evaluateToolExposure({
      observations: [{
        ...fixture.arm.provider[0],
        toolDefinitionsFull: [
          { name: 'read', definitionSha256: 'def', parametersSha256: 'params' },
          { name: 'exec', definitionSha256: 'def', parametersSha256: 'params' },
        ],
      }],
      toolName: 'read',
    });
    expect(exposure.ok).toBe(false);
    expect(exposure.violations.join(' ')).toContain('unexpected capability: exec');

    // A meta tool that the host policy would allow is a permission failure even
    // though it merely appears in the definitions and was never called.
    const permission = evaluateToolPermission({
      plan: fixture.plan,
      p0: {
        ...fixture.p0,
        toolExecutionPolicy: {
          ...fixture.p0.toolExecutionPolicy,
          oracle: { ...fixture.p0.toolExecutionPolicy.oracle, metaToolsDenied: false },
          dispatch: { ...fixture.p0.toolExecutionPolicy.dispatch, catalogOnly: false },
        },
      },
      toolName: 'read',
    });
    expect(permission.ok).toBe(false);
    expect(permission.violations).toContain('the host policy allows one or more fixed meta tools');
    expect(permission.violations).toContain('the dispatch chain did not prove catalog-only resolution');
  });

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
    const fixture = makePositiveGateFixture();
    const arm = {
      ...fixture.arm,
      provider: [{
        ...fixture.arm.provider[0],
        intervention: { directivesBlockPresent: false, directiveIds: [] },
        principleBody: { present: false, directiveMatches: [] },
      }],
    };
    const verdict = evaluatePositiveGate({ ...fixture, arm, model: FAKE_MODEL_ID, expectedPrincipleId: fixture.principleId });
    expect(verdict.ok).toBe(false);
    const failed = verdict.failures.map((row) => row.id);
    expect(failed).toContain('http-count');
    expect(failed).toContain('tool-invocation');
    expect(failed).toContain('intervention');
    expect(failed).toContain('target-body');
  });

  it('requires the frozen target directive id, not just any directives block', () => {
    const fixture = makePositiveGateFixture({ principleId: 'other-principle' });
    const verdict = evaluatePositiveGate({ ...fixture, model: FAKE_MODEL_ID, expectedPrincipleId: 'principle-1' });
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

describe('admission file — the real file, not the argv', () => {
  function writeAdmission(dir, overrides = {}) {
    // Bind the claimed createdAt to the real file clock: the inspected file is
    // written now, and the check refuses a createdAt that disagrees with the
    // filesystem birthtime by more than two minutes.
    const base = overrides.now ?? Date.now() - 60_000;
    const createdAt = overrides.createdAt ?? new Date(base).toISOString();
    const expiresAt = overrides.expiresAt ?? new Date(base + 10 * 60 * 1000).toISOString();
    const admissionPath = join(dir, 'admission.json');
    const document = {
      schemaVersion: 'pd-aa-controlled-admission/v2',
      admissionId: 'adm-test',
      experimentRoot: dir,
      inputPath: join(dir, 'input.txt'),
      inputSha256: 'i',
      manifestPath: join(dir, 'manifest.json'),
      manifestSha256: 'm',
      targetArtifactId: 'artifact-1',
      targetActivationId: 'activation-1',
      fixtureRef: 'AA-FIXTURE-x',
      sessionBinding: 'predeclared',
      expectedSessionId: 'session-1',
      createdAt,
      expiresAt,
      consumedAt: null,
      consumedBy: null,
      ...overrides.document,
    };
    writeFileSync(admissionPath, JSON.stringify(document, null, 2), 'utf8');
    return { admissionPath, document };
  }

  const now = Date.now();

  it('accepts an unconsumed, unexpired, 10-minute admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-adm-'));
    const { admissionPath } = writeAdmission(dir);
    const result = inspectAdmissionFile({ admissionPath, now });
    expect(result.ok).toBe(true);
    expect(result.facts.lifetimeMs).toBe(10 * 60 * 1000);
  });

  it('rejects the exact 13:00Z failure: a 115-minute admission lifetime (PD rule)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-adm-'));
    const { admissionPath } = writeAdmission(dir, {
      createdAt: '2026-11-06T11:05:00.000Z',
      expiresAt: '2026-11-06T13:00:00.000Z',
    });
    const result = inspectAdmissionFile({ admissionPath, now });
    expect(result.ok).toBe(false);
    expect(result.violations.some((row) => row.includes('15-minute'))).toBe(true);
  });

  it('rejects an already-consumed admission and an expired admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-adm-'));
    const consumed = writeAdmission(dir, { document: { consumedAt: '2026-11-06T11:06:00.000Z', consumedBy: { sessionId: 's', hookInvocationId: 'h' } } });
    expect(inspectAdmissionFile({ admissionPath: consumed.admissionPath, now }).ok).toBe(false);

    const expired = writeAdmission(dir, { createdAt: '2026-11-06T10:50:00.000Z', expiresAt: '2026-11-06T11:00:00.000Z' });
    const result = inspectAdmissionFile({ admissionPath: expired.admissionPath, now });
    expect(result.ok).toBe(false);
    expect(result.violations.some((row) => row.includes('expired'))).toBe(true);
  });

  it('rejects bytes that differ from the frozen hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-adm-'));
    const { admissionPath } = writeAdmission(dir);
    const result = inspectAdmissionFile({ admissionPath, now, expectedSha256: 'not-the-file' });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('admission file sha256 differs from the frozen plan');
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

async function makeFrozenExperiment(dir, { toolName = 'read', port = 18082 } = {}) {
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
  const workspaceTarget = await seedControlledWorkspace({
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
    const target = await seedControlledWorkspace({
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

  it('refuses a changed config, fixture or admission', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-frozen-'));
    const frozen = await makeFrozenExperiment(dir);
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

  it('refuses a positive workspace whose target state.db changed after freezing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-frozen-ws-'));
    const frozen = await makeFrozenExperiment(dir);
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

  it('refuses to execute when the P0 report is from another host or bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aa-exec-frozen-'));
    const hostDir = join(dir, 'host');
    makeIsolatedHost(hostDir);
    const profile = resolveHostProfile({ hostRoot: hostDir });
    const frozen = await makeFrozenExperiment(join(dir, 'experiment'));
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
      admissionFile: { ok: true },
      toolExecutionPolicy: {
        ok: true,
        policyAllow: [frozen.plan.toolName],
        readAllowed: true,
        metaToolsDenied: true,
        dispatch: { catalogOnly: true },
      },
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
