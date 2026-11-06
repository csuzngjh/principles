// redact-sensitive.ts
// Privacy-preserving redaction helpers used by the feedback pipeline.
// ERR-001/005: no `as` casts on untrusted values.
// ERR-002: never throws; pipeline functions return either a string or a structured result with notes.
// ERR-003: segment-exact key matching (e.g. "authorization", "auth_token"), never substring ("author" must NOT match).
// ERR-014/016: bounded output.

export const REDACTED_PATH = '<redacted-path>';
export const REDACTED_VALUE = '[REDACTED]';
export const NO_STACK = '<no-stack>';

const MAX_STACK_FRAMES_DEFAULT = 3;

// ── Path redaction ──────────────────────────────────────────────────────────

// Windows: C:\Users\alice\...   D:\foo\bar   E:/...
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/](?:[^\\\s/:*?"<>|]+[\\/])+[^\\\s/:*?"<>|]*)/g;
// POSIX: /home/alice/...   /Users/wesley/...   /usr/local/bin/...
// Preceded check (?<![a-zA-Z0-9_.]) preserves relative paths like ./usr/bin and avoids matching URL paths
const POSIX_PATH = /(?<![a-zA-Z0-9_.])[\\/](?:usr|home|Users|var|opt|etc|tmp|root|run|mnt|media|srv|boot|dev|proc|sys)(?:[\\/][^\\\s/:*?"<>|]+)+/g;

/**
 * Replace absolute paths with `<redacted-path>`. Relative paths are left alone.
 */
export function redactAbsolutePaths(text: string): string {
  if (typeof text !== 'string') return text;
  return text.replace(WINDOWS_PATH, REDACTED_PATH).replace(POSIX_PATH, REDACTED_PATH);
}

// ── Token redaction ─────────────────────────────────────────────────────────

// OpenAI sk-..., Anthropic sk-ant-..., generic sk-_...
const OPENAI_TOKEN = /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g;
// GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g;
// Linear API tokens: lin_api_<hex> (underscores allowed — e.g. lin_api_test_abc123)
const LINEAR_TOKEN = /\blin_api_[A-Za-z0-9_-]{16,}\b/g;
// Authorization header values (keep key label, optional quote, scheme like Bearer/Basic, redact only the actual token)
const AUTH_HEADER_VALUE = /(Authorization\s*:\s*)(["'])?([A-Za-z]+\s+)?([^\s"';,]+)/gi;
// PowerShell env var: $env:VAR="value"
const PWSH_ENV_VAR = /(\$env:\s*[A-Z_][A-Z0-9_]{2,}\s*=\s*")([^"]*)(")/gi;
// Generic api_key= / token= / secret= / password= assignments
const KEY_ASSIGN = /\b(api[_-]?key|token|secret|password|auth(?:_?token)?)\s*[:=]\s*['"]?([^\s'",}{]+)['"]?/gi;
// Bearer headers
const BEARER = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/g;

/**
 * Replace token-like values with `[REDACTED]`.
 */
export function redactTokenLikeValues(text: string): string {
  if (typeof text !== 'string') return text;
  return text
    .replace(OPENAI_TOKEN, REDACTED_VALUE)
    .replace(GITHUB_TOKEN, REDACTED_VALUE)
    .replace(LINEAR_TOKEN, REDACTED_VALUE)
    .replace(AUTH_HEADER_VALUE, '$1$2$3[REDACTED]')
    .replace(PWSH_ENV_VAR, '$1[REDACTED]$3')
    .replace(BEARER, REDACTED_VALUE)
    .replace(KEY_ASSIGN, (_m, key: string) => `${key}=${REDACTED_VALUE}`);
}

// ── Environment-like value redaction ────────────────────────────────────────

// KEY=value (basic)  /  KEY="value with spaces"
const ENV_ASSIGN = /\b([A-Z_][A-Z0-9_]{2,})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}{]+))/g;

export function redactEnvLikeValues(text: string): string {
  if (typeof text !== 'string') return text;
  return text.replace(ENV_ASSIGN, (_m, key: string) => `${key}=${REDACTED_VALUE}`);
}

// ── Combined telemetry redaction ────────────────────────────────────────────

export function redactTelemetryString(text: string): string;
export function redactTelemetryString(text: unknown): unknown;
/**
 * Run all string-level redactors in sequence on telemetry strings (commands,
 * file paths, tool arguments, params summaries) before they enter event logs.
 *
 * This combines token, env, auth-header, and absolute-path redaction in a single pass.
 * ERR-002: never throws; returns original value for non-string input.
 * ERR-045/046: covers composite command strings, Authorization headers, env vars, paths.
 * ERR-001: no `as` casts — runtime type guard via typeof.
 *
 * Type signature accepts `unknown` so callers don't need unsafe casts.
 */
export function redactTelemetryString(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  let result = redactAbsolutePaths(text);
  result = redactTokenLikeValues(result);
  result = redactEnvLikeValues(result);
  return result;
}

// ── Stack trace redaction ──────────────────────────────────────────────────

const STACK_FRAME_LINE = /^\s*at\s+.*$/gm;

/**
 * Reduce a stack trace to the error name and the first N frames (paths redacted).
 * Empty input returns `<no-stack>`.
 */
export function redactStackTrace(text: string, maxFrames: number = MAX_STACK_FRAMES_DEFAULT): string {
  if (typeof text !== 'string' || text.length === 0) return NO_STACK;
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  const frames = text.match(STACK_FRAME_LINE) ?? [];
  const kept = frames
    .slice(0, Math.max(0, maxFrames))
    .map((f) => f.replace(WINDOWS_PATH, REDACTED_PATH).replace(POSIX_PATH, REDACTED_PATH))
    .join('\n');
  if (!kept) return firstLine || NO_STACK;
  return kept.includes(firstLine) ? kept : `${firstLine}\n${kept}`;
}

// ── Structured field redaction ──────────────────────────────────────────────

/**
 * Segment-exact sensitive key names (split on `_-`).
 * ERR-003 fix: do not match substrings like "author" → "auth".
 */
const SENSITIVE_KEY_SEGMENTS = new Set<string>([
  'password',
  'passwd',
  'secret',
  'token',
  'api',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'private',
  'key',
]);

function segmentsOfKey(key: string): string[] {
  return key
    .toLowerCase()
    .split(/[_\-.]/g)
    .filter((s) => s.length > 0);
}

function isSensitiveKey(key: string): boolean {
  const segs = segmentsOfKey(key);
  if (segs.length === 0) return false;
  // A key is sensitive if ANY of its segments matches a sensitive segment.
  // This catches composite names like "github_token" or "db_password".
  for (const seg of segs) {
    if (SENSITIVE_KEY_SEGMENTS.has(seg)) return true;
  }
  return false;
}

export type RedactResult =
  | { ok: true; value: unknown; notes: string[] }
  | { ok: false; error: string; nextAction: string };

const REDACT_MAX_DEPTH = 6;
const REDACT_MAX_KEYS = 100;
const REDACT_MAX_STRING = 2000;

type RedactContext = { seen: WeakSet<object>; depth: number; notes: string[] };

// Internal helpers (defined above the public entry point to satisfy
// `no-use-before-define` while still being hoisted via `function` declarations).

function redactInner(value: unknown, ctx: RedactContext): RedactResult {
  if (value === null) return { ok: true, value: null, notes: [] };
  if (value === undefined) return { ok: true, value: undefined, notes: [] };
  const t = typeof value;
  if (t === 'string') {
    let s = value as string;
    const original = s;
    // Run string through path/token/env redactors before truncation so
    // secrets embedded in values (e.g. buildId, cwd) are cleaned regardless of key name.
    s = redactAbsolutePaths(s);
    s = redactTokenLikeValues(s);
    s = redactEnvLikeValues(s);
    if (s !== original) {
      ctx.notes.push('string value redacted (path/token/env)');
    }
    if (s.length > REDACT_MAX_STRING) {
      s = s.slice(0, REDACT_MAX_STRING) + '…';
      ctx.notes.push(`string truncated to ${REDACT_MAX_STRING} chars`);
    }
    return { ok: true, value: s, notes: ctx.notes };
  }
  if (t === 'bigint') {
    // BigInt-safe preview: encode as a string marker so JSON.stringify callers don't throw
    return { ok: true, value: `<bigint:${(value as bigint).toString()}>`, notes: [] };
  }
  if (t !== 'object') {
    return { ok: true, value, notes: [] };
  }
  if (ctx.depth >= REDACT_MAX_DEPTH) {
    return { ok: true, value: '<deep>', notes: [] };
  }
  const obj = value;
  if (ctx.seen.has(obj)) {
    ctx.notes.push('circular reference detected');
    return { ok: true, value: '<circular>', notes: [] };
  }
  ctx.seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const r = redactInner(value[i], { seen: ctx.seen, depth: ctx.depth + 1, notes: ctx.notes });
        if (!r.ok) return r;
        arr.push(r.value);
      }
      return { ok: true, value: arr, notes: [] };
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(record).slice(0, REDACT_MAX_KEYS);
    for (const k of keys) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED_VALUE;
        ctx.notes.push(`field "${k}" redacted`);
        continue;
      }
      const v = record[k];
      if (v !== null && typeof v === 'object' && ctx.seen.has(v)) {
        ctx.notes.push(`circular reference detected at "${k}"`);
        out[k] = '<circular>';
        continue;
      }
      const r = redactInner(v, { seen: ctx.seen, depth: ctx.depth + 1, notes: ctx.notes });
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out, notes: [] };
  } finally {
    ctx.seen.delete(obj);
  }
}

