// telemetry-core.ts
// Core request-handling logic for the Anonymous Product Telemetry collector
// Pages Function (PRI-600, PRI-595~603; review remediation: abuse limiter,
// tri-state facts, shared retention policy).
//
// POST /api/product-telemetry/snapshot — receives one daily milestone
// snapshot per participating workspace per day (measurement unit = the
// workspace; consent stays machine-scope on the client).
//
// Dependency-injected so it runs identically in the Workers runtime and under
// vitest (same pattern as relay-core.ts): D1, KV, HMAC secrets, source
// network address, and clock are injected; tests supply a real
// better-sqlite3-backed D1 shim so upsert and retention SQL semantics are
// exercised for real.
//
// Privacy posture ("Collect signals, not users"):
// - No auth token (anonymous clients); abuse control = strict schema +
//   size cap + two-layer rate limiting + D1-only storage.
// - The ONLY persisted identity is serverDailyId =
//   HMAC-SHA256(serverSecret, clientDailyTelemetryId) — even the client's
//   daily unlinkable ID never lands in D1 raw. Cross-day and cross-workspace
//   correlation is impossible by construction (client IDs differ per day and
//   per workspace under a secret the server never sees).
// - The source network address (CF-Connecting-IP) is used ONLY to derive a
//   keyed, short-lived abuse-prevention token via a domain-separated HMAC
//   secret. Raw IPs are never written to D1, never logged, never echoed in
//   responses, and the token expires automatically (KV TTL ~1h).
// - No User-Agent, no other headers, no raw request body are read or
//   persisted.
// - No error messages/stacks are ever accepted (tri-state reliability only).
//
// Measurement honesty ("Unknown ≠ false"):
// - Milestone/reliability facts are tri-state. `null` = the client's source
//   was unavailable; it is stored as SQL NULL, excluded from dashboard
//   denominators, and never summed as 0.
//
// Security posture (SPEC §51):
// - Strict schema: exact top-level allowlist (8 keys), exact nested
//   allowlists; unknown keys → 400.
// - Body cap 4 KB → 413.
// - Layer 1 rate limit: 60/hour/dailyTelemetryId via KV (best-effort, same
//   recipe as relay-core's rl: keys).
// - Layer 2 abuse limit: keyed-IP token, 120/hour via KV with ~1h TTL —
//   an attacker rotating client-provided dailyTelemetryId values cannot
//   rotate this key. Best-effort like layer 1; zone-level Cloudflare WAF
//   rate limiting is the optional strict tier (deployment recommendation).
// - All SQL is static prepared statements; values bound as parameters.
// - Responses bounded (204 empty on success; tiny JSON on errors).
// - Retention: 90-day policy. Every successful write sweeps expired rows
//   (opportunistic), and a scheduled protected cleanup endpoint enforces the
//   same policy independently of writes (see telemetry-cleanup-core.ts).

/** Minimal D1 surface used by the collector (structurally satisfied by the real binding). */
export interface TelemetryD1 {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

/** Minimal KV namespace surface (rate limiting). */
export interface TelemetryKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface TelemetryEnv {
  PD_PRODUCT_TELEMETRY: TelemetryD1;
  /** KV namespace reused from the feedback relay for rate limiting. */
  FEEDBACK_KV: TelemetryKV;
  /** Server-side HMAC secret (wrangler pages secret put TELEMETRY_HMAC_SECRET). */
  TELEMETRY_HMAC_SECRET?: string;
  /** Domain-separated abuse-limiter secret (independent of TELEMETRY_HMAC_SECRET). */
  TELEMETRY_ABUSE_HMAC_SECRET?: string;
}

export interface TelemetryDeps {
  env: TelemetryEnv;
  /** Raw request body text. */
  body: string;
  /**
   * Source network address from transport metadata (CF-Connecting-IP), used
   * ONLY inside the keyed abuse token. Absent → the abuse layer is skipped
   * (layer 1 still applies); the value is never logged, stored, or echoed.
   */
  sourceIp?: string;
  now?: () => number;
}

export interface TelemetryResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const MAX_BODY_BYTES = 4 * 1024; // SPEC §51: bounded payload (snapshots are ~400 bytes).
const RATE_LIMIT = 60; // generous for same-day retries; blocks abuse.
const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Layer-2 per-source-network budget: covers NAT'd teams, blocks floods. */
const ABUSE_LIMIT = 120;
const ABUSE_WINDOW_MS = 60 * 60 * 1000;
/** Retention policy (single source of truth for write sweep AND cleanup job). */
export const RETENTION_DAYS = 90;

/** Must equal core's PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS (drift-locked by tests). */
const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'dailyTelemetryId',
  'bucketDate',
  'pdVersion',
  'hostKind',
  'milestones',
  'reliability',
  'consentVersion',
] as const;

