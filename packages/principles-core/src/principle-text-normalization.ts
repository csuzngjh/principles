/**
 * Phase 7.2 B1 — normalization for the ledger's exact-duplicate guard.
 *
 * Package-internal (not on any public subpath export map): its only
 * production consumer is principle-tree-ledger.ts's in-lock duplicate scan,
 * and tests import it relatively. Keeping it out of the public surface is the
 * point — the export-surface admission gate would otherwise demand a public
 * consumer that does not exist.
 */

/**
 * Normalize a principle text for EXACT-duplicate comparison
 * (LEDGER_WRITE_SAFETY_SPEC §3.2, 7.1 revision).
 *
 * The algorithm is deliberately CONSERVATIVE — it only folds differences that
 * cannot change a principle's meaning at the byte level:
 *
 *   1. NFKC equivalence folding (fullwidth ↔ halfwidth and other Unicode
 *      compatibility equivalents);
 *   2. ALL punctuation is PRESERVED verbatim — no "punctuation → whitespace"
 *      folding. Distinct punctuation ('，' vs '。', '&&' vs '||') stays
 *      distinct; NFKC maps fullwidth punctuation onto its ASCII equivalent,
 *      which is exactly the intended equivalence class;
 *   3. runs of whitespace collapse to a single space and the result is
 *      trimmed — whitespace-level duplicates ARE duplicates;
 *   4. NO case folding — `useMockHandler` and `usemockhandler` are different
 *      code identifiers and must stay distinct (negative control N6).
 *
 * This is exact-match protection only. It is NOT semantic deduplication:
 * near-duplicates remain the reuse gate's responsibility.
 */
export function normalizePrincipleText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
