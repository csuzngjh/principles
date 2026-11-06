// PRI-1118 controlled-admission experiment — acceptance gates.
//
// The positive arm's evidence is checked item by item BEFORE the control arm is
// allowed to start. Any single failure stops the experiment: no control turn,
// no retry, no continuation. Abnormal paths must still persist the ledger, the
// failure record and the cleanup result, so a stopped run stays diagnosable.
//
// Every verdict here is derived from structured fields (ledger records,
// endpoint observations and the consumed admission document). None of them is
// inferred from stdout text.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File, sha256Bytes, verifyHostIdentity } from './host-profile.mjs';
import { fixtureBytes } from './ledger.mjs';
import { hostConfigSha256, validateHostConfigWiring, readHostConfig } from './host-config.mjs';

function check(id, ok, detail, evidence = {}) {
  return { id, status: ok ? 'PASS' : 'FAIL', detail, evidence };
}

function summarize(checks) {
  const failures = checks.filter((row) => row.status !== 'PASS');
  return { ok: failures.length === 0, checks, failures };
}

/** Positive arm: process, HTTP, tool, intervention, identity, budget, surface. */
export function evaluatePositiveGate({ arm, snapshot, manifest, toolName, model, admission, expectedPrincipleId = null }) {
  const observations = Array.isArray(arm?.provider) ? arm.provider : [];
  const checks = [];

  checks.push(check('process', arm?.exitCode === 0 && arm?.timedOut === false && arm?.spawnError === null,
    'host exited 0, stayed inside its deadline and spawned successfully', {
      exitCode: arm?.exitCode, timedOut: arm?.timedOut, spawnError: arm?.spawnError, signal: arm?.signal,
    }));

  checks.push(check('http-count', observations.length === 2, 'positive arm made exactly two HTTP requests', {
    observed: observations.length,
    requestIds: observations.map((row) => row.endpointRequestId ?? null),
  }));

  checks.push(check('provider-anomalies', Array.isArray(arm?.anomalies) && arm.anomalies.length === 0,
    'the endpoint saw no off-protocol or unfunded request', { anomalies: arm?.anomalies ?? null }));

  const first = observations[0] ?? null;
  const second = observations[1] ?? null;
  checks.push(check('http-response',
    first?.status === 200 && second?.status === 200
    && first?.finishReason === 'tool_calls' && second?.finishReason === 'stop',
    'request 1 returns a tool call, request 2 returns the final answer', {
      firstStatus: first?.status, firstFinish: first?.finishReason,
      secondStatus: second?.status, secondFinish: second?.finishReason,
    }));

  const toolCalls = Array.isArray(snapshot?.toolCalls) ? snapshot.toolCalls : [];
  checks.push(check('tool-evidence',
    toolCalls.length === 1
    && toolCalls[0]?.name === toolName
    && typeof toolCalls[0]?.toolCallId === 'string'
    && second?.toolResultObserved === true
    && second?.toolResultContainsFixture === true,
    'exactly one tool call of the allowlisted name returned the fixture bytes', {
      toolCalls, toolName,
      secondToolResultObserved: second?.toolResultObserved ?? null,
      secondToolResultContainsFixture: second?.toolResultContainsFixture ?? null,
    }));

  const targetDirectivePresent = typeof expectedPrincipleId === 'string'
    && expectedPrincipleId.length > 0
    && Array.isArray(first?.intervention?.directiveIds)
    && first.intervention.directiveIds.includes(expectedPrincipleId);
  checks.push(check('intervention',
    first?.intervention?.directivesBlockPresent === true
    && targetDirectivePresent,
    'the model-visible system prompt carried the frozen target directive id', {
      firstIntervention: first?.intervention ?? null,
      secondIntervention: second?.intervention ?? null,
      expectedPrincipleId,
      targetDirectivePresent,
    }));

  checks.push(check('identity',
    typeof admission?.consumedAt === 'string' && admission.consumedAt.length > 0
    && typeof admission?.consumedBy?.sessionId === 'string' && admission.consumedBy.sessionId.length > 0
    && typeof admission?.consumedBy?.hookInvocationId === 'string' && admission.consumedBy.hookInvocationId.length > 0
    && admission?.targetArtifactId === manifest?.targetArtifactId
    && admission?.targetActivationId === manifest?.targetActivationId,
    'the single admission was consumed once for the frozen target', {
      consumedAt: admission?.consumedAt ?? null,
      consumedBy: admission?.consumedBy ?? null,
      targetArtifactId: admission?.targetArtifactId ?? null,
      targetActivationId: admission?.targetActivationId ?? null,
    }));

  checks.push(check('budget',
    snapshot?.withinBudget === true
    && snapshot?.usedByArm?.positive?.hostTurns === 1
    && snapshot?.usedByArm?.positive?.httpRequests === 2
    && snapshot?.usedByArm?.positive?.toolCalls === 1
    && snapshot?.usedByArm?.positive?.paidCalls === 0,
    'positive arm stayed inside its own allocation', { usedByArm: snapshot?.usedByArm ?? null, violations: snapshot?.violations ?? [] }));

  const surfaces = observations.map((row) => Array.isArray(row.toolDefinitions) ? row.toolDefinitions : []);
  const surfaceOk = surfaces.length > 0
    && surfaces.every((names) => names.length > 0 && names.every((name) => name === toolName))
    && surfaces[0].includes(toolName);
  checks.push(check('tool-surface', surfaceOk, 'the endpoint only received the single allowlisted tool', { surfaces, toolName }));

  checks.push(check('model', observations.every((row) => row.model === model),
    'every request used the frozen fake model', { observed: observations.map((row) => row.model), model }));

  const verdict = summarize(checks);
  return { ...verdict, arm: 'positive', stopBeforeControl: !verdict.ok ? verdict.failures.map((row) => row.id) : [] };
}

