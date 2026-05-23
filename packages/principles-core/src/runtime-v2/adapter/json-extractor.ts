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
