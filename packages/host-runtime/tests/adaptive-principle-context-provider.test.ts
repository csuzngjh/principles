import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { HostEvent } from '@principles/core/host';
import type { ActivatedPrinciple, PdConfig } from '@principles/core/runtime';
import type { AdaptiveSelectionDiagnosticLine } from '../src/adaptive-priority-provider.js';
import { createAdaptivePriorityProviderForConfig, createAdaptivePriorityProvider } from '../src/adaptive-priority-provider.js';
import { ADAPTIVE_SELECTION_LIMITS } from '../src/adaptive-selection.js';
import type { PrincipleContextRead } from '../src/adaptive-principle-context-reader.js';

// The factory resolves its credential from the passed env, but the selector
// resolves from the process env at send time — provide both.
const PRIOR_DECISION_KEY = process.env.DECISION_KEY;
beforeAll(() => {
  process.env.DECISION_KEY = 'test-decision-key';
});
afterAll(() => {
  if (PRIOR_DECISION_KEY === undefined) delete process.env.DECISION_KEY;
  else process.env.DECISION_KEY = PRIOR_DECISION_KEY;
});

/**
 * Principle Context provider contract (SPEC v1.1 §5.4.1 / TD v0.3 §5.1):
 * the four runtime states S1–S4 with SEPARATE I/O and scoring assertions.
 *
 * - Readiness fail → provider not created → zero Context I/O (S0).
 * - skip hit → zero Context I/O and zero sends, even when authorized.
 * - S1 (unauthorized): the Reader is never called (zero stat/read) but the
 *   Adaptive path still runs and sends without the context field.
 * - S2 (authorized, unavailable): EXACTLY one bounded read attempt, no field.
 * - S3 (authorized, budget-dropped): read completed, field removed whole,
 *   request rebuilt; instruction and candidates intact.
 * - S4 (authorized, available, in budget): the field travels inside `state`.
 */

const CONTEXT_TEXT = '长期背景：证据优先。当前方向：Principle Context 接入。';

function makeConfig(sendPrincipleContext?: boolean): PdConfig {
  return {
    version: 1,
    features: {'host.codex.adaptive_activation': {enabled: true}} as PdConfig['features'],
    runtimeProfiles: {},
    internalAgents: {defaultRuntime: 'default', agents: {}},
    ui: {},
    adaptiveActivation: {
      endpoint: 'https://decisions.example.test/v1/score',
      model: 'decision-model',
      apiKeyEnv: 'DECISION_KEY',
      ...(sendPrincipleContext !== undefined ? {sendPrincipleContext} : {}),
    },
  } as unknown as PdConfig;
}

function makeCandidate(index: number, chars = 60): ActivatedPrinciple {
  return {
    principleId: `p-${index}`,
    activationId: `act-${index}`,
    artifactId: `art-${index}`,
    artifactContentSha256: `${String(index).padStart(2, '0')}`.repeat(32),
    text: `原则${index}：` + '证'.repeat(chars),
    authority: 'runtime_v2',
    approvedBy: 'owner',
  } as unknown as ActivatedPrinciple;
}

function makeEvent(prompt = '请帮我审查这段代码并指出风险'): HostEvent {
  return {
    kind: 'before_prompt_build',
    source: 'test',
    rawPayload: null,
    context: {workspaceDir: 'W:\\placeholder', sessionId: 'sess-1', turnId: 'turn-1', promptContent: prompt},
  };
}

interface CapturedRequest {
  state: Record<string, unknown>;
  questions: Record<string, {type: string; instructions: string}>;
}

function makeCaptureFetch(captured: CapturedRequest[], model = 'decision-model'): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {state: string; questions: CapturedRequest['questions']};
    captured.push({state: JSON.parse(body.state) as Record<string, unknown>, questions: body.questions});
    // Answer EVERY question the request asked (closed set, varies per candidate count).
    const answers: Record<string, {type: 'noul'; noul: number}> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = {type: 'noul', noul: id === 'insufficient_context' ? 0.05 : 0.9};
    }
    return new Response(JSON.stringify({model, answers}), {status: 200});
  }) as unknown as typeof fetch;
}

