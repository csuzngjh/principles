// fingerprint.ts
// Deterministic fingerprint for feedback deduplication / clustering.
// Pure logic only — no I/O, no fs, no db, no network. Uses node:crypto's
// pure hash computation (no external side effects), so it is safe in core.
//
// EP-01 / EP-09: the fingerprint is a content hash computed over fields that
// were already validated at the input boundary. Inputs are strings; we
// normalize them deterministically before hashing.

import { createHash } from 'node:crypto';

/** Fallback bucket for reports with no area. */
export const FEEDBACK_FINGERPRINT_DEFAULT_AREA = 'general';

/** Max length of the normalized title used for hashing (bounds input). */
export const FEEDBACK_FINGERPRINT_TITLE_LIMIT = 80;

/**
 * Normalize a title for fingerprinting:
 * - lowercase
 * - remove punctuation (non-alphanumeric/non-CJK replaced by nothing)
 * - collapse whitespace runs to a single space
 * - trim, then truncate to FEEDBACK_FINGERPRINT_TITLE_LIMIT chars
 *
 * Kept CJK-safe: CJK ideographs are matched by /[^\w\u4e00-\u9fff]/g below.
 * '/\w/' in JS covers Latin letters/digits/underscore; we explicitly keep
 * the CJK range so Chinese titles are not gutted.
 */
export function normalizeFeedbackTitle(value: string): string {
  const lower = value.toLowerCase();
  // Keep word chars, digits, underscore, CJK ideographs; drop the rest
  // (spaces collapse via the whitespace pass, punctuation is removed here).
  const noPunct = lower.replace(/[^\w\u4e00-\u9fff]/g, ' ');
  const collapsed = noPunct.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, FEEDBACK_FINGERPRINT_TITLE_LIMIT);
}

/**
 * Compute the sha256 hex fingerprint for a feedback report.
 *
 *   fingerprint = sha256hex(`${type}|${area ?? general}|${normalizedTitle}`)
 *
 * Derived from a SHA-256 hash of normalized, content-derived values — a
 * Unicode NFC normalization could alter the hash for visually identical
 * strings, but for dedup purposes minor form differences are acceptable.
 */
export function computeFeedbackFingerprint(args: {
  type: string;
  title: string;
  area?: string;
}): string {
  const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
  const areaRaw = typeof args.area === 'string' && args.area.length > 0
    ? args.area
    : FEEDBACK_FINGERPRINT_DEFAULT_AREA;
  const normalizedTitle = normalizeFeedbackTitle(args.title);

  const payload = `${type}|${areaRaw}|${normalizedTitle}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}