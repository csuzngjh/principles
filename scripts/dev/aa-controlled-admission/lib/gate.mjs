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
import { existsSync, writeFileSync } from 'node:fs';
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

/** Fixed meta tools the host injects regardless of `tools.allow`. */
export const FIXED_META_TOOLS = Object.freeze(['dispatch_action', 'tool_describe', 'tool_search']);

function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
}

function normalizedSha256(value) {
  const normalized = normalizeText(value);
  return normalized === null || normalized.length === 0 ? null : createHash('sha256').update(normalized).digest('hex');
}

/**
 * Layer 1 — exposure audit.
 *
 * Meta tools are allowed to APPEAR (the host injects tool-search controls),
 * but every definition is recorded in full and every name is audited. A
 * definition whose name is not the allowlisted tool and not a fixed meta tool
 * fails, so no capability can hide behind a familiar name.
 */
export function evaluateToolExposure({ observations, toolName }) {
  const allowedSet = [toolName, ...FIXED_META_TOOLS];
  const surfaces = observations.map((row) => (
    Array.isArray(row?.toolDefinitionsFull) && row.toolDefinitionsFull.length > 0
      ? row.toolDefinitionsFull
      : (Array.isArray(row?.toolDefinitions) ? row.toolDefinitions.map((name) => ({ name })) : [])
  ));
  const namesByRequest = surfaces.map((definitions) => definitions.map((definition) => definition?.name ?? null));
  const violations = [];
  if (surfaces.length === 0) violations.push('no endpoint observation');
  for (const [index, definitions] of surfaces.entries()) {
    if (definitions.length === 0) violations.push(`request ${index + 1} carried no tool definitions`);
    if (!namesByRequest[index].includes(toolName)) violations.push(`request ${index + 1} did not expose the allowlisted tool ${toolName}`);
    for (const definition of definitions) {
      if (definition?.name === null || typeof definition?.name !== 'string') {
        violations.push(`request ${index + 1} has a definition without a name`);
        continue;
      }
      if (!allowedSet.includes(definition.name)) violations.push(`request ${index + 1} exposed an unexpected capability: ${definition.name}`);
      if (typeof definition.definitionSha256 !== 'string' || definition.definitionSha256.length === 0) {
        violations.push(`request ${index + 1} did not record the complete definition hash for ${definition.name}`);
      }
      if (typeof definition.parametersSha256 !== 'string' || definition.parametersSha256.length === 0) {
        violations.push(`request ${index + 1} did not record the parameter schema for ${definition.name}`);
      }
    }
  }
  const capabilityTools = [...new Set(namesByRequest.flat().filter((name) => name !== null && !FIXED_META_TOOLS.includes(name)))].sort();
  if (capabilityTools.length !== 1 || capabilityTools[0] !== toolName) {
    violations.push(`capability tools in the surface were ${JSON.stringify(capabilityTools)}, expected only ${toolName}`);
  }
  const metaToolsObserved = [...new Set(namesByRequest.flat().filter((name) => FIXED_META_TOOLS.includes(name)))].sort();
  return {
    ok: violations.length === 0,
    violations,
    evidence: {
      allowedSet,
      fixedMetaTools: [...FIXED_META_TOOLS],
      metaToolsObserved,
      capabilityTools,
      surfaces: namesByRequest,
      definitions: surfaces,
    },
  };
}

/**
 * Layer 2 — effective permission.
 *
 * Presence in the definitions is not permission. This consumes the P0 audit
 * that (a) executed the host's own policy predicate under `tools.allow` and
 * (b) recorded the dispatch chain showing `dispatch_action` resolves ids only
 * against a catalog built from the effective tool surface.
 */
