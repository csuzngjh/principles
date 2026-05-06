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
export function extractJsonObject(text: string): unknown | null {
  // Try code-fenced JSON first: ```json ... ``` or ``` ... ```
  const fencedMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fencedMatch) {
    const [, fencedContent] = fencedMatch;
    if (fencedContent) {
      try { return JSON.parse(fencedContent.trim()); } catch { /* fall through */ }
    }
  }

  // Balanced-bracket scan for first top-level {...}
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
        try { return JSON.parse(text.slice(start, i + 1)); } catch { start = -1; }
      }
    }
  }
  return null;
}
