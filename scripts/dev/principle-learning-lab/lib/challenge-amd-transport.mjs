// SPEC-PD-EXAMINER-001 v0.4 §2.7 — Stage G AMD Radeon TokenFactory transport
// (REAL network implementation, owner engineering round 2026-10-25).
//
// Provider: amd-radeon-tokenfactory · Model: GLM-5.3-Flash (OpenAI-compatible
// /chat/completions) · deployment marked EXPERIMENTAL by AMD — recorded, not
// a design-review trigger.
//
// Safety posture (mirrors the adapter contract; nothing here may be bypassed):
//   - Credentials ONLY from AMD_RADEON_API_KEY env or ~/.amd_radeon_api_key
//     file (mode 600). Never in source/logs/SPEC. No fallback provider.
//   - https-only base URL; localhost/loopback/private/reserved hosts refused
//     before any request.
//   - This transport is called ONLY by runExaminerRequest AFTER the Stage G
//     authorization gate, budget reservation, REQUEST_PREPARED persistence
//     and per-request candidate cap checks. It sends the constrained
//     actor-visible input ONLY — never gold, judge-only fields, production
//     data or credentials.
//   - Network-level failures after send are AMBIGUOUS: they surface as
//     AmbiguousOutcomeError → RESULT_UNKNOWN (never auto-retried, never
//     mislabelled as clean failure). 429/HTTP errors with a received response
//     are FAILED_KNOWN with server hints recorded.
//   - Metering: the AMD free tier bills PLATFORM POINTS, not USD. usage is
//     reported with metering='platform_points' and costUsd=null-by-design;
//     points and dollars are NEVER mixed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

export const AMD_PROVIDER_ID = 'amd-radeon-tokenfactory';
export const AMD_BASE_URL = 'https://developer.amd.com.cn/radeon/api/v1';
export const AMD_MODEL_ID = 'GLM-5.3-Flash';
export const AMD_DEPLOYMENT_STATUS = 'experimental';
export const AMD_REQUESTED_MODEL_IDENTITY = `${AMD_PROVIDER_ID}/${AMD_MODEL_ID}`;

// 2026-10-25 参数专项修正（Owner 指令）：思考过程与最终输出共享生成预算，
// 4000 上限被 reasoning 挤占导致 content=null。默认生成上限提到 32768。
// 供应商不可分别设置/报告 reasoning 与最终输出预算 → 明确标记「不可分解」。
// 分解口径：输入 ≤8000（spec.inputTokenCap，计量口径）｜生成总预算
// (reasoning+completion) ≤32768（max_tokens，部署实测上限）｜最终输出=不可单独限制。
export const AMD_GENERATION_BUDGET = {
  maxTokensDefault: 32768,
  inputTokenCap: 8000,
  decomposition: 'non_decomposable_by_provider: reasoning 与 completion 共享 max_tokens，供应商不分别报告上限；usage 中 reasoning_tokens/completion_tokens 可事后分解计量',
};
export const AMD_TRANSPORT_TIMEOUTS = {
  requestTimeoutMs: 240_000,
  connectTimeoutMs: 15_000,
  note: 'node:https 强制 HTTP/1.1（2026-10-25 根因修复：undici 全局 fetch 对该网关协商 HTTP/2，5KB body 挂死 300s headers-timeout/偶发 403——round1 全轮因此作废）。connectTimeoutMs 以 socket 早段近似（中止标记 connect_or_early，仍按 ambiguous→RESULT_UNKNOWN 处理）；requestTimeoutMs 覆盖整体。免费层慢响应实测样本 104.6~106.9s，240s 提供余量。',
};
/** Catalog-declared parameters (2026-10-25): temperature, max_tokens, top_p,
 *  stream, response_format, tools, tool_choice — reasoning_effort is NOT
 *  declared; it is sent per zhipu convention and tolerated by the server,
 *  with its effect treated as UNVERIFIED (recorded, not assumed). */
export const AMD_CATALOG_SUPPORTED_PARAMETERS = ['temperature', 'max_tokens', 'top_p', 'stream', 'response_format', 'tools', 'tool_choice'];