describe('Principle Context authorization chain (factory + closure)', () => {
  it('readiness fail (flag disabled): no provider is created and the Reader is never consulted', () => {
    const reader = vi.fn();
    const resolution = createAdaptivePriorityProviderForConfig(
      {...makeConfig(), features: {}} as unknown as PdConfig,
      'W:\\placeholder',
      {env: {DECISION_KEY: 'k'}, readPrincipleContextImpl: reader as never},
    );
    expect(resolution.ok).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  it('the factory derives authorization ONCE from the validated config; direct construction stays fail-closed', async () => {
    const authorized = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const captured: CapturedRequest[] = [];

    const unauthorized = createAdaptivePriorityProviderForConfig(makeConfig(), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: authorized as never,
    });
    expect(unauthorized.ok).toBe(true);
    if (!unauthorized.ok) return;
    await unauthorized.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    expect(authorized).not.toHaveBeenCalled(); // S1: zero read by construction
    expect(captured).toHaveLength(1); // Adaptive itself still ran
    expect(Object.hasOwn(captured[0]!.state, 'principleContext')).toBe(false);

    // Direct construction without the authorization field is fail-closed too.
    const direct = createAdaptivePriorityProvider({
      workspaceDir: 'W:\\placeholder',
      model: {endpoint: 'https://decisions.example.test/v1/score', model: 'decision-model', apiKeyEnv: 'DECISION_KEY'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: authorized as never,
    });
    await direct(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    expect(authorized).not.toHaveBeenCalled();
    expect(captured).toHaveLength(2);
    expect(Object.hasOwn(captured[1]!.state, 'principleContext')).toBe(false);
  });

  it('skip hit: zero Context I/O and zero sends even when authorized', async () => {
    const reader = vi.fn();
    const fetchSpy = vi.fn();
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: fetchSpy as never,
      readPrincipleContextImpl: reader as never,
    });
    if (!resolution.ok) throw new Error('expected ready');
    const selection = await resolution.provider(makeEvent('谢谢'), [makeCandidate(1)], {
      excludedByBudget: false, replacementByActivationId: new Map(),
    });
    expect(selection).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Principle Context four states (S1–S4)', () => {
  it('S2: authorized but unavailable — exactly one read attempt, no field, Adaptive continues', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'missing', reason: 'file_missing'}));
    const captured: CapturedRequest[] = [];
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (!resolution.ok) throw new Error('expected ready');
    await resolution.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});

    expect(reader).toHaveBeenCalledTimes(1); // one bounded attempt — NOT zero-read
    expect(captured).toHaveLength(1);
    expect(Object.hasOwn(captured[0]!.state, 'principleContext')).toBe(false);
    // rc-9: the degradation is observable as a bounded code, never context text.
    expect(lines.at(-1)?.failures).toContain('principle_context:missing:file_missing');
  });

  it('S2 (Reader throws): degrades to a no-context turn instead of failing the host prompt path', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => {
      throw new Error('unexpected reader explosion');
    });
    const captured: CapturedRequest[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: reader as never,
    });
    if (!resolution.ok) throw new Error('expected ready');
    const selection = await resolution.provider(makeEvent(), [makeCandidate(1)], {
      excludedByBudget: false, replacementByActivationId: new Map(),
    });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1); // Adaptive still sent exactly one request
    expect(Object.hasOwn(captured[0]!.state, 'principleContext')).toBe(false);
    // The prompt path never saw the explosion; whether the selection lands
    // depends on revalidation against a real store, which is out of scope here.
    expect(selection).toBeUndefined();
  });

  it('S4: authorized and available — the context travels INSIDE the state JSON string (layer 3)', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const captured: CapturedRequest[] = [];
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (!resolution.ok) throw new Error('expected ready');
    await resolution.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});

    expect(reader).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.state.principleContext).toBe(CONTEXT_TEXT);
    // Privacy: the bounded diagnostic lines never carry the context text.
    expect(JSON.stringify(lines)).not.toContain(CONTEXT_TEXT);
    // Criteria v4 with-context instructions mention the background source;
    // question IDs stay in the closed set.
    const ids = Object.keys(captured[0]!.questions);
    expect(ids).toEqual(['candidate_c1', 'insufficient_context']);
    expect(captured[0]!.questions['candidate_c1']!.instructions).toContain('principleContext');
  });

  it('S1 vs S4 question text: without context the instructions are byte-identical to v3 semantics', async () => {
    const v3Append = expect.stringContaining('依据 currentInstruction 判断用户现在要做什么');
    const readerAvailable = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const capturedS1: CapturedRequest[] = [];
    const capturedS4: CapturedRequest[] = [];

    const s1 = createAdaptivePriorityProviderForConfig(makeConfig(), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch(capturedS1),
      readPrincipleContextImpl: readerAvailable as never,
    });
    if (s1.ok) await s1.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    const s4 = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch(capturedS4),
      readPrincipleContextImpl: readerAvailable as never,
    });
    if (s4.ok) await s4.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});

    const s1Append = capturedS1[0]!.questions['candidate_c1']!.instructions;
    const s4Append = capturedS4[0]!.questions['candidate_c1']!.instructions;
    expect(s1Append).toEqual(v3Append);
    expect(s1Append).not.toContain('principleContext');
    expect(s4Append).not.toEqual(s1Append);
    // Same question IDs in both branches (closed set unchanged).
    expect(Object.keys(capturedS1[0]!.questions)).toEqual(Object.keys(capturedS4[0]!.questions));
  });

  it('S3: budget overflow removes the WHOLE context, keeps instruction and candidates, and reports the drop code', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({
      status: 'available',
      text: '背'.repeat(ADAPTIVE_SELECTION_LIMITS.maxInputChars - 10),
    }));
    const captured: CapturedRequest[] = [];
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (!resolution.ok) throw new Error('expected ready');

    // Inflate the no-context payload close to the ceiling so the context (but
    // not the instruction/candidates) pushes it over 20,000 units.
    const candidates = Array.from({length: 10}, (_unused, index) => makeCandidate(index + 1, 600));
    const prior = Array.from({length: 4}, (_unused, index) => ({text: '史'.repeat(1200), source: 'history', index}));
    const event: HostEvent = {
      ...makeEvent(),
      context: {
        ...makeEvent().context,
        promptContent: '指'.repeat(ADAPTIVE_SELECTION_LIMITS.maxInputChars - 5),
      },
    };
    // priorMessages reach the selector via the prompt? No — the provider only
    // forwards currentPrompt; prior messages are not part of this seam, so the
    // inflation comes from instruction + 10 candidates + context instead.
    void prior;

    await resolution.provider(event, candidates, {excludedByBudget: false, replacementByActivationId: new Map()});

    expect(reader).toHaveBeenCalledTimes(1); // S3: the read DID happen
    expect(captured).toHaveLength(1); // exactly one send (the rebuilt request)
    const state = captured[0]!.state;
    expect(Object.hasOwn(state, 'principleContext')).toBe(false);
    expect(String(state.currentInstruction).length).toBe(ADAPTIVE_SELECTION_LIMITS.maxInputChars - 5);
    expect((state.candidates as unknown[]).length).toBe(10);
    // The S3 marker is reported as a bounded code on the diagnostic line.
    expect(lines.at(-1)?.contextDropped).toBe('principle_context_dropped:budget');
  });
});