function redactArray(arr: unknown[]): RedactResult {
  const notes: string[] = [];
  const out: unknown[] = [];
  const ctx: RedactContext = { seen: new WeakSet<object>(), depth: 0, notes };
  ctx.seen.add(arr);
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (item !== null && typeof item === 'object' && ctx.seen.has(item)) {
      notes.push('circular reference detected in array');
      out.push('<circular>');
      continue;
    }
    const r = redactInner(item, ctx);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out, notes };
}

function redactObject(obj: object): RedactResult {
  const rec = obj as Record<string, unknown>;
  const notes: string[] = [];
  const ctx: RedactContext = { seen: new WeakSet<object>(), depth: 0, notes };
  ctx.seen.add(obj);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(rec).slice(0, REDACT_MAX_KEYS);
  for (const k of keys) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED_VALUE;
      notes.push(`field "${k}" redacted`);
      continue;
    }
    const v = rec[k];
    if (v !== null && typeof v === 'object' && ctx.seen.has(v)) {
      notes.push(`circular reference detected at "${k}"`);
      out[k] = '<circular>';
      continue;
    }
    const r = redactInner(v, ctx);
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return { ok: true, value: out, notes };
}

/**
 * Recursively redact sensitive fields in an unknown value.
 * Never throws. Returns a structured result with notes describing what was redacted.
 *
 * ERR-002: returns `{ok:false,error,nextAction}` for non-object top-level input
 * because field redaction is a structured-data operation. Primitives carry no
 * fields; their values should be sanitized via `redactTokenLikeValues` /
 * `redactEnvLikeValues` / `redactAbsolutePaths` instead.
 */
export function redactSensitiveFields(value: unknown): RedactResult {
  if (value === null) {
    return {
      ok: false,
      error: 'redactSensitiveFields: null is not a redactable object',
      nextAction: 'pass a JSON object or array; null carries no fields to redact',
    };
  }
  if (value === undefined) {
    return {
      ok: false,
      error: 'redactSensitiveFields: undefined is not a redactable object',
      nextAction: 'pass a JSON object or array; undefined carries no fields to redact',
    };
  }
  const t = typeof value;
  if (t !== 'object') {
    return {
      ok: false,
      error: `redactSensitiveFields: top-level value must be an object or array (got ${t})`,
      nextAction: 'pass a JSON object or array; for primitive values use redactTokenLikeValues / redactEnvLikeValues / redactAbsolutePaths',
    };
  }
  if (Array.isArray(value)) {
    return redactArray(value);
  }
  return redactObject(value);
}