const KEY_FILE = path.join(os.homedir(), '.amd_radeon_api_key');

/** Credential from existing secure sources only. Throws before any network action. */
export function resolveAmdApiKey({ env = process.env, keyFile = KEY_FILE } = {}) {
  const fromEnv = env.AMD_RADEON_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { source: 'env:AMD_RADEON_API_KEY', key: fromEnv };
  try {
    const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
    if (fromFile.length > 0) return { source: `file:${keyFile}`, key: fromFile };
  } catch { /* file absent — fall through to refusal */ }
  const err = new Error('AMD credential source unavailable: set AMD_RADEON_API_KEY or create ~/.amd_radeon_api_key (mode 600). Refusing BEFORE any network action — no fallback provider.');
  err.beforeSend = true;
  throw err;
}

/** IPv4 (canonical dotted-quad only) private/reserved range check. */
function ipv4IsPrivateOrReserved(v4) {
  const o = v4.split('.').map(Number);
  if (o.some((n) => !Number.isInteger(n) || n > 255)) return true; // malformed → refuse
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true; // this-network / private / loopback
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT 100.64/10
  if (o[0] === 169 && o[1] === 254) return true; // link-local
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // private
  if (o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return true; // IETF assignments / TEST-NET-1
  if (o[0] === 192 && o[1] === 168) return true; // private
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19 || (o[1] === 51 && o[2] === 100))) return true; // benchmarking / TEST-NET-2
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return true; // TEST-NET-3
  if (o[0] >= 224) return true; // multicast + reserved
  return false;
}

/** True when the host must never be dispatched to: loopback/private/reserved,
 *  in any spelling — names, canonical IPv4, evasive integer/hex IPv4, and
 *  IPv6 (loopback / unspecified / unique-local / link-local / v4-mapped). */
function isNonPublicHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const mapped = h.match(/^::ffff:(.+)$/);
  const v4 = mapped ? mapped[1] : (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h : null);
  if (v4) return ipv4IsPrivateOrReserved(v4);
  if (h.includes(':')) { // remaining IPv6 literals
    if (h === '::' || h === '::1') return true;
    if (/^f[cd][0-9a-f]{0,3}:/.test(h)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]?:/.test(h)) return true; // fe80::/10 link local
    return false;
  }
  // Evasive non-canonical IPv4 spellings (integer 2130706433, hex 0x7f000001,
  // shortened 127.1, octal-ish 0177.0.0.1) are never accepted as public hosts.
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  if (/^[0-9.]+$/.test(h)) return true; // digits+dots that failed the canonical quad above → non-canonical → refuse
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal');
}

/** https-only; explicit port refused (the poster connects to 443 only);
 *  localhost/loopback/private/reserved hosts refused in any spelling.
 *  Thrown errors carry beforeSend=true: refused BEFORE any dispatch —
 *  callers settle these as clean refusals, never as RESULT_UNKNOWN. */
export function assertPublicHttpsUrl(url) {
  const refused = (message) => { const e = new Error(`AMD transport: ${message}`); e.beforeSend = true; return e; };
  let u;
  try { u = new URL(url); } catch { throw refused(`invalid base URL (not a URL): ${url}`); }
  if (u.protocol !== 'https:') throw refused(`base URL must be https, got ${u.protocol}//`);
  if (u.port !== '') throw refused(`base URL must use the default https port (443), got explicit port ${u.port}`);
  if (isNonPublicHost(u.hostname)) throw refused(`refusing non-public host '${u.hostname}'`);
  return u;
}

/** Thrown when a request MAY have reached the server but no response landed:
 *  the runner must settle RESULT_UNKNOWN (no auto-retry, budget kept). */
export class AmbiguousOutcomeError extends Error {
  constructor(detail) {
    super(`ambiguous outcome (request possibly sent, no response): ${detail}`);
    this.name = 'AmbiguousOutcomeError';
    this.ambiguous = true;
  }
}

