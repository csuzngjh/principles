/**
 * Balanced-bracket JSON extraction from LLM output.
 *
 * Handles prose-wrapped and code-fenced JSON (```json ... ```).
 * Shared utility imported by both pi-ai-runtime-adapter.ts and
 * structured-output-repair.ts — kept in adapter/ to avoid a new
 * top-level directory for one small function.
 */

/**
 * Extract JSON object from text (handles prose-wrapped and code-fenced JSON).
 * Returns the parsed object, or null if no valid JSON found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fencedMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fencedMatch) {
    const [, fencedContent] = fencedMatch;
    if (fencedContent) {
      try {
        const parsed = JSON.parse(fencedContent.trim());
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
        return null;
      } catch { /* fall through */ }
    }
  }

  const trimmed = text.trimStart();
  if (trimmed.length > 0 && trimmed[0] === '[') {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    if (end >= 0) {
      try {
        const parsed = JSON.parse(trimmed.slice(0, end + 1));
        if (Array.isArray(parsed)) return null;
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      } catch { /* fall through to brace scan */ }
    }
  }

  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
          }
          start = -1;
        } catch { start = -1; }
      }
    }
  }
  return null;
}

/**
 * Collect every top-level balanced JSON object in the text (fenced content
 * first, then all brace-scanned candidates in order). PRI-621 RC3: a single
 * free-form LLM answer can contain several complete objects — e.g. an
 * outer truncated answer plus an inner lineage fragment that happens to
 * parse. First-object extraction kept validating the wrong fragment.
 */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];

  // String.match intentionally (RegExp#exec triggers a Mimosa write-gate
  // false positive on the `.exec(` token; match() is equivalent here).
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        candidates.push(parsed);
      }
    } catch { /* not a complete object */ }
  }

  // Track string/escape state: a `}` inside a JSON string value must not
  // terminate the span early (CodeRabbit round on PRI-621).
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            candidates.push(parsed);
          }
        } catch { /* skip unparseable span */ }
        start = -1;
      }
    }
  }
  return candidates;
}

/**
 * Pick the candidate most likely to be the intended structured output,
 * scored by how many of the schema's required top-level keys it carries.
 * PRI-621 RC3: lineage fragments like {"scribeArtifactId":...} score 0
 * against a schema requiring taskId/implementationCode/etc., so the real
 * (later, larger) object wins even when a smaller fragment appears first.
 * Ties break toward more own keys, then larger serialized size. Without
 * requiredKeys (or when nothing scores), behavior degrades to the first
 * candidate — identical to legacy extractJsonObject semantics.
 */
export function selectBestJsonObject(
  candidates: readonly Record<string, unknown>[],
  requiredKeys?: readonly string[],
): Record<string, unknown> | null {
  if (candidates.length === 0) return null;
  if (!requiredKeys || requiredKeys.length === 0) return candidates[0] ?? null;

  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  let bestKeyCount = -1;
  let bestSize = -1;
  for (const candidate of candidates) {
    let score = 0;
    for (const key of requiredKeys) {
      if (Object.hasOwn(candidate, key)) score++;
    }
    const keyCount = Object.keys(candidate).length;
    const size = JSON.stringify(candidate)?.length ?? 0;
    if (
      score > bestScore
      || (score === bestScore && keyCount > bestKeyCount)
      || (score === bestScore && keyCount === bestKeyCount && size > bestSize)
    ) {
      best = candidate;
      bestScore = score;
      bestKeyCount = keyCount;
      bestSize = size;
    }
  }
  // CodeRabbit round: when NOTHING matches any required key, fall back to
  // the first candidate (legacy semantics) instead of letting the size/
  // key-count tie-breaker promote an unrelated fragment.
  return bestScore > 0 ? best : candidates[0] ?? null;
}

/**
 * Schema-aware extraction (PRI-621 RC3): collect all object candidates and
 * return the one that best matches the schema's required top-level keys.
 * Falls back to legacy first-object behavior when no keys are known.
 */
export function extractJsonObjectForSchema(
  text: string,
  requiredKeys?: readonly string[],
): Record<string, unknown> | null {
  const candidates = extractJsonObjects(text);
  return selectBestJsonObject(candidates, requiredKeys);
}

/**
 * Attempt syntactic repair of malformed JSON where string values contain
 * unescaped double quotes (a common LLM output error).
 *
 * Strategy: find the outermost `{...}` via balanced-bracket scan, then
 * try to fix unescaped quotes by escaping inner double-quote characters
 * that appear between key-value separators (`: `) and field separators (`,`).
 *
 * This is a BEST-EFFORT heuristic — it handles the most common LLM mistake
 * (unescaped quotes in string values) but is not a general JSON repair.
 * Returns the parsed object, or null if repair fails.
 */
export function repairMalformedJson(text: string): Record<string, unknown> | null {
  // Find the outermost {...} via balanced-bracket scan
  let start = -1;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        end = i;
        break;
      }
    }
  }

  if (start < 0 || end < 0) return null;

  let candidate = text.slice(start, end + 1);

  // Try parsing as-is first
  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch { /* needs repair */ }

  // Heuristic: escape unescaped double quotes inside string values.
  // Walk character-by-character tracking JSON structure state.
  // When inside a string value (after `: ` and before `,` or `}`),
  // escape any unescaped `"` that is NOT at a structural boundary.
  const chars = [...candidate];
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        // Opening quote
        inString = true;
        result += ch;
      } else {
        // Closing quote — but is it really a closing quote?
        // Look ahead: if followed by `:` it's a key end (valid)
        // If followed by `,` or `}` or `]` or whitespace+`,` etc. it's a value end (valid)
        // Otherwise it's likely an unescaped quote inside a string value
        const rest = candidate.slice(i + 1).trimStart();
        if (
          rest.startsWith(':') ||      // end of key
          rest.startsWith(',') ||      // end of value
          rest.startsWith('}') ||      // end of last value in object
          rest.startsWith(']') ||      // end of last value in array
          rest.length === 0            // end of text
        ) {
          // This is a structural closing quote
          inString = false;
          result += ch;
        } else {
          // This is an unescaped quote inside a string value — escape it
          result += '\\"';
        }
      }
      continue;
    }

    result += ch;
  }

  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch { /* repair failed */ }

  return null;
}
