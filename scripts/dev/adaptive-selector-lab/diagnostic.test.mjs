import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundary, MODELS, URLS, validateDecision, validateSelection, hash,
  buildInputs, loadFixture, glmSelection } from './diagnostic.mjs';

const fixture = loadFixture();
const keys = { decision: 'fake-decision-secret', glm: 'fake-glm-secret' };
const decision = () => ({ model: MODELS.decision,
  answers: Object.fromEntries(Object.keys(fixture.questions).map(k => [k, { type: 'noul', noul: 0.2 }])) });
function setup(options = {}) {
  const ledger = { counts: { decision: 0, glm: 0 }, requests: [] };
  const sends = []; let persisted = 0;
  const boundary = createBoundary({ ledger, keys, persist: () => persisted++,
    fetchImpl: async (url, init) => { sends.push({ url, init }); return Response.json(decision()); }, ...options });
  return { ledger, sends, boundary, persisted: () => persisted };
}
const request = (extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODELS.decision, state: ['synthetic'], questions: fixture.questions,
    provider: { only: ['Respan'], allow_fallbacks: false }, ...extra }) });

test('frozen fixture and prompt projection exclude gold and principles from decision input', () => {
  const input = buildInputs(fixture.cases[0], fixture);
  assert.deepEqual(Object.keys(input.state).sort(), ['currentInput', 'previousTask']);
  assert.equal(JSON.stringify(input.glm).includes('acceptableSelections'), false);
  assert.equal(JSON.stringify(input.glm).includes('expectedDecision'), false);
  assert.equal(JSON.stringify(input.glm).includes('forbidden'), false);
  assert.equal(input.glm.untrustedAuxiliaryMeasurements, undefined);
});
test('valid overlapping probabilities are not normalized into fake exclusive labels', () => {
  const d = decision(); d.answers.new_task.noul = 0.9; d.answers.goal_shift.noul = 0.9;
  const scores = validateDecision(d);
  assert.equal(scores.new_task, 0.9); assert.equal(scores.goal_shift, 0.9);
});
for (const bad of [NaN, Infinity, -0.1, 1.1, '0.8', null]) {
  test(`reject invalid probability ${String(bad)}`, () => {
    const d = decision(); d.answers.new_task.noul = bad;
    assert.throws(() => validateDecision(d), /PROTOCOL/);
  });
}
test('missing probability or unknown model cannot masquerade as a successful decision', () => {
  const d = decision(); delete d.answers.goal_shift;
  assert.throws(() => validateDecision(d), /PROTOCOL/);
  assert.throws(() => validateDecision({ ...decision(), model: 'paid-model' }), /PROTOCOL/);
});
test('selection requires exact candidate digest; abstention cannot smuggle a target', () => {
  const c = fixture.candidates[0];
  assert.equal(validateSelection({ status: 'selected', id: c.id, digest: hash(c.text) }, fixture.candidates).id, c.id);
  assert.throws(() => validateSelection({ status: 'selected', id: c.id, digest: 'old' }, fixture.candidates), /REFERENCE/);
  assert.throws(() => validateSelection({ status: 'selected', id: 'unknown', digest: 'old' }, fixture.candidates), /REFERENCE/);
  assert.throws(() => validateSelection({ status: 'uncertain', id: c.id, digest: null }, fixture.candidates), /PROTOCOL/);
});
test('transport records attempt before send, and blocks a hidden second request', async () => {
  const s = setup(); const send = s.boundary('decision', 'dev-01', 'D');
  await send(URLS.decision, request());
  assert.equal(s.sends.length, 1); assert.equal(s.ledger.counts.decision, 1);
  assert.equal(s.persisted(), 2); assert.equal(s.ledger.requests[0].status, 'RECEIVED');
  await assert.rejects(send(URLS.decision, request()), /BUDGET/);
  assert.equal(s.sends.length, 1);
  assert.equal(JSON.stringify(s.ledger).includes(keys.decision), false);
});
test('global sixth decision limit covers independent invocation closures', async () => {
  const s = setup();
  for (let i = 0; i < 6; i++) await s.boundary('decision', `dev-${i}`, 'D')(URLS.decision, request());
  await assert.rejects(s.boundary('decision', 'extra', 'D')(URLS.decision, request()), /BUDGET/);
  assert.equal(s.sends.length, 6);
});
test('endpoint/model/fallback/input/secret failures send zero requests', async () => {
  for (const [url, body] of [
    ['https://untrusted.invalid/decisions', request()],
    [URLS.decision, request({ model: 'paid-model' })],
    [URLS.decision, request({ provider: { only: ['Respan'], allow_fallbacks: true } })],
    [URLS.decision, request({ state: ['x'.repeat(6001)] })],
    [URLS.decision, request({ state: [keys.glm] })],
  ]) {
    const s = setup(); await assert.rejects(s.boundary('decision', 'dev-01', 'D')(url, body));
    assert.equal(s.sends.length, 0); assert.equal(s.ledger.counts.decision, 0);
  }
});
test('429 refusal is counted once and provider error text is never persisted', async () => {
  let sends = 0;
  const s = setup({ fetchImpl: async () => { sends++; return new Response(keys.decision, { status: 429 }); } });
  await assert.rejects(s.boundary('decision', 'dev-01', 'D')(URLS.decision, request()), /HTTP_429/);
  assert.equal(sends, 1); assert.equal(s.ledger.counts.decision, 1);
  assert.equal(JSON.stringify(s.ledger).includes(keys.decision), false);
});
test('deadline abort reaches transport and timeout stays in the denominator', async () => {
  let aborted = false;
  const s = setup({ requestMs: 20, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test must abort before this')), 1000);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(new Error('secret')); }, { once: true });
  }) });
  await assert.rejects(s.boundary('decision', 'dev-01', 'D')(URLS.decision, request()), /TIMEOUT/);
  assert.equal(aborted, true); assert.equal(s.ledger.counts.decision, 1);
});
test('expired whole-run deadline refuses before send', async () => {
  const s = setup({ now: () => 100, endAt: 99 });
  await assert.rejects(s.boundary('decision', 'dev-01', 'D')(URLS.decision, request()), /BUDGET/);
  assert.equal(s.sends.length, 0);
});
test('the twelfth GLM call is the last allowed send, even across fresh closures', async () => {
  let sent = 0;
  const s = setup({ fetchImpl: async () => { sent++; return Response.json({ model: MODELS.glm }); } });
  const init = { method: 'POST', body: JSON.stringify({ model: MODELS.glm, messages: [], max_tokens: 512 }) };
  for (let i = 0; i < 12; i++) await s.boundary('glm', 'dev', 'C')(URLS.glm, init);
  await assert.rejects(s.boundary('glm', 'extra', 'D')(URLS.glm, init), /BUDGET/);
  assert.equal(sent, 12);
  const t = setup();
  await assert.rejects(t.boundary('glm', 'dev', 'C')(URLS.glm,
    { ...init, body: JSON.stringify({ model: MODELS.glm, messages: [], max_tokens: 513 }) }), /OUTPUT_BUDGET/);
  assert.equal(t.sends.length, 0);
});
test('unexpected provider, model substitution or a charged free response stops after one attempt', async () => {
  for (const packet of [{ ...decision(), provider: 'Other' }, { ...decision(), model: 'paid-model' },
    { ...decision(), usage: { cost: 0.01 } }]) {
    const s = setup({ fetchImpl: async () => Response.json(packet) });
    await assert.rejects(s.boundary('decision', 'dev', 'D')(URLS.decision, request()), /ALLOWLISTED|CHARGE/);
    assert.equal(s.ledger.counts.decision, 1);
  }
});
test('oversize response is bounded and cancelled instead of entering the SDK', async () => {
  const s = setup({ fetchImpl: async () => new Response('x'.repeat(65537)) });
  await assert.rejects(s.boundary('decision', 'dev', 'D')(URLS.decision, request()), /RESPONSE_TOO_LARGE/);
  assert.equal(s.ledger.counts.decision, 1);
});
test('actual pi-ai adapter emits one bounded GLM request through the injected boundary', async () => {
  const { PiAiRuntimeAdapter } = await import('../../../packages/principles-core/dist/runtime-v2/adapter/pi-ai-runtime-adapter.js');
  const old = process.env.ZAI_CODING_CN_API_KEY;
  process.env.ZAI_CODING_CN_API_KEY = keys.glm;
  const c = fixture.candidates[0];
  const output = { status: 'selected', id: c.id, digest: hash(c.text) };
  const packets = [
    { id: 'fake', model: MODELS.glm, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: null }] },
    { id: 'fake', model: MODELS.glm, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 } },
  ];
  let sends = 0; let emitted;
  const s = setup({ fetchImpl: async (_url, init) => { sends++; emitted = JSON.parse(init.body);
    return new Response(packets.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  try {
    const result = await glmSelection({ PiAiRuntimeAdapter, fetch: s.boundary('glm', 'dev-01', 'C'),
      payload: buildInputs(fixture.cases[0], fixture).glm, candidates: fixture.candidates });
    assert.equal(result.id, c.id); assert.equal(sends, 1); assert.equal(s.ledger.counts.glm, 1);
    assert.equal(emitted.max_tokens, 512); assert.equal(emitted.model, MODELS.glm);
    assert.equal(s.ledger.requests[0].usage.completion_tokens, 25);
  } finally {
    if (old === undefined) delete process.env.ZAI_CODING_CN_API_KEY; else process.env.ZAI_CODING_CN_API_KEY = old;
  }
});
test('actual pi-ai adapter cannot retry a failed provider request', async () => {
  const { PiAiRuntimeAdapter } = await import('../../../packages/principles-core/dist/runtime-v2/adapter/pi-ai-runtime-adapter.js');
  const old = process.env.ZAI_CODING_CN_API_KEY; process.env.ZAI_CODING_CN_API_KEY = keys.glm;
  let sends = 0;
  const s = setup({ fetchImpl: async () => { sends++; return new Response('provider error', { status: 500 }); } });
  try {
    await assert.rejects(glmSelection({ PiAiRuntimeAdapter, fetch: s.boundary('glm', 'dev-01', 'C'),
      payload: buildInputs(fixture.cases[0], fixture).glm, candidates: fixture.candidates }));
    assert.equal(sends, 1); assert.equal(s.ledger.counts.glm, 1);
    assert.equal(s.ledger.requests[0].failure, 'HTTP_500');
  } finally {
    if (old === undefined) delete process.env.ZAI_CODING_CN_API_KEY; else process.env.ZAI_CODING_CN_API_KEY = old;
  }
});
