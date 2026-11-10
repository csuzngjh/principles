// PRI-1122 single-model selection arm — acceptance wiring tests.
//
// Fake transport drives the REAL PiAiRuntimeAdapter; the REAL Runtime V2 Reader
// and the REAL shared assembly (`buildActivePrinciplePromptContext`) produce the
// final text. No network, no production workspace, no governance write besides
// the throwaway fixture workspaces under the OS temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePromptBudget } from '@principles/core/runtime';
import {
  buildActivePrinciplePromptContext,
  readPromptActivationCandidates,
} from '@principles/host-runtime';
import {
  measureFixtureCosts as costs,
  mutateFixtureDb as mutateDb,
  seedFixtureWorkspace as seedWorkspace,
} from './fixture-workspace.mjs';
import { PiAiRuntimeAdapter } from '../../../packages/principles-core/dist/runtime/adapter/pi-ai-runtime-adapter.js';
import {
  LIMITS,
  buildBoundedSelectionInput,
  createSingleModelSelector,
  localFailureCode,
  runSelectionOpportunity,
  validateSelectionResult,
  hash,
} from './orchestrator.mjs';

process.env.ZAI_CODING_CN_API_KEY = process.env.ZAI_CODING_CN_API_KEY || 'fake-test-key';

const TEXT = {
  SCOPE: '只修改与任务直接相关的文件，邻近改进记为后续事项。',
  BIG: '避免为假设的未来需求预建抽象和额外服务。'.repeat(40),
  DELIVERY: '交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论。',
  TESTS: '修复缺陷时先写能复现问题的回归测试，再改实现。',
  DRAFT: '起草阶段先明确目标与约束，不提前宣称完成。',
};

let counter = 0;
const tempWorkspace = (label) => {
  counter += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `pri1122-${label}-${counter}-`));
};

const deleteApproval = (workspaceDir, artifactId) => mutateDb(workspaceDir,
  (db) => db.prepare('DELETE FROM approvals WHERE artifact_id = ?').run(artifactId));

const deactivate = (workspaceDir, activationId) => mutateDb(workspaceDir,
  (db) => db.prepare('UPDATE activations SET deactivated_at = ? WHERE activation_id = ?').run(new Date().toISOString(), activationId));

const rewriteArtifact = (workspaceDir, artifactId, principleId, text) => mutateDb(workspaceDir,
  (db) => db.prepare('UPDATE pi_artifacts SET content_json = ?, updated_at = ? WHERE artifact_id = ?')
    .run(JSON.stringify({ principleId, text }), new Date().toISOString(), artifactId));

async function selectionPayload(workspaceDir, principleId) {
  if (principleId === null) return { status: 'none_applicable', id: null, digest: null };
  if (typeof principleId === 'object') return principleId;
  const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  const index = read.principles.findIndex((principle) => principle.principleId === principleId);
  assert.notEqual(index, -1, `fixture principle ${principleId} must be an active candidate`);
  return { status: 'selected', id: `c${index + 1}`, digest: hash(read.principles[index].text) };
}

// Read the candidate list out of the ACTUAL outbound request body. The tests
// below build their answer from this, so a payload that forgets the locally
// precomputed digest fails here instead of silently passing.
function requestCandidates(send) {
  assert.ok(send, 'the selection request must have been sent');
  const body = JSON.parse(send.init.body);
  const message = (body.messages ?? []).find(
    (item) => typeof item.content === 'string' && item.content.trim().startsWith('{'),
  );
  assert.ok(message, 'the selection payload must be sent as a JSON message');
  const payload = JSON.parse(message.content);
  assert.ok(Array.isArray(payload.candidates), 'the request must carry a candidate list');
  return payload.candidates;
}

