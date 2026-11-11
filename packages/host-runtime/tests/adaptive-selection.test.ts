/**
 * The adaptive selector's transport contract after PRI-1182.
 *
 * History: before this PR the selector was `createSingleModelSelector`, which
 * sent an agent run through `PiAiRuntimeAdapter` and required the registered
 * `adaptive-selection-output` schema (S5). PRI-1182 replaces that transport with
 * one Decisions POST, so the adapter-specific assertions have no subject here.
 * The guarantees they protected are re-asserted against the new transport:
 *
 *   - an unparseable answer is labelled SELECTION_OUTPUT_INVALID, not the
 *     generic TRANSPORT_FAILED;
 *   - a structurally incomplete answer is labelled by the protocol
 *     (DECISION_QUESTION_MISMATCH), not by the transport;
 *   - exactly one POST is made, so the turn cannot pay twice.
 *
 * `SELECTION_SCHEMA_UNAVAILABLE` / `SELECTION_AMBIGUOUS` had no remaining
 * producer on this path and were removed from the failure union instead of
 * being kept as types only. The deadline accepted/expired split is covered by
 * the hook-level frozen-envelope tests.
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createDecisionSelector,
  type AdaptiveCandidate,
  type DecisionSelectorOptions,
} from '../src/adaptive-selection.js';
import type {DecisionRequestEnvelope} from '../src/adaptive-decision-protocol.js';

const endpoint = 'https://openrouter.ai/api/alpha/decisions';
const model = 'respan/span-01-lite:free';
const apiKeyEnv = 'PRI_1182_TEST_KEY';

const candidates: readonly AdaptiveCandidate[] = [
  {
    ref: 'c1',
    text: 'Prefer additive delivery over rewrites.',
    digest: 'digest-c1',
    principle: {} as AdaptiveCandidate['principle'],
  },
];

const body: DecisionRequestEnvelope = {
  model,
  state: 'select at most one principle for this turn',
  questions: {
    candidate_c1: {type: 'noul', instructions: 'does candidate c1 apply now?'},
    insufficient_context: {type: 'noul', instructions: 'is context insufficient?'},
  },
  provider: {only: ['Respan'], allow_fallbacks: false},
};

const questionIds = ['candidate_c1', 'insufficient_context'];

function selector(fetchImpl: typeof fetch, now: () => number = Date.now): ReturnType<typeof createDecisionSelector> {
  const options: DecisionSelectorOptions = {
    endpoint,
    model: {endpoint, model, provider: 'Respan', apiKeyEnv},
    admissionDeadlineAt: now() + 5_000,
    generationTimeoutMs: 500,
    fetchImpl,
    now,
  };
  return createDecisionSelector(options);
}

function respondWith(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: {'Content-Type': 'application/json'},
  })) as typeof fetch;
}

afterEach(() => {
  delete process.env[apiKeyEnv];
  vi.restoreAllMocks();
});

describe('createDecisionSelector — one Decisions request per turn', () => {
  it('sends exactly one POST and applies an in-time complete answer', async () => {
    process.env[apiKeyEnv] = 'test-key';
    const fetchImpl = vi.fn(respondWith({
      model,
      provider: 'Respan',
      answers: {
        candidate_c1: {type: 'noul', noul: 0.95},
        insufficient_context: {type: 'noul', noul: 0.1},
      },
    }));
    const s = selector(fetchImpl as unknown as typeof fetch);

    const outcome = await s.select({body, questionIds, candidates});

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(JSON.parse(String(init.body)).model).toBe(model);
    expect(outcome).toEqual({
      status: 'selected',
      ref: 'c1',
      reason: 'selected',
      scores: {candidate_c1: 0.95, insufficient_context: 0.1},
    });
    expect(s.report().sends).toBe(1);
  });

  it('labels an unparseable decision body as SELECTION_OUTPUT_INVALID, not TRANSPORT_FAILED', async () => {
    process.env[apiKeyEnv] = 'test-key';
    const fetchImpl = (async () => new Response('not-json', {status: 200})) as typeof fetch;
    const s = selector(fetchImpl);

    await expect(s.select({body, questionIds, candidates})).rejects.toThrow('SELECTION_OUTPUT_INVALID');
    expect(s.report().failure).toBe('SELECTION_OUTPUT_INVALID');
    expect(s.report().status).toBe('failed');
  });

  it('labels a structurally incomplete answer by protocol code, not transport', async () => {
    process.env[apiKeyEnv] = 'test-key';
    const fetchImpl = respondWith({
      model,
      provider: 'Respan',
      // `candidate_c1` is missing: a complete table is required before any
      // selection is applied.
      answers: {insufficient_context: {type: 'noul', noul: 0.1}},
    });
    const s = selector(fetchImpl);

    await expect(s.select({body, questionIds, candidates})).rejects.toThrow('DECISION_QUESTION_MISMATCH');
    expect(s.report().failure).toBe('DECISION_QUESTION_MISMATCH');
    expect(s.report().status).toBe('failed');
  });
});
