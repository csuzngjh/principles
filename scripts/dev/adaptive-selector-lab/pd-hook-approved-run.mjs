// PRI-1170 — approved small-batch acceptance through the MERGED Codex hook path.
//
// This runner deliberately drives the production entry point
// (`processHookInvocation` -> real decoder -> `pd-hook` dispatch ->
// `adaptivePriorityProvider` -> shared selection + additive assembly) instead of
// the lab's local selector. Only the SQLite workspace is a fixture and only the
// HTTP transport is wrapped (for accounting, not substitution).
//
// Boundaries, all fail closed before any network work:
//   * the run plan comes ONLY from the frozen case file + run manifest;
//   * an independent approval record binds the FULL manifest SHA-256, the frozen
//     cases SHA-256, this runner's SHA-256, the 3-request cap, the endpoint/model
//     and the expiry; it is validated against the actual files before claiming;
//   * the approval is claimed exactly once with an exclusive create;
//   * the cumulative request ledger is write-ahead (a failed attempt is spent);
//   * zero retries, zero repair, zero provider fallback, zero model switching.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  getDefaultPdConfig,
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { readPromptActivationCandidates } from '@principles/host-runtime';
import { processHookInvocation } from '@principles/codex-adapter/pd-hook';
import { seedFixtureWorkspace } from './fixture-workspace.mjs';

export const RUNNER_PATH = 'scripts/dev/adaptive-selector-lab/pd-hook-approved-run.mjs';
export const MANIFEST_FILE = 'docs/specs/PD-AA-PRI-1170-CODEX-EXEC-RUN-MANIFEST-v0.1.json';
export const APPROVAL_FILE = 'docs/specs/APPROVAL-PRI-1170-CODEX-EXEC-v0.1.json';
export const CLAIM_FILE = '.tmp/pri1170-approval-claim.json';
export const LEDGER_FILE = '.tmp/pri1170-requests.jsonl';
export const REPORT_FILE = '.tmp/pri1170-report.json';
export const MANIFEST_SCHEMA = 'pd-pri1170-codex-exec-run-manifest/v0.1';
export const APPROVAL_SCHEMA = 'pd-pri1170-codex-exec-approval/v1';
export const RUN_CARD_VERSION = 'v0.1';
/** chars = tokens / 32 in the production operator-declared window. */
export const CHARS_PER_TOKEN = 32;
/** The merged Codex path floors the operator-declared window at 1250 chars. */
export const MIN_EXPRESSIBLE_BUDGET_CHARS = 1250;

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Frozen budget rule, resolved from the measured shared-directive costs.
 * `native_kept_plus_target` = appendable / budget-blocked regimes;
 * `all_candidates` = Native-covers regime.
 */
export function computeCaseBudget({ rule, costs, candidateOrder }) {
  const block = (id) => {
    const value = costs.byPrincipleId[id];
    if (!Number.isFinite(value)) fail('BUDGET_PRINCIPLE_UNKNOWN');
    return value;
  };
  if (rule?.kind === 'native_kept_plus_target') {
    return costs.base
      + (rule.keptPrincipleIds ?? []).reduce((total, id) => total + block(id), 0)
      + block(rule.targetPrincipleId)
      + (rule.slackChars ?? 0)
      - (rule.deficitChars ?? 0);
  }
  if (rule?.kind === 'all_candidates') {
    return costs.base
      + candidateOrder.reduce((total, id) => total + block(id), 0)
      + (rule.slackChars ?? 0);
  }
  return fail('BUDGET_SPEC_INVALID');
}