function echoFromRequest(sends, marker) {
  const candidates = requestCandidates(sends.at(-1));
  const candidate = candidates.find((item) => item.text.includes(marker));
  assert.ok(candidate, `the request must carry the candidate containing ${marker}`);
  assert.equal(typeof candidate.digest, 'string', 'the request must carry a locally precomputed digest');
  assert.match(candidate.digest, /^[a-f0-9]{64}$/u, 'the digest must be a sha256 hex string');
  assert.equal(candidate.digest, hash(candidate.text), 'the digest must be sha256 of the candidate text');
  return { status: 'selected', id: candidate.ref, digest: candidate.digest };
}

function sse(payload) {
  const packets = [
    { id: 'fake', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: null }] },
    { id: 'fake', model: 'glm-5.3-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}

function selectorFor({ payload, choose, fetchOverride, now = Date.now, deadlineAt = Date.now() + LIMITS.selectTimeoutMs }) {
  const sends = [];
  const fetch = async (url, init) => {
    sends.push({ url, init });
    if (fetchOverride) return fetchOverride({ url, init, sends });
    if (choose) return sse(choose({ url, init, sends }));
    return sse(payload);
  };
  const selector = createSingleModelSelector({ PiAiRuntimeAdapter, fetch, now, deadlineAt });
  return { select: selector.select, selectorReport: selector.report, sends };
}

const budgetResolution = (budgetChars) => ({ ...resolvePromptBudget(), budgetChars });

async function fourCandidateWorkspace(label) {
  const workspaceDir = tempWorkspace(label);
  await seedWorkspace(workspaceDir, [
    { key: 'A', principleId: 'SCOPE', text: TEXT.SCOPE },
    { key: 'B', principleId: 'BIG', text: TEXT.BIG },
    { key: 'T', principleId: 'DELIVERY', text: TEXT.DELIVERY },
    { key: 'C', principleId: 'TESTS', text: TEXT.TESTS },
  ]);
  const measured = await costs(workspaceDir);
  assert.deepEqual(measured.order, ['SCOPE', 'BIG', 'DELIVERY', 'TESTS']);
  return { workspaceDir, ...measured };
}

test('bounded input separates the current instruction from prior history and drops whole old messages', () => {
  const candidates = [
    { principleId: 'P1', artifactId: 'a1', activationId: 'x1', artifactContentSha256: 'a'.repeat(64), text: '原则一', authority: 'owner', approvedBy: 'owner-test' },
  ];
  const priorMessages = ['x'.repeat(LIMITS.maxInputChars), '第一条历史', '第二条历史'];
  const bounded = buildBoundedSelectionInput({ currentInput: '当前任务：交付验收', priorMessages, candidates });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.payload.currentInstruction, '当前任务：交付验收');
  assert.equal(bounded.payload.candidates.length, 1);
  assert.equal(bounded.payload.candidates[0].ref, 'c1');
  assert.equal(bounded.byRef.get('c1').principle.principleId, 'P1');
  // The oversized history message is dropped whole, the newest short one kept.
  assert.equal(bounded.payload.priorContext.some((message) => message.text === 'x'.repeat(LIMITS.maxInputChars)), false);
  assert.equal(bounded.payload.priorContext.at(-1).text, '第二条历史');
  assert.equal(bounded.priorDropped, 1);
  // Evaluation answers are never part of the model input.
  assert.equal(JSON.stringify(bounded.payload).includes('allowedSelections'), false);
});

test('candidate cap refuses instead of truncating and falls back to Native with zero sends', async () => {
  const { workspaceDir } = await fourCandidateWorkspace('cap');
  const principles = Array.from({ length: LIMITS.maxCandidates + 1 }, (_, index) => ({
    principleId: `P${index}`,
    artifactId: `a${index}`,
    activationId: `x${index}`,
    artifactContentSha256: 'b'.repeat(64),
    text: `原则${index}`,
    authority: 'owner',
    approvedBy: 'owner-test',
  }));
  let called = 0;
  const result = await runSelectionOpportunity({
    workspaceDir,
    promptBudget: budgetResolution(100000),
    currentInput: '继续实现',
    readCandidates: async () => ({ principles, warnings: [], aborted: false, selfReportEnabled: false }),
    select: async () => { called += 1; throw new Error('must not be called'); },
    selectorReport: () => ({ sends: 0, status: 'not_called', failure: null }),
  });
  assert.equal(called, 0);
  assert.equal(result.selection.reason, 'candidate_cap_exceeded');
  assert.equal(result.model.sends, 0);
  assert.equal(result.outcome, 'native_baseline');
  assert.equal(result.additionalContext, result.nativeContext);
});

