// relay-core.ts
// Core request-handling logic for the feedback relay Pages Function.
//
// Slice 4, spec §9: POST /api/feedback (submit) + GET /api/feedback/health.
// This module is dependency-injected so it runs identically in the Workers
// runtime and under vitest (EP-02: tests exercise the production path, not a
// hand-rolled copy). I/O (KV, fetch, crypto, clock) is injected: the production
// handler wires real bindings, tests supply fakes.
//
// Security posture (spec §9.2):
// - INGEST_TOKEN is a constant-time compared anti-abuse gate, NOT a security
//   boundary. The real content defense is the Console-side redaction pipeline.
// - Rate limiting via KV `rl:<ip>:<hourBucket>` (5/hour/IP), best-effort.
// - Whole-body size cap 256KB → 413.
// - Field whitelist: only known FeedbackReport top-level keys + fingerprint/area.
// - Fingerprint is recomputed here and compared against the submitted value;
//   mismatch → 400 (integrity check, prevents forged area/title decoupling).
// - Errors log only fingerprint/trackingId/reason, never the report body.
//
// ERR mapping:
// - EP-01 / ERR-001: all untrusted fields stay `unknown` until `typeof` guards;
//   no `as` casts and no `in` on user objects (`Object.hasOwn` used).
// - EP-03 / rc-9: every refusal includes a structured reason + nextAction.
// - EP-08: constant-time token compare; size bound applied to the decoded body.
// - EP-05 / rc-7: rate-limit reads fresh KV each call; Linear create/comment
//   reads the fingerprint record once and writes current-iteration data.

export interface RelayEnv {
  FEEDBACK_KV: RelayKV;
  INGEST_TOKEN?: string;
  LIN_API_KEY?: string;
  LIN_TEAM_ID?: string;
}