export function loadFrozenPlan({ root = process.cwd() } = {}) {
  const manifestPath = path.join(root, MANIFEST_FILE);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) fail('MANIFEST_SCHEMA_INVALID');
  if (manifest.runCard?.version !== RUN_CARD_VERSION) fail('RUN_CARD_VERSION_MISMATCH');
  if (manifest.status !== 'FROZEN_NOT_EXECUTED') fail('MANIFEST_STATUS_INVALID');
  if (!manifest.frozenCases?.file) fail('MANIFEST_FROZEN_REFERENCE_MISSING');

  const frozenPath = path.join(root, manifest.frozenCases.file);
  const frozenBytes = fs.readFileSync(frozenPath);
  const frozenCasesSha256 = sha256(frozenBytes);
  if (frozenCasesSha256 !== manifest.frozenCases.sha256) fail('MANIFEST_DRIFT');
  const frozen = JSON.parse(frozenBytes.toString('utf8'));
  if (frozen.status !== 'FROZEN_NOT_EXECUTED') fail('FROZEN_STATUS_INVALID');

  const pool = new Map((frozen.candidatePool ?? []).map((entry) => [entry.id, entry]));
  const selectedIds = Array.isArray(manifest.selectedCaseIds) ? manifest.selectedCaseIds : [];
  if (selectedIds.length === 0) fail('SELECTED_CASES_EMPTY');
  if (new Set(selectedIds).size !== selectedIds.length) fail('SELECTED_CASES_DUPLICATED');
  if (selectedIds.length !== manifest.limits?.maxTotalRequests) fail('CASE_COUNT_CAP_MISMATCH');

  const cases = selectedIds.map((id) => {
    const frozenCase = (frozen.cases ?? []).find((entry) => entry.id === id);
    if (!frozenCase) fail('CASE_NOT_FROZEN');
    const candidates = frozenCase.candidateOrder.map((candidateId) => {
      const candidate = pool.get(candidateId);
      if (!candidate) fail('CANDIDATE_NOT_FROZEN');
      return {
        key: candidateId,
        principleId: candidateId,
        artifactId: `art-${candidateId}`,
        activationId: `act-${candidateId}`,
        text: candidate.text,
      };
    });
    const target = pool.get(frozen.targetPrincipleId);
    if (!target) fail('TARGET_NOT_FROZEN');
    return {
      id: frozenCase.id,
      category: frozenCase.category,
      prompt: frozenCase.prompt,
      candidateOrder: frozenCase.candidateOrder,
      candidates,
      budgetRule: frozenCase.budgetRule,
      expectedSelection: frozenCase.expectedSelection,
      expectedFinal: frozenCase.expectedFinal,
      targetText: target.text,
      candidateTexts: frozenCase.candidateOrder.map((candidateId) => pool.get(candidateId).text),
    };
  });

  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    frozenCasesSha256,
    runnerSha256: sha256(fs.readFileSync(path.join(root, RUNNER_PATH))),
    cases,
  };
}

export function validateApproval({ approval, plan, now = Date.now }) {
  const violations = [];
  const limits = plan.manifest.limits ?? {};
  const transport = plan.manifest.transport ?? {};
  if (approval?.schemaVersion !== APPROVAL_SCHEMA) violations.push('approval schemaVersion mismatch');
  if (typeof approval?.approvedBy !== 'string' || !approval.approvedBy.trim()) violations.push('approvedBy is required');
  if (typeof approval?.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt))) violations.push('approvedAt must be an ISO timestamp');
  if (typeof approval?.approvalEvidence !== 'string' || !approval.approvalEvidence.trim()) violations.push('approvalEvidence is required');
  if (approval?.cardVersion !== RUN_CARD_VERSION) violations.push('approval is not bound to this card version');
  if (approval?.manifestSha256 !== plan.manifestSha256) violations.push('approval is not bound to this manifest sha256');
  if (approval?.frozenCasesSha256 !== plan.frozenCasesSha256) violations.push('approval is not bound to this frozen-case sha256');
  if (approval?.runnerSha256 !== plan.runnerSha256) violations.push('approval is not bound to this runner sha256');
  if (approval?.maxTotalRequests !== limits.maxTotalRequests) violations.push('approval request cap differs from the manifest cap');
  if (approval?.transport?.provider !== transport.provider
    || approval?.transport?.model !== transport.model
    || approval?.transport?.baseUrl !== transport.baseUrl) {
    violations.push('approval transport binding differs from the manifest transport');
  }
  if (!Number.isFinite(Date.parse(approval?.expiresAt)) || Date.parse(approval.expiresAt) <= now()) {
    violations.push('approval has expired or has no expiry');
  }
  return violations;
}