test('positive: Native misses the target, generic model selects it, shared assembly adds it and keeps the native set', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('positive');
  // Legacy Native stops at the first non-fit (BIG), leaving DELIVERY out even
  // though it would fit later. Placing it first must not displace SCOPE.
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
  assert.deepEqual(native.activationIds, ['act-A']);
  assert.equal(native.additionalContext.includes(TEXT.DELIVERY), false);

  // The answer is minted from the ACTUAL request body: reference AND digest
  // come out of the payload PD really sent, never from a test-side hash.
  const { select, selectorReport, sends } = selectorFor({
    choose: ({ sends: sent }) => echoFromRequest(sent, TEXT.DELIVERY),
  });
  const result = await runSelectionOpportunity({
    workspaceDir,
    promptBudget,
    currentInput: '请交付验收：这次改动已经全部完成了吗？',
    priorMessages: ['先完成草稿，暂不进入验收。'],
    select,
    selectorReport,
  });

  // Checked AFTER the run so a missing digest fails with its real name instead
  // of being swallowed as a transport error by the adapter.
  const outbound = requestCandidates(sends[0]);
  assert.ok(outbound.length > 0);
  for (const candidate of outbound) {
    assert.equal(typeof candidate.digest, 'string', 'the outbound payload must carry a locally precomputed digest');
    assert.equal(candidate.digest, hash(candidate.text), 'the outbound digest must be sha256 of the candidate text');
  }
  assert.equal(result.outcome, 'dynamic_added');
  assert.equal(result.selection.status, 'selected');
  assert.equal(result.selection.principleId, 'DELIVERY');
  assert.equal(result.model.sends, 1);
  assert.equal(sends.length, 1);
  assert.equal(result.assembly.targetSnapshotVerified, true);
  assert.equal(result.assembly.addedTarget, true);
  assert.equal(result.assembly.lostNative.length, 0);
  assert.equal(result.assembly.mandatoryPreserved, true);
  assert.equal(result.assembly.targetDirectiveCount, 1);
  assert.deepEqual(result.assembly.finalActivationIds, ['act-T', 'act-A']);
  assert.equal(result.additionalContext.includes(TEXT.DELIVERY), true);
  assert.equal(result.additionalContext.includes(TEXT.SCOPE), true);
  assert.equal(result.model.diagnostics.httpStatus, 200);
  assert.equal(result.model.diagnostics.finishReason, 'stop');
  assert.equal(Number.isFinite(result.model.diagnostics.firstByteAt), true);
});

test('gate: a reply without the digest carried by the request can never select', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('no-digest');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  // Models cannot compute sha256. Without a digest in the payload the model can
  // only answer selected+null, and PD must refuse instead of applying text.
  const { select, selectorReport, sends } = selectorFor({
    choose: ({ sends: sent }) => {
      const [candidate] = requestCandidates(sent.at(-1));
      assert.equal(typeof candidate.text, 'string');
      return { status: 'selected', id: candidate.ref, digest: null };
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '请交付验收', select, selectorReport,
  });
  assert.equal(sends.length, 1);
  assert.equal(result.model.sends, 1);
  assert.equal(result.outcome, 'selection_failed');
  assert.equal(result.selection.reason, 'SELECTION_REFERENCE_INVALID');
  assert.equal(result.additionalContext, result.nativeContext);
  assert.equal(result.additionalContext.includes(TEXT.DELIVERY), false);
});