/** Control arm: same endpoint, no admission, no tool call, no directives. */
export function evaluateControlGate({ arm, snapshot, toolName, model }) {
  const observations = Array.isArray(arm?.provider) ? arm.provider : [];
  const checks = [];

  checks.push(check('process', arm?.exitCode === 0 && arm?.timedOut === false && arm?.spawnError === null,
    'host exited 0, stayed inside its deadline and spawned successfully', {
      exitCode: arm?.exitCode, timedOut: arm?.timedOut, spawnError: arm?.spawnError, signal: arm?.signal,
    }));

  checks.push(check('http-count', observations.length === 1, 'control arm made exactly one HTTP request', {
    observed: observations.length,
    requestIds: observations.map((row) => row.endpointRequestId ?? null),
  }));

  checks.push(check('provider-anomalies', Array.isArray(arm?.anomalies) && arm.anomalies.length === 0,
    'the endpoint saw no off-protocol or unfunded request', { anomalies: arm?.anomalies ?? null }));
  checks.push(check('http-response', observations[0]?.status === 200 && observations[0]?.finishReason === 'stop',
    'the single control request returned the final answer', { status: observations[0]?.status, finish: observations[0]?.finishReason }));

  checks.push(check('no-tool', (snapshot?.toolCalls?.length ?? 0) === 0 && observations[0]?.toolResultObserved !== true,
    'control arm called no tool', { toolCalls: snapshot?.toolCalls ?? [] }));

  checks.push(check('no-intervention',
    observations[0]?.intervention?.directivesBlockPresent === false
    && Array.isArray(observations[0]?.intervention?.directiveIds) && observations[0].intervention.directiveIds.length === 0,
    'control arm received no PD behavior directives', { intervention: observations[0]?.intervention ?? null }));

  checks.push(check('budget',
    snapshot?.withinBudget === true
    && snapshot?.usedByArm?.control?.hostTurns === 1
    && snapshot?.usedByArm?.control?.httpRequests === 1
    && snapshot?.usedByArm?.control?.toolCalls === 0
    && snapshot?.usedByArm?.control?.paidCalls === 0,
    'control arm stayed inside its own allocation', { usedByArm: snapshot?.usedByArm ?? null, violations: snapshot?.violations ?? [] }));

  const surfaces = observations.map((row) => Array.isArray(row.toolDefinitions) ? row.toolDefinitions : []);
  checks.push(check('tool-surface', surfaces.every((names) => names.every((name) => name === toolName)),
    'control endpoint also saw only the allowlisted tool surface', { surfaces, toolName }));

  checks.push(check('model', observations.every((row) => row.model === model),
    'the control request used the frozen fake model', { observed: observations.map((row) => row.model), model }));

  const verdict = summarize(checks);
  return { ...verdict, arm: 'control' };
}