export function assertApproval({ approval, plan, now = Date.now }) {
  const violations = validateApproval({ approval, plan, now });
  if (violations.length === 0) return;
  const error = new Error(`APPROVAL_RECORD_INVALID: ${violations.join('; ')}`);
  error.code = 'APPROVAL_RECORD_INVALID';
  error.violations = violations;
  throw error;
}

export function readApproval({ root = process.cwd() } = {}) {
  const file = path.join(root, APPROVAL_FILE);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('APPROVAL_RECORD_MISSING');
    throw error;
  }
  let approval;
  try {
    approval = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('APPROVAL_RECORD_INVALID_JSON');
  }
  return { approval, approvalSha256: sha256(bytes), file };
}

export function claimApproval({ root = process.cwd(), plan, approvalSha256, now = Date.now } = {}) {
  const claimPath = path.join(root, CLAIM_FILE);
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  const record = {
    schema: 'pd-pri1170-codex-exec-claim/v1',
    runCardVersion: RUN_CARD_VERSION,
    manifestSha256: plan.manifestSha256,
    frozenCasesSha256: plan.frozenCasesSha256,
    runnerSha256: plan.runnerSha256,
    maxTotalRequests: plan.manifest.limits.maxTotalRequests,
    approvalFileSha256: approvalSha256,
    caseIds: plan.cases.map((entry) => entry.id),
    claimedAt: new Date(now()).toISOString(),
  };
  try {
    fs.writeFileSync(claimPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', flush: true });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('APPROVAL_ALREADY_CLAIMED');
    throw error;
  }
  return record;
}

export function assertExecutionVersion({ root, plan }) {
  const mergedCommit = plan.manifest.executionVersion?.mergedCommit;
  const baseHead = plan.manifest.executionVersion?.baseHead;
  if (!mergedCommit || !baseHead) fail('EXECUTION_VERSION_UNBOUND');
  let actualHead;
  try {
    actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    // The run may add docs/scripts; production packages must equal the merged commit.
    execFileSync('git', ['diff', '--quiet', mergedCommit, 'HEAD', '--', 'packages/'], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    if (error?.status === 1) fail('EXECUTION_VERSION_DRIFT');
    fail('EXECUTION_VERSION_UNVERIFIABLE');
  }
  return { mergedCommit, baseHead, actualHead };
}

export function assertTransportKey({ transport }) {
  if (!transport?.apiKeyEnv || !process.env[transport.apiKeyEnv]) fail('APPROVED_MODEL_KEY_MISSING');
}

/** Write-ahead cumulative request ledger; the cap is enforced before fetch. */
export function createRequestLedger({ file, maxTotalRequests, now = Date.now }) {
  const rows = [];
  const persist = (row) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  const startedRows = () => rows.filter((row) => row.type === 'STARTED');
  return {
    rows,
    begin(caseId, meta = {}) {
      if (startedRows().some((row) => row.caseId === caseId)) fail('CASE_REQUEST_ALREADY_SENT');
      if (startedRows().length >= maxTotalRequests) fail('REQUEST_BUDGET_EXHAUSTED');
      const row = {
        type: 'STARTED',
        caseId,
        seq: startedRows().length + 1,
        startedAt: new Date(now()).toISOString(),
        maxTotalRequests,
        ...meta,
      };
      rows.push(row);
      persist(row); // write-ahead: this attempt is spent even if the transport fails
      return row;
    },
    finish(caseId, patch = {}) {
      const row = { type: 'RESULT', caseId, at: new Date(now()).toISOString(), ...patch };
      rows.push(row);
      persist(row);
      return row;
    },
  };
}

async function measureCosts(workspaceDir) {
  const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  const base = sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: false });
  const byPrincipleId = {};
  for (const principle of read.principles) {
    byPrincipleId[principle.principleId] = measureSharedDirectiveBlockChars(principle, {
      escapeFn: escapeXml,
      selfReportInstruction: false,
    });
  }
  return { base, byPrincipleId };
}

