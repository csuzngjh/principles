/**
 * PRI-1170 — Adaptive Activation through the REAL Codex hook entry.
 *
 * Everything here goes through `processHookInvocation` → the real decoder →
 * `pd-hook` → `createProductionHostRuntime.dispatch` → `adaptivePriorityProvider`
 * → shared Runtime V2 reader + revalidation + `additiveOnly` packer. Only the
 * HTTP transport is fake.
 *
 * The fake endpoint answers from the candidate list it ACTUALLY received
 * (reference + digest), so a payload that forgets the locally precomputed
 * digest can never produce a valid selection.
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
import { processHookInvocation } from '../src/pd-hook.js';

const TEXT = {
  SCOPE: '只修改与任务直接相关的文件，邻近改进记为后续事项。',
  BIG: '避免为假设的未来需求预建抽象和额外服务。'.repeat(40),
  DELIVERY: '交付验收前以可观察证据自检：先列出验收基准与已有证据；缺证据时如实限定结论。',
  TESTS: '修复缺陷时先写能复现问题的回归测试，再改实现。',
};
const ORDER = ['SCOPE', 'BIG', 'DELIVERY', 'TESTS'] as const;
const API_KEY_ENV = 'PD_TEST_ADAPTIVE_KEY';
const MODEL = 'glm-5.3-flash';
/** chars = tokens / 32, so tokens = chars * 32. */
const CHARS_PER_TOKEN = 32;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
// The shared selector and the Pi AI adapter both resolve the key from the real
// process environment; the transport stays fake, so this value is never used.
beforeAll(() => { process.env[API_KEY_ENV] = 'test-key'; });
afterAll(() => { delete process.env[API_KEY_ENV]; });

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

interface FixtureOptions {
  readonly label: string;
  readonly order?: ReadonlyArray<keyof typeof TEXT>;
  readonly adaptive: boolean;
  /** Budget expressed in chars; converted to the operator-declared token window. */
  readonly budgetChars: number;
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
  config.runtimeProfiles['pd.default'] = {
    type: 'pi-ai',
    provider: 'zai-coding-plan',
    model: MODEL,
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKeyEnv: API_KEY_ENV,
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
}) as unknown as NodeJS.ProcessEnv;