export function evaluateToolPermission({ p0, plan, toolName }) {
  const policy = p0?.toolExecutionPolicy ?? null;
  const oracle = policy?.oracle ?? null;
  const dispatch = policy?.dispatch ?? null;
  const violations = [];
  if (p0?.ready !== true) violations.push('P0 report is not ready');
  if (p0?.host?.identitySha256 !== plan?.host?.identitySha256) violations.push('P0 host identity differs from the frozen plan');
  if (!Array.isArray(policy?.policyAllow) || policy.policyAllow.length !== 1 || policy.policyAllow[0] !== toolName) {
    violations.push(`policy allowlist ${JSON.stringify(policy?.policyAllow ?? null)} is not [${toolName}]`);
  }
  if (oracle?.readAllowed !== true) violations.push('the host policy does not allow the allowlisted tool');
  if (oracle?.metaToolsDenied !== true) violations.push('the host policy allows one or more fixed meta tools');
  if (dispatch?.catalogOnly !== true) violations.push('the dispatch chain did not prove catalog-only resolution');
  if (typeof oracle?.predicateFileSha256 !== 'string' || oracle.predicateFileSha256.length === 0) {
    violations.push('the policy predicate was not hash-bound to the host bundle');
  }
  const evidence = Array.isArray(dispatch?.evidence) ? dispatch.evidence : [];
  if (evidence.length === 0 || evidence.some((item) => item?.present !== true)) {
    violations.push('one or more dispatch-chain facts are missing');
  }
  return {
    ok: violations.length === 0,
    violations,
    evidence: {
      policyAllow: policy?.policyAllow ?? null,
      readAllowed: oracle?.readAllowed ?? null,
      metaToolsDenied: oracle?.metaToolsDenied ?? null,
      allowedMetaTools: oracle?.allowedMetaTools ?? null,
      predicateFileSha256: oracle?.predicateFileSha256 ?? null,
      catalogOnly: dispatch?.catalogOnly ?? null,
      dispatchEvidenceIds: evidence.map((item) => item?.id ?? null),
      p0HostIdentitySha256: p0?.host?.identitySha256 ?? null,
      planHostIdentitySha256: plan?.host?.identitySha256 ?? null,
    },
  };
}

/**
 * Layer 3 — actual invocation.
 *
 * The only invocation anywhere in the conversation must be one call to the
 * allowlisted tool. A meta-tool call is an invocation too and fails here; it is
 * never exempted by name.
 */
export function evaluateToolInvocation({ observations, snapshot, toolName, second }) {
  const attempts = observations.flatMap((row) => (Array.isArray(row?.toolCallAttempts) ? row.toolCallAttempts : []));
  const toolCalls = Array.isArray(snapshot?.toolCalls) ? snapshot.toolCalls : [];
  const violations = [];
  if (toolCalls.length !== 1) violations.push(`ledger recorded ${toolCalls.length} tool calls, expected 1`);
  if (toolCalls[0]?.name !== toolName) violations.push(`ledger tool name ${JSON.stringify(toolCalls[0]?.name ?? null)} is not ${toolName}`);
  if (typeof toolCalls[0]?.toolCallId !== 'string') violations.push('ledger tool call has no id');
  if (attempts.length !== 1) violations.push(`endpoint saw ${attempts.length} assistant tool-call attempts, expected 1`);
  if (attempts[0]?.name !== toolName) violations.push(`endpoint tool-call name ${JSON.stringify(attempts[0]?.name ?? null)} is not ${toolName}`);
  if (attempts[0]?.toolCallId !== toolCalls[0]?.toolCallId) violations.push('endpoint and ledger tool-call ids differ');
  if (second?.toolResultObserved !== true) violations.push('the tool result was not echoed back to the endpoint');
  if (second?.toolResultContainsFixture !== true) violations.push('the tool result did not contain the fixture bytes');
  return {
    ok: violations.length === 0,
    violations,
    evidence: { toolCalls, attempts, toolName, metaToolAttempts: attempts.filter((attempt) => FIXED_META_TOOLS.includes(attempt?.name)) },
  };
}

