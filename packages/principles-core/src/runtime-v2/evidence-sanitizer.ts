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
 * - EP-08: platform-agnostic path basename — uses split on both `\\` and `/`,
 *   never relies on nodePath.basename which only splits on the host OS separator.
 */

// ── Limits ──

export const MAX_EVIDENCE_VALUE_CHARS = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 20;
const SENSITIVE_KEY_PARTS = new Set(['token', 'secret', 'password', 'authorization', 'apikey', 'accesstoken', 'refreshtoken']);

// ── Token patterns ──

const TOKEN_LIKE_PATTERNS: RegExp[] = [
  /[A-Za-z0-9+/=]{40,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{36,}/g,
  /gho_[A-Za-z0-9]{36,}/g,
  /xox[bpras]-[A-Za-z0-9-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\./g,
];

// ── PD tag patterns ──

const PD_TAG_PATTERNS: RegExp[] = [
  /\[EMOTIONAL_DAMAGE_DETECTED(?::(?:mild|moderate|severe))?\]/gi,
  /\[EMPATHY_ROLLBACK_REQUEST\]/gi,
  // No `\/?` before `>`: `/` is already in `[^>]`, so the optional branch only
  // adds backtracking paths (CodeQL js/polynomial-redos) without changing what matches.
  /<empathy[^>]*>(?:<\/empathy>)?/gi,
];

// ── Path detection ──

const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

/**
 * Matches absolute paths embedded anywhere inside a string.
 * Windows drive, POSIX root, UNC paths.
 */
const ABSOLUTE_PATH_IN_STRING_RE =
  /(?:^|[\s"'=])([A-Za-z]:\\[^\s"'&|<>]+|[A-Za-z]:\/[^\s"'&|<>]+|\\\\[^\s"'&|<>]+|(?:\/[\w.-]+){2,}(?:\/[^\s"'&|<>]*)?)/gm;

// ── Helpers ──

/**
 * Strips every trailing `\` / `/` via a linear end-scan.
 * Constraint: keep this regex-free — trailing-separator strip regexes are
 * js/polynomial-redos flagged (adversarial separator runs reach convergePath
 * through untrusted evidence strings).
 */
function stripTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end--;
  return end === value.length ? value : value.slice(0, end);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const parts = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // A sensitive word may span several camelCase/underscore segments, e.g.
  // `userApiKey` → ['user','api','key'] where 'apikey' is the sensitive word.
  // Check every contiguous subsequence join so `userApiKey`/`openaiApiKey`
  // match, while a plain `tokenizer` (single segment) does not.
  for (let i = 0; i < parts.length; i++) {
    for (let j = i; j < parts.length; j++) {
      const joined = parts.slice(i, j + 1).join('');
      if (SENSITIVE_KEY_PARTS.has(joined)) return true;
    }
  }
  return false;
}

/**
 * Platform-agnostic basename that handles both `\` and `/` separators.
 *
 * EP-08: nodePath.basename on Linux does not split on backslash.
 * This helper splits on both separator families so that Windows paths
 * like `D:\Code\principles` produce `principles` even when running on
 * a POSIX CI runner.
 */
function platformAgnosticBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Converges a single absolute path to a safe representation.
 * - Under workspaceDir → repo-relative
 * - Other absolute → basename only (platform-agnostic)
 * - Relative paths → kept as-is
 */
export function convergePath(value: string, workspaceDir?: string): string {
  if (!ABSOLUTE_PATH_RE.test(value)) return value;

  // Try repo-relative
  if (workspaceDir) {
    const normalizedWorkspace = stripTrailingSeparators(workspaceDir);
    const normalizedValue = stripTrailingSeparators(value);
    // Case-insensitive comparison on Windows
    const compare = WINDOWS_DRIVE_RE.test(value)
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
    if (compare(normalizedValue.slice(0, normalizedWorkspace.length), normalizedWorkspace)) {
      const relative = normalizedValue.slice(normalizedWorkspace.length).replace(/^[/\\]/, '');
      return relative || platformAgnosticBasename(value);
    }
  }

  // Absolute, not under workspace → basename
  return platformAgnosticBasename(value);
}

/**
 * Replace absolute paths embedded inside a longer string.
 * e.g. "cd D:\Code\principles && git status" → "cd <path:principles> && git status"
 * e.g. "error in /home/user/project/src/file.ts" → "error in <path:file.ts>"
 */
function replacePathsInString(value: string, workspaceDir?: string): string {
  return value.replace(ABSOLUTE_PATH_IN_STRING_RE, (fullMatch, capturedPath: string) => {
    const leading = fullMatch.slice(0, fullMatch.length - capturedPath.length);
    const converged = convergePath(capturedPath, workspaceDir);
    // Wrap outside-workspace absolute paths in angle brackets
    if (ABSOLUTE_PATH_RE.test(capturedPath) && converged === platformAgnosticBasename(capturedPath)) {
      return `${leading}<path:${converged}>`;
    }
    return `${leading}${converged}`;
  });
}

// ── String sanitization ──

/**
 * Sanitize a single string value:
 * 1. Strip internal PD tags
 * 2. Redact token-like patterns
 * 3. Replace absolute paths embedded in the string
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

  // 3. Replace absolute paths embedded in the string
  result = replacePathsInString(result, workspaceDir);

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
  if (depth > MAX_DEPTH) return '<max-depth>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value, workspaceDir);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS);
    const mapped = items.map((item) => sanitizeValue(item, depth + 1, workspaceDir));
    if (value.length > MAX_ARRAY_ITEMS) {
      mapped.push(`<${value.length - MAX_ARRAY_ITEMS} more items>`);
    }
    return mapped;
  }

  // ERR-001: runtime guard instead of `as Record`
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
      if (count >= MAX_KEYS) {
        result['<truncated>'] = `${Object.keys(value).length - count} more keys`;
        break;
      }
      result[k] = isSensitiveKey(k) ? '<sensitive___REDACTED___field>' : sanitizeValue(v, depth + 1, workspaceDir);
      count++;
    }
    return result;
  }

  return '<unsupported-type>';
}

/**
 * Sanitize tool-call params for evidence/trajectory storage.
 *
 * ERR-001: accepts `unknown`, not `Record<string, unknown>`. Runtime guards only.
 * ERR-055: ANY-segment sensitive field matching.
 * ERR-056: token redaction runs on ALL strings via sanitizeValue recursion.
 */
export function sanitizeToolParams(
  params: unknown,
  workspaceDir?: string,
): Record<string, unknown> {
  if (params === null || params === undefined) {
    return {};
  }

  if (typeof params === 'string') {
    return { '<string-input>': sanitizeString(params.slice(0, MAX_EVIDENCE_VALUE_CHARS), workspaceDir) };
  }

  if (typeof params === 'number' || typeof params === 'boolean') {
    return {};
  }

  if (Array.isArray(params)) {
    const sanitized = sanitizeValue(params, 0, workspaceDir);
    if (Array.isArray(sanitized)) {
      return { '<array-input>': sanitized.join(', ').slice(0, MAX_EVIDENCE_VALUE_CHARS) };
    }
    return { '<array-input>': '<sanitization-error>' };
  }

  if (isPlainRecord(params)) {
    const sanitized = sanitizeValue(params, 0, workspaceDir);
    if (isPlainRecord(sanitized)) {
      return sanitized;
    }
    return {};
  }

  return {};
}
