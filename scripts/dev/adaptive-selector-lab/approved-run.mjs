// PRI-1122 approved real-call branch.
//
// Boundary rules (all fail closed before any network work):
//   * the run plan comes ONLY from the frozen batch + run manifest; no CLI field
//     may overwrite the workspace, case id, current input, prior context,
//     candidate pool or budget;
//   * the approval binds run-card version, frozen manifest SHA-256 and the
//     12-request cap, and is claimed exactly once with an exclusive create;
//   * every opportunity may send at most one request, the cap is cumulative and
//     a failed request still counts (write-ahead persist before fetch).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePromptBudget } from '@principles/core/runtime';
import {
  createSingleModelSelector,
  runSelectionOpportunity,
  summarizeOpportunity,
  LIMITS,
  SELECTOR_MODEL,
} from './orchestrator.mjs';
import { measureFixtureCosts, seedFixtureWorkspace } from './fixture-workspace.mjs';

export const MANIFEST_FILE = 'docs/specs/PD-AA-PRI-1122-SINGLE-MODEL-RUN-MANIFEST-v0.1.json';
export const MANIFEST_SCHEMA = 'pd-aa-pri1122-single-model-run-manifest/v0.1';
export const RUN_CARD_VERSION = 'v0.2';
export const MAX_TOTAL_REQUESTS = 12;
export const CLAIM_FILE = 'APPROVAL-PRI-1122-SINGLE-MODEL-v0.2-CLAIM.json';
export const MAX_TRANSPORT_FAILURES = 2;

const fail = (code) => { throw new Error(code); };

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function loadApprovedPlan({ root = process.cwd(), manifestFile = path.join(root, MANIFEST_FILE) } = {}) {
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) fail('MANIFEST_SCHEMA_INVALID');
  if (manifest.runCard?.version !== RUN_CARD_VERSION) fail('RUN_CARD_VERSION_MISMATCH');
  if (manifest.limits?.maxTotalRequests !== MAX_TOTAL_REQUESTS) fail('REQUEST_CAP_MISMATCH');
  if (manifest.frozenCases?.file === undefined) fail('MANIFEST_FROZEN_REFERENCE_MISSING');
  const frozenBytes = fs.readFileSync(path.join(root, manifest.frozenCases.file));
  const frozenCasesSha256 = sha256(frozenBytes);
  if (frozenCasesSha256 !== manifest.frozenCases.sha256) fail('MANIFEST_DRIFT');
  const frozen = JSON.parse(frozenBytes.toString('utf8'));
  const candidates = new Map((frozen.sharedInputs?.candidateSet ?? []).map((entry) => [entry.id, entry]));
  const frozenCases = Array.isArray(frozen.cases) ? frozen.cases : [];
  const manifestCases = Array.isArray(manifest.cases) ? manifest.cases : [];
  // The case set is the frozen set: neither adding nor dropping a case is allowed.
  if (JSON.stringify(frozenCases.map((entry) => entry.id)) !== JSON.stringify(manifestCases.map((entry) => entry.id))) {
    fail('CASE_LIST_DRIFT');
  }
  const cases = manifestCases.map((entry) => {
    const frozenCase = frozenCases.find((item) => item.id === entry.id);
    // Input, prior context and split are read from the frozen batch, not restated.
    const priorMessages = frozenCase.previousTask === null ? [] : [frozenCase.previousTask];
    const pool = entry.candidateOrder.map((id) => {
      const candidate = candidates.get(id);
      if (!candidate) fail('MANIFEST_CANDIDATE_UNKNOWN');
      return { key: id, principleId: id, artifactId: `art-${id}`, activationId: `act-${id}`, text: candidate.text };
    });
    return {
      id: entry.id,
      split: frozenCase.split,
      assemblyRegime: frozenCase.assemblyRegime,
      // `null` in the manifest means the legacy FIFO policy; the assembly reads
      // "absent" as FIFO, so the null is normalized to undefined here.
      roundKey: entry.roundKey === null ? undefined : entry.roundKey,
      currentInput: frozenCase.currentInput,
      priorMessages,
      candidateOrder: entry.candidateOrder,
      candidates: pool,
      budget: entry.budget,
    };
  });
  return {
    runCardVersion: RUN_CARD_VERSION,
    manifestSha256: sha256(manifestBytes),
    frozenCasesSha256,
    maxTotalRequests: MAX_TOTAL_REQUESTS,
    timeoutMs: manifest.limits.timeoutMs ?? LIMITS.selectTimeoutMs,
    maxOutputTokens: manifest.limits.maxOutputTokens ?? LIMITS.maxOutputTokens,
    cases,
  };
}