test('gate: a fabricated digest for a real reference is rejected', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('fake-digest');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const { select, selectorReport } = selectorFor({
    choose: ({ sends }) => {
      const [candidate] = requestCandidates(sends.at(-1));
      return { status: 'selected', id: candidate.ref, digest: hash('guessed-body') };
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '请交付验收', select, selectorReport,
  });
  assert.equal(result.outcome, 'selection_failed');
  assert.equal(result.selection.reason, 'SELECTION_REFERENCE_INVALID');
  assert.equal(result.additionalContext, result.nativeContext);
});

test('no applicable principle abstains and keeps the Native text byte-identical', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('abstain');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + 10);
  const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
  const { select, selectorReport } = selectorFor({ payload: { status: 'none_applicable', id: null, digest: null } });
  const result = await runSelectionOpportunity({
    workspaceDir,
    promptBudget,
    currentInput: '继续实现下一个模块',
    priorMessages: ['历史消息里提到“请交付验收”，但那是上一次任务。'],
    select,
    selectorReport,
  });
  assert.equal(result.selection.status, 'none_applicable');
  assert.equal(result.outcome, 'selection_abstained');
  assert.equal(result.additionalContext, native.additionalContext);
  assert.equal(result.additionalContext.includes('请交付验收'), false);
  assert.equal(result.additionalContext.includes('继续实现下一个模块'), false);
});

test('gate: Native already carries the target; it is reported once and never counted as dynamic', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('present');
  const total = Object.values(byPrincipleId).reduce((sum, value) => sum + value, 0);
  const promptBudget = budgetResolution(base + total + 100);
  const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
  assert.equal(native.activationIds.includes('act-T'), true);
  const { select, selectorReport } = selectorFor({ payload: await selectionPayload(workspaceDir, 'DELIVERY') });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收', select, selectorReport,
  });
  assert.equal(result.outcome, 'target_present');
  assert.equal(result.assembly.targetAlreadyInNative, true);
  assert.equal(result.assembly.addedTarget, false);
  assert.equal(result.assembly.targetDirectiveCount, 1);
  assert.equal(result.additionalContext, native.additionalContext);
});

test('tight budget: target is selected but cannot be packed; the text stays Native', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('tight');
  const promptBudget = budgetResolution(base + byPrincipleId.DELIVERY + 5);
  const native = await buildActivePrinciplePromptContext({ workspaceDir, promptBudget });
  assert.deepEqual(native.activationIds, ['act-A']);
  const { select, selectorReport } = selectorFor({ payload: await selectionPayload(workspaceDir, 'DELIVERY') });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收', select, selectorReport,
  });
  assert.equal(result.selection.status, 'selected');
  assert.equal(result.outcome, 'selected_not_packed');
  assert.equal(result.assembly.selectedButNotPacked, true);
  assert.equal(result.assembly.adaptiveReason, 'mandatory_constraint_displaced');
  assert.equal(result.additionalContext, native.additionalContext);
  assert.deepEqual(result.assembly.finalActivationIds, native.activationIds);
});

test('out-of-candidate and previous-round references fail closed to Native', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('reference');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);

  const outside = selectorFor({ payload: { status: 'selected', id: 'c9', digest: 'f'.repeat(64) } });
  const first = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: outside.select, selectorReport: outside.selectorReport,
  });
  assert.equal(first.outcome, 'selection_failed');
  assert.equal(first.selection.reason, 'SELECTION_REFERENCE_INVALID');
  assert.equal(first.additionalContext, first.nativeContext);

  // A response minted against another call's candidate order cannot be replayed
  // into this call: c1 now points at a different text digest.
  const stale = await selectionPayload(workspaceDir, 'SCOPE');
  stale.digest = 'e'.repeat(64);
  const replay = selectorFor({ payload: stale });
  const second = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: replay.select, selectorReport: replay.selectorReport,
  });
  assert.equal(second.outcome, 'selection_failed');
  assert.equal(second.selection.reason, 'SELECTION_REFERENCE_INVALID');
  assert.equal(second.additionalContext, second.nativeContext);
});

