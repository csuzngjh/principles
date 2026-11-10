// PRI-1170 — fake-stream proof for the approved-run harness.
//
// These tests exercise the SAME `runCase`/`classifyCase` code used by the real
// small batch, but with a fake transport. They prove:
//   * the harness never sends before authorization and never exceeds the cap;
//   * the merged hook path is not cancelled at the admission deadline while the
//     generation is still completing (first-byte semantics);
//   * the per-case host deadline (shipped UserPromptSubmit timeout) aborts the
//     transport and keeps Native;
//   * the three frozen regimes classify correctly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import {
  RUNNER_PATH,
  classifyCase,
  createRequestLedger,
  runCase,
  sha256,
} from './pd-hook-approved-run.mjs';

const ROOT = path.resolve('.tmp/pri1170-test');
const FROZEN_FILE = path.resolve('docs/specs/PD-AA-PRI-1170-CODEX-EXEC-FROZEN-CASES-v0.1.json');
const TRANSPORT = {
  provider: 'zai-coding-plan',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  model: 'glm-5.3-flash',
  apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
};
const LIMITS = { perCaseWallClockMs: 5000, maxOutputTokens: 512 };
process.env[TRANSPORT.apiKeyEnv] = 'test-key';

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

function loadCases() {
  const frozen = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
  const pool = new Map(frozen.candidatePool.map((entry) => [entry.id, entry]));
  return frozen.cases.map((entry) => ({
    id: entry.id,
    category: entry.category,
    prompt: entry.prompt,
    candidateOrder: entry.candidateOrder,
    candidates: entry.candidateOrder.map((id) => ({
      key: id,
      principleId: id,
      artifactId: `art-${id}`,
      activationId: `act-${id}`,
      text: pool.get(id).text,
    })),
    budgetRule: entry.budgetRule,
    candidateTexts: entry.candidateOrder.map((id) => pool.get(id).text),
    targetText: pool.get(frozen.targetPrincipleId).text,
  }));
}

function sseBody(answer) {
  const packets = [
    { id: 'fake', model: TRANSPORT.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: null }] },
    { id: 'fake', model: TRANSPORT.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  return `${packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('')}data: [DONE]\n\n`;
}

function sseResponse(answer, { delayMs = 0 } = {}) {
  const body = sseBody(answer);
  if (delayMs === 0) {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  const stream = new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      }, delayMs);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function requestCandidates(init) {
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, TRANSPORT.model);
  assert.equal(body.max_tokens, 512);
  const message = (body.messages ?? []).find(
    (item) => typeof item.content === 'string' && item.content.trim().startsWith('{'),
  );
  assert.ok(message, 'selection payload must be a JSON message');
  const payload = JSON.parse(message.content);
  assert.ok(Array.isArray(payload.candidates));
  return payload.candidates;
}

/** Echoes the ref + digest read from the actual outbound request. */
function echoTransport(marker, options = {}) {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const candidate = requestCandidates(init).find((entry) => entry.text.includes(marker));
    assert.ok(candidate, `request must carry the candidate containing ${marker}`);
    assert.equal(candidate.digest, sha256(candidate.text));
    return sseResponse({ status: 'selected', id: candidate.ref, digest: candidate.digest }, options);
  };
  return { fetchImpl, calls: () => calls };
}

function answeringTransport(answer) {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    requestCandidates(init);
    return sseResponse(answer);
  };
  return { fetchImpl, calls: () => calls };
}

