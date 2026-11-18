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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  handleFeedbackSubmit,
  recomputeAndCompareFingerprint,
  buildRelayIssueTitle,
  appendAggregationFooter,
  parseTrackingId,
  buildLinearIssueCreate,
  buildLinearCommentCreate,
  DAILY_ISSUE_CREATE_CAP,
  type RelayD1,
  type RelayEnv,
  type RelayKV,
} from '../relay-core.js';
import { handleFeedbackHealth } from '../health.js';
import { computeFeedbackFingerprintWebCrypto } from '../fingerprint-webcrypto.js';

/**
 * Shared cross-implementation vectors — MUST mirror
 * `packages/principles-core/src/runtime/feedback/__tests__/fingerprint.test.ts`
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

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

/** D1 shim over a real in-memory SQLite with every migration applied. */
class SqliteD1Shim implements RelayD1 {
  readonly db = new Database(':memory:');
  constructor() {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((n) => /^\d+_.*\.sql$/.test(n)).sort();
    for (const file of files) {
      const ddl = fs
        .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      for (const statement of ddl.split(';')) {
        if (statement.trim().length > 0) this.db.prepare(statement.trim()).run();
      }
    }
  }
  prepare(query: string) {
    const statement = this.db.prepare(query);
    return {
      bind: (...values: unknown[]) => ({
        first: async () => (statement.reader ? statement.get(...values) : (statement.run(...values), null)) ?? null,
        run: async () => ({ meta: { changes: statement.run(...values).changes } }),
      }),
    };
  }
  counters(): Array<{ counter_key: string; count: number; expires_at: number }> {
    return this.db.prepare('SELECT * FROM feedback_rate_counters').all() as Array<{ counter_key: string; count: number; expires_at: number }>;
  }
}

function makeEnv(overrides?: Partial<RelayEnv>): RelayEnv {
  return {
    FEEDBACK_KV: new MemKV(),
    PD_PRODUCT_TELEMETRY: new SqliteD1Shim(),
    INGEST_TOKEN: 'test-token',
    LIN_TEAM_ID: 'TEAM',
    LIN_API_KEY: 'lin-key',
    ...overrides,
  };
}

interface SubmitResult {
  result: Awaited<ReturnType<typeof handleFeedbackSubmit>>;
  kv: Map<string, string>;
  linearCalls: { url: string; body: unknown; headers?: Record<string, string> }[];
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
    linearCalls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
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

function okIssue(i: number): FakeResponse {
  return jsonResponse({ data: { issueCreate: { success: true, issue: { id: `ISS-${i}`, url: `https://linear.app/acme/ISS-${i}` } } } });
}

/** Valid body with a unique title, so each request takes the issueCreate branch. */
async function distinctBody(i: number): Promise<string> {
  const title = `Spam title ${i}`;
  const fingerprint = await computeFeedbackFingerprintWebCrypto({ type: 'bug', title, area: 'failed_tasks' });
  return buildSubmitBody({ report: { type: 'bug', title, area: 'failed_tasks', description: 'x' }, fingerprint, area: 'failed_tasks' });
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

  it('returns 429 after the hourly rate limit, with Retry-After header', async () => {
    const env = makeEnv();
    const ip = '9.9.9.9';
    const { body } = await freshBody();
    for (let i = 0; i < 5; i++) {
      expect((await submit({ env, body, ip, linearResponses: [okIssue(i)] })).result.status).toBe(202);
    }
    const { result } = await submit({ env, body, ip });
    expect(result.status).toBe(429);
    // spec §9.2: 超限 429 + Retry-After (seconds until the hour bucket rolls).
    expect(result.headers?.['Retry-After']).toMatch(/^\d+$/);
    if (!('reason' in (result.json as object))) throw new Error('expected json');
    expect((result.json as { nextAction?: string }).nextAction).toContain('retry');
  });

  it('never persists the raw source IP in the counter table', async () => {
    const env = makeEnv();
    await submit({ env, body: (await freshBody()).body, ip: '203.0.113.7' });
    const keys = (env.PD_PRODUCT_TELEMETRY as SqliteD1Shim).counters().map((r) => r.counter_key);
    expect(keys.some((k) => k.startsWith('ip:'))).toBe(true);
    expect(keys.join('|')).not.toContain('203.0.113.7');
  });

  it('allows at most 5 of 20 concurrent requests from one IP (atomic counter)', async () => {
    const env = makeEnv();
    const bodies = await Promise.all(Array.from({ length: 20 }, (_, i) => distinctBody(i)));
    const runs = await Promise.all(
      bodies.map((body, i) => submit({ env, body, ip: '198.51.100.1', linearResponses: [okIssue(i)] })),
    );
    const statuses = runs.map((r) => r.result.status);
    expect(statuses.filter((s) => s === 202).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 202).length).toBe(5);
    expect(statuses.filter((s) => s === 429).length).toBe(15);
    expect(runs.reduce((n, r) => n + r.linearCalls.length, 0)).toBe(5);
  });

  it('caps new Linear issues per day globally, even across many IPs', async () => {
    const env = makeEnv();
    const total = DAILY_ISSUE_CREATE_CAP + 10;
    const bodies = await Promise.all(Array.from({ length: total }, (_, i) => distinctBody(i)));
    const runs = await Promise.all(
      bodies.map((body, i) => submit({ env, body, ip: `10.0.${Math.floor(i / 200)}.${i % 200}`, linearResponses: [okIssue(i)] })),
    );
    const created = runs.filter((r) => r.result.status === 202).length;
    expect(created).toBe(DAILY_ISSUE_CREATE_CAP);
    expect(runs.reduce((n, r) => n + r.linearCalls.length, 0)).toBe(DAILY_ISSUE_CREATE_CAP);
    const capped = runs.find((r) => r.result.status === 429);
    expect((capped?.result.json as { error?: string }).error).toBe('daily_issue_cap_reached');
    expect(capped?.result.headers?.['Retry-After']).toMatch(/^\d+$/);
  });

  it('fails closed with 503 when the D1 counter is missing or broken, without calling Linear', async () => {
    const body = (await freshBody()).body;
    const broken: RelayD1 = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1_ERROR: no such table');
          },
          run: async () => ({}),
        }),
      }),
    };
    for (const env of [makeEnv({ PD_PRODUCT_TELEMETRY: undefined }), makeEnv({ PD_PRODUCT_TELEMETRY: broken })]) {
      const { result, linearCalls } = await submit({ env, body });
      expect(result.status).toBe(503);
      expect((result.json as { error?: string }).error).toBe('rate_limiter_unavailable');
      expect(linearCalls).toHaveLength(0);
    }
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

    // Linear API rejects "Bearer <key>"; it expects the bare personal API key.
    // Assert the real request header (production path), not a remembered schema (EP-02/EP-09).
    const createHeaders = (linearCalls[0] as { headers?: Record<string, string> }).headers ?? {};
    expect(createHeaders.Authorization).toBe('lin-key');
    expect(createHeaders.Authorization).not.toContain('Bearer');

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
      variables: { issueId: string; body: string };
    };
    expect(call.query).toContain('commentCreate');
    expect(call.variables.issueId).toBe('ISS-1');
    // spec §9.3: duplicate comment carries the new report summary —
    // 时间 / 阻塞度 / 描述前 200 字 — plus the fingerprint footer.
    expect(call.variables.body).toContain('时间: 2023-11-14T22:13:20.000Z');
    expect(call.variables.body).toContain('阻塞度: 未填写');
    expect(call.variables.body).toContain('描述摘要: Tasks stay in queued forever.');
    expect(call.variables.body).toContain('反馈通道指纹');

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