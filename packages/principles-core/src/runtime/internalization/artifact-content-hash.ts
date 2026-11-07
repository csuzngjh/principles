/**
 * Layer 0 — canonical serialization and content hashing (design §6.1, PR 1 /
 * task 3.6).
 *
 * Pure logic only: no I/O. In particular this module does NOT import
 * `node:crypto` — the hash algorithm is injected by the caller (plugin
 * layer), keeping this file free of the `io-seam-registry.json` obligation
 * (`antipattern-core-io`).
 */

/** Hash function injected by the caller (e.g. `node:crypto`'s sha256, hex-encoded). */
export type HashFn = (input: string) => string;

/** 256 KB. Content beyond this size only has its prefix hashed (documented limitation). */
export const CANONICAL_JSON_MAX_CHARS = 262_144;

const TRUNCATION_MARKER = '…[canonical-json-truncated]';

/**
 * Stable serialization: object keys are sorted lexicographically at every
 * level so that key-insertion-order differences never change the result.
 * Arrays keep their original order (order is semantically meaningful there).
 *
 * Postcondition: the same input always yields the same string; truncation
 * (when the result would exceed `CANONICAL_JSON_MAX_CHARS`) happens at a
 * deterministic position and is explicitly marked — never silent (rc-9).
 *
 * Known limitation: content beyond `CANONICAL_JSON_MAX_CHARS` only has its
 * prefix participate in the hash, so staleness detection on such oversized
 * content only observes prefix changes. This is a documented trade-off, not
 * a silently-accepted gap.
 */
// ── Stable JSON serialization ────────────────────────────────────────────────

/**
 * Deterministic JSON.stringify replacement: sorts object keys, handles
 * cycles and non-JSON-safe values (functions, undefined, symbols) the same
 * way JSON.stringify would (dropped from objects, `null` inside arrays),
 * and never throws on values JSON.stringify would reject (BigInt, circular
 * references) — instead renders an explicit placeholder.
 */
function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return 'null';
  const type = typeof value;

  if (type === 'string') return JSON.stringify(value);
  if (type === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (type === 'boolean') return String(value);
  if (type === 'bigint') return JSON.stringify(`${String(value)}n`);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const items = value.map((entry) => stableStringify(entry, seen));
    seen.delete(value);
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    return JSON.stringify(Number.isNaN(value.getTime()) ? null : value.toISOString());
  }

  if (value instanceof Map) {
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const entries = [...value.entries()]
      .map(([k, v]) => [String(k), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, seen)}`).join(',');
    seen.delete(value);
    return `{${body}}`;
  }

  if (value instanceof Set) {
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const items = [...value.values()].map((entry) => stableStringify(entry, seen));
    seen.delete(value);
    return `[${items.join(',')}]`;
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '"[Circular]"';
    seen.add(obj);
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      const serialized = stableStringify(obj[key], seen);
      // Mirror JSON.stringify's own behaviour: keys whose value serializes to
      // undefined-equivalent (function/undefined/symbol) are simply omitted,
      // not rendered as "key":null. stableStringify already renders those as
      // 'null', so detect the pre-serialization type here directly.
      const rawValue = obj[key];
      const rawType = typeof rawValue;
      if (rawValue === undefined || rawType === 'function' || rawType === 'symbol') {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${serialized}`);
    }
    seen.delete(obj);
    return `{${parts.join(',')}}`;
  }

  // Unreachable for the standard JS type set, but never throw (defensive).
  return '"[Unserializable]"';
}

export function canonicalStringify(value: unknown): { readonly text: string; readonly truncated: boolean } {
  const text = stableStringify(value);
  if (text.length <= CANONICAL_JSON_MAX_CHARS) {
    return { text, truncated: false };
  }
  const prefixLen = CANONICAL_JSON_MAX_CHARS - TRUNCATION_MARKER.length;
  return { text: `${text.slice(0, Math.max(0, prefixLen))}${TRUNCATION_MARKER}`, truncated: true };
}

export function computeContentHash(value: unknown, hash: HashFn): string {
  return hash(canonicalStringify(value).text);
}