function hangingTransport() {
  let calls = 0;
  const fetchImpl = (_url, init) => new Promise((_, reject) => {
    calls += 1;
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  return { fetchImpl, calls: () => calls };
}

function ledgerFor(label, maxTotalRequests = 3) {
  return createRequestLedger({
    file: path.join(ROOT, `ledger-${label}.jsonl`),
    maxTotalRequests,
  });
}

test('runner file is present for hash binding', () => {
  assert.ok(fs.existsSync(path.resolve(RUNNER_PATH)));
  assert.equal(sha256(fs.readFileSync(path.resolve(RUNNER_PATH))).length, 64);
});

test('request ledger refuses the fourth send before any transport call', () => {
  let calls = 0;
  const ledger = ledgerFor('cap');
  for (const caseId of ['a', 'b', 'c']) {
    ledger.begin(caseId);
    calls += 1;
  }
  assert.equal(calls, 3);
  assert.throws(() => {
    ledger.begin('d');
    calls += 1;
  }, /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(calls, 3);
  const rows = fs.readFileSync(path.join(ROOT, 'ledger-cap.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.filter((row) => JSON.parse(row).type === 'STARTED').length, 3);
});

test('exec-append: Native misses the target, Adaptive appends it and keeps Native content', async () => {
  const kase = loadCases().find((entry) => entry.id === 'exec-append');
  const ledger = ledgerFor('append');
  const native = await runCase({
    root: ROOT, kase, arm: 'native', adaptive: false, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: async () => { throw new Error('Native arm must not send'); },
  });
  assert.equal(native.transport.calls, 0);
  assert.equal(native.diagnostic, null);
  assert.ok(!native.context.includes(kase.targetText));
  assert.ok(native.budgetChars >= 1250, `budget must be expressible, got ${native.budgetChars}`);
  assert.equal(Math.floor(native.budgetTokens / 32), native.budgetChars);

  const echo = echoTransport(kase.targetText);
  const adaptive = await runCase({
    root: ROOT, kase, arm: 'adaptive', adaptive: true, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: echo.fetchImpl,
  });
  assert.equal(echo.calls(), 1);
  const verdict = classifyCase({ kase, native, adaptive });
  assert.equal(verdict.classification, 'TARGET_APPENDED_NATIVE_PRESERVED', JSON.stringify(verdict));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.removedPrincipleIds.length, 0);
  assert.deepEqual(verdict.addedPrincipleIds, ['fixture_verify']);
});

test('exec-abstain: model abstains and the final text is byte-identical', async () => {
  const kase = loadCases().find((entry) => entry.id === 'exec-abstain');
  const ledger = ledgerFor('abstain');
  const native = await runCase({
    root: ROOT, kase, arm: 'native', adaptive: false, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: async () => { throw new Error('Native arm must not send'); },
  });
  const abstain = answeringTransport({ status: 'none_applicable', id: null, digest: null });
  const adaptive = await runCase({
    root: ROOT, kase, arm: 'adaptive', adaptive: true, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: abstain.fetchImpl,
  });
  assert.equal(abstain.calls(), 1);
  assert.equal(adaptive.diagnostic.reason, 'adaptive_selection_none:no_increment');
  const verdict = classifyCase({ kase, native, adaptive });
  assert.equal(verdict.classification, 'ABSTAINED_NATIVE_UNCHANGED', JSON.stringify(verdict));
  assert.equal(verdict.pass, true);
  assert.equal(adaptive.context, native.context);
});

test('exec-nofit: a correct selection that cannot fit leaves Native untouched', async () => {
  const kase = loadCases().find((entry) => entry.id === 'exec-nofit');
  const ledger = ledgerFor('nofit');
  const native = await runCase({
    root: ROOT, kase, arm: 'native', adaptive: false, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: async () => { throw new Error('Native arm must not send'); },
  });
  assert.ok(!native.context.includes(kase.targetText));
  const echo = echoTransport(kase.targetText);
  const adaptive = await runCase({
    root: ROOT, kase, arm: 'adaptive', adaptive: true, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: echo.fetchImpl,
  });
  assert.equal(adaptive.diagnostic.reason, 'adaptive_selection_selected:selected');
  const verdict = classifyCase({ kase, native, adaptive });
  assert.equal(verdict.classification, 'SELECTED_NOT_PACKED', JSON.stringify(verdict));
  assert.equal(verdict.pass, true);
  assert.equal(adaptive.context, native.context);
  assert.equal(verdict.addedPrincipleIds.length, 0);
});

test('generation is not cancelled at the admission deadline (first-byte semantics)', async () => {
  const base = loadCases().find((entry) => entry.id === 'exec-append');
  const kase = { ...base, id: 'exec-generation-proof' };
  const ledger = ledgerFor('generation');
  const echo = echoTransport(kase.targetText, { delayMs: 120 });
  const adaptive = await runCase({
    root: ROOT, kase, arm: 'adaptive', adaptive: true, transport: TRANSPORT, limits: LIMITS, ledger,
    fetchImpl: echo.fetchImpl,
    // Admission deadline is 40 ms; the wire body only completes at ~120 ms.
    selectionTimeouts: { firstByteTimeoutMs: 40, generationTimeoutMs: 800 },
  });
  assert.equal(adaptive.diagnostic.reason, 'adaptive_selection_selected:selected', JSON.stringify(adaptive.diagnostic));
  assert.ok(adaptive.context.includes(kase.targetText));
});

test('the per-case host deadline aborts the transport and keeps Native', async () => {
  const base = loadCases().find((entry) => entry.id === 'exec-append');
  const kase = { ...base, id: 'exec-host-timeout' };
  const ledger = ledgerFor('host-timeout');
  const hanging = hangingTransport();
  const adaptive = await runCase({
    root: ROOT, kase, arm: 'adaptive', adaptive: true, transport: TRANSPORT,
    limits: { perCaseWallClockMs: 80, maxOutputTokens: 512 },
    ledger,
    fetchImpl: hanging.fetchImpl,
  });
  assert.equal(hanging.calls(), 1);
  assert.equal(adaptive.transport.hostDeadlineHit, true);
  assert.equal(adaptive.transport.abortReachedTransport, true);
  const verdict = classifyCase({
    kase,
    native: {
      status: 'COMPLETED', wallClockMs: 1, context: 'native', diagnostic: null,
      transport: { calls: 0, hostDeadlineHit: false },
    },
    adaptive,
  });
  assert.equal(verdict.classification, 'HOST_HOOK_TIMEOUT');
  assert.equal(verdict.pass, false);
});
