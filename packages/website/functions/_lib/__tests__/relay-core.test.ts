/**
 * Relay Core Tests — Slice 4, spec §13 (relay row).
 *
 * Two concerns:
 *  1. Cross-implementation fingerprint consistency: the relay WebCrypto
 *     implementation (fingerprint-webcrypto.ts) MUST produce the exact same
 *     sha256 hex as core's node:crypto fingerprint for the SHARED CORE_VECTORS
 *     fixture that core ships in fingerprint.test.ts (spec §5.3). If the two
 *     drift, dedup clustering breaks across the Console↔relay boundary.
 *  2. Relay request handling (relay-core.ts) is dependency-injected, so we
 *     exercise the PRODUCTION code path with in-memory KV + Linear fetch fakes
 *     (EP-02) rather than a hand-rolled copy or a miniflare shim.
 *
 * ERR checklist:
 * - EP-01 / ERR-001: body fields stay `unknown`; relay refuses unknown top-level
 *   keys rather than silently ignoring them.
 * - EP-08: constant-time token compare; 256KB body cap.
 * - EP-03 / rc-9: every refusal carries a structured reason + nextAction.
 * - EP-05 / rc-7: rate-limit + fingerprint records read fresh from KV each call;
 *   duplicate-branch count is written with current-iteration data.
 */
import { describe, it, expect } from 'vitest';
import {
  handleFeedbackSubmit,
  recomputeAndCompareFingerprint,
  buildRelayIssueTitle,
  appendAggregationFooter,
  parseTrackingId,
  buildLinearIssueCreate,
  buildLinearCommentCreate,
  type RelayEnv,
  type RelayKV,
} from '../relay-core.js';
import { handleFeedbackHealth } from '../health.js';
import { computeFeedbackFingerprintWebCrypto } from '../fingerprint-webcrypto.js';

/**
 * Shared cross-implementation vectors — MUST mirror
 * `packages/principles-core/src/runtime-v2/feedback/__tests__/fingerprint.test.ts`
 * (CORE_VECTORS). Do not change without updating that fixture.
 */
const CORE_VECTORS: {
  type: string;
  area: string | undefined;
  title: string;
  expected: string;
}[] = [
  {
    type: 'bug',
    area: 'failed_tasks',
    title: 'Peers never finish',
    expected: '58ed53e95d411083e43a722af7dd0fe278988158a06b5dfeaba7219e203272ad',
  },
  {
    type: 'confusing',
    area: undefined,
    title: 'What does "ok" mean?',
    expected: 'cc82d7792a4b816d29596d4f0d6e8b00f8836889d3efc648bd77c945923139de',
  },
  {
    type: 'feature_request',
    area: 'principles',
    title: '设置里无法保存 环境变量',
    expected: 'd388e28fe715e7455ccc2b7a98f05760e9944411b17830c933cc8774f783c38b',
  },
];

