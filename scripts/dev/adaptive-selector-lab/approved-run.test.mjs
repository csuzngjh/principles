// PRI-1122 approved-branch acceptance on a FAKE transport.
//
// These tests never reach the network. They drive the real CLI entry, the real
// frozen manifest, the real claim and the real request ledger, and prove that
// every refusal happens before the first send. A real model call still requires
// an explicit Owner approval of the budget card and is NOT RUN here.
process.env.ZAI_CODING_CN_API_KEY ||= 'fake-test-key';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_FILE,
  MANIFEST_FILE,
  createApprovalBoundary,
  loadApprovedPlan,
  resolveBudget,
} from './approved-run.mjs';
import { APPROVAL_FLAG, run } from './orchestrate.mjs';
import { SELECTOR_MODEL, LIMITS } from './orchestrator.mjs';
import { measureFixtureCosts, seedFixtureWorkspace } from './fixture-workspace.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FROZEN_FILE = 'docs/specs/PD-AA-PRI-1122-SINGLE-MODEL-FROZEN-CASES-v0.1.json';

function tempRoot() {
  return fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'pri1122-approved-'));
}

function copySpecs({ mutateFrozen = false } = {}) {
  const root = tempRoot();
  for (const relative of [MANIFEST_FILE, FROZEN_FILE]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  if (mutateFrozen) {
    const frozenPath = path.join(root, FROZEN_FILE);
    const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
    frozen.amendments.push({ at: '2026-11-10', change: 'drift injected by test' });
    fs.writeFileSync(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
  }
  return { root, reportsRoot: path.join(root, 'reports') };
}

function sseFetch(payload, state = { count: 0 }, onRequest = null) {
  const fetch = async (url, init) => {
    state.count += 1;
    if (onRequest) onRequest(url, init);
    const packets = [
      { id: 'fake', model: SELECTOR_MODEL.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: null }] },
      { id: 'fake', model: SELECTOR_MODEL.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    ];
    return new Response(packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, state };
}

const REQUEST_BODY = JSON.stringify({ model: SELECTOR_MODEL.model, max_tokens: LIMITS.maxOutputTokens, messages: [] });

function boundaryFor(plan, fetchImpl, now = () => Date.now()) {
  const ledger = { counts: { total: 0 }, requests: [] };
  const boundary = createApprovalBoundary({
    ledger, persist: () => {}, plan, model: SELECTOR_MODEL, now, fetchImpl, maxTokens: LIMITS.maxOutputTokens,
  });
  return { ledger, boundary };
}

test('the real branch refuses to run without explicit approval and sends nothing', async () => {
  const { root, reportsRoot } = copySpecs();
  const { fetch, state } = sseFetch({ status: 'none_applicable', id: null, digest: null });
  await assert.rejects(run(['--mode', 'approved'], { root, reportsRoot, fetch }), /EXPLICIT_APPROVAL_REQUIRED/);
  assert.equal(state.count, 0);
  assert.equal(fs.existsSync(path.join(reportsRoot, CLAIM_FILE)), false);
});

test('frozen manifest drift is refused before the claim and before any request', async () => {
  const { root, reportsRoot } = copySpecs({ mutateFrozen: true });
  const { fetch, state } = sseFetch({ status: 'none_applicable', id: null, digest: null });
  await assert.rejects(run(['--mode', 'approved', APPROVAL_FLAG], { root, reportsRoot, fetch }), /MANIFEST_DRIFT/);
  assert.equal(state.count, 0);
  assert.equal(fs.existsSync(path.join(reportsRoot, CLAIM_FILE)), false);
});

test('every frozen field is closed to command-line overrides in the real branch', async () => {
  const { root, reportsRoot } = copySpecs();
  const { fetch, state } = sseFetch({ status: 'none_applicable', id: null, digest: null });
  const overrides = [
    ['--workspace', root],
    ['--current-input', '覆盖当前指令'],
    ['--prior', '覆盖事前上下文'],
    ['--round-key', '2'],
    ['--budget-chars', '999999'],
    ['--fixture-response', '{"status":"none_applicable"}'],
  ];
  for (const [flag, value] of overrides) {
    await assert.rejects(
      run(['--mode', 'approved', APPROVAL_FLAG, flag, value], { root, reportsRoot, fetch }),
      /REAL_BRANCH_ARGUMENT_FORBIDDEN/,
      `${flag} must be refused`,
    );
  }
  assert.equal(state.count, 0);
  assert.equal(fs.existsSync(path.join(reportsRoot, CLAIM_FILE)), false);
});

test('a second execution of the same approval sends nothing, and splits stay separated', async () => {
  const { root, reportsRoot } = copySpecs();
  const fixture = sseFetch({ status: 'none_applicable', id: null, digest: null });
  const first = await run(['--mode', 'approved', APPROVAL_FLAG], { root, reportsRoot, fetch: fixture.fetch });
  assert.equal(first.mode, 'approved');
  assert.equal(first.requests, 12);
  assert.deepEqual(first.splits.dev, {
    planned: 8, completed: 8, failed: 0, notRun: 0,
    dynamicAdditions: 0, nativeBaseline: 0, selectedButNotPacked: 0,
  });
  assert.deepEqual(first.splits.eval, {
    planned: 4, completed: 4, failed: 0, notRun: 0,
    dynamicAdditions: 0, nativeBaseline: 0, selectedButNotPacked: 0,
  });
  const claim = JSON.parse(fs.readFileSync(path.join(reportsRoot, CLAIM_FILE), 'utf8'));
  assert.equal(claim.runCardVersion, 'v0.2');
  assert.equal(claim.maxTotalRequests, 12);
  assert.match(claim.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(claim.manifestSha256, first.manifestSha256);
  assert.equal(claim.caseIds.length, 12);

  // The frozen plan must reproduce the intended Native shapes end to end: the
  // appendable case stops at the oversized control, the blocked case fills both
  // kept principles. Otherwise the positive/negative controls mean nothing.
  const results = JSON.parse(fs.readFileSync(path.join(first.runDir, 'results.json'), 'utf8'));
  const rowOf = (caseId) => results.results.find((row) => row.caseId === caseId);
  assert.deepEqual(rowOf('dev-04').assembly.nativeActivationIds, ['act-fixture_preserve']);
  assert.deepEqual(rowOf('dev-04').assembly.finalActivationIds, ['act-fixture_preserve']);
  assert.deepEqual(rowOf('dev-08').assembly.nativeActivationIds, ['act-fixture_preserve', 'act-fixture_explicit_goal']);
  assert.deepEqual(rowOf('eval-02').assembly.nativeActivationIds, ['act-fixture_preserve']);
  assert.equal(rowOf('dev-04').budgetChars > 0, true);
  assert.equal(results.results.length, 12);
  assert.equal(results.requests.length, 12);

  const replay = sseFetch({ status: 'none_applicable', id: null, digest: null });
  await assert.rejects(run(['--mode', 'approved', APPROVAL_FLAG], { root, reportsRoot, fetch: replay.fetch }),
    /APPROVAL_ALREADY_CLAIMED/);
  assert.equal(replay.state.count, 0);
  assert.equal(fixture.state.count, 12);
});

test('concurrent execution of one approval lets exactly one batch send', async () => {
  const { root, reportsRoot } = copySpecs();
  const left = sseFetch({ status: 'none_applicable', id: null, digest: null });
  const right = sseFetch({ status: 'none_applicable', id: null, digest: null });
  const [first, second] = await Promise.allSettled([
    run(['--mode', 'approved', APPROVAL_FLAG], { root, reportsRoot, fetch: left.fetch }),
    run(['--mode', 'approved', APPROVAL_FLAG], { root, reportsRoot, fetch: right.fetch }),
  ]);
  const fulfilled = [first, second].filter((entry) => entry.status === 'fulfilled');
  const rejected = [first, second].filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /APPROVAL_ALREADY_CLAIMED/);
  assert.equal(left.state.count + right.state.count, 12);
});

test('the thirteenth request is refused before the network, and failures still count', async () => {
  const plan = { maxTotalRequests: 12, timeoutMs: LIMITS.selectTimeoutMs, maxOutputTokens: LIMITS.maxOutputTokens };
  const { fetch, state } = sseFetch({ status: 'none_applicable', id: null, digest: null });
  const { ledger, boundary } = boundaryFor(plan, fetch);
  for (let index = 0; index < 12; index += 1) {
    const handler = boundary(`case-${index}`, Date.now() + LIMITS.selectTimeoutMs);
    await handler(SELECTOR_MODEL.url, { method: 'POST', body: REQUEST_BODY });
  }
  assert.equal(state.count, 12);
  assert.equal(ledger.requests.length, 12);
  const thirteenth = boundary('case-12', Date.now() + LIMITS.selectTimeoutMs);
  await assert.rejects(thirteenth(SELECTOR_MODEL.url, { method: 'POST', body: REQUEST_BODY }), /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(state.count, 12);

  const failing = boundaryFor(plan, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(failing.boundary('case-x', Date.now() + LIMITS.selectTimeoutMs)(
    SELECTOR_MODEL.url, { method: 'POST', body: REQUEST_BODY },
  ), /NETWORK_OR_PROTOCOL_ERROR/);
  assert.equal(failing.ledger.counts.total, 1);
  assert.equal(failing.ledger.requests[0].status, 'FAILED');
});

test('the frozen budget rule reproduces the appendable and blocked regimes', async () => {
  const plan = loadApprovedPlan({ root: repoRoot });
  assert.equal(plan.cases.length, 12);
  const byId = new Map(plan.cases.map((entry) => [entry.id, entry]));
  const appendable = byId.get('dev-04');
  assert.equal(appendable.roundKey, undefined);
  assert.equal(appendable.assemblyRegime, 'native_misses_appendable');

  const workspaceDir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'pri1122-budget-'));
  await seedFixtureWorkspace(workspaceDir, appendable.candidates);
  const costs = await measureFixtureCosts(workspaceDir);
  const budgetChars = resolveBudget({ spec: appendable.budget, costs, candidateOrder: appendable.candidateOrder });
  assert.equal(budgetChars, costs.base + costs.byPrincipleId.fixture_preserve + costs.byPrincipleId.fixture_verify + 10);

  const blocked = byId.get('dev-08');
  const blockedDir = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'pri1122-budget-'));
  await seedFixtureWorkspace(blockedDir, blocked.candidates);
  const blockedCosts = await measureFixtureCosts(blockedDir);
  const blockedBudget = resolveBudget({ spec: blocked.budget, costs: blockedCosts, candidateOrder: blocked.candidateOrder });
  assert.equal(blockedBudget, blockedCosts.base + blockedCosts.byPrincipleId.fixture_preserve
    + blockedCosts.byPrincipleId.fixture_explicit_goal + blockedCosts.byPrincipleId.fixture_verify - 5);
});

test('the approved budget card names the exact artifacts it was written against', () => {
  const plan = loadApprovedPlan({ root: repoRoot });
  const card = fs.readFileSync(path.join(repoRoot, 'docs/specs/PD-AA-PRI-1122-SINGLE-MODEL-BUDGET-CARD-v0.2.md'), 'utf8');
  const hashes = [...card.matchAll(/`([0-9a-f]{64})`/g)].map((match) => match[1]);
  assert.equal(hashes.includes(plan.manifestSha256), true, 'card must record the current manifest sha256');
  assert.equal(hashes.includes(plan.frozenCasesSha256), true, 'card must record the current frozen cases sha256');
  assert.match(card, /请求总数硬上限 \| \*\*12\*\*/);
  assert.match(card, /未批准 \/ NOT RUN/);
});
