// safe-stringify.ts
// ERR-017: BigInt-safe + circular-ref-safe JSON stringifier for previews.
// Used by renderers when they need to embed a value (e.g. versions, platform) into markdown or email text.

const MAX_SAFE_STRINGIFY_DEPTH = 8;
const MAX_SAFE_STRINGIFY_KEYS = 50;

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

type StringifyCtx = { seen: WeakSet<object>; depth: number; out: { result: string } };

function safeStringifyValue(value: unknown, ctx: StringifyCtx): void {
  const { out } = ctx;
  if (out.result === '<truncated>') return;
  if (value === null) {
    out.result += 'null';
    return;
  }
  if (value === undefined) {
    out.result += 'undefined';
    return;
  }
  const t = typeof value;
  if (t === 'string') {
    out.result += JSON.stringify(truncateString(value as string, 200));
    return;
  }
  if (t === 'number') {
    out.result += Number.isFinite(value as number) ? String(value) : '"NaN"';
    return;
  }
  if (t === 'boolean') {
    out.result += String(value);
    return;
  }
  if (t === 'bigint') {
    out.result += `"<bigint:${(value as bigint).toString()}>"`;
    return;
  }
  if (t === 'symbol') {
    out.result += `"<symbol>"`;
    return;
  }
  if (t === 'function') {
    out.result += '"<function>"';
    return;
  }
  if (ctx.depth >= MAX_SAFE_STRINGIFY_DEPTH) {
    out.result += '"<deep>"';
    return;
  }
  const obj = value as object;
  if (ctx.seen.has(obj)) {
    out.result += '"<circular>"';
    return;
  }
  ctx.seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      out.result += '[';
      const len = Math.min(obj.length, MAX_SAFE_STRINGIFY_KEYS);
      for (let i = 0; i < len; i++) {
        if (i > 0) out.result += ',';
        safeStringifyValue(obj[i], { seen: ctx.seen, depth: ctx.depth + 1, out });
      }
      if (obj.length > len) out.result += ',…';
      out.result += ']';
    } else {
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record).slice(0, MAX_SAFE_STRINGIFY_KEYS);
      out.result += '{';
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i] as string;
        if (i > 0) out.result += ',';
        out.result += JSON.stringify(truncateString(k, 80)) + ':';
        safeStringifyValue(record[k], { seen: ctx.seen, depth: ctx.depth + 1, out });
      }
      if (Object.keys(record).length > keys.length) {
        out.result += ',…';
      }
      out.result += '}';
    }
  } finally {
    ctx.seen.delete(obj);
  }
}

/**
 * BigInt-safe + circular-ref-safe JSON-style stringifier for preview text.
 * Truncates long strings, bounds depth, and never throws on BigInt or circular refs.
 */
export function safeStringifyPreview(value: unknown): string {
  const out: { result: string } = { result: '' };
  const ctx: StringifyCtx = { seen: new WeakSet<object>(), depth: 0, out };
  try {
    safeStringifyValue(value, ctx);
  } catch {
    return '<unserializable>';
  }
  if (out.result.length > 2000) {
    return out.result.slice(0, 2000) + '…';
  }
  return out.result;
}