// The frozen budget rule, resolved from measured block sizes. `native_kept_plus_target`
// is the appendable/blocked regime; `all_candidates` is the Native-covers regime.
export function resolveBudget({ spec, costs, candidateOrder }) {
  const block = (id) => {
    const value = costs.byPrincipleId[id];
    if (!Number.isFinite(value)) fail('BUDGET_PRINCIPLE_UNKNOWN');
    return value;
  };
  if (spec?.kind === 'native_kept_plus_target') {
    const slack = spec.slackChars ?? 0;
    const deficit = spec.deficitChars ?? 0;
    return costs.base + (spec.keptPrincipleIds ?? []).reduce((total, id) => total + block(id), 0)
      + block(spec.targetPrincipleId) + slack - deficit;
  }
  if (spec?.kind === 'all_candidates') {
    return costs.base + candidateOrder.reduce((total, id) => total + block(id), 0) + (spec.slackChars ?? 0);
  }
  return fail('BUDGET_SPEC_INVALID');
}

// One-shot claim. `wx` is the mutex: a repeated or concurrent invocation finds
// the file and is refused before any request leaves the process.
export function claimApproval({ claimPath, plan, now = Date.now }) {
  const record = {
    schema: 'pd-pri1122-single-model-claim/v1',
    runCardVersion: plan.runCardVersion,
    manifestSha256: plan.manifestSha256,
    frozenCasesSha256: plan.frozenCasesSha256,
    maxTotalRequests: plan.maxTotalRequests,
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

// Per-opportunity transport gate layered under the selector's own single-send
// gate: cumulative cap, allowlist, write-ahead accounting, deadline forwarding.
export function createApprovalBoundary({
  ledger, persist, plan, model, now = Date.now, fetchImpl, maxTokens = plan.maxOutputTokens,
}) {
  if (typeof fetchImpl !== 'function') fail('TRANSPORT_REQUIRED');
  return (caseId, deadlineAt) => {
    let used = false;
    return async (input, init = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init.body === 'string' ? init.body : '';
      if (!body || init.method?.toUpperCase() !== 'POST') fail('REQUEST_NOT_ALLOWLISTED');
      const payload = JSON.parse(body);
      if (url !== model.url || payload.model !== model.model) fail('REQUEST_NOT_ALLOWLISTED');
      if (payload.max_tokens !== maxTokens) fail('OUTPUT_BUDGET_INVALID');
      if (used) fail('REQUEST_BUDGET_EXHAUSTED');
      if (ledger.counts.total >= plan.maxTotalRequests) fail('REQUEST_BUDGET_EXHAUSTED');
      if (now() >= deadlineAt) fail('REQUEST_DEADLINE_EXPIRED');
      used = true;
      ledger.counts.total += 1;
      const row = { caseId, requestOrdinal: ledger.counts.total, status: 'STARTED', httpStatus: null, latencyMs: null };
      ledger.requests.push(row);
      persist(); // write-ahead: a failed or interrupted attempt is still spent
      const started = now();
      try {
        const remaining = Math.max(1, Math.min(plan.timeoutMs, deadlineAt - started));
        const signals = [init.signal, AbortSignal.timeout(remaining)].filter(Boolean);
        const response = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals), redirect: 'error' });
        row.httpStatus = response.status;
        if (!response.ok) {
          row.status = 'FAILED';
          row.failure = `HTTP_${response.status}`;
          throw new Error(row.failure);
        }
        row.status = 'RECEIVED';
        return response;
      } catch (error) {
        if (row.status !== 'FAILED') {
          row.status = 'FAILED';
          row.failure = /^HTTP_\d+$/.test(error?.message) ? error.message : 'NETWORK_OR_PROTOCOL_ERROR';
        }
        throw new Error(row.failure);
      } finally {
        row.latencyMs = now() - started;
        persist();
      }
    };
  };
}

