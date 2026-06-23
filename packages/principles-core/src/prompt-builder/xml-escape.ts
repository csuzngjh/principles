/**
 * Escape special XML characters in a string.
 *
 * Pure logic — no I/O, no side effects.
 *
 * Used by prompt injection to safely embed user/principle text into XML-style
 * prompt markers (e.g. `<directive id="...">...</directive>`). Also accepted
 * as a callback by `trimToBudget` and `renderPrinciplesToDirectives` in
 * `runtime-v2/activation/prompt-activation-reader-contract.ts`.
 */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
