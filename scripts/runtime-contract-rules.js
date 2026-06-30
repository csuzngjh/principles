/**
 * Runtime Contract Rules — PRI-441 / Issue #996
 *
 * Pure single-line checker for the three Runtime Contract violation patterns
 * that map to real ERR entries (see docs/process/error-management/ERROR_PATTERN_INDEX.md EP-01):
 *   - ERR-001: `as` type-assertion bypasses runtime validation on untrusted data
 *   - ERR-005: `as Foo[]` array-element cast without per-element validation
 *   - ERR-013: `'key' in obj` on untrusted objects matches inherited properties
 *
 * This module is intentionally side-effect free and dependency free so it can be
 * unit-tested by direct import (mirrors scripts/check-repo-hygiene.js convention).
 *
 * Trust-origin analysis is the caller's responsibility: the caller builds a
 * `TrustContext` (set of variable names that originate from JSON.parse / fs /
 * fetch / DB) and passes it in. Inline untrusted calls (`JSON.parse(x) as Y`)
 * are detected directly on the line so data-flow gaps do not cause false negatives.
 *
 * Runtime Contract Rule 2 (no `as` bypass): this module validates its inputs with
 * typeof / instanceof, never `as`. Rule 5 (Object.hasOwn): untrusted key access
 * uses Object.hasOwn.
 */

/**
 * @typedef {Object} TrustContext
 * @property {Set<string>} untrustedVars - variable identifiers whose runtime
 *   value originates from an untrusted source (JSON.parse, fs.readFile, fetch,
 *   DB .all()/.get()). Includes both simple names (`parsed`) and dotted paths
 *   (`event.data`). The checker tests the full operand AND its root identifier.
 */

/**
 * @typedef {Object} Violation
 * @property {string} ruleId - e.g. 'ERR-001'
 */

/** Tag prefix for all scanner output, matches check-error-handbook.cjs convention. */
export const TAG = '[check:runtime-contract]';

/** Whitelist of `as <Type>` forms that are NEVER ERR-001 violations. */
const SAFE_AS_TYPES = new Set([
  'const', // literal narrowing
  'unknown', // widening to unknown is safe (preserves unknown-ness)
  'unknown[]', // array of unknown — sanctioned ERR-005 fix prefix
  'Buffer',
  'NodeJS',
]);

/** Whitelist of `<Type>[]` element forms that are NEVER ERR-005 violations. */
const SAFE_ARRAY_ELEMENT_TYPES = new Set(['unknown']);

/**
 * Regex matching an exemption comment.
 * Group 1 = ERR ID (ERR-NNN), group 2 = non-empty reason.
 * A line that has the `runtime-contract-exempt:` marker but does NOT satisfy
 * this full regex is a malformed exemption (caller reports it as its own finding).
 */
export const EXEMPTION_RE = /\/\/\s*runtime-contract-exempt:\s*(ERR-\d+)\s+(\S.*)/;

/** Regex detecting ANY exemption-comment attempt (valid or malformed). */
export const EXEMPTION_MARKER_RE = /\/\/\s*runtime-contract-exempt:/;

/**
 * Parse an exemption comment line.
 *
 * Runtime Contract Rule 3 (required fields fail loud): an exemption without an
 * ERR ID or without a non-empty reason is rejected.
 *
 * @param {string} line
 * @returns {{ errId: string, reason: string } | 'MALFORMED' | null}
 *   - `{errId, reason}` if the line is a valid exemption comment
 *   - `'MALFORMED'` if the line has the exemption marker but is missing ERR ID or reason
 *   - `null` if the line is not an exemption comment at all
 */
export function parseExemption(line) {
  if (typeof line !== 'string') return null;
  if (!EXEMPTION_MARKER_RE.test(line)) return null;
  const match = EXEMPTION_RE.exec(line);
  if (!match) return 'MALFORMED';
  const errId = match[1];
  const reason = match[2].trim();
  if (reason.length === 0) return 'MALFORMED';
  return { errId, reason };
}

/**
 * Extract the root identifier from a dotted operand like `event.data` → `event`.
 * @param {string} operand
 * @returns {string}
 */
function rootIdentifier(operand) {
  const dotIdx = operand.indexOf('.');
  return dotIdx === -1 ? operand : operand.slice(0, dotIdx);
}

/**
 * True if `operand` (or its root identifier) is flagged as untrusted.
 * @param {string} operand
 * @param {Set<string>} untrustedVars
 */