const SYSTEM_PROMPT = [
  '你是受约束的考题生成器（Examiner）。你只能：改写允许表达字段（taskText、facts[].statement、observations[].label/output 措辞——不得翻转语义方向）并在合法参数值域内选择组合。',
  '你绝对不能：改变真值、蕴含关系、Gold 判定结构、观察对象身份或成本；编造新事实；输出代码或工具调用。',
  '输出严格 JSON：{"candidates":[{"candidateId":string,"draft":{...},"caseDef":{...},"sourceBinding":{...}}]}，最多 N 个候选（见输入约束）。',
].join('\n');

export function buildAmdRequestBody({ constrainedInput, perRequestCandidateCap, modelId = AMD_MODEL_ID, maxTokens = AMD_GENERATION_BUDGET.maxTokensDefault, reasoningEffort = 'medium' }) {
  const req = {
    model: modelId,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\n本请求候选数上限：${perRequestCandidateCap}。` },
      { role: 'user', content: JSON.stringify(constrainedInput) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
    stream: false,
  };
  if (reasoningEffort !== null && reasoningEffort !== undefined) req.reasoning_effort = reasoningEffort; // null = provider rejects the parameter (intern-s2 → 422)
  return req;
}

/**
 * Default POST via node:https — HTTP/1.1 ONLY (the round-1 root-cause fix:
 * undici/global fetch negotiates HTTP/2 with this gateway and hangs/403s).
 * Two-phase timeouts: connect/early (socket idle before response) and total.
 * Returns { status, headers:{get}, text }.
 */
/** Response-stage telemetry (PRI-1037-adjacent observability, timing PR):
 *  distinguishes "no response headers yet" from "headers but no body bytes"
 *  from "body streaming/completed" — the 240s total timeouts observed in the
 *  F1 round-1 run were indistinguishable under the old two-phase poster.
 *  Durations use the MONOTONIC clock (performance.now deltas — immune to
 *  wall-clock changes); requestStartedAt is UTC wall time ONLY for
 *  cross-run correlation. Stages never observed stay null — never zeroed. */
export function createDefaultHttpsPoster({ connectTimeoutMs = AMD_TRANSPORT_TIMEOUTS.connectTimeoutMs, requestTimeoutMs = AMD_TRANSPORT_TIMEOUTS.requestTimeoutMs } = {}) {  return function httpsPoster(url, { headers, body }) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = assertPublicHttpsUrl(url); // sink guard: the dispatching function revalidates whatever it is handed
      } catch (e) {
        reject(e); // beforeSend-tagged by the guard — refused before any dispatch
        return;
      }
      const startedMono = performance.now();
      let gotResponse = false; // connect-watchdog disarm flag (headers arrived)
      const timing = {
        requestStartedAt: new Date().toISOString(), // wall clock — correlation only
        responseHeadersReceivedMs: null,
        firstBodyByteReceivedMs: null,
        responseBodyCompletedMs: null,
        responseStageAtFailure: 'awaiting_headers', // pre-dispatch failures are classified at reject time below
      };
      const fail = (message, ambiguous) => {
        const err = new Error(message);
        if (ambiguous) err.ambiguous = true; // dispatched but unresolved — caller must settle RESULT_UNKNOWN
        err.timing = { ...timing, responseStageAtFailure: timing.responseStageAtFailure };
        reject(err);
        return err;
      };
      const req = https.request(
        { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', headers },
        (res) => {
          gotResponse = true;
          timing.responseHeadersReceivedMs = Math.round(performance.now() - startedMono);
          timing.responseStageAtFailure = 'awaiting_body';
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (d) => {
            if (timing.firstBodyByteReceivedMs === null) {
              timing.firstBodyByteReceivedMs = Math.round(performance.now() - startedMono);
              timing.responseStageAtFailure = 'body_read';
            }
            data += d;
          });
          res.on('end', () => {
            timing.responseBodyCompletedMs = Math.round(performance.now() - startedMono);
            timing.responseStageAtFailure = 'completed';
            resolve({
              status: res.statusCode,
              headers: { get: (n) => res.headers[String(n).toLowerCase()] ?? null },
              text: async () => data,
              timing: { ...timing },
            });
          });
        },
      );
      req.setTimeout(requestTimeoutMs, () => req.destroy(fail(`request timeout after ${requestTimeoutMs}ms (total)`, true)));
      req.on('socket', (s) => {
        s.setTimeout(connectTimeoutMs, () => {
          if (!gotResponse) req.destroy(fail(`connect/early timeout after ${connectTimeoutMs}ms`, true));
          s.setTimeout(0);
        });
      });
      req.on('error', (e) => {
        // socket-level error mid-flight: keep whatever stages were observed
        const err = new Error(e?.message ?? String(e));
        err.ambiguous = true; // dispatched — outcome unknowable
        err.timing = { ...timing };
        reject(err);
      });
      req.write(body);
      req.end();
    });
  };
}

/**
 * The real AMD transport. Network layer = node:https poster (HTTP/1.1).
 * Injectable posterImpl for offline tests; the production default is
 * createDefaultHttpsPoster(). No auto-retry, no fallback, no credential logging.
 */
export function createAmdRadeonTransport({ posterImpl = null, baseUrl = AMD_BASE_URL, modelId = AMD_MODEL_ID, apiKeyProvider = resolveAmdApiKey, reasoningEffort = 'medium', treatReasoningContentAsOutput = false } = {}) {
  const poster = posterImpl || createDefaultHttpsPoster();
  return {
    kind: 'amd-radeon-tokenfactory',
    deploymentStatus: AMD_DEPLOYMENT_STATUS,
    async respond(request) {
      assertPublicHttpsUrl(baseUrl); // transport-level gate (the poster revalidates at the sink)
      const cred = apiKeyProvider();
    const body = buildAmdRequestBody({
      constrainedInput: request.constrainedInput,
      perRequestCandidateCap: (request.spec && request.spec.perRequestCandidateCap) || 6,
      modelId,
      maxTokens: Math.min((request.spec && request.spec.outputTokenCap) || AMD_GENERATION_BUDGET.maxTokensDefault, AMD_GENERATION_BUDGET.maxTokensDefault),
      reasoningEffort,
    });
      let res;
      try {
        // NOTE: string concat, NOT new URL(path, base) — an absolute path would
        // silently drop the base's version prefix (/v1 → 404; round3 root cause).
        res = await poster(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json', 'User-Agent': 'pd-stage-g-research/1.0', 'Content-Length': Buffer.byteLength(JSON.stringify(body), 'utf8') },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (e && e.beforeSend === true) throw e; // refused BEFORE any dispatch — clean refusal, never ambiguous
        throw new AmbiguousOutcomeError(`poster failed after dispatch: ${e.message}`); // possibly sent → RESULT_UNKNOWN
      }
      const retryAfter = res.headers ? res.headers.get('retry-after') : null;
      if (res.status === 429) {
        return { ok: false, error: `rate_limited (HTTP 429); server Retry-After: ${retryAfter || 'unspecified'} — recorded, NOT auto-retried (explicit new request would consume the 16-request cap)`, retryAfter };
      }
      if (res.status !== 200) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}: ${String(text).slice(0, 300)}` };
      }
      let json;
      const rawText = await res.text();
      try {
        json = JSON.parse(rawText);
      } catch (e) {
        throw new AmbiguousOutcomeError(`response received but unparseable as JSON: ${e.message}`); // billed? unknown → RESULT_UNKNOWN
      }
      const observedModel = (json.metadata && (json.metadata.used_model || json.metadata.requested_model)) || json.model || null;
      // The server's `model` field carries a provider prefix (e.g. 'self-dploy/GLM-5.3-Flash');
      // identity is adjudicated on the authoritative metadata fields / suffix match.
      const identityOk = observedModel === modelId || (typeof observedModel === 'string' && observedModel.endsWith(`/${modelId}`)) || (typeof json.model === 'string' && json.model.endsWith(`/${modelId}`));
      if (observedModel && !identityOk) {
        return { ok: false, error: `model_identity_mismatch: requested '${modelId}', server reports '${observedModel}' (raw model field '${json.model}') — refusing candidates, stop condition for subsequent generation`, observedModelIdentity: observedModel };
      }
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      const finishReason = (json.choices && json.choices[0] && json.choices[0].finish_reason) || null;
      const reasoningTokensUsage = (json.usage && json.usage.completion_tokens_details && json.usage.completion_tokens_details.reasoning_tokens) ?? null;
      // intern-s2 layout quirk: with finish=stop and a non-empty reasoning_content, the
      // FINAL ANSWER is delivered in message.reasoning_content (content stays null).
      // Only trusted under finish=stop — a length-truncated reasoning stream is never
      // promoted to output.
      let effectiveContent = content;
      if ((effectiveContent === null || effectiveContent === undefined) && treatReasoningContentAsOutput && finishReason === 'stop') {
        const rc = json.choices[0].message.reasoning_content;
        if (typeof rc === 'string' && rc.length > 0) effectiveContent = rc;
      }
      if (finishReason === 'length') {
        // Output budget exhausted: the generated stream was truncated mid-way. Incomplete
        // candidates are NEVER accepted (no silent truncation, no auto-completion).
        return { ok: false, error: `output_budget_exhausted (finish_reason=length, max_tokens=${body.max_tokens}): generated stream truncated — zero candidates adopted; reasoning_tokens=${reasoningTokensUsage}`, observedModelIdentity: observedModel, finishReason, usage: json.usage || null };
      }
      if (typeof effectiveContent !== 'string' || effectiveContent.length === 0) {
        const cause = reasoningTokensUsage !== null && reasoningTokensUsage > 0
          ? `reasoning_budget_exhausted: reasoning consumed ${reasoningTokensUsage} of the shared ${body.max_tokens} generation budget before any final output`
          : `empty or missing message content (finish_reason=${finishReason})`;
        return { ok: false, error: `${cause} — zero candidates adopted; original diagnostics retained`, observedModelIdentity: observedModel, finishReason, reasoningTokens: reasoningTokensUsage, usage: json.usage || null };
      }
      let parsed;
      try {
        parsed = JSON.parse(effectiveContent);
      } catch (e) {
        return { ok: false, error: `structured_output_parse_failed: ${e.message}; content head: ${effectiveContent.slice(0, 120)}`, observedModelIdentity: observedModel };
      }
      const usage = json.usage || {};
      // Owner confirmation 2026-10-25: the AMD model is FREE for tokenfactory users —
      // catalog USD prices are nominal only. Budget accounting therefore books ZERO
      // model cost; server-metered nominal cost is retained as an audit annotation
      // and never mixed into the budget ledger. Stability (not cost) is the risk.
      const serverNominal = typeof usage.cost === 'number' ? usage.cost : null;
      return {
        ok: true,
        candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
        observedModelIdentity: observedModel,
        outputField: effectiveContent !== content ? 'reasoning_content (intern-s2 layout)' : 'content',
        usage: {
          inputTokens: usage.prompt_tokens ?? null,
          outputTokens: usage.completion_tokens ?? null,
          provider: AMD_PROVIDER_ID,
          metering: 'free_tier_zero_cost',
          costUsd: 0,
          nominalServerCost: serverNominal,
          costNote: 'FREE tier (Owner-confirmed 2026-10-25): model cost books $0; nominalServerCost is an audit annotation only, never budgeted. Free-tier instability (slow responses / 000 / 429) is covered by RESULT_UNKNOWN + no-auto-retry semantics and consumes request quota.',
        },
        reasoningTokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) ?? null,
        rawResponseMeta: { id: json.id || null, created: json.created || null, deploymentStatus: AMD_DEPLOYMENT_STATUS, systemFingerprint: json.system_fingerprint || null },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 书生·端砚 intern-s2 (Shanghai AI Lab discovery API) — preregistered one-time
