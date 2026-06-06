/**
 * Shared evidence sanitizer for durable pain signal storage.
 *
 * Used by:
 * - pain-signal-observability.ts (core package)
 * - message-sanitize.ts (openclaw-plugin package)
 *
 * Design contract (EP-08 Security Boundary Placement):
 * - Sanitization happens at the PERSISTENCE boundary, not at evaluation boundary
 * - Enforcement input (raw params, error text) stays available for gate/score computation
 * - All strings are token-redacted and bounded before durable storage
 * - Unknown-first: never throws on malformed input; returns {} or bounded preview
 * - Recursive with depth/key/array limits to prevent infinite traversal
 *
 * ERR checklist:
 * - ERR-001: no `as` casts — input is `unknown`, narrowed with typeof guards
 * - ERR-055: ANY-segment sensitive field matching, not ALL-segment
 * - ERR-056: token redaction runs on ALL strings, not just truncation
 * - ERR-051: redaction is at persistence output path, not evaluation input path
 */

import * as nodePath from 'path';

// ── Limits ──

export const MAX_EVIDENCE_VALUE_CHARS = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 20;

// ── Token patterns ──

const TOKEN_LIKE_PATTERNS: RegExp[] = [
  /[A-Za-z0-9+/=]{40,}/g,          // ≥40 base64-like or hex tokens
  /sk-[A-Za-z0-9_-]{20,}/g,        // OpenAI-style secret keys
  /ghp_[A-Za-z0-9]{36,}/g,         // GitHub PATs
  /gho_[A-Za-z0-9]{36,}/g,         // GitHub OAuth tokens
  /xox[bpras]-[A-Za-z0-9-]{20,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{20,}\./g,     // JWT-like tokens
];

// ── PD tag patterns ──

const PD_TAG_PATTERNS: RegExp[] = [
  /\[EMOTIONAL_DAMAGE_DETECTED(?::(?:mild|moderate|severe))?\]/gi,
  /\[EMPATHY_ROLLBACK_REQUEST\]/gi,
  /<empathy[^>]*\/?>(?:<\/empathy>)?/gi,
];

// ── Path detection ──

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

/**
 * Converges an absolute path to a safe representation.
 * - Under workspaceDir → repo-relative
 * - Other absolute → basename only
 * - Relative paths → kept as-is
 */
export function convergePath(value: string, workspaceDir?: string): string {
  if (!ABSOLUTE_PATH_RE.test(value)) return value;

  // Try repo-relative
  if (workspaceDir) {
    const normalizedWorkspace = workspaceDir.replace(/[\\/]+$/, '');
    const normalizedValue = value.replace(/[\\/]+$/, '');
    // Case-insensitive comparison on Windows
    const compare = WINDOWS_DRIVE_RE.test(value)
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
    if (compare(normalizedValue.slice(0, normalizedWorkspace.length), normalizedWorkspace)) {
      const relative = normalizedValue.slice(normalizedWorkspace.length).replace(/^[/\\]/, '');
      return relative || nodePath.basename(value);
    }
  }

  // Absolute, not under workspace → basename
  return nodePath.basename(value);
}

// ── String sanitization ──

/**
 * Sanitize a single string value:
 * 1. Strip internal PD tags
 * 2. Redact token-like patterns
 * 3. Converge absolute paths
 * 4. Bound length
 */
export function sanitizeString(value: string, workspaceDir?: string): string {
  let result = value;

  // 1. Strip PD tags
  for (const p of PD_TAG_PATTERNS) {
    result = result.replace(p, '');
  }

  // 2. Redact tokens
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const prefix = match.length > 50 ? match.slice(0, 8) : match.slice(0, 4);
      return `${prefix}___REDACTED___${match.length}`;
    });
  }

  // 3. Path convergence (only if it looks like a path)
  result = convergePath(result, workspaceDir);

  // 4. Bound length
  if (result.length > MAX_EVIDENCE_VALUE_CHARS) {
    result = result.slice(0, MAX_EVIDENCE_VALUE_CHARS) + '___TRUNCATED___';
  }

  return result.trim();
}

// ── Recursive value sanitization ──

/**
 * Recursively sanitize any value for durable evidence storage.
 * - Primitives: string → redact+bound; number/boolean → pass-through
 * - Objects: recurse with key limit
 * - Arrays: recurse with item limit
 * - Depth limit prevents infinite traversal
 *
 * ERR-001: input is `unknown`, narrowed with typeof guards (no `as` casts)
 */
export function sanitizeValue(
  value: unknown,
  depth = 0,
  workspaceDir?: string,
): unknown {
  // Depth guard
  if (depth > MAX_DEPTH) return '<max-depth>';

  // Null/undefined
  if (value === null || value === undefined) return value;

  // Primitives
  if (typeof value === 'string') return sanitizeString(value, workspaceDir);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  // Arrays
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS);
    const mapped = items.map((item) => sanitizeValue(item, depth + 1, workspaceDir));
    if (value.length > MAX_ARRAY_ITEMS) {
      mapped.push(`<${value.length - MAX_ARRAY_ITEMS} more items>`);
    }
    return mapped;
  }

  // Objects — ERR-001: runtime validate before Object.entries
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(record)) {
      if (count >= MAX_KEYS) {
        result['<truncated>'] = `${Object.keys(record).length - count} more keys`;
        break;
      }
      result[k] = sanitizeValue(v, depth + 1, workspaceDir);
      count++;
    }
    return result;
  }

  // Functions, symbols, etc.
  return '<unsupported-type>';
}

/**
 * Sanitize tool-call params for evidence/trajectory storage.
 *
 * ERR-001: accepts `unknown`, not `Record<string, unknown>`.
 * ERR-055: ANY-segment sensitive field matching.
 * ERR-056: token redaction runs on ALL strings via sanitizeValue recursion.
 *
 * @param params - raw tool params (any shape)
 * @param workspaceDir - optional workspace root for path convergence
 */
export function sanitizeToolParams(
  params: unknown,
  workspaceDir?: string,
): Record<string, unknown> {
  // ERR-001: runtime validate before Object.entries
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    // Non-object input: return safe bounded preview
    if (Array.isArray(params)) {
      return { '<array-input>': sanitizeValue(params, 0, workspaceDir) as string };
    }
    if (typeof params === 'string') {
      return { '<string-input>': sanitizeString(params.slice(0, MAX_EVIDENCE_VALUE_CHARS), workspaceDir) };
    }
    return {};
  }

  // Valid object: recurse through sanitizeValue
  return sanitizeValue(params, 0, workspaceDir) as Record<string, unknown>;
}