export function summarizeSplits({ plan, ledger }) {
  const splits = {};
  for (const split of ['dev', 'eval']) {
    const planned = plan.cases.filter((entry) => entry.split === split);
    const rows = ledger.results.filter((row) => row.split === split);
    splits[split] = {
      planned: planned.length,
      completed: rows.filter((row) => row.status === 'completed').length,
      failed: rows.filter((row) => row.status !== 'completed').length,
      notRun: planned.length - rows.length,
      dynamicAdditions: rows.filter((row) => row.outcome === 'dynamic_added').length,
      nativeBaseline: rows.filter((row) => row.outcome === 'native_baseline').length,
      selectedButNotPacked: rows.filter((row) => row.assembly?.selectedButNotPacked).length,
    };
  }
  return splits;
}

export async function runApprovedBatch({
  plan, reportsRoot, fetch, adapter, now = Date.now,
}) {
  if (typeof fetch !== 'function') fail('TRANSPORT_REQUIRED');
  if (typeof adapter !== 'function') fail('ADAPTER_REQUIRED');
  fs.mkdirSync(reportsRoot, { recursive: true });
  // Claim first: nothing in this batch may send before the exclusive claim lands.
  const claim = claimApproval({ claimPath: path.join(reportsRoot, CLAIM_FILE), plan, now });
  const runDir = path.join(reportsRoot, new Date(now()).toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir); // exclusive: a colliding run directory is a hard failure
  const ledger = {
    schema: 'pd-pri1122-single-model-approved-run/v1',
    startedAt: new Date(now()).toISOString(),
    runCardVersion: plan.runCardVersion,
    manifestSha256: plan.manifestSha256,
    frozenCasesSha256: plan.frozenCasesSha256,
    maxTotalRequests: plan.maxTotalRequests,
    timeoutMs: plan.timeoutMs,
    claim,
    counts: { total: 0 },
    requests: [],
    results: [],
  };
  const resultsFile = path.join(runDir, 'results.json');
  const persist = () => fs.writeFileSync(resultsFile, `${JSON.stringify(ledger, null, 2)}\n`, { flush: true });
  persist();

  let transportFailures = 0;
  let stopped = null;
  const boundary = createApprovalBoundary({
    ledger, persist, plan, model: SELECTOR_MODEL, now, fetchImpl: fetch, maxTokens: plan.maxOutputTokens,
  });
  for (const entry of plan.cases) {
    if (transportFailures >= MAX_TRANSPORT_FAILURES) { stopped = 'TRANSPORT_FAILURE_LIMIT'; break; }
    const deadlineAt = now() + plan.timeoutMs;
    const workspaceDir = path.join(runDir, 'workspaces', entry.id);
    try {
      await seedFixtureWorkspace(workspaceDir, entry.candidates);
      const costs = await measureFixtureCosts(workspaceDir);
      const budgetChars = resolveBudget({ spec: entry.budget, costs, candidateOrder: entry.candidateOrder });
      const promptBudget = { ...resolvePromptBudget(), budgetChars };
      const selector = createSingleModelSelector({
        PiAiRuntimeAdapter: adapter, fetch: boundary(entry.id, deadlineAt), now, deadlineAt, maxTokens: plan.maxOutputTokens,
      });
      const result = await runSelectionOpportunity({
        workspaceDir,
        roundKey: entry.roundKey,
        promptBudget,
        currentInput: entry.currentInput,
        priorMessages: entry.priorMessages,
        hookInvocationId: `approved-${entry.id}`,
        deadlineAt,
        select: selector.select,
        selectorReport: selector.report,
      });
      ledger.results.push({ caseId: entry.id, split: entry.split, status: 'completed', budgetChars, ...summarizeOpportunity(result) });
    } catch (error) {
      transportFailures += 1;
      ledger.results.push({
        caseId: entry.id, split: entry.split, status: 'failed',
        reason: typeof error?.message === 'string' ? error.message : 'UNKNOWN',
      });
    }
    persist();
  }

  const splits = summarizeSplits({ plan, ledger });
  const summary = {
    schema: 'pd-pri1122-single-model-approved-summary/v1',
    status: stopped === null ? 'complete' : 'stopped',
    stopped,
    runDir,
    runCardVersion: plan.runCardVersion,
    manifestSha256: plan.manifestSha256,
    frozenCasesSha256: plan.frozenCasesSha256,
    requests: ledger.counts.total,
    maxTotalRequests: plan.maxTotalRequests,
    splits,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flush: true });
  return { claim, runDir, ledger, splits, summary };
}