/** Minimal KV namespace surface used by the relay. */
export interface RelayKV {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface RelayDeps {
  env: RelayEnv;
  /** Raw `Authorization` header value, or undefined when absent. */
  authToken?: string;
  /** Raw IP from `CF-Connecting-IP`. */
  ip: string;
  /** JSON request text to parse (POST only). */
  body?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

export interface RelayResult {
  status: number;
  json: unknown;
  /** Extra response headers (e.g. 429 `Retry-After`, spec §9.2). */
  headers?: Record<string, string>;
}

const MAX_BODY_BYTES = 256 * 1024; // spec §9.2 / Console route parity (256KB).
const RATE_LIMIT = 5; // 5 requests / hour / IP.
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Safe slice: pure decode against a known-length text, mirrors TextEncoder bugs. */
function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Constant-time byte-string comparison via XOR accumulation (WebCrypto has no timingSafeEqual). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = encodeUtf8(a);
  const bb = encodeUtf8(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Allowed top-level body keys. Unknown keys are rejected (400). */
const TOP_LEVEL_KEYS = new Set(['report', 'fingerprint', 'area']);

const FEEDBACK_TYPES = new Set([
  'bug',
  'confusing',
  'privacy_concern',
  'feature_request',
  'other',
]);

function isFeedbackType(v: unknown): v is string {
  return typeof v === 'string' && FEEDBACK_TYPES.has(v);
}

/** Linear priority mapping (spec §9.3): blocked→High / workaround→Medium / minor→Low. */
function blockToLinearPriority(blockingLevel: unknown): number {
  if (blockingLevel === 'blocked') return 1; // High
  if (blockingLevel === 'minor') return 3; // Low
  return 2; // Medium (default + workaround)
}

interface NormalizedFingerprintInput {
  type: string;
  title: string;
  area?: string;
}

/**
 * Validate the submitted `fingerprint` + recompute from the report's
 * type/title/area, compare them. Returns null on any validation failure
 * (caller maps to 400).
 */
export async function recomputeAndCompareFingerprint(args: {
  submitted: unknown;
  report: Record<string, unknown>;
  compute: (input: NormalizedFingerprintInput) => Promise<string>;
}): Promise<{ ok: true; fingerprint: string } | { ok: false; reason: string }> {
  const { submitted, report } = args;
  if (typeof submitted !== 'string' || submitted.length === 0) {
    return { ok: false, reason: 'fingerprint must be a non-empty string' };
  }
  const type = report.type;
  const title = report.title;
  const area = report.area;
  if (!isFeedbackType(type) || typeof title !== 'string') {
    return { ok: false, reason: 'report.type/title are required for fingerprint verify' };
  }
  const recomputed = await args.compute({
    type,
    title,
    area: typeof area === 'string' ? area : undefined,
  });
  if (submitted !== recomputed) {
    return { ok: false, reason: 'fingerprint mismatch: report was tampered with' };
  }
  return { ok: true, fingerprint: recomputed };
}

function readReportString(report: Record<string, unknown>, key: string): string | undefined {
  const v = report[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readBlockingLevel(report: Record<string, unknown>): string | undefined {
  // userText.blockingLevel (typed field) → fallback legacy userSeverity mapping.
  const ut = report.userText;
  if (isRecord(ut)) {
    const bl = ut.blockingLevel;
    if (bl === 'blocked' || bl === 'workaround' || bl === 'minor') return bl;
    const legacy = ut.userSeverity;
    if (legacy === 'high') return 'blocked';
    if (legacy === 'low') return 'minor';
  }
  return undefined;
}

/** Build the Linear issue title per spec §9.3: `[PD反馈][<type>][<area>] <title>`. */
export function buildRelayIssueTitle(args: {
  type: string;
  area?: string;
  title: string;
}): string {
  const area = args.area && args.area.length > 0 ? args.area : 'general';
  return `[PD反馈][${args.type}][${area}] ${args.title}`;
}

/** Append the dedup-aggregation footer (count seen) to the issue body. */
export function appendAggregationFooter(body: string, count: number): string {
  return `${body.trim()}\n\n---\n_收到 ${count} 条同类反馈。_`;
}

/**
 * Duplicate-branch comment per spec §9.3: 新报告摘要(时间/阻塞度/描述前 200 字)
 * + fingerprint footer. Gives the maintainer triage signal without re-reading
 * the full report.
 */
export function buildDuplicateComment(args: {
  count: number;
  atIso: string;
  blockingLevel?: string;
  description: string;
  fingerprint: string;
}): string {
  const normalized = args.description.replace(/\s+/g, ' ').trim();
  const truncated = normalized.slice(0, 200);
  const ellipsis = normalized.length > truncated.length ? '…' : '';
  return [
    `收到一条新的同类反馈(#${args.count})。`,
    '',
    `- 时间: ${args.atIso}`,
    `- 阻塞度: ${args.blockingLevel ?? '未填写'}`,
    `- 描述摘要: ${truncated}${ellipsis}`,
    '',
    `>— 来自反馈通道指纹 ${args.fingerprint.slice(0, 8)}…`,
  ].join('\n');
}

export function parseTrackingId(random: () => number): string {
  const byte = () => Math.floor(random() * 256);
  const bytes = [byte(), byte(), byte(), byte()];
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `fb-${hex}`;
}

export interface LinearRequest {
  query: string;
  variables: Record<string, unknown>;
}

/** Build the Linear issueCreate GraphQL mutation (URL magnitudes bounded). */
export function buildLinearIssueCreate(args: {
  teamId: string;
  title: string;
  description: string;
  priority: number;
}): LinearRequest {
  return {
    query: /* GraphQL */ `
      mutation IssueCreate($teamId: String!, $title: String!, $description: String, $priority: Int) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, priority: $priority }) {
          success
          issue { id url }
        }
      }
    `,
    variables: {
      teamId: args.teamId,
      title: args.title,
      description: args.description,
      priority: args.priority,
    },
  };
}

/** Build the Linear issueCommentCreate mutation for an existing issue. */
export function buildLinearCommentCreate(args: {
  issueId: string;
  body: string;
}): LinearRequest {
  return {
    query: /* GraphQL */ `
      mutation CommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }
    `,
    variables: { issueId: args.issueId, body: args.body },
  };
}

interface LinearCallOutcome {
  ok: boolean;
  issueId?: string;
  issueUrl?: string;
  reason?: string;
}

async function callLinearGraphQL(args: {
  apiKey: string;
  request: LinearRequest;
  fetchFn: typeof fetch;
}): Promise<LinearCallOutcome> {
  let res: Response;
  try {
    // Invoke with `this` bound to globalThis: storing `globalThis.fetch` in a
    // variable and calling it as `fetchFn(...)` detaches its receiver and
    // throws "Illegal invocation" on the Workers/Pages runtime. Using
    // `.call(globalThis, ...)` restores the receiver and works for both the
    // real fetch and injected test fakes (which ignore `this`).
    res = await args.fetchFn.call(globalThis, 'https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Linear rejects "Bearer <key>"; it expects the bare API key.
        Authorization: args.apiKey,
      },
      body: JSON.stringify({ query: args.request.query, variables: args.request.variables }),
    });
  } catch {
    return { ok: false, reason: 'linear-network' };
  }
  if (!res.ok) {
    return { ok: false, reason: `linear-http-${res.status}` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, reason: 'linear-invalid-json' };
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    return { ok: false, reason: 'linear-invalid-response' };
  }
  return { ok: true, ...extractIssueFromGraphQLData(parsed.data) };
}

/** Narrow issueCreate/issue from the GraphQL `data` object. */
function extractIssueFromGraphQLData(data: Record<string, unknown>): {
  issueId?: string;
  issueUrl?: string;
} {
  const create = data.issueCreate;
  if (isRecord(create)) {
    const issue = create.issue;
    if (isRecord(issue)) {
      return {
        issueId: typeof issue.id === 'string' ? issue.id : undefined,
        issueUrl: typeof issue.url === 'string' ? issue.url : undefined,
      };
    }
  }
  const comment = data.commentCreate;
  if (isRecord(comment)) {
    // For comments we don't mint a new issue; keep issueId undefined.
    return {};
  }
  return {};
}

export async function createLinearIssue(args: {
  env: RelayEnv;
  request: LinearRequest;
  fetchFn?: typeof fetch;
}): Promise<LinearCallOutcome> {
  const apiKey = args.env.LIN_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return { ok: false, reason: 'linear-not-configured' };
  }
  return callLinearGraphQL({
    apiKey,
    request: args.request,
    fetchFn: args.fetchFn ?? globalThis.fetch,
  });
}

/**
 * Full submit flow. Returns a RelayResult. Pure aside from injected I/O.
 *
 * Order (spec §9.3): token → rate limit → parse/whitelist → fingerprint verify
 * → KV read fp: → create or comment → KV write → 202.
 */
export async function handleFeedbackSubmit(deps: RelayDeps): Promise<RelayResult> {
  const { env } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  // 1) Token (constant-time compare); uniform 401.
  const auth = /^Bearer (.+)$/i.exec(deps.authToken ?? '');
  const token = deps.env.INGEST_TOKEN;
  if (!auth || typeof token !== 'string' || !constantTimeEqual(auth[1]!, token)) {
    return {
      status: 401,
      json: { error: 'unauthorized', reason: 'invalid or missing token', nextAction: 're-submit from the console' },
    };
  }

  // 2) Rate limit by IP (5/hour).
  const t = now();
  const hourBucket = Math.floor(t / RATE_WINDOW_MS);
  const rlKey = `rl:${deps.ip}:${hourBucket}`;
  const rlRaw = await env.FEEDBACK_KV.get(rlKey);
  let rlCount = 0;
  if (rlRaw !== null) {
    const parsed = Number(rlRaw);
    rlCount = Number.isFinite(parsed) ? parsed : 0;
  }
  if (rlCount >= RATE_LIMIT) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (t % RATE_WINDOW_MS)) / 1000);
    return {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
      json: { error: 'rate_limited', reason: `too many requests (${rlCount}/${RATE_LIMIT})`, nextAction: `retry in ~${retryAfter}s` },
    };
  }
  await env.FEEDBACK_KV.put(rlKey, String(rlCount + 1), {
    expirationTtl: Math.ceil(RATE_WINDOW_MS / 1000) + 60,
  });

  // 3) Body size cap (413) — bound applied to the decoded text length in bytes.
  const bytes = deps.body !== undefined ? encodeUtf8(deps.body).length : 0;
  if (bytes > MAX_BODY_BYTES) {
    return {
      status: 413,
      json: { error: 'payload_too_large', reason: `body exceeds ${MAX_BODY_BYTES} bytes`, nextAction: 'reduce the report size and retry' },
    };
  }

  // 4) Parse + field whitelist (400 for unknown top-level keys / bad shape).
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(deps.body ?? '');
  } catch {
    return { status: 400, json: { error: 'bad_request', reason: 'request body must be JSON', nextAction: 'resend valid JSON' } };
  }
  if (!isRecord(parsedBody)) {
    return {
      status: 400,
      json: { error: 'bad_request', reason: 'request body must be an object', nextAction: 'resend valid JSON' },
    };
  }
  for (const key of Object.keys(parsedBody)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return {
        status: 400,
        json: { error: 'bad_request', reason: `unknown field "${key}" not allowed`, nextAction: 'resend only whitelisted fields' },
      };
    }
  }
  const reportRaw = parsedBody.report;
  const area = typeof parsedBody.area === 'string' ? parsedBody.area : undefined;
  if (!isRecord(reportRaw)) {
    return {
      status: 400,
      json: { error: 'bad_request', reason: 'report must be an object', nextAction: 'resend valid report' },
    };
  }

  // 5) Recompute + compare fingerprint (400 on mismatch).
  const verify = await recomputeAndCompareFingerprint({
    submitted: parsedBody.fingerprint,
    report: reportRaw,
    compute: async (input) =>
      (await import('./fingerprint-webcrypto.js')).computeFeedbackFingerprintWebCrypto(input),
  });
  if (!verify.ok) {
    return { status: 400, json: { error: 'bad_request', reason: verify.reason, nextAction: 're-save the draft and submit again' } };
  }

  const type = reportRaw.type as string;
  const titleRaw = readReportString(reportRaw, 'title') ?? 'Untitled feedback';
  const normArea = area ?? (typeof reportRaw.area === 'string' ? reportRaw.area : undefined);
  const issueTitle = buildRelayIssueTitle({ type, area: normArea, title: titleRaw });
  const bodyRaw = readOutputsMarkdown(reportRaw.outputs) ?? readReportString(reportRaw, 'description');
  const body = bodyRaw ?? '';
  const blockingLevel = readBlockingLevel(reportRaw);
  const priority = blockToLinearPriority(blockingLevel);

  // Fingerprint standalone approves normArea for KV key.
  const fingerprint = (await (
    await import('./fingerprint-webcrypto.js')
  ).computeFeedbackFingerprintWebCrypto({ type, title: titleRaw, area: normArea }));

  const fpKey = `fp:${fingerprint}`;
  const existingRaw = await env.FEEDBACK_KV.get(fpKey);
  const existing = existingRaw !== null ? parseRecord(existingRaw) : undefined;
  const count = (existing && typeof existing.count === 'number' ? existing.count : 0) + 1;
  const nowIso = new Date(t).toISOString();
  const trackingId = parseTrackingId(random);

  // 6) First-branch (issueCreate) vs duplicate-branch (comment).
  if (!existing || typeof existing.issueId !== 'string') {
    if (!env.LIN_TEAM_ID) {
      return {
        status: 502,
        json: { error: 'linear_misconfigured', reason: 'LIN_TEAM_ID is not set', nextAction: 'maintainer must configure the relay' },
      };
    }
    const bodyFull = appendAggregationFooter(body, count);
    const outcome = await createLinearIssue({
      env,
      request: buildLinearIssueCreate({
        teamId: env.LIN_TEAM_ID,
        title: issueTitle,
        description: bodyFull,
        priority,
      }),
      fetchFn,
    });
    if (!outcome.ok || !outcome.issueId) {
      return {
        status: 502,
        json: { error: 'linear_create_failed', reason: outcome.reason ?? 'linear create failed', nextAction: 'maintainer must check Linear config' },
      };
    }
    const issueUrl = outcome.issueUrl ?? '';
    // KV write fp record + id mapping (current-iteration data).
    await env.FEEDBACK_KV.put(
      fpKey,
      JSON.stringify({
        count,
        firstSeen: nowIso,
        lastSeen: nowIso,
        issueId: outcome.issueId,
        issueUrl,
      }),
    );
    await env.FEEDBACK_KV.put(
      `id:${trackingId}`,
      JSON.stringify({ fingerprint, issueUrl, createdAt: nowIso }),
    );
    return {
      status: 202,
      json: { trackingId, issueUrl, duplicate: false, count },
    };
  }

  // Duplicate branch: comment on existing issue + count increment.
  const commentBody = buildDuplicateComment({
    count,
    atIso: nowIso,
    blockingLevel,
    description: body,
    fingerprint,
  });
  const commentReply = await createLinearIssue({
    env,
    request: buildLinearCommentCreate({
      issueId: existing.issueId,
      body: commentBody,
    }),
    fetchFn,
  });
  if (!commentReply.ok) {
    return {
      status: 502,
      json: { error: 'linear_comment_failed', reason: commentReply.reason ?? 'linear comment failed', nextAction: 'maintainer must check Linear config' },
    };
  }
  await env.FEEDBACK_KV.put(
    fpKey,
    JSON.stringify({
      count,
      firstSeen: existing.firstSeen,
      lastSeen: nowIso,
      issueId: existing.issueId,
      issueUrl: existing.issueUrl,
    }),
  );
  return {
    status: 202,
    json: {
      trackingId,
      issueUrl: existing.issueUrl ?? '',
      duplicate: true,
      count,
    },
  };
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const p: unknown = JSON.parse(raw);
    return isRecord(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function readOutputsMarkdown(outputs: unknown): string | undefined {
  if (!isRecord(outputs)) return undefined;
  const md = outputs.markdown;
  return typeof md === 'string' && md.length > 0 ? md : undefined;
}