const MILESTONE_KEYS = [
  'initialized',
  'painObserved',
  'principleObserved',
  'activationObserved',
  'presenceReceiptObserved',
  'effectReceiptObserved',
] as const;

const HOST_KINDS = new Set(['openclaw', 'codex', 'other']);

/** `true` / `false` / `null` (null = source unavailable; never "observed false"). */
type Fact = boolean | null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFact(v: unknown): v is Fact {
  return v === null || typeof v === 'boolean';
}

function isValidBucketDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}

interface ValidatedSnapshot {
  schemaVersion: string;
  dailyTelemetryId: string;
  bucketDate: string;
  pdVersion: string;
  hostKind: string;
  initialized: Fact;
  painObserved: Fact;
  principleObserved: Fact;
  activationObserved: Fact;
  presenceReceiptObserved: Fact;
  effectReceiptObserved: Fact;
  initializationFailed: Fact;
  consentVersion: string;
}

/**
 * Strict validation — mirrors @principles/core's
 * validateProductTelemetrySnapshot (the Pages bundle cannot import the core
 * package; tests lock the two validators against drift via shared vectors).
 * Unknown fields are final rejections: nothing else is interpreted.
 */
function validateSnapshot(raw: unknown): { ok: true; value: ValidatedSnapshot } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['snapshot must be a JSON object'] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) errors.push(`unknown top-level field '${key}'`);
  }
  if (errors.length > 0) return { ok: false, errors };

  if (raw.schemaVersion !== '1') errors.push("schemaVersion must be '1'");
  if (typeof raw.consentVersion !== 'string' || raw.consentVersion.length === 0 || raw.consentVersion.length > 8) {
    errors.push('consentVersion must be a short non-empty string');
  }
  if (typeof raw.dailyTelemetryId !== 'string' || !/^[0-9a-f]{32}$/.test(raw.dailyTelemetryId)) {
    errors.push('dailyTelemetryId must be 32 lowercase hex chars');
  }
  if (!isValidBucketDate(raw.bucketDate)) errors.push('bucketDate must be a valid YYYY-MM-DD UTC date');
  if (typeof raw.pdVersion !== 'string' || raw.pdVersion.length === 0 || raw.pdVersion.length > 32) {
    errors.push('pdVersion must be a non-empty string of at most 32 chars');
  }
  if (typeof raw.hostKind !== 'string' || !HOST_KINDS.has(raw.hostKind)) {
    errors.push("hostKind must be one of: openclaw, codex, other");
  }

  const milestones = raw.milestones;
  if (!isRecord(milestones)) {
    errors.push('milestones must be an object');
  } else {
    for (const key of Object.keys(milestones)) {
      if (!(MILESTONE_KEYS as readonly string[]).includes(key)) errors.push(`unknown milestones field '${key}'`);
    }
    for (const key of MILESTONE_KEYS) {
      if (!Object.hasOwn(milestones, key) || !isFact(milestones[key])) {
        errors.push(`milestones.${key} must be a boolean or null`);
      }
    }
  }

  const reliability = raw.reliability;
  if (!isRecord(reliability)) {
    errors.push('reliability must be an object');
  } else {
    for (const key of Object.keys(reliability)) {
      if (key !== 'initializationFailed') errors.push(`unknown reliability field '${key}'`);
    }
    if (!Object.hasOwn(reliability, 'initializationFailed') || !isFact(reliability.initializationFailed)) {
      errors.push('reliability.initializationFailed must be a boolean or null');
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const m = raw.milestones as Record<string, Fact>;
  // Guard-narrowed copy preserving null facts — never collapse null to false.
  const fact = (v: unknown): Fact => (v === null ? null : v === true);
  return {
    ok: true,
    value: {
      schemaVersion: raw.schemaVersion as string,
      dailyTelemetryId: raw.dailyTelemetryId as string,
      bucketDate: raw.bucketDate as string,
      pdVersion: raw.pdVersion as string,
      hostKind: raw.hostKind as string,
      initialized: fact(m.initialized),
      painObserved: fact(m.painObserved),
      principleObserved: fact(m.principleObserved),
      activationObserved: fact(m.activationObserved),
      presenceReceiptObserved: fact(m.presenceReceiptObserved),
      effectReceiptObserved: fact(m.effectReceiptObserved),
      initializationFailed: fact((raw.reliability as Record<string, Fact>).initializationFailed),
      consentVersion: raw.consentVersion as string,
    },
  };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTC YYYY-MM-DD bucket for a timestamp (matches client bucketDateFromTime). */
export function bucketDateOf(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

/**
 * Retention cutoff (UTC date) — the SINGLE policy computation shared by the
 * write-time sweep and the scheduled cleanup endpoint, so the two paths can
 * never disagree on the window.
 */
export function retentionCutoffDate(nowMs: number): string {
  return bucketDateOf(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Layer-2 transport abuse limiter. Derives a keyed, short-lived token from
 * the source network address:
 *
 *   abuseToken = HMAC(TELEMETRY_ABUSE_HMAC_SECRET,
 *                     "telemetry-abuse:" + sourceIp + ":" + hourBucket)
 *
 * The token — never the raw address — is the KV key, so KV cannot be made to
 * leak IPs. An attacker cannot rotate it by rotating client-provided IDs.
 * Returns true when the request is allowed (and counts it).
 */
async function checkAbuseLimit(kv: TelemetryKV, secret: string, sourceIp: string, nowMs: number): Promise<boolean> {
  const hourBucket = Math.floor(nowMs / ABUSE_WINDOW_MS);
  const token = await hmacHex(secret, `telemetry-abuse:${sourceIp}:${hourBucket}`);
  const key = `tl-ab:${token}`;
  let hits = 0;
  try {
    const current = await kv.get(key);
    hits = current !== null && /^\d+$/.test(current) ? Number(current) : 0;
  } catch {
    hits = 0; // KV unavailable → fail open (layer 1 still applies)
  }
  if (hits >= ABUSE_LIMIT) return false;
  try {
    await kv.put(key, String(hits + 1), { expirationTtl: Math.ceil(ABUSE_WINDOW_MS / 1000) });
  } catch {
    // fail open — see above
  }
  return true;
}

export async function handleTelemetrySnapshot(deps: TelemetryDeps): Promise<TelemetryResult> {
  const now = deps.now ?? Date.now;

  if (new TextEncoder().encode(deps.body).length > MAX_BODY_BYTES) {
    return { status: 413, json: { error: 'payload_too_large', reason: 'snapshot body exceeds 4KB', nextAction: 'Send only the ProductTelemetrySnapshotV1 payload' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.body);
  } catch {
    return { status: 400, json: { error: 'invalid_json', reason: 'body is not valid JSON', nextAction: 'Send ProductTelemetrySnapshotV1 as JSON' } };
  }

  const validated = validateSnapshot(parsed);
  if (!validated.ok) {
    return { status: 400, json: { error: 'invalid_snapshot', reason: validated.errors.join('; ') } };
  }
  const snapshot = validated.value;

  // Reject snapshots dated too far from today: prevents back/fill flooding.
  const today = bucketDateOf(now());
  const dayMs = 24 * 60 * 60 * 1000;
  const ageMs = Date.parse(`${snapshot.bucketDate}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`);
  if (ageMs > dayMs || ageMs < -2 * dayMs) {
    return { status: 400, json: { error: 'bucket_date_out_of_range', reason: 'bucketDate must be today or within the last 2 days' } };
  }

  // Layer 2: transport-level keyed abuse limit (cannot be rotated by client
  // payload). Secret floor mirrors TELEMETRY_HMAC_SECRET — fail closed rather
  // than running an unkeyed (enumerable) limiter. Skipped only when the
  // platform provided no source address.
  const abuseSecret = deps.env.TELEMETRY_ABUSE_HMAC_SECRET;
  if (abuseSecret === undefined || !/^[0-9a-f]{64,}$/i.test(abuseSecret)) {
    return { status: 500, json: { error: 'collector_misconfigured', reason: 'TELEMETRY_ABUSE_HMAC_SECRET must be >=32 bytes as hex (64+ hex chars)' } };
  }
  if (deps.sourceIp !== undefined && !(await checkAbuseLimit(deps.env.FEEDBACK_KV, abuseSecret, deps.sourceIp, now()))) {
    return { status: 429, json: { error: 'rate_limited', reason: 'too many submissions from this network this hour' }, headers: { 'Retry-After': '3600' } };
  }

  // Layer 1: rate limit per anonymous daily ID (KV best-effort, same recipe
  // as relay-core).
  const kv = deps.env.FEEDBACK_KV;
  const hourBucket = Math.floor(now() / RATE_WINDOW_MS);
  const rateKey = `tl-rl:${snapshot.dailyTelemetryId}:${hourBucket}`;
  let hits = 0;
  try {
    const current = await kv.get(rateKey);
    hits = current !== null && /^\d+$/.test(current) ? Number(current) : 0;
  } catch {
    hits = 0; // KV unavailable → fail open (telemetry loss is acceptable; PD is unaffected)
  }
  if (hits >= RATE_LIMIT) {
    return { status: 429, json: { error: 'rate_limited', reason: 'too many snapshots this hour' }, headers: { 'Retry-After': '3600' } };
  }
  try {
    await kv.put(rateKey, String(hits + 1), { expirationTtl: Math.ceil(RATE_WINDOW_MS / 1000) });
  } catch {
    // fail open — see above
  }

  // Secret floor matches the runbook exactly: ≥32 bytes as hex (64+ hex
  // chars). Fail closed rather than persisting weakly-derived IDs.
  if (deps.env.TELEMETRY_HMAC_SECRET === undefined || !/^[0-9a-f]{64,}$/i.test(deps.env.TELEMETRY_HMAC_SECRET)) {
    return { status: 500, json: { error: 'collector_misconfigured', reason: 'TELEMETRY_HMAC_SECRET must be >=32 bytes as hex (64+ hex chars)' } };
  }
  const serverDailyId = await hmacHex(deps.env.TELEMETRY_HMAC_SECRET, snapshot.dailyTelemetryId);

  const db = deps.env.PD_PRODUCT_TELEMETRY;
  const storedAt = new Date(now()).toISOString();
  try {
    // Upsert: (server_daily_id, bucket_date) uniqueness makes same-day
    // duplicate sends idempotent (last write wins; dedup is a SPEC §38 must).
    // NULL facts bind as SQL NULL — "unavailable", never "observed false".
    await db
      .prepare(
        `INSERT INTO product_telemetry_daily (
           server_daily_id, bucket_date, schema_version, pd_version, host_kind,
           initialized, pain_observed, principle_observed, activation_observed,
           presence_receipt_observed, effect_receipt_observed, initialization_failed,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(server_daily_id, bucket_date) DO UPDATE SET
           pd_version = excluded.pd_version,
           host_kind = excluded.host_kind,
           initialized = excluded.initialized,
           pain_observed = excluded.pain_observed,
           principle_observed = excluded.principle_observed,
           activation_observed = excluded.activation_observed,
           presence_receipt_observed = excluded.presence_receipt_observed,
           effect_receipt_observed = excluded.effect_receipt_observed,
           initialization_failed = excluded.initialization_failed,
           updated_at = excluded.updated_at`,
      )
      .bind(
        serverDailyId,
        snapshot.bucketDate,
        snapshot.schemaVersion,
        snapshot.pdVersion,
        snapshot.hostKind,
        factToInt(snapshot.initialized),
        factToInt(snapshot.painObserved),
        factToInt(snapshot.principleObserved),
        factToInt(snapshot.activationObserved),
        factToInt(snapshot.presenceReceiptObserved),
        factToInt(snapshot.effectReceiptObserved),
        factToInt(snapshot.initializationFailed),
        storedAt,
        storedAt,
      )
      .run();
  } catch (error) {
    // Fixed coarse reason only — backend error text never reaches a public
    // responder; detail goes to the platform log (owner-controlled). The
    // source address is never part of any log line.
    console.error('[telemetry] snapshot persist failed:', error instanceof Error ? error.message : String(error));
    return { status: 500, json: { error: 'storage_unavailable', reason: 'snapshot could not be stored' } };
  }

  // Opportunistic retention sweep (the scheduled cleanup endpoint enforces
  // the SAME policy — retentionCutoffDate is the single computation).
  // Deliberately outside the persist try: an accepted snapshot stays accepted
  // even if the sweep hiccups — stale rows are reclaimed by the next write
  // or by the scheduled job.
  try {
    const cutoff = retentionCutoffDate(now());
    await db.prepare('DELETE FROM product_telemetry_daily WHERE bucket_date < ?').bind(cutoff).run();
  } catch (error) {
    console.error('[telemetry] retention sweep failed:', error instanceof Error ? error.message : String(error));
  }

  // Bounded success response (empty body).
  return { status: 204, json: null };
}

/** Map a tri-state fact to its D1 binding: true→1, false→0, null→NULL. */
function factToInt(fact: Fact): number | null {
  return fact === null ? null : fact ? 1 : 0;
}
