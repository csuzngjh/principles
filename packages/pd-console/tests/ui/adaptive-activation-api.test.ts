// @vitest-environment jsdom
/**
 * PR #2641 review — browser transport + wire validation.
 *
 * The section tests mock the api module; these exercise the REAL client path
 * (fetch → request → validator) so the 4 previously-uncovered api lines and the
 * strict validator branches are genuinely executed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAdaptiveActivation, updateAdaptiveActivation } from '../../src/ui/api.js';
import { validateAdaptiveActivationView } from '../../src/ui/utils/validators.js';

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceDir: 'D:/ws-a',
    codex: { enabled: true, serviceConfigured: true, saved: true },
    service: {
      presetId: 'decisions-openrouter-respan',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: 'respan/span-01-lite:free',
      provider: 'Respan',
      responseModels: ['respan/span-01-lite:free'],
      apiKeyEnv: 'OPENROUTER_API_KEY',
      credentialSeenInConsoleProcess: false,
    },
    replaceableActivationIds: [],
    appendOnlyEligible: true,
    otherHostAaEnabled: [],
    candidates: { validCount: 1, blockingWarnings: [], aborted: false, emptyState: 'ok' },
    lastRecord: null,
    evidence: { status: 'not_observed', reason: 'no_adaptive_fact', parseFailures: 0, logFilesRead: 0 },
    ...overrides,
  };
}

function stubFetch(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Adaptive Activation wire validation', () => {
  it('accepts a valid view and preserves the evidence tri-state verbatim', () => {
    for (const status of ['observed', 'not_observed', 'unknown'] as const) {
      const parsed = validateAdaptiveActivationView(validPayload({ evidence: { status, reason: status === 'unknown' ? 'logs_unreadable' : status === 'observed' ? 'observed' : 'no_adaptive_fact', parseFailures: 0, logFilesRead: 1 } }));
      expect(parsed?.evidence.status).toBe(status);
    }
  });

  it('rejects counts that are not non-negative safe integers', () => {
    for (const validCount of [Number.POSITIVE_INFINITY, -1, 1.5, Number.NaN]) {
      const payload = validPayload({ candidates: { validCount, blockingWarnings: [], aborted: false, emptyState: 'ok' } });
      expect(validateAdaptiveActivationView(payload)).toBeNull();
    }
    for (const parseFailures of [-1, 2.5]) {
      const payload = validPayload({ evidence: { status: 'observed', reason: 'observed_partial', parseFailures, logFilesRead: 1 } });
      expect(validateAdaptiveActivationView(payload)).toBeNull();
    }
  });

  it('rejects an evidence status outside the closed set (never coerced)', () => {
    const payload = validPayload({ evidence: { status: 'maybe', reason: 'observed', parseFailures: 0, logFilesRead: 0 } });
    expect(validateAdaptiveActivationView(payload)).toBeNull();
  });

  it('rejects an evidence reason outside the closed set', () => {
    const payload = validPayload({ evidence: { status: 'unknown', reason: 'EACCES at C:/secret', parseFailures: 0, logFilesRead: 0 } });
    expect(validateAdaptiveActivationView(payload)).toBeNull();
  });

  it('rejects a payload with no evidence field instead of assuming not_observed', () => {
    const legacy = validPayload();
    delete (legacy as Record<string, unknown>).evidence;
    expect(validateAdaptiveActivationView(legacy)).toBeNull();
  });

  it('rejects a malformed lastRecord', () => {
    expect(validateAdaptiveActivationView(validPayload({ lastRecord: { ts: 1 } }))).toBeNull();
  });

  it('accepts a known other-host list', () => {
    const parsed = validateAdaptiveActivationView(validPayload({ otherHostAaEnabled: ['openclaw', 'workbuddy'] }));
    expect(parsed?.otherHostAaEnabled).toEqual(['openclaw', 'workbuddy']);
  });

  it('rejects every structurally invalid field instead of defaulting it', () => {
    const withField = (mutate: (payload: Record<string, unknown>) => void): unknown => {
      const payload = validPayload();
      mutate(payload);
      return payload;
    };
    const badService = (mutate: (service: Record<string, unknown>) => void): unknown =>
      withField((payload) => {
        const service = payload.service as Record<string, unknown>;
        mutate(service);
      });
    const badCandidates = (mutate: (candidates: Record<string, unknown>) => void): unknown =>
      withField((payload) => {
        const candidates = payload.candidates as Record<string, unknown>;
        mutate(candidates);
      });
    const badEvidence = (mutate: (evidence: Record<string, unknown>) => void): unknown =>
      withField((payload) => {
        const evidence = payload.evidence as Record<string, unknown>;
        mutate(evidence);
      });

    const payloads: Array<[string, unknown]> = [
      ['null payload', null],
      ['array payload', []],
      ['string payload', 'view'],
      ['missing workspaceDir', withField((p) => { delete p.workspaceDir; })],
      ['numeric workspaceDir', withField((p) => { p.workspaceDir = 7; })],
      ['missing codex', withField((p) => { delete p.codex; })],
      ['non-object codex', withField((p) => { p.codex = 'off'; })],
      ['non-boolean codex.enabled', withField((p) => { (p.codex as Record<string, unknown>).enabled = 'yes'; })],
      ['missing service', withField((p) => { delete p.service; })],
      ['non-object service', withField((p) => { p.service = []; })],
      ['numeric service.model', badService((s) => { s.model = 1; })],
      ['numeric provider', badService((s) => { s.provider = 5; })],
      ['missing credential flag', badService((s) => { delete s.credentialSeenInConsoleProcess; })],
      ['non-array responseModels', badService((s) => { s.responseModels = 'x'; })],
      ['non-string responseModels element', badService((s) => { s.responseModels = ['ok', 3]; })],
      ['missing replaceableActivationIds', withField((p) => { delete p.replaceableActivationIds; })],
      ['non-array replaceableActivationIds', withField((p) => { p.replaceableActivationIds = 'act'; })],
      ['missing appendOnlyEligible', withField((p) => { delete p.appendOnlyEligible; })],
      ['missing otherHostAaEnabled', withField((p) => { delete p.otherHostAaEnabled; })],
      ['non-array otherHostAaEnabled', withField((p) => { p.otherHostAaEnabled = 'openclaw'; })],
      ['unknown other host', withField((p) => { p.otherHostAaEnabled = ['some-host']; })],
      ['missing candidates', withField((p) => { delete p.candidates; })],
      ['non-object candidates', withField((p) => { p.candidates = null; })],
      ['missing blockingWarnings', badCandidates((c) => { delete c.blockingWarnings; })],
      ['non-string blockingWarnings element', badCandidates((c) => { c.blockingWarnings = [1]; })],
      ['unknown emptyState', badCandidates((c) => { c.emptyState = 'weird'; })],
      ['missing lastRecord', withField((p) => { delete p.lastRecord; })],
      ['record is a string', withField((p) => { p.lastRecord = 'record'; })],
      ['record missing ts', withField((p) => { p.lastRecord = { sessionId: 's', resultCode: 'x', scored: true, appendedActivationId: null, activationIds: [] }; })],
      ['record numeric runId', withField((p) => { p.lastRecord = { ts: null, runId: 3, sessionId: 's', resultCode: 'x', scored: true, appendedActivationId: null, activationIds: [] }; })],
      ['record missing sessionId', withField((p) => { p.lastRecord = { ts: null, runId: null, resultCode: 'x', scored: true, appendedActivationId: null, activationIds: [] }; })],
      ['record numeric resultCode', withField((p) => { p.lastRecord = { ts: null, runId: null, sessionId: 's', resultCode: 1, scored: true, appendedActivationId: null, activationIds: [] }; })],
      ['record non-boolean scored', withField((p) => { p.lastRecord = { ts: null, runId: null, sessionId: 's', resultCode: 'x', scored: 'no', appendedActivationId: null, activationIds: [] }; })],
      ['record non-string appendedActivationId', withField((p) => { p.lastRecord = { ts: null, runId: null, sessionId: 's', resultCode: 'x', scored: true, appendedActivationId: 2, activationIds: [] }; })],
      ['record non-array activationIds', withField((p) => { p.lastRecord = { ts: null, runId: null, sessionId: 's', resultCode: 'x', scored: true, appendedActivationId: null, activationIds: 'act' }; })],
      ['record non-string activationIds element', withField((p) => { p.lastRecord = { ts: null, runId: null, sessionId: 's', resultCode: 'x', scored: true, appendedActivationId: null, activationIds: [1] }; })],
      ['evidence not an object', withField((p) => { p.evidence = 'unknown'; })],
      ['evidence numeric status', badEvidence((e) => { e.status = 3; })],
      ['evidence numeric reason', badEvidence((e) => { e.reason = 9; })],
      ['evidence negative logFilesRead', badEvidence((e) => { e.logFilesRead = -2; })],
      ['evidence float logFilesRead', badEvidence((e) => { e.logFilesRead = 0.5; })],
    ];

    for (const [label, payload] of payloads) {
      expect(validateAdaptiveActivationView(payload), label).toBeNull();
    }
  });
});

describe('Adaptive Activation client calls', () => {
  it('GETs the entry and validates the envelope', async () => {
    const fetchSpy = stubFetch({ success: true, data: validPayload() });
    const result = await fetchAdaptiveActivation();
    expect(result.success).toBe(true);
    expect(result.data?.evidence.status).toBe('not_observed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/config/adaptive-activation');
  });

  it('PATCHes the fixed service id and never sends an endpoint', async () => {
    const fetchSpy = stubFetch({ success: true, data: validPayload() });
    await updateAdaptiveActivation({ service: 'decisions-openrouter-respan' });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ service: 'decisions-openrouter-respan' });
  });

  it('surfaces a server error envelope without inventing data', async () => {
    stubFetch({ success: false, error: 'append_only_conflict', message: 'no' }, false);
    const result = await updateAdaptiveActivation({ enabled: true });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});