describe('Principle Context privacy boundary (SPEC v1.1 §6.3.1)', () => {
  it('revoking authorization changes the NEXT round: the field disappears from the request', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const captured: CapturedRequest[] = [];
    const authorized = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch(captured), readPrincipleContextImpl: reader as never,
    });
    const revoked = createAdaptivePriorityProviderForConfig(makeConfig(false), 'W:\\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch(captured), readPrincipleContextImpl: reader as never,
    });
    if (authorized.ok) await authorized.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    if (revoked.ok) await revoked.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});

    expect(captured).toHaveLength(2);
    expect(captured[0]!.state.principleContext).toBe(CONTEXT_TEXT); // sent while authorized
    expect(Object.hasOwn(captured[1]!.state, 'principleContext')).toBe(false); // next round: gone
    expect(reader).toHaveBeenCalledTimes(1); // revoked round never read
  });
});

describe('Principle Context S-state diagnostic (SPEC v1.1 sect 5.4.1, consumer-facing)', () => {
  it('S1: unauthorized turns report principleContext=unauthorized and NO reader failure', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(), 'W:\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch([]), readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (resolution.ok) await resolution.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    const line = lines.at(-1);
    expect(line?.principleContext).toBe('unauthorized'); // honest S1 — NOT a reader failure
    expect(line?.failures.filter((f) => f.startsWith('principle_context'))).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });

  it('S2: authorized-unavailable turns report principleContext=unavailable with the bounded reason in failures', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'invalid', reason: 'unsafe_path'}));
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch([]), readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (resolution.ok) await resolution.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    const line = lines.at(-1);
    expect(line?.principleContext).toBe('unavailable');
    expect(line?.failures).toContain('principle_context:invalid:unsafe_path');
    expect(JSON.stringify(line)).not.toContain(CONTEXT_TEXT);
  });

  it('S3: budget-dropped turns report principleContext=dropped_budget (never "sent")', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({
      status: 'available',
      text: '背'.repeat(ADAPTIVE_SELECTION_LIMITS.maxInputChars - 10),
    }));
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch([]), readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    // Inflate the no-context payload past 20,000 units: 10 candidates x ~600
    // chars plus a near-max instruction leaves the context as the only
    // overflow source.
    const candidates = Array.from({length: 10}, (_unused, index) => makeCandidate(index + 1, 600));
    const event: HostEvent = {
      ...makeEvent(),
      context: {
        ...makeEvent().context,
        promptContent: '指'.repeat(ADAPTIVE_SELECTION_LIMITS.maxInputChars - 5),
      },
    };
    if (resolution.ok) await resolution.provider(event, candidates, {excludedByBudget: false, replacementByActivationId: new Map()});
    const line = lines.at(-1);
    expect(line?.principleContext).toBe('dropped_budget');
    expect(line?.contextDropped).toBe('principle_context_dropped:budget');
  });

  it('S4: sent turns report principleContext=sent', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch([]), readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (resolution.ok) await resolution.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    expect(lines.at(-1)?.principleContext).toBe('sent');
  });

  it('skip turns carry NO S-state (the turn never reached selection)', async () => {
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\placeholder', {
      env: {DECISION_KEY: 'k'}, fetchImpl: makeCaptureFetch([]), readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (resolution.ok) await resolution.provider(makeEvent('谢谢'), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    const line = lines.at(-1);
    expect(line?.status).toBe('skipped');
    expect(line?.principleContext).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });

  it('Codex Background maps the S-state onto AdaptiveBackgroundDiagnostic verbatim', async () => {
    const captured: CapturedRequest[] = [];
    const reader = vi.fn(async (): Promise<PrincipleContextRead> => ({status: 'available', text: CONTEXT_TEXT}));
    const lines: AdaptiveSelectionDiagnosticLine[] = [];
    const resolution = createAdaptivePriorityProviderForConfig(makeConfig(true), 'W:\placeholder', {
      env: {DECISION_KEY: 'k'},
      fetchImpl: makeCaptureFetch(captured),
      readPrincipleContextImpl: reader as never,
      onDiagnostic: (line) => lines.push(line),
    });
    if (resolution.ok) await resolution.provider(makeEvent(), [makeCandidate(1)], {excludedByBudget: false, replacementByActivationId: new Map()});
    // Project the same mapping the background adapter performs.
    const line = lines.at(-1)!;
    const backgroundDiagnostic = {
      status: line.status, reason: line.reason, sends: line.sends,
      ...(line.principleContext !== undefined ? {principleContext: line.principleContext} : {}),
    };
    expect(backgroundDiagnostic.principleContext).toBe('sent');
    expect(JSON.stringify(backgroundDiagnostic)).not.toContain(CONTEXT_TEXT);
  });
});
