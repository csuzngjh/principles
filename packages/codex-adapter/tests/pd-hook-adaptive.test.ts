/**
 * PRI-1182 — Adaptive Activation through the REAL Codex hook entry.
 *
 * Everything here goes through `processHookInvocation` → the real decoder →
 * `pd-hook` → `createProductionHostRuntime.dispatch` → `adaptivePriorityProvider`
 * → shared Runtime V2 reader + revalidation + `additiveOnly` packer. Only the
 * HTTP transport is fake.
 *
 * The fake endpoint reads the candidate snapshot and the condition question
 * ids from the request IT ACTUALLY RECEIVED, then answers each question id with
 * an independent probability. A payload that drops a condition, renames a
 * question id, or sends a different candidate set cannot produce a valid
 * selection.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { readPromptActivationCandidates } from '@principles/host-runtime';
import {
  CODEX_ADAPTIVE_BUDGET_MS,
  CODEX_ADAPTIVE_DECISION_MS,
  CODEX_HOOK_TIMEOUT_MS,
  CODEX_NATIVE_RESERVE_MS,
  processHookInvocation,
} from '../src/pd-hook.js';

const TEXT = {
  SCOPE: '只修改与任务直接相关的文件，邻近改进记为后续事项。',
  BIG: '避免为假设的未来需求预建抽象和额外服务。'.repeat(40),
  DELIVERY: '交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论。',
  TESTS: '修复缺陷时先写能复现问题的回归测试，再改实现。',
};
const ORDER = ['SCOPE', 'BIG', 'DELIVERY', 'TESTS'] as const;
const API_KEY_ENV = 'PD_TEST_ADAPTIVE_KEY';
const DECISION_ENDPOINT = 'https://decisions.test/alpha/decisions';
const DECISION_MODEL = 'respan/span-01-lite:free';
const DECISION_PROVIDER = 'Respan';
/** chars = tokens / 32, so tokens = chars * 32. */
const CHARS_PER_TOKEN = 32;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
// The decision transport reads the key from the real process environment; the
// transport stays fake, so this value is never used.
beforeAll(() => { process.env[API_KEY_ENV] = 'test-key'; });
afterAll(() => { delete process.env[API_KEY_ENV]; });

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

interface FixtureOptions {
  readonly label: string;
  readonly order?: ReadonlyArray<keyof typeof TEXT>;
  readonly adaptive: boolean;
  /** Budget expressed in chars; converted to the operator-declared token window. */
  readonly budgetChars: number;
  /** Frozen exact response-model allowlist written into the manifest. */
  readonly responseModels?: readonly string[];
}

async function fixture(options: FixtureOptions): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pd-adaptive-hook-${options.label}-`));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  // Hermetic CODEX_HOME: never fall through to this machine's real user workspace.
  fs.mkdirSync(path.join(root, 'codex-home'), { recursive: true });
  const connection = new SqliteConnection(root);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `);
    const approve = db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, 'owner-test')
    `);
    const store = new SqliteActivationStateStore(connection);
    let index = 0;
    for (const key of options.order ?? ORDER) {
      const at = new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + index * 1000).toISOString();
      index += 1;
      const artifactId = `art-${key}`;
      insertArtifact.run(artifactId, `task-${artifactId}`, key, JSON.stringify({ principleId: key, text: TEXT[key] }), at, at);
      await store.recordActivation({
        activationId: `act-${key}`,
        idempotencyKey: `${artifactId}::prompt`,
        artifactId,
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: `ledger://${key}`,
        activatedAt: at,
        deactivatedAt: null,
      });
      approve.run(`approval-${artifactId}`, artifactId, at, at);
    }
  } finally {
    connection.close();
  }

  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  if (options.adaptive) config.features['host.codex.adaptive_activation'].enabled = true;
  // PRI-1182: the Adaptive path reads its OWN endpoint + model + key reference.
  config.adaptiveActivation = {
    endpoint: DECISION_ENDPOINT,
    model: DECISION_MODEL,
    apiKeyEnv: API_KEY_ENV,
    provider: DECISION_PROVIDER,
    ...(options.responseModels ? {responseModels: [...options.responseModels]} : {}),
  };
  config.promptBudget = { hosts: { codex: Math.max(1024, Math.round(options.budgetChars * CHARS_PER_TOKEN)) } };
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
  return root;
}

