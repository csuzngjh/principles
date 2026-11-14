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
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  ADAPTIVE_ACTIVATION_FLAG,
  resolveAdaptiveSelectionModel,
} from '../src/adaptive-priority-provider.js';
import type {PdConfig} from '@principles/core/runtime';
import {
  createDecisionSelector,
  type AdaptiveCandidate,
  type DecisionSelectorOptions,
} from '../src/adaptive-selection.js';
import {
  validateDecisionResponse,
  type DecisionRequestEnvelope,
} from '../src/adaptive-decision-protocol.js';

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
    requestTimeoutMs: 500,
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

/**
 * PRI-1182 merge condition: removing `SELECTION_SCHEMA_UNAVAILABLE` is only
 * valid if the new path still separates a CONFIGURATION fault from a TRANSPORT
 * fault. The assertions below pin that separation: every configuration fault
 * reports `needs_setup` with its own reason, every malformed answer reports a
 * protocol code, and only a real fetch rejection reports `TRANSPORT_FAILED`.
 */
describe('configuration faults stay distinguishable from transport failure', () => {
  const features = {[ADAPTIVE_ACTIVATION_FLAG]: {enabled: true}};
  const configWith = (adaptiveActivation?: Record<string, unknown>): PdConfig => ({
    features,
    ...(adaptiveActivation ? {adaptiveActivation} : {}),
  }) as unknown as PdConfig;

  it('reports needs_setup with a specific reason for each configuration gap', () => {
    const missingSection = resolveAdaptiveSelectionModel(configWith(), {});
    expect(missingSection.ok).toBe(false);
    if (missingSection.ok) throw new Error('expected needs_setup');
    expect(missingSection.readiness).toBe('needs_setup');
    expect(missingSection.reason).toContain('adaptiveActivation is not configured');

    const missingFields = resolveAdaptiveSelectionModel(
      configWith({endpoint: '', model: '', apiKeyEnv: ''}),
      {},
    );
    expect(missingFields.ok).toBe(false);
    if (missingFields.ok) throw new Error('expected needs_setup');
    expect(missingFields.reason).toContain('missing endpoint/model/apiKeyEnv');

    const missingKey = resolveAdaptiveSelectionModel(
      configWith({endpoint, model, apiKeyEnv}),
      // Isolate the credentials-file fallback so a developer machine with
      // ~/.pd/credentials.yaml cannot turn this "missing" case into "ready".
      {PD_EXPERIMENT_ROOT: path.join(os.tmpdir(), `pd-credential-isolation-${String(process.pid)}`)},
    );
    expect(missingKey.ok).toBe(false);
    if (missingKey.ok) throw new Error('expected needs_setup');
    // PRI-1213: a key may come from env OR ~/.pd/credentials.yaml
    expect(missingKey.reason).toContain(`No API key for '${apiKeyEnv}'`);

    // None of the configuration faults is reported as a transport failure.
    for (const reason of [missingSection.reason, missingFields.reason, missingKey.reason]) {
      expect(reason).not.toContain('TRANSPORT_FAILED');
    }
  });

  it('labels mismatched identity and malformed answers by protocol code, and only a broken fetch as TRANSPORT_FAILED', async () => {
    process.env[apiKeyEnv] = 'test-key';
    const expected = {model, questionIds, provider: 'Respan'};
    const complete = {
      candidate_c1: {type: 'noul', noul: 0.9},
      insufficient_context: {type: 'noul', noul: 0.1},
    };

    expect(validateDecisionResponse({model: 'respan/other', answers: complete}, expected))
      .toEqual({ok: false, reason: 'DECISION_MODEL_MISMATCH'});
    expect(validateDecisionResponse({model, answers: {candidate_c1: {type: 'text'}, insufficient_context: complete.insufficient_context}}, expected))
      .toEqual({ok: false, reason: 'DECISION_OUTPUT_INVALID'});
    expect(validateDecisionResponse({model, answers: {candidate_c1: {type: 'noul', noul: 1.4}, insufficient_context: complete.insufficient_context}}, expected))
      .toEqual({ok: false, reason: 'DECISION_SCORE_INVALID'});

    const offline = selector(async () => {
      throw new TypeError('network down');
    });
    await expect(offline.select({body, questionIds, candidates})).rejects.toThrow('TRANSPORT_FAILED');
    expect(offline.report().failure).toBe('TRANSPORT_FAILED');
    expect(offline.report().sends).toBe(1);
  });

  it('reports a credential that vanished before send as a configuration code, with zero requests', async () => {
    // The provider factory normally refuses earlier with `needs_setup`. This
    // guards the narrower race: the key disappears between resolution and send.
    // A missing credential is a configuration fault, so it must NOT be filed
    // under the TRANSPORT_* family.
    const send = vi.fn(respondWith({model, provider: 'Respan', answers: {}}));
    const s = selector(send as unknown as typeof fetch);

    await expect(s.select({body, questionIds, candidates})).rejects.toThrow('DECISION_CREDENTIAL_MISSING');
    const report = s.report();
    expect(report.failure).toBe('DECISION_CREDENTIAL_MISSING');
    expect(report.status).toBe('failed');
    expect(report.sends).toBe(0);
    expect(report.diagnostics.failures).toEqual(['DECISION_CREDENTIAL_MISSING']);
    expect(send).not.toHaveBeenCalled();
    expect(report.failure).not.toBe('TRANSPORT_FAILED');
    expect(report.failure).not.toBe('TRANSPORT_NOT_SENT');
  });

  it('keeps TRANSPORT_NOT_SENT for the repeat-call guard, so neither code can absorb the other', async () => {
    process.env[apiKeyEnv] = 'test-key';
    const s = selector(respondWith({
      model,
      provider: 'Respan',
      answers: {
        candidate_c1: {type: 'noul', noul: 0.95},
        insufficient_context: {type: 'noul', noul: 0.1},
      },
    }));

    await s.select({body, questionIds, candidates});
    await expect(s.select({body, questionIds, candidates})).rejects.toThrow('TRANSPORT_NOT_SENT');
    expect(s.report().failure).toBe('TRANSPORT_NOT_SENT');
    expect(s.report().sends).toBe(1);
    expect(s.report().failure).not.toBe('DECISION_CREDENTIAL_MISSING');
  });
});

describe('an expiry is classified by the window that expired, not by which timer won', () => {
  it('reports TURN_DEADLINE_EXCEEDED when the host window caps the shared request window', async () => {
    process.env[apiKeyEnv] = 'test-key';
    // Frozen clock: the wall clock never reaches the deadline, so only the
    // expired window's identity can decide the cause. This is the CI shape —
    // `firstByteAt` was in time, the body never arrived, and the host window
    // (also the generation window) fired at the shared instant.
    const t0 = 1_000_000;
    const deadline = t0 + 40;
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          }, {once: true});
        },
      }), {status: 200})) as typeof fetch;
    const s = createDecisionSelector({
      endpoint,
      model: {endpoint, model, provider: 'Respan', apiKeyEnv},
      requestTimeoutMs: 5_000,
      outerDeadlineAt: deadline,
      fetchImpl,
      now: () => t0,
    });

    await expect(s.select({body, questionIds, candidates})).rejects.toThrow('TURN_DEADLINE_EXCEEDED');
    const report = s.report();
    expect(report.failure).toBe('TURN_DEADLINE_EXCEEDED');
    expect(report.diagnostics.stage).toBe('generation');
    expect(report.diagnostics.failures).toEqual(['TURN_DEADLINE_EXCEEDED']);
  });
});