function writeFixtureConfig({ workspaceDir, adaptive, budgetTokens, transport }) {
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  // Set BOTH states explicitly: the default config object is shared, so a
  // previous Adaptive arm must never leak into a Native arm.
  config.features['host.codex.adaptive_activation'].enabled = adaptive === true;
  config.runtimeProfiles['pd.default'] = {
    type: 'pi-ai',
    provider: transport.provider,
    model: transport.model,
    baseUrl: transport.baseUrl,
    apiKeyEnv: transport.apiKeyEnv,
  };
  config.promptBudget = { hosts: { codex: budgetTokens } };
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
}

function hookInput({ workspaceDir, caseId, prompt }) {
  return JSON.stringify({
    session_id: `pri1170-${caseId}`,
    turn_id: `turn-${caseId}`,
    transcript_path: null,
    cwd: workspaceDir,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
}

async function readUsage(clone) {
  const contentType = clone.headers.get('content-type') ?? '';
  const text = await clone.text();
  let usage = null;
  let finishReason = 'unknown';
  if (contentType.includes('event-stream') || text.includes('data:')) {
    for (const line of text.split('\n')) {
      const match = line.match(/^data:\s*(.*)$/);
      if (!match) continue;
      const raw = match[1].trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const packet = JSON.parse(raw);
        if (packet?.usage) usage = packet.usage;
        const reason = packet?.choices?.[0]?.finish_reason;
        if (typeof reason === 'string' && reason.length > 0) finishReason = reason;
      } catch {
        // A partial/non-JSON SSE line is not usable evidence; keep unknown.
      }
    }
    return { usage, finishReason };
  }
  try {
    const packet = JSON.parse(text);
    return {
      usage: packet?.usage ?? null,
      finishReason: packet?.choices?.[0]?.finish_reason ?? 'unknown',
    };
  } catch {
    return { usage: null, finishReason: 'unknown' };
  }
}

function hookContext(result) {
  const output = result?.stdout;
  return output?.hookSpecificOutput?.additionalContext ?? '';
}

function parseAdaptiveDiagnostic(stderr) {
  const line = (stderr ?? []).find((entry) => typeof entry === 'string' && entry.includes('reason=adaptive_selection_'));
  if (!line) return null;
  const fields = {};
  for (const token of line.split(/\s+/)) {
    const index = token.indexOf('=');
    if (index > 0) fields[token.slice(0, index)] = token.slice(index + 1);
  }
  return {
    line,
    status: fields.status ?? 'unknown',
    reason: fields.reason ?? 'unknown',
    stage: fields.stage ?? 'unknown',
    sends: Number(fields.sends ?? '0'),
    firstByteAt: fields.firstByteAt ?? 'unknown',
    generationEndedAt: fields.generationEndedAt ?? 'unknown',
    cancelledAt: fields.cancelledAt ?? 'unknown',
    httpStatus: fields.httpStatus ?? 'unknown',
    finishReason: fields.finishReason ?? 'unknown',
    failures: fields.failures ?? 'unknown',
  };
}

/**
 * Runs ONE arm of ONE case through the merged hook entry.
 * The caller supplies the transport; the runner never substitutes a model.
 */
export async function runCase({
  root,
  kase,
  arm,
  adaptive,
  transport,
  limits,
  ledger,
  fetchImpl,
  selectionTimeouts,
  now = Date.now,
}) {
  const workspaceDir = path.join(root, '.tmp', 'pri1170-run', kase.id, arm);
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspaceDir, 'codex-home'), { recursive: true });
  await seedFixtureWorkspace(workspaceDir, kase.candidates);
  const costs = await measureCosts(workspaceDir);
  const budgetChars = computeCaseBudget({ rule: kase.budgetRule, costs, candidateOrder: kase.candidateOrder });
  if (budgetChars < MIN_EXPRESSIBLE_BUDGET_CHARS) fail('BUDGET_BELOW_PRODUCTION_FLOOR');
  const budgetTokens = Math.round(budgetChars * CHARS_PER_TOKEN);
  if (Math.floor(budgetTokens / CHARS_PER_TOKEN) !== budgetChars) fail('BUDGET_TOKEN_ROUNDING');
  writeFixtureConfig({ workspaceDir, adaptive, budgetTokens, transport });

  const state = {
    calls: 0,
    firstByteAtMs: null,
    httpStatus: null,
    usage: null,
    finishReason: 'unknown',
    hostDeadlineHit: false,
    hardDeadlineHit: false,
    abortReachedTransport: false,
    usagePromise: null,
  };
  const caseStartedAt = now();
  const hostController = new AbortController();
  const hostTimer = setTimeout(() => {
    state.hostDeadlineHit = true;
    hostController.abort(new DOMException('host hook timeout', 'AbortError'));
  }, Math.max(1, limits.perCaseWallClockMs));

  const measuredFetch = async (url, init = {}) => {
    ledger.begin(kase.id, {
      url: String(url),
      model: transport.model,
      maxTokens: limits.maxOutputTokens,
    });
    state.calls += 1;
    const signals = [init.signal, hostController.signal].filter(Boolean);
    const startedAt = now();
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals), redirect: 'error' });
      state.httpStatus = response.status;
      state.firstByteAtMs = now() - startedAt;
      state.usagePromise = readUsage(response.clone()).then((value) => {
        state.usage = value.usage;
        state.finishReason = value.finishReason;
      }).catch(() => {});
      ledger.finish(kase.id, { outcome: 'RECEIVED', httpStatus: response.status, firstByteAtMs: state.firstByteAtMs });
      return response;
    } catch (error) {
      state.abortReachedTransport = hostController.signal.aborted;
      ledger.finish(kase.id, {
        outcome: 'FAILED',
        httpStatus: state.httpStatus,
        error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        hostDeadlineHit: state.hostDeadlineHit,
      });
      throw error;
    }
  };

  const env = {
    CODEX_HOME: path.join(workspaceDir, 'codex-home'),
    [transport.apiKeyEnv]: process.env[transport.apiKeyEnv] ?? '',
  };

  const invocation = processHookInvocation(
    hookInput({ workspaceDir, caseId: kase.id, prompt: kase.prompt }),
    env,
    workspaceDir,
    { fetchImpl: measuredFetch, ...(selectionTimeouts ?? {}) },
  );

  let result;
  try {
    result = await Promise.race([
      invocation,
      new Promise((_, reject) => {
        setTimeout(() => {
          state.hardDeadlineHit = true;
          reject(new Error('CASE_HARD_DEADLINE'));
        }, limits.perCaseWallClockMs + 2000);
      }),
    ]);
  } catch (error) {
    result = null;
    if (!(error instanceof Error && error.message === 'CASE_HARD_DEADLINE')) throw error;
  } finally {
    clearTimeout(hostTimer);
    // Never abort a completed invocation: the usage probe may still be reading
    // the cloned stream. Abort only when the case did not complete.
    if (result === null) hostController.abort();
  }

  if (state.usagePromise) await Promise.race([state.usagePromise, new Promise((resolve) => setTimeout(resolve, 500))]);

  return {
    caseId: kase.id,
    arm,
    status: result === null ? 'HOST_TIMEOUT' : 'COMPLETED',
    context: result === null ? '' : hookContext(result),
    stderr: result === null ? [] : result.stderr,
    diagnostic: result === null ? null : parseAdaptiveDiagnostic(result.stderr),
    budgetChars,
    budgetTokens,
    wallClockMs: now() - caseStartedAt,
    transport: {
      calls: state.calls,
      firstByteAtMs: state.firstByteAtMs,
      httpStatus: state.httpStatus,
      usage: state.usage,
      finishReason: state.finishReason,
      hostDeadlineHit: state.hostDeadlineHit,
      hardDeadlineHit: state.hardDeadlineHit,
      abortReachedTransport: state.abortReachedTransport,
    },
  };
}