/**
 * Frozen-plan integrity: a changed config, fixture, input, manifest or
 * admission is a refusal. Returns a violation list (empty means intact).
 */
export function verifyPlanIntegrity({ plan, manifestPath, manifest, admissionPath, admission, configPath }) {
  const violations = [];
  if (!plan || !manifest || !admission) return ['plan, manifest and admission are required'];

  if (!existsSync(configPath)) violations.push('frozen config file is missing');
  else if (plan.configSha256 !== hostConfigSha256(configPath)) violations.push('frozen config sha256 changed');

  if (!existsSync(manifestPath)) violations.push('frozen manifest file is missing');
  else {
    const manifestSha256 = sha256File(manifestPath);
    if (admission.manifestSha256 !== manifestSha256) violations.push('manifest sha256 changed after admission was written');
  }

  if (plan.fixtureId !== manifest.fixtureId || plan.fixtureId !== manifest.fixtureRef) violations.push('fixture id is not consistent across plan and manifest');
  const expectedFixture = fixtureBytes(plan.fixtureId);
  if (manifest.fixtureSha256 !== sha256Bytes(expectedFixture)) violations.push('fixture sha256 does not match the fixture id bytes');
  if (!existsSync(manifest.fixtureFile)) violations.push('fixture file is missing');
  else if (sha256File(manifest.fixtureFile) !== manifest.fixtureSha256) violations.push('fixture file bytes changed');

  if (!existsSync(manifest.inputFile)) violations.push('input file is missing');
  else if (sha256File(manifest.inputFile) !== manifest.inputSha256) violations.push('input file bytes changed');
  if (admission.inputSha256 !== manifest.inputSha256) violations.push('admission input sha256 differs from the manifest');

  if (!existsSync(admissionPath)) violations.push('admission file is missing');
  if (admission.fixtureRef !== manifest.fixtureRef) violations.push('admission fixtureRef differs from the manifest');

  const workspaceTarget = plan.workspaceTarget;
  if (!workspaceTarget || typeof workspaceTarget !== 'object') {
    violations.push('plan has no frozen workspace target');
  } else {
    if (workspaceTarget.artifactId !== plan.mapping?.artifactId || workspaceTarget.activationId !== plan.mapping?.activationId) {
      violations.push('frozen workspace target differs from the mapping');
    }
    if (!existsSync(workspaceTarget.stateDbPath)) violations.push('workspace state.db is missing');
    else if (sha256File(workspaceTarget.stateDbPath) !== workspaceTarget.stateDbSha256) violations.push('workspace state.db changed after the plan was frozen');
  }
  return violations;
}

/**
 * P0/runtime agreement: same host executable, same config, same state root,
 * same plugin artifact. Any drift is a refusal.
 */