// fallback provider (Owner-confirmed 2026-10-25 after AMD gateway blocker).
// Free tier · OpenAI Chat protocol · response_format json_object SUPPORTED ·
// reasoning_effort REJECTED (422) → never sent · final answer may arrive in
// message.reasoning_content (promoted to output only under finish=stop).
// ---------------------------------------------------------------------------

export const INTERN_S2_PROVIDER_ID = 'intern-ai-discovery';
export const INTERN_S2_BASE_URL = 'https://discovery-api.intern-ai.org.cn/v1';
export const INTERN_S2_MODEL_ID = 'intern-s2';
export const INTERN_S2_DEPLOYMENT_STATUS = 'free-tier';
export const INTERN_S2_REQUESTED_MODEL_IDENTITY = `${INTERN_S2_PROVIDER_ID}/${INTERN_S2_MODEL_ID}`;
export const INTERN_S2_CATALOG = { contextLength: '256K', protocols: ['OpenAI Chat', 'Anthropic Messages'], price: 'free', reasoningEffortSupport: 'REJECTED (422) — parameter never sent', outputField: 'reasoning_content under finish=stop (content stays null)' };

const INTERN_S2_KEY_FILE = path.join(os.homedir(), '.intern_s2_api_key');

export function resolveInternS2ApiKey({ env = process.env, keyFile = INTERN_S2_KEY_FILE } = {}) {
  const fromEnv = env.INTERN_S2_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { source: 'env:INTERN_S2_API_KEY', key: fromEnv };
  try {
    const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
    if (fromFile.length > 0) return { source: `file:${keyFile}`, key: fromFile };
  } catch { /* absent → refusal below */ }
  const err = new Error('intern-s2 credential source unavailable: set INTERN_S2_API_KEY or create ~/.intern_s2_api_key (mode 600). Refusing BEFORE any network action — no fallback provider.');
  err.beforeSend = true;
  throw err;
}