function presentTexts(context, texts) {
  return texts.filter((text) => context.includes(text));
}

/** Turns the two arms + diagnostics into a verdict that never overclaims. */
export function classifyCase({ kase, native, adaptive }) {
  const nativeTexts = presentTexts(native.context, kase.candidateTexts);
  const adaptiveTexts = presentTexts(adaptive.context, kase.candidateTexts);
  const added = adaptiveTexts.filter((text) => !nativeTexts.includes(text));
  const removed = nativeTexts.filter((text) => !adaptiveTexts.includes(text));
  const nativeHasTarget = native.context.includes(kase.targetText);
  const adaptiveHasTarget = adaptive.context.includes(kase.targetText);
  const reason = adaptive.diagnostic?.reason ?? 'unknown';
  const selected = reason.startsWith('adaptive_selection_selected:selected');
  const abstained = reason.includes('no_increment') || reason.includes(':uncertain');
  const hostTimeout = adaptive.status === 'HOST_TIMEOUT' || adaptive.transport.hostDeadlineHit;

  let pass = false;
  let classification = 'FAIL';
  if (hostTimeout) {
    classification = 'HOST_HOOK_TIMEOUT';
  } else if (!adaptive.diagnostic) {
    classification = 'NO_SELECTION_DIAGNOSTIC';
  } else if (kase.category === 'native_misses_appendable') {
    if (selected && !nativeHasTarget && adaptiveHasTarget
      && added.length === 1 && added[0] === kase.targetText && removed.length === 0) {
      classification = 'TARGET_APPENDED_NATIVE_PRESERVED';
      pass = true;
    } else {
      classification = selected ? 'SELECTED_BUT_ASSEMBLY_UNEXPECTED' : 'MODEL_DID_NOT_SELECT_TARGET';
    }
  } else if (kase.category === 'should_abstain') {
    if (abstained && adaptive.context === native.context && added.length === 0 && removed.length === 0) {
      classification = 'ABSTAINED_NATIVE_UNCHANGED';
      pass = true;
    } else {
      classification = abstained ? 'ABSTAINED_BUT_TEXT_CHANGED' : 'FALSE_SELECTION';
    }
  } else if (kase.category === 'selected_but_budget_blocked') {
    if (selected && !nativeHasTarget && !adaptiveHasTarget
      && adaptive.context === native.context && added.length === 0 && removed.length === 0) {
      classification = 'SELECTED_NOT_PACKED';
      pass = true;
    } else {
      classification = selected ? 'SELECTED_AND_TEXT_UNEXPECTED' : 'MODEL_DID_NOT_SELECT_TARGET';
    }
  } else {
    classification = 'UNKNOWN_CASE_CATEGORY';
  }

  return {
    caseId: kase.id,
    category: kase.category,
    expectedFinal: kase.expectedFinal,
    classification,
    pass,
    native: {
      status: native.status,
      wallClockMs: native.wallClockMs,
      sends: native.transport.calls,
      chars: native.context.length,
      principlesPresent: nativeTexts.map((text) => kase.candidateOrder[kase.candidateTexts.indexOf(text)]),
      hasTarget: nativeHasTarget,
    },
    adaptive: {
      status: adaptive.status,
      wallClockMs: adaptive.wallClockMs,
      sends: adaptive.transport.calls,
      chars: adaptive.context.length,
      principlesPresent: adaptiveTexts.map((text) => kase.candidateOrder[kase.candidateTexts.indexOf(text)]),
      hasTarget: adaptiveHasTarget,
      byteIdenticalToNative: adaptive.context === native.context,
      diagnostic: adaptive.diagnostic,
      transport: adaptive.transport,
    },
    addedPrincipleIds: added.map((text) => kase.candidateOrder[kase.candidateTexts.indexOf(text)]),
    removedPrincipleIds: removed.map((text) => kase.candidateOrder[kase.candidateTexts.indexOf(text)]),
    budgetChars: adaptive.budgetChars,
    budgetTokens: adaptive.budgetTokens,
    hostHookFits: adaptive.status === 'COMPLETED' && adaptive.wallClockMs <= 5000,
  };
}