/** Positive arm: process, HTTP, three tool layers, intervention, admission, route. */
export function evaluatePositiveGate({
  arm, snapshot, manifest, plan = null, p0 = null, toolName, model, admission, expectedPrincipleId = null,
}) {
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

  const exposure = evaluateToolExposure({ observations, toolName });
  checks.push(check('tool-exposure', exposure.ok,
    'every request exposed the complete tool definitions; only the allowlisted capability plus the fixed meta tools appeared',
    exposure.evidence));

  const permission = evaluateToolPermission({ p0, plan, toolName });
  checks.push(check('tool-permission', permission.ok,
    'the frozen host policy denies the fixed meta tools under the allowlist and dispatch_action resolves ids only from the effective surface catalog',
    permission.evidence));

  const invocation = evaluateToolInvocation({ observations, snapshot, toolName, second });
  checks.push(check('tool-invocation', invocation.ok,
    'the only tool invocation in the whole conversation was one call to the allowlisted tool', invocation.evidence));

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

  // The TARGET BODY itself must reach the endpoint. A directive id alone is not
  // enough: the native delivery path can carry the id while the controlled
  // admission was never consumed.
  const expectedBodySha256 = normalizedSha256(plan?.workspaceTarget?.principleText);
  const bodyMatches = observations.map((row) => {
    const match = Array.isArray(row?.principleBody?.directiveMatches)
      ? row.principleBody.directiveMatches.find((entry) => entry?.id === expectedPrincipleId)
      : null;
    return {
      present: row?.principleBody?.present === true,
      normalizedMatch: match ? match.normalizedSha256 === expectedBodySha256 : false,
    };
  });
  const targetBodyOk = observations.length > 0
    && bodyMatches.every((row) => row.present === true || row.normalizedMatch === true);
  checks.push(check('target-body', targetBodyOk,
    'the frozen target principle body (not only its id) reached every endpoint request', {
      expectedBodySha256,
      bodyMatches,
      principleBudgets: observations.map((row) => row?.principleBody ?? null),
    }));

  const consumedAtMs = typeof admission?.consumedAt === 'string' ? Date.parse(admission.consumedAt) : NaN;
  const createdAtMs = typeof admission?.createdAt === 'string' ? Date.parse(admission.createdAt) : NaN;
  const expiresAtMs = typeof admission?.expiresAt === 'string' ? Date.parse(admission.expiresAt) : NaN;
  const consumedOk = typeof admission?.consumedAt === 'string' && admission.consumedAt.length > 0
    && Number.isFinite(consumedAtMs)
    && typeof admission?.consumedBy?.sessionId === 'string' && admission.consumedBy.sessionId.length > 0
    && typeof admission?.consumedBy?.hookInvocationId === 'string' && admission.consumedBy.hookInvocationId.length > 0;
  checks.push(check('admission-consumed', consumedOk,
    'the plugin actually consumed the controlled admission (consumedAt/consumedBy written into the file)', {
      consumedAt: admission?.consumedAt ?? null,
      consumedBy: admission?.consumedBy ?? null,
    }));

  const expectedSessionId = plan?.sessionBinding === 'predeclared' ? plan.expectedSessionId : null;
  const sessionMatched = plan?.sessionBinding === 'predeclared'
    ? admission?.consumedBy?.sessionId === expectedSessionId
    : typeof admission?.consumedBy?.sessionId === 'string' && admission.consumedBy.sessionId.length > 0;
  const identityOk = sessionMatched
    && admission?.expectedSessionId === expectedSessionId
    && admission?.targetArtifactId === plan?.mapping?.artifactId
    && admission?.targetActivationId === plan?.mapping?.activationId
    && admission?.fixtureRef === plan?.fixtureRef
    && (manifest ? admission?.targetArtifactId === manifest?.targetArtifactId : true)
    && (manifest ? admission?.targetActivationId === manifest?.targetActivationId : true)
    && (Number.isFinite(consumedAtMs) && Number.isFinite(createdAtMs) ? consumedAtMs >= createdAtMs : true)
    && (Number.isFinite(consumedAtMs) && Number.isFinite(expiresAtMs) ? consumedAtMs <= expiresAtMs : true);
  checks.push(check('admission-identity', identityOk,
    'the consumed admission matches the frozen target, fixture and session binding inside its window', {
      sessionBinding: plan?.sessionBinding ?? null,
      expectedSessionId,
      consumedBy: admission?.consumedBy ?? null,
      targetArtifactId: admission?.targetArtifactId ?? null,
      targetActivationId: admission?.targetActivationId ?? null,
      fixtureRef: admission?.fixtureRef ?? null,
    }));

  checks.push(check('budget',
    snapshot?.withinBudget === true
    && snapshot?.usedByArm?.positive?.hostTurns === 1
    && snapshot?.usedByArm?.positive?.httpRequests === 2
    && snapshot?.usedByArm?.positive?.toolCalls === 1
    && snapshot?.usedByArm?.positive?.paidCalls === 0,
    'positive arm stayed inside its own allocation', { usedByArm: snapshot?.usedByArm ?? null, violations: snapshot?.violations ?? [] }));

  checks.push(check('model', observations.every((row) => row.model === model),
    'every request used the frozen fake model', { observed: observations.map((row) => row.model), model }));

  // Route verdict: a native activation-link delivery that reached the endpoint
  // while the controlled admission stayed unconsumed is a DIFFERENT path. It
  // must never be reported as a successful controlled wiring.
  const nativeDelivered = arm?.activationLink?.association === 'strong_run'
    || arm?.nativeDelivery?.delivered === true
    || arm?.nativeDelivery?.association === 'strong_run';
  const deliveryPath = consumedOk ? 'controlled' : (nativeDelivered ? 'native_not_controlled' : 'unknown');

  const verdict = summarize(checks);
  return {
    ...verdict,
    arm: 'positive',
    deliveryPath,
    nativeDeliveryObserved: nativeDelivered,
    stopBeforeControl: !verdict.ok ? verdict.failures.map((row) => row.id) : [],
  };
}