/** In-memory KV fake — satisfies RelayKV. */
class MemKV implements RelayKV {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  spy(): Map<string, string> {
    return this.map;
  }
}

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(json: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

/** Deterministic random so trackingId is stable: byte = 128 → '80'. */
const FIXED_RANDOM = () => 0.5;
const FIXED_NOW = 1700000000000; // fixed epoch ms for stable rate-limit buckets.

interface BuildSubmitOpts {
  fingerprint: string;
  report: Record<string, unknown>;
  area?: string;
}

function buildSubmitBody({ fingerprint, report, area }: BuildSubmitOpts): string {
  return JSON.stringify({ report, fingerprint, area });
}

function makeEnv(overrides?: Partial<RelayEnv>): RelayEnv {
  return {
    FEEDBACK_KV: new MemKV(),
    INGEST_TOKEN: 'test-token',
    LIN_TEAM_ID: 'TEAM',
    LIN_API_KEY: 'lin-key',
    ...overrides,
  };
}

interface SubmitResult {
  result: Awaited<ReturnType<typeof handleFeedbackSubmit>>;
  kv: Map<string, string>;
  linearCalls: { url: string; body: unknown }[];
}

async function submit(opts: {
  env?: RelayEnv;
  /** `null` renders a missing Authorization header; undefined → default Bearer token. */
  authToken?: string | null;
  body?: string;
  ip?: string;
  linearResponses?: FakeResponse[];
}): Promise<SubmitResult> {
  const env = opts.env ?? makeEnv();
  const linearCalls: { url: string; body: unknown }[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<FakeResponse> => {
    linearCalls.push({ url, body: JSON.parse(String(init.body)) });
    const responses = opts.linearResponses ?? [
      jsonResponse({ data: { issueCreate: { success: true, issue: { id: 'ISS-1', url: 'https://linear.app/acme/ISS-1' } } } }),
    ];
    return responses.shift() ?? jsonResponse({ error: 'unexpected linear call' }, 500);
  };
  const result = await handleFeedbackSubmit({
    env,
    authToken: opts.authToken === null ? undefined : opts.authToken ?? 'Bearer test-token',
    ip: opts.ip ?? '1.2.3.4',
    body: opts.body,
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => FIXED_NOW,
    random: FIXED_RANDOM,
  });
  return { result, kv: (env.FEEDBACK_KV as MemKV).spy(), linearCalls };
}

/** Report + fingerprint that passes relay validation. */
async function freshBody(): Promise<{ body: string; report: Record<string, unknown>; fingerprint: string }> {
  const report: Record<string, unknown> = {
    type: 'bug',
    title: 'Peers never finish',
    area: 'failed_tasks',
    description: 'Tasks stay in queued forever.',
  };
  const fingerprint = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
  return { body: buildSubmitBody({ report, fingerprint, area: 'failed_tasks' }), report, fingerprint };
}

// --------------------------------------------------------------------------
// 1) Cross-implementation fingerprint consistency (shared CORE_VECTORS).
// --------------------------------------------------------------------------
describe('relay fingerprint ↔ core fingerprint (shared vectors)', () => {
  it('reproduces every core CORE_VECTORS hex with WebCrypto', async () => {
    for (const v of CORE_VECTORS) {
      const hex = await computeFeedbackFingerprintWebCrypto({ type: v.type, area: v.area, title: v.title });
      expect(hex).toBe(v.expected);
    }
  });

  it('is case-insensitive on type and title, matching core', async () => {
    const lower = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    const upper = await computeFeedbackFingerprintWebCrypto({ type: 'BUG', title: 'PEERS NEVER FINISH', area: 'failed_tasks' });
    expect(upper).toBe(lower);
  });

  it('normalizes two equivalent differently-punctuated titles to the same fingerprint', async () => {
    const a = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title: 'Login fails: token expired!' });
    const b = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title: 'login fails token expired' });
    expect(a).toBe(b);
  });

  it('produces a bounded 64-char lower-hex fingerprint', async () => {
    const fp = await computeFeedbackFingerprintWebCrypto({ type: 'other', title: 'anything' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --------------------------------------------------------------------------
// 2) Builders / pure helpers.
// --------------------------------------------------------------------------
describe('relay pure helpers', () => {
  it('builds a typed Linear title with a general fallback area', () => {
    expect(buildRelayIssueTitle({ type: 'bug', area: 'dashboard', title: 'crashes' })).toBe(
      '[PD反馈][bug][dashboard] crashes',
    );
    expect(buildRelayIssueTitle({ type: 'bug', title: 'crashes' })).toBe('[PD反馈][bug][general] crashes');
  });

  it('appends an aggregation count footer', () => {
    expect(appendAggregationFooter('hello', 3)).toBe('hello\n\n---\n_收到 3 条同类反馈。_');
  });

  it('mints a stable dotted tracking id from random()', () => {
    expect(parseTrackingId(FIXED_RANDOM)).toBe('fb-80808080');
  });

  it('builds issueCreate and commentCreate graphQL mutations', () => {
    const create = buildLinearIssueCreate({ teamId: 'T', title: 'x', description: 'd', priority: 1 });
    expect(create.variables).toEqual({ teamId: 'T', title: 'x', description: 'd', priority: 1 });
    expect(create.query).toContain('issueCreate');
    const comment = buildLinearCommentCreate({ issueId: 'ISS-1', body: 'b' });
    expect(comment.variables).toEqual({ issueId: 'ISS-1', body: 'b' });
    expect(comment.query).toContain('commentCreate');
  });
});

// --------------------------------------------------------------------------
// 3) Fingerprint verification (recompute + compare).
// --------------------------------------------------------------------------
describe('recomputeAndCompareFingerprint', () => {
  it('accepts a matching fingerprint', async () => {
    const fp = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    const out = await recomputeAndCompareFingerprint({
      submitted: fp,
      report: { type: 'bug', title: 'Peers never finish', area: 'failed_tasks' },
      compute: (i) => computeFeedbackFingerprintWebCrypto(i),
    });
    expect(out.ok).toBe(true);
  });

  it('rejects a non-string/empty fingerprint', async () => {
    const out = await recomputeAndCompareFingerprint({
      submitted: '',
      report: { type: 'bug', title: 'x', area: 'a' },
      compute: (i) => computeFeedbackFingerprintWebCrypto(i),
    });
    expect(out.ok).toBe(false);
  });

  it('rejects a tampered report (fingerprint no longer matches)', async () => {
    const fp = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    const out = await recomputeAndCompareFingerprint({
      submitted: fp,
      report: { type: 'bug', title: 'Peers never finish', area: 'different_area' }, // area swapped
      compute: (i) => computeFeedbackFingerprintWebCrypto(i),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('mismatch');
  });

  it('rejects when type/title are missing', async () => {
    const out = await recomputeAndCompareFingerprint({
      submitted: 'abc',
      report: { area: 'a' },
      compute: (i) => computeFeedbackFingerprintWebCrypto(i),
    });
    expect(out.ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 4) handleFeedbackSubmit — auth / rate / size / whitelist / branches.
// --------------------------------------------------------------------------
describe('handleFeedbackSubmit security posture', () => {
  it('returns uniform 401 when token missing or wrong (constant-time)', async () => {
    const body = (await freshBody()).body;
    for (const authToken of [null, 'Bearer wrong-token', 'Nope test-token']) {
      const { result } = await submit({ authToken, body });
      expect(result.status).toBe(401);
    }
  });

  it('returns 413 when the body exceeds the size cap', async () => {
    const r = await freshBody();
    // size cap is enforced on the decoded text bytes BEFORE the whitelist pass,
    // so a huge but malformed body still yields 413 (not 400).
    const tooBig = JSON.stringify({ report: { ...r.report }, fingerprint: r.fingerprint, area: 'failed_tasks', padding: 'x'.repeat(300 * 1024) });
    const { result } = await submit({ body: tooBig });
    expect(result.status).toBe(413);
  });

  it('returns 429 after the hourly rate limit, with retry-after', async () => {
    const env = makeEnv();
    const ip = '9.9.9.9';
    const hourBucket = Math.floor(FIXED_NOW / (60 * 60 * 1000));
    await env.FEEDBACK_KV.put(`rl:${ip}:${hourBucket}`, '5'); // already at limit
    const { body } = await freshBody();
    const { result } = await submit({ env, body, ip });
    expect(result.status).toBe(429);
    if (!('reason' in (result.json as object))) throw new Error('expected json');
    expect((result.json as { nextAction?: string }).nextAction).toContain('retry');
  });

  it('rejects unknown top-level fields (whitelist)', async () => {
    const r = await freshBody();
    const injected = JSON.stringify({ ...JSON.parse(r.body), evil: 'x' });
    const { result } = await submit({ body: injected });
    expect(result.status).toBe(400);
    expect((result.json as { reason?: string }).reason).toContain('not allowed');
  });

  it('rejects a fingerprint mismatch with 400 (integrity check)', async () => {
    const r = await freshBody();
    const forged = JSON.stringify({ report: r.report, area: 'failed_tasks', fingerprint: '0'.repeat(64) });
    const { result } = await submit({ body: forged });
    expect(result.status).toBe(400);
    expect((result.json as { reason?: string }).reason).toContain('mismatch');
  });

  it('returns 400 when body is not JSON or not an object', async () => {
    for (const body of ['not-json', '123', '[]']) {
      const { result } = await submit({ body });
      expect(result.status).toBe(400);
    }
  });
});

// --------------------------------------------------------------------------
// 5) First-branch (issueCreate) vs duplicate-branch (comment).
// --------------------------------------------------------------------------
describe('handleFeedbackSubmit first-vs-duplicate branch', () => {
  it('creates a Linear issue on first sight and records the fp + id mapping in KV', async () => {
    const r = await freshBody();
    const env = makeEnv();
    const { result, kv, linearCalls } = await submit({ env, body: r.body });

    expect(result.status).toBe(202);
    const json = result.json as { duplicate: boolean; count: number; trackingId: string; issueUrl: string };
    expect(json.duplicate).toBe(false);
    expect(json.count).toBe(1);
    expect(json.trackingId).toBe('fb-80808080');
    expect(json.issueUrl).toBe('https://linear.app/acme/ISS-1');

    // Exactly one Linear call — an issueCreate.
    expect(linearCalls).toHaveLength(1);
    const createCall = (linearCalls[0] as { body: unknown }).body as {
      query: string;
      variables: { teamId: string; title: string };
    };
    expect(createCall.query).toContain('issueCreate');
    expect(createCall.variables).toMatchObject({
      teamId: 'TEAM',
      title: `[PD反馈][bug][failed_tasks] Peers never finish`,
    });

    // KV: fingerpint record + id mapping.
    const fpRecord = JSON.parse(kv.get(`fp:${r.fingerprint}`) as string);
    expect(fpRecord).toMatchObject({ count: 1, issueId: 'ISS-1', issueUrl: 'https://linear.app/acme/ISS-1' });
    expect(kv.has(`id:fb-80808080`)).toBe(true);
  });

  it('comments on the existing issue when the same fingerprint recurs', async () => {
    const r = await freshBody();
    const env = makeEnv();
    // Seed an existing fingerprint record pointing at an already-created issue.
    await env.FEEDBACK_KV.put(
      `fp:${r.fingerprint}`,
      JSON.stringify({ count: 2, firstSeen: 't1', lastSeen: 't1', issueId: 'ISS-1', issueUrl: 'https://linear.app/acme/ISS-1' }),
    );
    const { result, kv, linearCalls } = await submit({
      env,
      body: r.body,
      linearResponses: [jsonResponse({ data: { commentCreate: { success: true, comment: { id: 'C1' } } } })],
    });

    expect(result.status).toBe(202);
    const json = result.json as { duplicate: boolean; count: number; issueUrl: string };
    expect(json.duplicate).toBe(true);
    expect(json.count).toBe(3); // 2 seeded + 1
    expect(json.issueUrl).toBe('https://linear.app/acme/ISS-1');

    // One Linear call — a comment (commentCreate), not a new issue.
    expect(linearCalls).toHaveLength(1);
    const call = (linearCalls[0] as { body: unknown }).body as {
      query: string;
      variables: { issueId: string };
    };
    expect(call.query).toContain('commentCreate');
    expect(call.variables.issueId).toBe('ISS-1');

    // KV count increments with current-iteration data.
    const fpRecord = JSON.parse(kv.get(`fp:${r.fingerprint}`) as string);
    expect(fpRecord.count).toBe(3);
  });

  it('maps blockingLevel to Linear priority (blocked → High=1)', async () => {
    const r = await freshBody();
    r.report.userText = { blockingLevel: 'blocked' };
    const body = buildSubmitBody({ report: r.report, fingerprint: r.fingerprint, area: 'failed_tasks' });
    const { linearCalls } = await submit({ body });
    const call = (linearCalls[0] as { body: unknown }).body as { variables: { priority: number } };
    expect(call.variables.priority).toBe(1);
  });

  it('fails with 502 when Linear create returns a non-ok HTTP status', async () => {
    const r = await freshBody();
    const env = makeEnv();
    const { result } = await submit({
      env,
      body: r.body,
      linearResponses: [
        jsonResponse({ error: 'boom' }, 500),
        jsonResponse({ error: 'boom' }, 500),
      ],
    });
    expect(result.status).toBe(502);
    expect((result.json as { error?: string }).error).toContain('linear');
  });

  it('fails with 502 when LIN_TEAM_ID is not configured (first branch)', async () => {
    const r = await freshBody();
    const env = makeEnv({ LIN_TEAM_ID: undefined });
    const { result } = await submit({ env, body: r.body });
    expect(result.status).toBe(502);
    expect((result.json as { error?: string }).error).toBe('linear_misconfigured');
  });
});

// --------------------------------------------------------------------------
// 6) Health endpoint.
// --------------------------------------------------------------------------
describe('handleFeedbackHealth', () => {
  it('returns 200 ok on the health probe', async () => {
    const result = await handleFeedbackHealth();
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });
  });
});