function isUntrustedOperand(operand, untrustedVars) {
  if (untrustedVars.has(operand)) return true;
  const root = rootIdentifier(operand);
  return root !== operand && untrustedVars.has(root);
}

// ---------------------------------------------------------------------------
// Per-rule detectors. Each returns { ruleId } | null for a single line.
// ---------------------------------------------------------------------------

/**
 * ERR-013: `'key' in obj` on an untrusted object.
 *
 * Whitelist (do not flag):
 *   - `Object.hasOwn(obj, 'key')` — the sanctioned alternative
 *   - `instanceof Error` / `typeof x === 'object'` on the same line — type
 *     narrowing on caught errors is legitimate (the operand is typed, not raw)
 *   - operand NOT in the untrusted set — e.g. narrowing a typed `Result` union
 *
 * @param {string} line
 * @param {TrustContext} ctx
 * @returns {Violation | null}
 */
function detectErr013(line, ctx) {
  // `Object.hasOwn(...)` is the correct pattern — not an `in` check at all.
  if (/Object\.hasOwn\s*\(/.test(line)) return null;

  // Type narrowing on Error-like values is legitimate.
  if (/instanceof\s+Error/.test(line)) return null;
  if (/typeof\s+\w+\s*===\s*['"]object['"]/.test(line)) return null;

  // `for (... in ...)` iteration is a distinct language construct, not a
  // property-existence membership check. The EP-01 trust-boundary concern
  // (matching inherited Object.prototype properties) applies to `'k' in obj`
  // checks, not to `for...in` enumeration. Exclude the entire for-in header.
  // Matches `for (` / `for(` / `for(const` etc.
  if (/\bfor\s*\(/.test(line)) return null;

  // Match `KEY in operand` where KEY is a quoted or bare identifier.
  // Captures the operand (right side), supporting dotted member access.
  const re = /['"]?[\w$]+['"]?\s+in\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    const operand = match[1];
    if (isUntrustedOperand(operand, ctx.untrustedVars)) {
      return { ruleId: 'ERR-013' };
    }
  }
  return null;
}

/**
 * ERR-005: `as Foo[]` array-element cast on untrusted data without per-element
 * validation.
 *
 * Whitelist:
 *   - `as unknown[]` — preserves unknown-ness (sanctioned prefix before .filter)
 *   - operand is `]` (literal array `[] as Foo[]`) or Object.values/Object.keys
 *     on a typed local
 *
 * @param {string} line
 * @param {TrustContext} ctx
 * @returns {Violation | null}
 */
function detectErr005(line, ctx) {
  // Match `as <ElementType>[]` (also handles `as <Type>[]` with generics).
  // Capture group 1 = element type word before `[]`.
  const re = /\bas\s+([A-Za-z_$][\w$]*)\s*\[\]/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    const elementType = match[1];
    if (SAFE_ARRAY_ELEMENT_TYPES.has(elementType)) continue; // `as unknown[]` safe

    // Whitelist: literal array initializer `] as Foo[]` or Object.values/keys.
    const beforeAsIdx = match.index;
    const prefix = line.slice(0, beforeAsIdx).replace(/\s+$/, '');
    if (prefix.endsWith(']')) continue; // `[...] as Foo[]` — local literal
    if (/\b(?:Object\.values|Object\.keys)\s*\([^)]*\)\s*$/.test(prefix)) continue;

    // Inline untrusted call ending in `) as Foo[]` — unconditional violation.
    if (/\)\s*$/.test(prefix)) {
      if (/\b(?:JSON\.parse|fetch|exec|execSync|readFile|readFileSync)\s*\(/.test(prefix)) {
        return { ruleId: 'ERR-005' };
      }
      if (/\.(?:all|get|query|raw)\s*\(/.test(prefix)) {
        return { ruleId: 'ERR-005' };
      }
    }

    // Identifier operand — flag only if untrusted.
    const operandMatch = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/.exec(prefix);
    if (operandMatch) {
      if (isUntrustedOperand(operandMatch[1], ctx.untrustedVars)) {
        return { ruleId: 'ERR-005' };
      }
    }
    // Could not resolve operand origin — do not flag (precision over recall).
  }
  return null;
}

/**
 * ERR-001: `as` type-assertion on untrusted data bypasses runtime validation.
 *
 * Unconditional (always flag — these are high-signal bypasses):
 *   - `as unknown as X` — double cast defeats even loose type checks
 *
 * Conditional (flag only when operand originates from untrusted source):
 *   - `as string`, `as Record<...>`, `as <PascalCase>` on an untrusted operand
 *     or an inline untrusted call (`JSON.parse(x) as Foo`)
 *
 * Whitelist (never flag):
 *   - `as const`, `as unknown`, `as unknown[]`
 *   - `as NodeJS.ErrnoException`, `as Buffer` — platform/Error type narrowing
 *
 * @param {string} line
 * @param {TrustContext} ctx
 * @returns {Violation | null}
 */
function detectErr001(line, ctx) {
  // Unconditional: double cast `as unknown as X` — always a bypass.
  if (/\bas\s+unknown\s+as\s+[A-Za-z_$]/.test(line)) {
    return { ruleId: 'ERR-001' };
  }

  // Scan every `as <Type>` occurrence on the line.
  const re = /\bas\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    const typeWord = match[1];

    // Skip the `as unknown as` double-cast (already handled above) — when we
    // encounter the first `as unknown`, it may be the prefix of `as unknown as`.
    if (typeWord === 'unknown') {
      const after = line.slice(match.index + match[0].length);
      if (/^\s+as\s+/.test(after)) continue; // part of double cast, already flagged
      continue; // bare `as unknown` is widening — safe
    }

    if (SAFE_AS_TYPES.has(typeWord)) continue; // const / Buffer / NodeJS / unknown[]

    // From here, `typeWord` is a concrete asserted type. Decide if the operand
    // is untrusted.
    const beforeAsIdx = match.index;
    const prefix = line.slice(0, beforeAsIdx).replace(/\s+$/, '');

    // Inline untrusted call `JSON.parse(...) as Foo` / `db.all(...) as Foo`.
    if (/\)\s*$/.test(prefix)) {
      if (/\b(?:JSON\.parse|fetch|exec|execSync|readFile|readFileSync)\s*\(/.test(prefix)) {
        return { ruleId: 'ERR-001' };
      }
      if (/\.(?:all|get|query|raw)\s*\(/.test(prefix)) {
        return { ruleId: 'ERR-001' };
      }
    }

    // Identifier operand.
    const operandMatch = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/.exec(prefix);
    if (operandMatch) {
      if (isUntrustedOperand(operandMatch[1], ctx.untrustedVars)) {
        return { ruleId: 'ERR-001' };
      }
    }
    // Could not establish untrusted origin — do not flag.
  }
  return null;
}

/**
 * Check a single source line for Runtime Contract violations.
 *
 * Pure function: same (line, ctx) always yields the same result. No I/O.
 *
 * Evaluation order is ERR-013 → ERR-005 → ERR-001: an `in` violation is
 * reported before a cast violation on the same line. At most one violation is
 * returned per call; the caller re-scans after the developer fixes it.
 *
 * @param {string} line - one source line (the `+` prefix already stripped)
 * @param {TrustContext} [ctx] - defaults to empty (no known untrusted vars)
 * @returns {Violation | null}
 */
export function checkLine(line, ctx) {
  if (typeof line !== 'string') return null;
  const context = ctx && ctx.untrustedVars instanceof Set ? ctx : { untrustedVars: new Set() };

  // Strip comments and blank out string/regex literal CONTENTS so detector
  // regexes do not match tokens that appear inside a string or regex (e.g.
  // `'parsed as string'` must not trigger ERR-001 on the `as string`).
  // The exemption comment, if any, is preserved verbatim by the caller's
  // parseExemption() — it reads the original line, not codePart.
  const codePart = stripNoise(line);

  return (
    detectErr013(codePart, context) ||
    detectErr005(codePart, context) ||
    detectErr001(codePart, context)
  );
}

/**
 * Strip code-irrelevant portions of a line so detectors do not match tokens
 * inside comments, strings, or regex literals.
 *
 * - Single-line `// ...` comments: dropped entirely (returns the prefix).
 * - Block comments `/* ... *​/`: contents dropped.
 * - String literals (`'...'`, `"..."`, `` `...` ``): the literal is kept as a
 *   quoted placeholder (`''`, `""`, ` `` `) so the detector cannot match an
 *   `as`/`in` token that appears inside the string text.
 * - Regex literals `/.../flags`: replaced with `/ /`.
 *
 * The line-comment case returns a prefix (so a trailing exemption after `//`
 * is dropped from `codePart`); the exemption is consumed by the caller via
 * `parseExemption(originalLine)`, which reads the unstripped line, so this
 * is safe.
 *
 * @param {string} line
 * @returns {string}
 */
function stripNoise(line) {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inRegex = false;
  let inBlockComment = false;

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inRegex) {
      if (ch === '\\' && next !== undefined) {
        i += 2;
        continue;
      }
      if (ch === '[') {
        i += 1;
        while (i < line.length && line[i] !== ']') i += 1;
        if (i < line.length) i += 1;
        continue;
      }
      if (ch === '/') {
        inRegex = false;
        i += 1;
        while (i < line.length && /[A-Za-z]/.test(line[i])) i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle || inDouble || inTemplate) {
      // Unreachable: the quote-entry branches above consume the entire literal
      // and reset the flag before the loop continues. Kept defensively in case
      // a future edit re-introduces mid-string state.
      const close = inSingle ? "'" : inDouble ? '"' : '`';
      if (ch === '\\' && next !== undefined) {
        i += 2;
        continue;
      }
      if (ch === close) {
        out += ch;
        if (inSingle) inSingle = false;
        else if (inDouble) inDouble = false;
        else inTemplate = false;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      break; // line comment
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && isRegexStart(out)) {
      inRegex = true;
      out += '/';
      i += 1;
      continue;
    }
    if (ch === "'") {
      // Replace the string content with a single placeholder char so that
      // (a) an `as`/`in` token inside the string cannot trigger a false match,
      // but (b) a quoted property key like `'type' in obj` still has a
      // non-empty quoted token the ERR-013 regex can match.
      inSingle = true;
      out += "'_";
      i += 1;
      while (i < line.length && line[i] !== "'") {
        if (line[i] === '\\' && line[i + 1] !== undefined) {
          i += 2;
          continue;
        }
        i += 1;
      }
      if (i < line.length) {
        out += "'";
        i += 1;
      }
      inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += '"_';
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && line[i + 1] !== undefined) {
          i += 2;
          continue;
        }
        i += 1;
      }
      if (i < line.length) {
        out += '"';
        i += 1;
      }
      inDouble = false;
      continue;
    }
    if (ch === '`') {
      // Template literals: replace content with `_`. Note: ${...} interpolation
      // is not specially handled — a violation inside `${...}` would be masked.
      // This is acceptable: violations inside template interpolation are rare
      // and the detector runs on the original line via parseExemption anyway.
      inTemplate = true;
      out += '`_';
      i += 1;
      while (i < line.length && line[i] !== '`') {
        if (line[i] === '\\' && line[i + 1] !== undefined) {
          i += 2;
          continue;
        }
        i += 1;
      }
      if (i < line.length) {
        out += '`';
        i += 1;
      }
      inTemplate = false;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Decide whether a `/` at the current position starts a regex literal (vs a
 * division operator). Heuristic (good enough for the scanner's single-line
 * detectors): a `/` is a regex if the preceding non-whitespace code char is one
 * of the tokens that cannot end an expression — `(`, `,`, `=`, `:`, `[`, `!`,
 `&`, `|`, `?`, `{`, `;`, `+`, `-`, `*`, `%`, `<`, `>`, `~`, `^`, or the start
 * of the line. Otherwise it is division.
 *
 * This is a conservative heuristic; it can misclassify rare ambiguous cases but
 * will not cause false *negatives* on the violation detectors because a
 * misclassified regex literal just means the `/.../ ` content is treated as code
 * — and `/.../ ` content rarely contains `as <Type>` or `in <operand>` patterns
 * that would falsely trigger.
 *
 * @param {string} precedingCode
 * @returns {boolean}
 */
function isRegexStart(precedingCode) {
  for (let j = precedingCode.length - 1; j >= 0; j -= 1) {
    const c = precedingCode[j];
    if (c === ' ' || c === '\t') continue;
    return '(,=:[!&|?{;+-*%<>~^'.includes(c);
  }
  return true; // start of line
}


/**
 * The canonical rule list, exported for introspection / future extension.
 * Each rule documents the ERR entry it maps to and the failure mode.
 */
export const RULES = [
  {
    id: 'ERR-001',
    title: '`as` cast on untrusted data bypasses runtime validation',
    autofix: 'Use typeof / Array.isArray / type guards instead of `as`',
  },
  {
    id: 'ERR-005',
    title: 'array-element `as Foo[]` cast without per-element validation',
    autofix: 'Cast to `unknown[]` then `.filter((x): x is T => ...)`',
  },
  {
    id: 'ERR-013',
    title: '`in` operator on untrusted object matches inherited properties',
    autofix: 'Use `Object.hasOwn(obj, "key")`',
  },
];