/** Control arm: same endpoint, no admission, no tool call, no directives. */
export function evaluateControlGate({ arm, snapshot, plan = null, p0 = null, toolName, model }) {
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

  const exposure = evaluateToolExposure({ observations, toolName });
  checks.push(check('tool-exposure', exposure.ok,
    'the control endpoint exposed the same complete definitions (allowlisted capability plus fixed meta tools)',
    exposure.evidence));
  const permission = evaluateToolPermission({ p0, plan, toolName });
  checks.push(check('tool-permission', permission.ok,
    'the frozen host policy denies the fixed meta tools under the allowlist and dispatch_action resolves ids only from the effective surface catalog',
    permission.evidence));

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
  else if (typeof plan.admissionSha256 === 'string' && plan.admissionSha256.length > 0
    && sha256File(admissionPath) !== plan.admissionSha256) {
    violations.push('admission file bytes changed after the plan was frozen');
  }
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
  if (p0?.admissionFile?.ok !== true) violations.push('P0 admission-file check did not pass');
  if (p0?.toolExecutionPolicy?.ok !== true) violations.push('P0 tool-policy audit did not pass');
  if (Array.isArray(p0?.toolExecutionPolicy?.policyAllow)
    && (p0.toolExecutionPolicy.policyAllow.length !== 1 || p0.toolExecutionPolicy.policyAllow[0] !== plan?.toolName)) {
    violations.push('P0 tool-policy allowlist differs from the frozen plan');
  }
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
    return {
      stoppedAt: 'positive',
      deliveryPath: positiveGate.deliveryPath ?? 'unknown',
      positive,
      positiveGate,
      control: null,
      controlGate: null,
    };
  }
  const control = await runControl();
  const controlGate = evaluateControl(control);
  return {
    stoppedAt: controlGate.ok ? null : 'control',
    deliveryPath: positiveGate.deliveryPath ?? 'unknown',
    controlledAdmissionProven: positiveGate.deliveryPath === 'controlled' && controlGate.ok,
    positive,
    positiveGate,
    control,
    controlGate,
  };
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