function sse(payload: unknown): Response {
  const packets = [
    { id: 'fake', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: null }] },
    { id: 'fake', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  return new Response(`${packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

interface CandidateOnWire {
  readonly ref: string;
  readonly text: string;
  readonly digest?: string;
}

/** Candidate list parsed out of the real outbound request body. */
function requestCandidates(init: RequestInit | undefined): CandidateOnWire[] {
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe(MODEL);
  expect(body.max_tokens).toBe(512);
  const message = (body.messages ?? []).find(
    (item: { content?: unknown }) => typeof item.content === 'string' && item.content.trim().startsWith('{'),
  );
  expect(message, 'selection payload must be a JSON message').toBeTruthy();
  const payload = JSON.parse(message.content);
  expect(Array.isArray(payload.candidates)).toBe(true);
  return payload.candidates;
}

interface Transport {
  readonly fetchImpl: typeof fetch;
  readonly calls: () => number;
}

/** Answers using reference + digest READ FROM THE REQUEST, never recomputed. */
function echoingTransport(marker: string): Transport {
  const inits: Array<RequestInit | undefined> = [];
  const fetchImpl: typeof fetch = async (_resource, init) => {
    inits.push(init);
    const candidates = requestCandidates(init);
    const candidate = candidates.find((item) => item.text.includes(marker));
    expect(candidate, `request must carry the candidate containing ${marker}`).toBeTruthy();
    expect(typeof candidate?.digest).toBe('string');
    expect(candidate?.digest).toBe(sha256(candidate?.text ?? ''));
    return sse({ status: 'selected', id: candidate?.ref, digest: candidate?.digest });
  };
  return { fetchImpl, calls: () => inits.length };
}

function answeringTransport(answer: unknown): Transport {
  const inits: Array<RequestInit | undefined> = [];
  const fetchImpl: typeof fetch = async (_resource, init) => {
    inits.push(init);
    return sse(answer);
  };
  return { fetchImpl, calls: () => inits.length };
}

const additionalContext = (result: { stdout: unknown }): string => {
  const output = result.stdout as { hookSpecificOutput?: { additionalContext?: string } };
  return output.hookSpecificOutput?.additionalContext ?? '';
};

describe('PRI-1170 Codex exec Adaptive wiring', () => {
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

  it('an unusable selection model degrades to Native with zero requests', async () => {
    const root = await fixture({ label: 'needs-setup', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(
      input(root),
      { CODEX_HOME: path.join(root, 'codex-home') } as NodeJS.ProcessEnv,
      root,
      { fetchImpl: transport.fetchImpl },
    );
    expect(transport.calls()).toBe(0);
    expect(result.stderr.join('')).toContain('adaptive_activation_disabled');
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
  });

  it('a reference the frozen table does not know is rejected', async () => {
    const root = await fixture({ label: 'bad-ref', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = answeringTransport({ status: 'selected', id: 'c99', digest: 'a'.repeat(64) });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toMatch(/adaptive_selection_none:SELECTION_(REFERENCE|DIGEST)_INVALID/);
  });

  it('a digest that is not the candidate body hash is rejected', async () => {
    const root = await fixture({ label: 'bad-digest', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = answeringTransport({ status: 'selected', id: 'c1', digest: sha256('guessed') });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('SELECTION_DIGEST_INVALID');
  });

  it('a missing digest cannot select (models cannot compute sha256)', async () => {
    const root = await fixture({ label: 'no-digest', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const transport = answeringTransport({ status: 'selected', id: 'c1', digest: null });
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toMatch(/adaptive_selection_none:SELECTION_(DIGEST|REFERENCE)_INVALID/);
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
      firstByteTimeoutMs: 30,
      generationTimeoutMs: 30,
    });
    expect(calls, result.stderr.join('')).toBe(1);
    expect(aborted).toBe(true);
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:SELECTION_EXPIRED');
    expect(result.stderr.join('')).toContain('stage=admission');
  });

  it('a response that starts in time but finishes late is not applied', async () => {
    const root = await fixture({ label: 'late', adaptive: true, budgetChars: await nativeMissesDelivery() });
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async (_resource, init) => {
      const candidates = requestCandidates(init);
      const candidate = candidates.find((item) => item.text.includes(TEXT.DELIVERY));
      const body = JSON.stringify({ status: 'selected', id: candidate?.ref, digest: candidate?.digest });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'fake', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`));
          setTimeout(() => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'fake', model: MODEL, choices: [{ index: 0, delta: { content: body }, finish_reason: null }] })}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'fake', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }, 120);
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const result = await processHookInvocation(input(root), envFor(root), root, {
      fetchImpl,
      firstByteTimeoutMs: 500,
      generationTimeoutMs: 40,
    });
    expect(additionalContext(result)).not.toContain(TEXT.DELIVERY);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_none:SELECTION_EXPIRED');
    expect(result.stderr.join('')).toContain('stage=generation');
  });

  it('a target Native already injects stays byte-identical (no duplicate directive)', async () => {
    const root = await fixture({ label: 'already-covered', adaptive: true, budgetChars: 4000 });
    const transport = echoingTransport(TEXT.DELIVERY);
    const result = await processHookInvocation(input(root), envFor(root), root, { fetchImpl: transport.fetchImpl });
    expect(transport.calls(), result.stderr.join('')).toBe(1);
    const context = additionalContext(result);
    expect(context).toContain(TEXT.DELIVERY);
    expect(context.split(TEXT.DELIVERY).length - 1).toBe(1);
    expect(result.stderr.join('')).toContain('reason=adaptive_selection_selected:selected');
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
});