test('a revised target during the model wait is rejected; Native is re-read', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('revised');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const payload = await selectionPayload(workspaceDir, 'DELIVERY');
  const selector = selectorFor({
    fetchOverride: () => {
      rewriteArtifact(workspaceDir, 'art-T', 'DELIVERY', '交付验收（修订版）：只引用可复核的产物。');
      return sse(payload);
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: selector.select, selectorReport: selector.selectorReport,
  });
  assert.equal(result.selection.status, 'selected');
  assert.equal(result.outcome, 'native_baseline');
  assert.equal(result.assembly.fallback, 'reread_native_after_revalidation_failure');
  assert.equal(result.assembly.fallbackReason, 'pre_assembly_revalidation_failed');
  assert.equal(result.additionalContext.includes('修订版'), false);
  assert.equal(result.additionalContext.includes(TEXT.DELIVERY), false);
});

test('an authorization change during the model wait is rejected even when ids match', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('authority');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const payload = await selectionPayload(workspaceDir, 'DELIVERY');
  const selector = selectorFor({
    fetchOverride: () => {
      deleteApproval(workspaceDir, 'art-T'); // owner → system_policy, same ids/text
      return sse(payload);
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: selector.select, selectorReport: selector.selectorReport,
  });
  assert.equal(result.outcome, 'native_baseline');
  assert.equal(result.assembly.fallback, 'reread_native_after_revalidation_failure');
  assert.equal(result.additionalContext.includes(TEXT.DELIVERY), false);
});

test('a deactivated target during the model wait is rejected; Native is re-read', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('deactivated');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const selector = selectorFor({
    choose: ({ sends }) => {
      const answer = echoFromRequest(sends, TEXT.DELIVERY);
      deactivate(workspaceDir, 'act-T');
      return answer;
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: selector.select, selectorReport: selector.selectorReport,
  });
  assert.equal(result.selection.status, 'selected');
  assert.equal(result.outcome, 'native_baseline');
  assert.equal(result.assembly.fallbackReason, 'pre_assembly_revalidation_failed');
  assert.equal(result.additionalContext.includes(TEXT.DELIVERY), false);
});

test('an HTTP failure is not retried: exactly one send and no repair round', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('no-retry');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  let calls = 0;
  const { select, selectorReport, sends } = selectorFor({
    fetchOverride: () => {
      calls += 1;
      return new Response('{"error":"upstream"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收', select, selectorReport,
  });
  assert.equal(calls, 1);
  assert.equal(sends.length, 1);
  assert.equal(result.model.sends, 1);
  assert.equal(result.outcome, 'selection_failed');
  assert.equal(result.additionalContext, result.nativeContext);
  assert.equal(result.model.diagnostics.httpStatus, 500);
  assert.equal(result.model.diagnostics.finishReason, 'unknown');
});

test('revalidation passes but the packer next read sees a changed revision: increment is dropped', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('packer-drift');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const payload = await selectionPayload(workspaceDir, 'DELIVERY');
  const selector = selectorFor({ payload });
  let adaptiveCalls = 0;
  const buildContext = async (args) => {
    if (args.adaptivePriority) {
      adaptiveCalls += 1;
      // The pre-assembly revalidation has already passed; change the artifact
      // right before the packer's own first read.
      rewriteArtifact(workspaceDir, 'art-T', 'DELIVERY', '交付验收（装配时改写）：这条正文不应被注入。');
    }
    return buildActivePrinciplePromptContext(args);
  };
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: selector.select, selectorReport: selector.selectorReport, buildContext,
  });
  assert.equal(adaptiveCalls, 1);
  assert.equal(result.outcome, 'native_baseline');
  assert.equal(result.assembly.fallbackReason, 'target_snapshot_mismatch');
  assert.equal(result.assembly.targetChangedDuringWait, true);
  assert.equal(result.additionalContext.includes('装配时改写'), false);
});