export async function runApprovedBatch({ root = process.cwd(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const plan = loadFrozenPlan({ root });
  const executionVersion = assertExecutionVersion({ root, plan });
  assertTransportKey({ transport: plan.manifest.transport });
  const { approval, approvalSha256 } = readApproval({ root });
  assertApproval({ approval, plan, now });
  claimApproval({ root, plan, approvalSha256, now });

  const limits = plan.manifest.limits;
  const transport = plan.manifest.transport;
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const ledger = createRequestLedger({
    file: path.join(root, LEDGER_FILE),
    maxTotalRequests: limits.maxTotalRequests,
    now,
  });

  const batchStartedAt = now();
  const results = [];
  for (const kase of plan.cases) {
    const elapsed = now() - batchStartedAt;
    if (elapsed >= limits.batchWallClockMs) {
      results.push({ caseId: kase.id, category: kase.category, classification: 'NOT_RUN', pass: false, reason: 'BATCH_WALL_CLOCK_EXCEEDED' });
      continue;
    }
    const caseWallClockMs = Math.min(limits.perCaseWallClockMs, limits.batchWallClockMs - elapsed);
    const shared = { root, kase, transport, limits: { ...limits, perCaseWallClockMs: caseWallClockMs }, now };
    const native = await runCase({ ...shared, arm: 'native', adaptive: false, ledger, fetchImpl });
    const adaptive = await runCase({ ...shared, arm: 'adaptive', adaptive: true, ledger, fetchImpl });
    results.push(classifyCase({ kase, native, adaptive }));
  }

  const report = {
    schema: 'pd-pri1170-codex-exec-report/v1',
    generatedAt: new Date(now()).toISOString(),
    execution: {
      mergedCommit: plan.manifest.executionVersion?.mergedCommit,
      mergedTree: plan.manifest.executionVersion?.mergedTree,
      baseHead: plan.manifest.executionVersion?.baseHead,
      actualHead: executionVersion.actualHead,
      runnerSha256: plan.runnerSha256,
      manifestSha256: plan.manifestSha256,
      frozenCasesSha256: plan.frozenCasesSha256,
      approvalSha256,
      approvalEvidence: approval.approvalEvidence,
    },
    host: plan.manifest.host,
    limits,
    transport: {
      provider: transport.provider,
      baseUrl: transport.baseUrl,
      model: transport.model,
      maxOutputTokens: limits.maxOutputTokens,
      retries: 0,
      repairs: 0,
      providerFallback: 0,
      modelSwitches: 0,
    },
    totalRequests: ledger.rows.filter((row) => row.type === 'STARTED').length,
    batchWallClockMs: now() - batchStartedAt,
    cases: results,
    summary: {
      executed: results.filter((entry) => entry.classification !== 'NOT_RUN').length,
      passed: results.filter((entry) => entry.pass).length,
      failed: results.filter((entry) => entry.classification !== 'NOT_RUN' && !entry.pass).length,
      notRun: results.filter((entry) => entry.classification === 'NOT_RUN').length,
    },
  };
  fs.writeFileSync(path.join(root, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runApprovedBatch()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.code ?? 'RUN_FAILED'}: ${error?.message ?? String(error)}\n`);
      process.exitCode = 1;
    });
}