/** Measures the same shared-directive costs the production packer uses. */
async function measureCosts(root: string) {
  const read = await readPromptActivationCandidates({ workspaceDir: root, includeAuthority: true });
  const base = sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: false });
  const blocks: Record<string, number> = {};
  for (const principle of read.principles) {
    blocks[principle.principleId] = measureSharedDirectiveBlockChars(principle, {
      escapeFn: escapeXml,
      selfReportInstruction: false,
    });
  }
  return { base, blocks };
}

let tightBudget: number | undefined;
/** Budget that fits the first directive but not the target: Native misses DELIVERY. */
async function nativeMissesDelivery(): Promise<number> {
  if (tightBudget !== undefined) return tightBudget;
  const probe = await fixture({ label: 'cost-probe', adaptive: false, budgetChars: 4000 });
  const measured = await measureCosts(probe);
  tightBudget = measured.base + measured.blocks.SCOPE + measured.blocks.DELIVERY + 10;
  return tightBudget;
}

function input(root: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 's-1170',
    turn_id: 't-1170',
    transcript_path: null,
    cwd: root,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt: '请交付验收：这次改动已经全部完成了吗？',
    ...extra,
  });
}

const envFor = (root: string): NodeJS.ProcessEnv => ({
  [API_KEY_ENV]: 'test-key',
  CODEX_HOME: path.join(root, 'codex-home'),
});

interface CandidateOnWire {
  readonly ref: string;
  readonly text: string;
  readonly digest?: string;
}

interface ParsedDecisionRequest {
  readonly candidates: readonly CandidateOnWire[];
  readonly questionIds: readonly string[];
  readonly currentInstruction: string;
}

const candidateQuestion = (ref: string) => `candidate_${ref}`;

/** The request as it was actually sent — never the fixture's expectation. */
function parseDecisionRequest(resource: RequestInfo | URL, init: RequestInit | undefined): ParsedDecisionRequest {
  expect(String(resource)).toBe(DECISION_ENDPOINT);
  expect(init?.method).toBe('POST');
  const body = JSON.parse(String(init?.body)) as {
    model?: unknown;
    state?: unknown;
    questions?: unknown;
    provider?: unknown;
  };
  expect(body.model).toBe(DECISION_MODEL);
  expect(body.provider).toEqual({ only: [DECISION_PROVIDER], allow_fallbacks: false });
  expect(typeof body.state).toBe('string');
  expect(body.questions).toBeTypeOf('object');
  const state = JSON.parse(String(body.state)) as { currentInstruction?: unknown; candidates?: unknown };
  expect(typeof state.currentInstruction).toBe('string');
  expect(Array.isArray(state.candidates)).toBe(true);
  const candidates = state.candidates as CandidateOnWire[];
  const questionIds = Object.keys(body.questions as Record<string, unknown>);
  // One applicability condition per candidate plus exactly one insufficient-context question.
  expect(questionIds).toContain('insufficient_context');
  expect(questionIds).toHaveLength(candidates.length + 1);
  for (const candidate of candidates) {
    expect(questionIds, `missing condition for ${candidate.ref}`).toContain(candidateQuestion(candidate.ref));
  }
  return { candidates, questionIds, currentInstruction: String(state.currentInstruction) };
}

function refOf(request: ParsedDecisionRequest, marker: string): string {
  const candidate = request.candidates.find((item) => item.text.includes(marker));
  expect(candidate, `request must carry the candidate containing ${marker}`).toBeTruthy();
  return candidate!.ref;
}

interface Transport {
  readonly fetchImpl: typeof fetch;
  readonly calls: () => number;
  readonly requests: () => Array<RequestInit | undefined>;
}

type Scores = (request: ParsedDecisionRequest) => Record<string, number>;