export function verifyExecutionFrozen({ plan, p0, hostProfile, configPath, manifestPath, bundlePath }) {
  const violations = [];
  if (p0?.schemaVersion !== 'pd-aa-p0-preflight/v1' || p0?.ready !== true) {
    violations.push('P0 report is not ready');
    return violations;
  }
  violations.push(...verifyHostIdentity(plan?.host, {
    nodePath: hostProfile?.nodePath,
    cliPath: hostProfile?.cliPath,
    cliSha256: hostProfile?.cliSha256,
    version: hostProfile?.version,
    identitySha256: hostProfile?.identitySha256,
  }));
  if (p0?.host?.identitySha256 !== plan?.host?.identitySha256) violations.push('P0 host identity differs from the frozen plan');

  if (p0?.bundle?.bundleSha256 !== plan?.plugin?.bundleSha256) violations.push('P0 plugin bundle differs from the frozen plan');
  if (existsSync(bundlePath) && sha256File(bundlePath) !== plan?.plugin?.bundleSha256) violations.push('plugin bundle changed after the plan was frozen');
  if (!existsSync(bundlePath)) violations.push('plugin bundle is missing');

  if (p0?.config?.configSha256 !== plan?.configSha256) violations.push('P0 config sha256 differs from the frozen plan');
  if (plan?.configSha256 !== hostConfigSha256(configPath)) violations.push('config changed after the plan was frozen');

  if (p0?.endpoint?.port !== plan?.endpoint?.port) violations.push('P0 endpoint port differs from the frozen plan');
  if (p0?.stateRoot !== plan?.stateRoot) violations.push('P0 state root differs from the frozen plan');
  if (p0?.fixtureRef !== plan?.fixtureId) violations.push('P0 fixture ref differs from the frozen plan');
  if (p0?.workspace?.principleId !== plan?.workspaceTarget?.principleId) violations.push('P0 workspace target differs from the frozen plan');
  if (p0?.workspace?.stateDbSha256 !== plan?.workspaceTarget?.stateDbSha256) violations.push('P0 workspace state.db differs from the frozen plan');

  const config = existsSync(configPath) ? readHostConfig(configPath) : null;
  if (config) {
    const wiring = validateHostConfigWiring(config, {
      pluginRoot: plan.plugin.rootDir,
      workspaceDir: plan.workspaceDir,
      mapping: plan.mapping,
      toolName: plan.toolName,
      endpointPort: plan.endpoint.port,
    });
    if (wiring.length > 0) violations.push(...wiring.map((row) => `config wiring: ${row}`));
  }
  if (existsSync(manifestPath) || configPath) { /* paths are part of the evidence, not a check */ }
  return violations;
}

/**
 * Positive-then-control orchestration. The control runner is only invoked when
 * the positive gate passes, which is what makes "stop before control" structural
 * rather than a convention.
 */
export async function runPositiveThenControl({ runPositive, runControl, evaluatePositive, evaluateControl }) {
  const positive = await runPositive();
  const positiveGate = evaluatePositive(positive);
  if (!positiveGate.ok) {
    return { stoppedAt: 'positive', positive, positiveGate, control: null, controlGate: null };
  }
  const control = await runControl();
  const controlGate = evaluateControl(control);
  return { stoppedAt: controlGate.ok ? null : 'control', positive, positiveGate, control, controlGate };
}

/**
 * Durable failure record for every abnormal path: failure + ledger + cleanup.
 * The ledger snapshot is passed through the shared ledger so the counts of a
 * stopped run are never reconstructed after the fact.
 */
export function writeFailureArtifacts({ runDir, phase, error, snapshot, cleanup }) {
  const at = new Date().toISOString();
  const failurePath = join(runDir, 'failure.json');
  const ledgerPath = join(runDir, 'ledger.json');
  const cleanupPath = join(runDir, 'cleanup.json');
  const failure = {
    schemaVersion: 'pd-aa-failure/v1',
    phase,
    at,
    error: {
      name: typeof error?.name === 'string' ? error.name : 'Error',
      message: String(error?.message ?? error),
      code: typeof error?.code === 'string' ? error.code : null,
      stopBeforeControl: phase === 'positive' || phase === 'positive-gate',
    },
    nextAction: 'Inspect failure.json, ledger.json and cleanup.json; do not retry without a new plan.',
    snapshot: snapshot ?? null,
  };
  writeFileSync(failurePath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  if (snapshot) writeFileSync(ledgerPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  writeFileSync(cleanupPath, `${JSON.stringify(cleanup ?? { status: 'unknown' }, null, 2)}\n`, 'utf8');
  return { failurePath, ledgerPath, cleanupPath };
}

export function evidenceSha256(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