export function createInternS2Transport({ posterImpl = null, baseUrl = INTERN_S2_BASE_URL, modelId = INTERN_S2_MODEL_ID, apiKeyProvider = resolveInternS2ApiKey } = {}) {
  return createAmdRadeonTransport({
    posterImpl,
    baseUrl,
    modelId,
    apiKeyProvider,
    reasoningEffort: null, // intern-s2 rejects reasoning_effort with 422 — never sent
    treatReasoningContentAsOutput: true, // intern-s2 delivers the final answer in reasoning_content under finish=stop
  });
}

// ————————————————————————————————————————————————————————————————————————————
// Zhipu bigmodel Coding Plan (OpenAI Chat Completion protocol) — PAID plan,
// Owner-provided credential. Stage R F1 failover channel #4.
//   Docs: docs.bigmodel.cn/cn/coding-plan/quick-start (base) +
//         docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash (model)
// Identity discipline unchanged: the model id is the API's own GET /v4/models
// entry (re-verified at failover time), and the P1-6 responder adjudication
// accepts only server-attested fields.
// ————————————————————————————————————————————————————————————————————————————

export const BIGMODEL_CODING_PROVIDER_ID = 'bigmodel-coding';
export const BIGMODEL_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
export const BIGMODEL_CODING_MODEL_ID = 'glm-5.3-flash';
export const BIGMODEL_CODING_DEPLOYMENT_STATUS = 'paid-plan';
export const BIGMODEL_CODING_CATALOG = { protocols: ['OpenAI Chat (paas/v4)', 'Anthropic Messages', 'OpenAI Responses'], reasoningEffortSupport: 'UNVERIFIED — parameter never sent (same discipline as intern-ai)' };

const BIGMODEL_CODING_KEY_FILE = path.join(os.homedir(), '.bigmodel_coding_api_key');

export function resolveBigmodelCodingApiKey({ env = process.env, keyFile = BIGMODEL_CODING_KEY_FILE } = {}) {
  const fromEnv = env.BIGMODEL_CODING_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { source: 'env:BIGMODEL_CODING_API_KEY', key: fromEnv };
  try {
    const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
    if (fromFile.length > 0) return { source: `file:${keyFile}`, key: fromFile };
  } catch { /* absent → refusal below */ }
  const err = new Error('bigmodel coding credential source unavailable: set BIGMODEL_CODING_API_KEY or create ~/.bigmodel_coding_api_key (mode 600). Refusing BEFORE any network action — no fallback provider.');
  err.beforeSend = true;
  throw err;
}