test('a late but structurally valid response is not applied, and a second send is blocked before the network', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('late');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  const payload = await selectionPayload(workspaceDir, 'DELIVERY');
  let clock = 1_000_000;
  const deadlineAt = clock + 1_000;
  const selector = selectorFor({
    payload, now: () => clock, deadlineAt,
    fetchOverride: ({ sends }) => {
      assert.equal(sends.length, 1);
      clock = deadlineAt + 1; // arrives one tick after the frozen deadline
      return sse(payload);
    },
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收', deadlineAt,
    select: selector.select, selectorReport: selector.selectorReport,
  });
  assert.equal(result.outcome, 'selection_failed');
  assert.equal(result.selection.reason, 'SELECTION_EXPIRED');
  assert.equal(result.model.sends, 1);
  assert.equal(selector.sends.length, 1);
  assert.equal(result.additionalContext, result.nativeContext);

  await assert.rejects(selector.select({ input: { payload: {}, entries: [] } }), /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(selector.sends.length, 1);
});

test('deadline cancellation reaches fetch, and Native still returns', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('cancel');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);
  let aborted = false;
  const selector = selectorFor({
    deadlineAt: Date.now() + 80,
    fetchOverride: ({ init }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted-by-deadline'));
      }, { once: true });
    }),
  });
  const result = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: selector.select, selectorReport: selector.selectorReport,
  });
  assert.equal(aborted, true);
  assert.equal(result.model.sends, 1);
  assert.equal(result.outcome, 'selection_failed');
  assert.equal(result.additionalContext, result.nativeContext);
});

test('malformed output and a failing assembly dependency both fall back to Native', async () => {
  const { workspaceDir, base, byPrincipleId } = await fourCandidateWorkspace('malformed');
  const promptBudget = budgetResolution(base + byPrincipleId.SCOPE + byPrincipleId.DELIVERY + 10);

  const malformed = selectorFor({ payload: { status: 'bogus', id: null, digest: null } });
  const first = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: malformed.select, selectorReport: malformed.selectorReport,
  });
  assert.equal(first.outcome, 'selection_failed');
  assert.equal(first.selection.reason, 'SELECTION_PROTOCOL_INVALID');
  assert.equal(first.additionalContext, first.nativeContext);

  const payload = await selectionPayload(workspaceDir, 'DELIVERY');
  const valid = selectorFor({ payload });
  const buildContext = async (args) => {
    if (args.adaptivePriority) throw new Error('assembly dependency down');
    return buildActivePrinciplePromptContext(args);
  };
  const second = await runSelectionOpportunity({
    workspaceDir, promptBudget, currentInput: '交付验收',
    select: valid.select, selectorReport: valid.selectorReport, buildContext,
  });
  assert.equal(second.outcome, 'native_baseline');
  assert.equal(second.assembly.fallbackReason, 'assembly_dependency_failed');
  assert.equal(second.additionalContext, second.nativeContext);
});

test('ambiguous duplicate references, digest mismatch and structural errors are protocol failures', () => {
  const entries = [
    { ref: 'c1', text: '同一原则的旧版正文', principle: { principleId: 'DUP', artifactId: 'a1', activationId: 'x1' } },
    { ref: 'c2', text: '同一原则的新版正文', principle: { principleId: 'DUP', artifactId: 'a2', activationId: 'x2' } },
  ];
  assert.throws(() => validateSelectionResult({ status: 'selected', id: 'c1', digest: hash(entries[0].text) }, entries), /SELECTION_AMBIGUOUS/);
  assert.throws(() => validateSelectionResult({ status: 'selected', id: 'c1', digest: hash('wrong') }, [entries[0]]), /SELECTION_REFERENCE_INVALID/);
  assert.throws(() => validateSelectionResult({ status: 'uncertain', id: 'c1', digest: null }, entries), /SELECTION_PROTOCOL_INVALID/);
  assert.deepEqual(validateSelectionResult({ status: 'uncertain', id: null, digest: null }, entries), { status: 'uncertain', id: null, digest: null });
  assert.equal(localFailureCode(new Error('SELECTION_AMBIGUOUS')), 'SELECTION_AMBIGUOUS');
});