function decisionResponse(scores: Record<string, number>, ids: readonly string[]): Response {
  const answers: Record<string, { type: 'noul'; noul: number }> = {};
  for (const id of ids) answers[id] = { type: 'noul', noul: scores[id] ?? 0.02 };
  return new Response(JSON.stringify({ model: DECISION_MODEL, provider: DECISION_PROVIDER, answers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers by QUESTION ID, using scores derived from the real request. */
function scoringTransport(scores: Scores): Transport {
  const inits: Array<RequestInit | undefined> = [];
  const fetchImpl: typeof fetch = async (resource, init) => {
    inits.push(init);
    const request = parseDecisionRequest(resource, init);
    return decisionResponse(scores(request), request.questionIds);
  };
  return { fetchImpl, calls: () => inits.length, requests: () => inits };
}

/** Answers the candidate containing `marker` and leaves every other condition low. */
function echoingTransport(marker: string): Transport {
  return scoringTransport((request) => ({ [candidateQuestion(refOf(request, marker))]: 0.99 }));
}

/** Sends a raw (possibly malformed) answer table; the test owns every key. */
function rawDecisionTransport(build: (request: ParsedDecisionRequest) => unknown): Transport {
  const inits: Array<RequestInit | undefined> = [];
  const fetchImpl: typeof fetch = async (resource, init) => {
    inits.push(init);
    const request = parseDecisionRequest(resource, init);
    return new Response(JSON.stringify(build(request)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, calls: () => inits.length, requests: () => inits };
}

const additionalContext = (result: { stdout: unknown }): string => {
  const output = result.stdout as { hookSpecificOutput?: { additionalContext?: string } };
  return output.hookSpecificOutput?.additionalContext ?? '';
};

describe('PRI-1170/PRI-1182 Codex exec Adaptive wiring', () => {
  it('Adaptive OFF (the default) leaves Native byte-identical with zero model requests', async () => {
    const budgetChars = await nativeMissesDelivery();
    const defaultRoot = await fixture({ label: 'off-default', adaptive: false, budgetChars });
    const explicitRoot = await fixture({ label: 'off-explicit', adaptive: false, budgetChars });
    const baseline = await processHookInvocation(input(defaultRoot), envFor(defaultRoot), defaultRoot);
    const explicit = await processHookInvocation(input(explicitRoot), envFor(explicitRoot), explicitRoot);

    expect(additionalContext(baseline)).toContain(TEXT.SCOPE);
    expect(additionalContext(baseline)).not.toContain(TEXT.DELIVERY);
    // Byte-identical: the default config and an explicitly disabled flag are the same path.
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(baseline));
    expect(baseline.stderr.join('')).not.toContain('adaptive_selection');
  });

  it('Adaptive ON adds exactly one target and keeps every Native directive', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);
    expect(additionalContext(native)).toContain(TEXT.SCOPE);
    expect(additionalContext(native)).not.toContain(TEXT.DELIVERY);

    const adaptiveRoot = await fixture({ label: 'adaptive', adaptive: true, budgetChars });
    const transport = echoingTransport(TEXT.DELIVERY);
    const adaptive = await processHookInvocation(input(adaptiveRoot), envFor(adaptiveRoot), adaptiveRoot, {
      fetchImpl: transport.fetchImpl,
    });

    expect(transport.calls()).toBe(1);
    // The outbound contract carries the frozen candidate snapshot (text +
    // digest) exactly once, in state; the questions carry only conditions.
    const request = parseDecisionRequest(DECISION_ENDPOINT, transport.requests()[0]);
    expect(request.candidates.some((candidate) => candidate.text.includes(TEXT.SCOPE))).toBe(false);
    for (const sent of request.candidates) {
      expect(sent.digest, `outbound candidate ${sent.ref} must carry the frozen digest`).toBe(sha256(sent.text));
    }
    const context = additionalContext(adaptive);
    expect(context).toContain(TEXT.DELIVERY);
    // The Native body is not displaced by the increment.
    expect(context).toContain(TEXT.SCOPE);
    // Exactly one target directive was added.
    expect(context.split(TEXT.DELIVERY).length - 1).toBe(1);
    expect(adaptive.stderr.join('')).toContain('reason=adaptive_selection_selected:selected');
  });

  it('a missing turn_id is refused by the real decoder: zero selection requests', async () => {
    const root = await fixture({ label: 'no-turn', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = echoingTransport(TEXT.DELIVERY);
    const payload = JSON.parse(input(root));
    delete payload.turn_id;
    const result = await processHookInvocation(JSON.stringify(payload), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls()).toBe(0);
    expect(result.stdout).toEqual({});
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('a missing decision credential degrades to Native with zero requests', async () => {
    const root = await fixture({ label: 'needs-setup', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(
      input(root),
      { CODEX_HOME: path.join(root, 'codex-home') } as NodeJS.ProcessEnv,
      root,
      { fetchImpl: transport.fetchImpl },
    );
    expect(transport.calls()).toBe(0);
    // The operator-visible sentence for a configuration fault names the missing
    // credential and never borrows transport vocabulary.
    const stderr = result.stderr.join('');
    expect(stderr).toContain(
      `[PD] status=degraded reason=adaptive_activation_needs_setup:Environment variable '${API_KEY_ENV}' is not set or empty`,
    );
    expect(stderr).not.toContain('TRANSPORT_FAILED');
    expect(stderr).not.toContain('TRANSPORT_NOT_SENT');
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
  });

  it('an answer for an unknown question id is rejected', async () => {
    const root = await fixture({ label: 'extra-question', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = rawDecisionTransport((request) => {
      const scores: Record<string, number> = { [candidateQuestion(refOf(request, TEXT.DELIVERY))]: 0.99 };
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: scores[id] ?? 0.02 };
      answers.candidate_c99 = { type: 'noul', noul: 0.5 };
      return { model: DECISION_MODEL, provider: DECISION_PROVIDER, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('DECISION_QUESTION_MISMATCH');
  });

  it('a missing condition answer is rejected', async () => {
    const root = await fixture({ label: 'missing-answer', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = rawDecisionTransport((request) => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: 0.02 };
      delete answers[candidateQuestion(refOf(request, TEXT.DELIVERY))];
      return { model: DECISION_MODEL, provider: DECISION_PROVIDER, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('DECISION_QUESTION_MISMATCH');
  });

  it('a score outside [0, 1] is rejected', async () => {
    const root = await fixture({ label: 'bad-score', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = rawDecisionTransport((request) => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: 0.02 };
      answers[candidateQuestion(refOf(request, TEXT.DELIVERY))] = { type: 'noul', noul: 1.4 };
      return { model: DECISION_MODEL, provider: DECISION_PROVIDER, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    // PRI-1182: the Decisions protocol validates the score range itself, so an
    // out-of-range score fails as DECISION_SCORE_INVALID before the host guard
    // (the adapter-level SELECTION_OUTPUT_INVALID path no longer applies here).
    expect(result.stderr.join('')).toContain('DECISION_SCORE_INVALID');
  });

  it('a different decision model identity is rejected', async () => {
    const root = await fixture({ label: 'bad-model', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = rawDecisionTransport((request) => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: 0.02 };
      answers[candidateQuestion(refOf(request, TEXT.DELIVERY))] = { type: 'noul', noul: 0.99 };
      return { model: 'other/model', provider: DECISION_PROVIDER, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('DECISION_MODEL_MISMATCH');
  });

  it('rejects a same-prefix response model whose date is not in the frozen allowlist', async () => {
    const root = await fixture({
      label: 'unregistered-date',
      adaptive: true,
      budgetChars: await nativeMissesDelivery(),
      responseModels: [DECISION_MODEL, 'respan/span-01-lite-20260925'],
    });
    const transport = rawDecisionTransport((request) => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: 0.02 };
      answers[candidateQuestion(refOf(request, TEXT.DELIVERY))] = { type: 'noul', noul: 0.99 };
      // Same prefix as the request model, but this date was never registered.
      return { model: 'respan/span-01-lite-20260101', provider: DECISION_PROVIDER, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('DECISION_MODEL_MISMATCH');
    expect(result.stderr.join('')).toContain('modelObserved=respan/span-01-lite-20260101');
  });

  it('accepts the registered canonical slug and reports the observed model and provider', async () => {
    const root = await fixture({
      label: 'registered-date',
      adaptive: true,
      budgetChars: await nativeMissesDelivery(),
      responseModels: [DECISION_MODEL, 'respan/span-01-lite-20260925'],
    });
    const transport = rawDecisionTransport((request) => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: 0.02 };
      answers[candidateQuestion(refOf(request, TEXT.DELIVERY))] = { type: 'noul', noul: 0.99 };
      return { model: 'respan/span-01-lite-20260925', provider: DECISION_PROVIDER, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(additionalContext(result)).toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('modelObserved=respan/span-01-lite-20260925');
    expect(result.stderr.join('')).toContain('providerObserved=Respan');
  });

  it('an absent provider field is reported as absent, never as a provider claim', async () => {
    const root = await fixture({ label: 'no-provider', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = rawDecisionTransport((request) => {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const id of request.questionIds) answers[id] = { type: 'noul', noul: 0.02 };
      answers[candidateQuestion(refOf(request, TEXT.DELIVERY))] = { type: 'noul', noul: 0.99 };
      return { model: DECISION_MODEL, answers };
    });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(additionalContext(result)).toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('providerObserved=absent');
  });

  it('first-byte admission expiry cancels the underlying request and keeps Native', async () => {
    const root = await fixture({ label: 'ttfb-timeout', adaptive: true, budgetChars: await nativeMissesDelivery() });
    let aborted = false;
    let calls = 0;
    const fetchImpl: typeof fetch = (_resource, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl,
      // Isolate transport cancellation: the request's own windows are tiny.
      minExecutableBudgetMs: 0,
      requestTimeoutMs: 30,
    });
    expect(calls, result.stderr.join('')).toBe(1);
    expect(aborted).toBe(true);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:SELECTION_EXPIRED');
    expect(result.stderr.join('')).toContain('stage=admission');
  });

  it('a response that starts in time but finishes late is cancelled at its own deadline', async () => {
    const root = await fixture({ label: 'late', adaptive: true, budgetChars: await nativeMissesDelivery() });
    let bodyTornDown = false;
    const fetchImpl: typeof fetch = async (_resource, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            bodyTornDown = true;
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              // already closed
            }
          }, { once: true });
          // Headers are in time; the answer table never arrives in time.
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl,
      requestTimeoutMs: 150,
      minExecutableBudgetMs: 0,
    });
    expect(bodyTornDown, 'the completion deadline must cancel the body').toBe(true);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:SELECTION_EXPIRED');
    expect(result.stderr.join('')).toContain('stage=generation');
  });

  // ── PRI-1182 §1: the shared 2 s window is an execution constraint ─────────
  // Both cases run through the SAME production entry with NO timing seams, so
  // they prove the compiled-in envelope rather than a test-only arrangement.

  it('the shared 2 s window completes an in-time answer table and assembly', async () => {
    const budgetChars = await nativeMissesDelivery();
    const root = await fixture({ label: 'frozen-envelope-ok', adaptive: true, budgetChars });
    const transport = echoingTransport(TEXT.DELIVERY);
    const startedAt = Date.now();
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl: async (resource, init) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 650));
        return transport.fetchImpl(resource, init);
      },
    });
    const wallClockMs = Date.now() - startedAt;

    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).toContain(TEXT.DELIVERY);
    const stderr = result.stderr.join('');
    expect(stderr).toContain('reason=adaptive_selection_selected:selected');
    expect(stderr).toContain('modelObserved=' + DECISION_MODEL);
    // Measured from the actual send to a VALIDATED table.
    const sentAt = Number(/requestSentAt=(\d+)/u.exec(stderr)?.[1]);
    const validatedAt = Number(/validatedAt=(\d+)/u.exec(stderr)?.[1]);
    expect(Number.isFinite(sentAt) && Number.isFinite(validatedAt), stderr).toBe(true);
    expect(validatedAt - sentAt).toBeGreaterThanOrEqual(600);
    expect(validatedAt - sentAt).toBeLessThan(CODEX_ADAPTIVE_DECISION_MS);
    // Process entry → final stdout stays inside the host's hook window.
    expect(wallClockMs).toBeLessThan(CODEX_HOOK_TIMEOUT_MS);
  });

  it('a body that crosses the shared 2 s window is cancelled and the turn stays Native', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'frozen-envelope-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'frozen-envelope-late', adaptive: true, budgetChars });
    const transport = echoingTransport(TEXT.DELIVERY);
    let bodyTornDown = false;
    const fetchImpl: typeof fetch = async (resource, init) => {
      const response = await transport.fetchImpl(resource, init);
      const body = await response.text();
      await new Promise<void>((resolve) => setTimeout(resolve, 650));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            bodyTornDown = true;
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              // already closed
            }
          }, { once: true });
          // A complete, valid table would arrive inside a fresh two-second
          // body window, but outside the original send-to-validation window.
          const lateBody = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }, 1600);
          init?.signal?.addEventListener('abort', () => clearTimeout(lateBody), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const startedAt = Date.now();
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl });
    const wallClockMs = Date.now() - startedAt;

    expect(bodyTornDown, 'the completion window must cancel the body').toBe(true);
    expect(additionalContext(result)).toBe(additionalContext(native));
    const stderr = result.stderr.join('');
    expect(stderr).toContain('reason=adaptive_selection_none:SELECTION_EXPIRED');
    expect(stderr).toContain('stage=generation');
    expect(stderr).toContain('generationEndedAt=unknown');
    const sentAt = Number(/requestSentAt=(\d+)/u.exec(stderr)?.[1]);
    const cancelledAt = Number(/cancelledAt=(\d+)/u.exec(stderr)?.[1]);
    expect(Number.isFinite(sentAt) && Number.isFinite(cancelledAt), stderr).toBe(true);
    // Timers may wake late under load. No late result may be applied.
    expect(cancelledAt - sentAt).toBeGreaterThanOrEqual(CODEX_ADAPTIVE_DECISION_MS - 20);
    expect(wallClockMs).toBeLessThan(CODEX_HOOK_TIMEOUT_MS);
  });

  it('a target Native already injects stays byte-identical (no duplicate directive)', async () => {
    const root = await fixture({ label: 'already-covered', adaptive: true, budgetChars: 4000 });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(0);
    const context = additionalContext(result);
    expect(context).toContain(TEXT.DELIVERY);
    expect(context.split(TEXT.DELIVERY).length - 1).toBe(1);
    expect(result.stderr.join('')).toContain('NO_CANDIDATES');
  });

  it('the plugin hook window is the budget source and the PD self-deadline stays inside it', () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../../../plugins/principles-disciple/hooks/hooks.json', import.meta.url), 'utf8'),
    ) as { hooks: { UserPromptSubmit: Array<{ hooks: Array<{ timeout: number }> }> } };
    const hookTimeoutMs = manifest.hooks.UserPromptSubmit[0]!.hooks[0]!.timeout * 1000;
    expect(hookTimeoutMs).toBe(CODEX_HOOK_TIMEOUT_MS);
    expect(CODEX_ADAPTIVE_BUDGET_MS + CODEX_NATIVE_RESERVE_MS).toBe(CODEX_HOOK_TIMEOUT_MS);
    // The Native body still has to be packed, encoded and written after the
    // Adaptive step is cancelled; the reserve is what that budget protects.
    expect(CODEX_NATIVE_RESERVE_MS).toBeGreaterThanOrEqual(500);
  });

  it('an outer hook deadline cancels a response that already started and keeps Native', async () => {
    const budgetChars = await nativeMissesDelivery();
    const root = await fixture({ label: 'outer-deadline', adaptive: true, budgetChars });
    let abortObserved = false;
    let bodyTornDown = false;
    const fetchImpl: typeof fetch = async (_resource, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            abortObserved = true;
            bodyTornDown = true;
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              // The stream is already closed; the abort still reached it.
            }
          }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const startedAt = Date.now();
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl,
      hookBudgetMs: 600,
      // This scenario isolates transport cancellation; the budget gate is
      // exercised separately below.
      minExecutableBudgetMs: 0,
      requestTimeoutMs: 5000,
    });
    const elapsed = Date.now() - startedAt;
    expect(abortObserved, 'the outer deadline must reach the transport').toBe(true);
    expect(bodyTornDown).toBe(true);
    expect(elapsed).toBeLessThan(1500);
    expect(additionalContext(result)).toContain(TEXT.SCOPE);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:TURN_DEADLINE_EXCEEDED');
    expect(result.stderr.join('')).toContain('stage=generation');
    // Distinguishable from a pure generation timeout (SELECTION_EXPIRED).
    expect(result.stderr.join('')).not.toContain('SELECTION_EXPIRED');
  });

  it('a valid selection that arrives after the outer deadline cannot change the final body', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'late-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'late-selection', adaptive: true, budgetChars });
    let abortObserved = false;
    const fetchImpl: typeof fetch = async (_resource, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            abortObserved = true;
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              // already closed
            }
          }, { once: true });
          // A protocol-valid answer, but only after the outer deadline.
          setTimeout(() => {
            try {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({
                model: DECISION_MODEL,
                provider: DECISION_PROVIDER,
                answers: { insufficient_context: { type: 'noul', noul: 0.01 } },
              })));
              controller.close();
            } catch {
              // Aborted first.
            }
          }, 1500);
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const startedAt = Date.now();
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl,
      hookBudgetMs: 600,
      minExecutableBudgetMs: 0,
      requestTimeoutMs: 5000,
    });
    expect(abortObserved).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('TURN_DEADLINE_EXCEEDED');
  });

  it('a fast none_applicable answer returns normally under the hook budget', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'none-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'none-fast', adaptive: true, budgetChars });
    const transport = scoringTransport(() => ({}));
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl: transport.fetchImpl,
      hookBudgetMs: 2000,
    });
    expect(transport.calls()).toBe(1);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:no_increment');
    expect(result.stderr.join('')).toContain('stage=done');
    expect(result.stderr.join('')).not.toContain('TURN_DEADLINE_EXCEEDED');
  });

  it('a selected target that cannot fit leaves Native untouched', async () => {
    const probe = await fixture({ label: 'nofit-probe', adaptive: false, budgetChars: 4000, order: ['BIG', 'SCOPE', 'DELIVERY', 'TESTS'] });
    const measured = await measureCosts(probe);
    const budgetChars = measured.base + measured.blocks.BIG + 5;
    const root = await fixture({ label: 'nofit', adaptive: true, budgetChars, order: ['BIG', 'SCOPE', 'DELIVERY', 'TESTS'] });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    const context = additionalContext(result);
    expect(context).toContain(TEXT.BIG);
    expect(context).not.toContain(TEXT.DELIVERY);
  });

  // ── PRI-1181/PRI-1182: deterministic zero-call gate before the candidate read ─

  it('a pure acknowledgement costs zero requests and leaves Native byte-identical', async () => {
    const budgetChars = await nativeMissesDelivery();
    const prompt = '收到，谢谢！';
    const nativeRoot = await fixture({ label: 'ack-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot, { prompt }), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'ack', adaptive: true, budgetChars });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root, { prompt }), envFor(root), root, { fetchImpl: transport.fetchImpl });

    expect(transport.calls()).toBe(0);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('status=skipped');
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_skipped:trivial_confirmation');
    expect(result.stderr.join('')).toContain('sends=0');
  });

  it('a short approval is NOT skipped: it enters the decision path', async () => {
    // The counterexample: "要不要提交最终版？" → "确认". It is a stage change.
    const root = await fixture({ label: 'approval', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root, { prompt: '确认' }), envFor(root), root, {
      fetchImpl: transport.fetchImpl,
    });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).not.toContain('trivial_confirmation');
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_selected:selected');
  });

  it('an exhausted hook budget costs zero requests and leaves Native byte-identical', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'budget-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'budget-skip', adaptive: true, budgetChars });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl: transport.fetchImpl,
      hookBudgetMs: 400,
    });

    expect(transport.calls()).toBe(0);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_skipped:budget_insufficient');
  });

  it('the old 1500 ms line no longer blocks an executable fast request', async () => {
    const budgetChars = await nativeMissesDelivery();
    const root = await fixture({ label: 'sub-1500', adaptive: true, budgetChars });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl: transport.fetchImpl,
      hookBudgetMs: 1400,
    });
    // 1400 ms remaining would have been skipped under the old slow-path line;
    // the request is executable, so it is sent and the fast answer is applied.
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).not.toContain('budget_insufficient');
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_selected:selected');
  });

  it('a short continuation is NOT mistaken for a social acknowledgement', async () => {
    const root = await fixture({ label: 'continuation', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = scoringTransport(() => ({}));
    const result = await processHookInvocation(input(root, { prompt: '继续' }), envFor(root), root, {
      fetchImpl: transport.fetchImpl,
    });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:no_increment');
    expect(result.stderr.join('')).not.toContain('trivial_confirmation');
  });

  it('close condition scores are treated as abstention with one request', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'uncertain-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'uncertain', adaptive: true, budgetChars });
    const transport = scoringTransport((request) => ({
      [candidateQuestion(refOf(request, TEXT.DELIVERY))]: 0.82,
      [candidateQuestion(refOf(request, TEXT.TESTS))]: 0.74,
    }));
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });

    expect(transport.calls()).toBe(1);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:uncertain');
  });

  it('a high candidate score with insufficient context is treated as abstention', async () => {
    const budgetChars = await nativeMissesDelivery();
    const nativeRoot = await fixture({ label: 'insufficient-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'insufficient', adaptive: true, budgetChars });
    const transport = scoringTransport((request) => ({
      [candidateQuestion(refOf(request, TEXT.DELIVERY))]: 0.95,
      insufficient_context: 0.88,
    }));
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });

    expect(transport.calls()).toBe(1);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:uncertain');
  });

  it('a prompt that only QUOTES a past delivery statement does not activate it', async () => {
    const budgetChars = await nativeMissesDelivery();
    const prompt = `你刚才说「${TEXT.DELIVERY}」，这句话具体什么意思？`;
    const nativeRoot = await fixture({ label: 'quote-native', adaptive: false, budgetChars });
    const native = await processHookInvocation(input(nativeRoot, { prompt }), envFor(nativeRoot), nativeRoot);

    const root = await fixture({ label: 'quote', adaptive: true, budgetChars });
    const transport = scoringTransport(() => ({}));
    const result = await processHookInvocation(input(root, { prompt }), envFor(root), root, { fetchImpl: transport.fetchImpl });

    expect(transport.calls()).toBe(1);
    expect(additionalContext(result)).toBe(additionalContext(native));
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:no_increment');
  });

  it('a candidate revised between request and revalidation cannot be applied', async () => {
    const root = await fixture({ label: 'revised', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = echoingTransport(TEXT.DELIVERY);
    const fetchImpl: typeof fetch = async (resource, init) => {
      const connection = new SqliteConnection(root);
      try {
        connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run(
          JSON.stringify({ principleId: 'DELIVERY', text: `${TEXT.DELIVERY}（修订版）` }),
          'art-DELIVERY',
        );
      } finally {
        connection.close();
      }
      return transport.fetchImpl(resource, init);
    };
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl });
    expect(transport.calls()).toBe(1);
    expect(additionalContext(result)).not.toContain(`${TEXT.DELIVERY}（修订版）`);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:revalidation_failed');
  });

  it('a candidate revoked between request and revalidation cannot be applied', async () => {
    const root = await fixture({ label: 'revoked', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = echoingTransport(TEXT.DELIVERY);
    const fetchImpl: typeof fetch = async (resource, init) => {
      const connection = new SqliteConnection(root);
      try {
        await new SqliteActivationStateStore(connection).deactivateActivation('act-DELIVERY', new Date().toISOString());
      } finally {
        connection.close();
      }
      return transport.fetchImpl(resource, init);
    };
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl });
    expect(transport.calls()).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:revalidation_failed');
  });
});
