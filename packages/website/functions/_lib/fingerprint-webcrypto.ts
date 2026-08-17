// fingerprint-webcrypto.ts
// Relay-side fingerprint implementation (WebCrypto, Workers-compatible).
//
// Slice 4 of the feedback last-mile design (spec §5.3): the relay lives in a
// Cloudflare Pages Function, so it CANNOT import core's node:crypto-based
// fingerprint (that would pull node:crypto into the Workers bundle). Instead we
// re-implement SHAPE-and-HASH-IDENTICAL normalization using WebCrypto
// `crypto.subtle.digest('SHA-256', ...)`.
//
// Cross-consistency contract: node:crypto (core) and WebCrypto (relay) MUST
// produce the exact same sha256 hex for the same (type, area, title). The relay
// test verifies this against core's `computeFeedbackFingerprint` using the same
// vectors core ships in fingerprint.test.ts (EP-09: shared fixture, no drift).
//
// ERR mapping:
// - EP-01 / ERR-001: inputs are plain strings, normalized deterministically.
// - ERR-014: output is bounded (sha256 → 64 hex chars).

/**
 * Mirrors core's FEEDBACK_FINGERPRINT_DEFAULT_AREA. MUST stay in sync with
 * `packages/principles-core/src/runtime-v2/feedback/fingerprint.ts`.
 */
export const FEEDBACK_FINGERPRINT_DEFAULT_AREA = 'general';

/**
 * Mirrors core's FEEDBACK_FINGERPRINT_TITLE_LIMIT. MUST stay in sync with
 * `packages/principles-core/src/runtime-v2/feedback/fingerprint.ts`.
 */
export const FEEDBACK_FINGERPRINT_TITLE_LIMIT = 80;

/**
 * Normalize a title for fingerprinting. Kept byte-for-byte identical to
 * core's `normalizeFeedbackTitle`: lowercase → strip punctuation (keep
 * word chars / digits / underscore / CJK) → collapse whitespace → trim →
 * truncate to FEEDBACK_FINGERPRINT_TITLE_LIMIT.
 */
export function normalizeFeedbackTitle(value: string): string {
  const lower = value.toLowerCase();
  const noPunct = lower.replace(/[^\w\u4e00-\u9fff]/g, ' ');
  const collapsed = noPunct.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, FEEDBACK_FINGERPRINT_TITLE_LIMIT);
}

/**
 * Compute the sha256 hex fingerprint for a feedback report using WebCrypto.
 *
 *   fingerprint = sha256hex(`${type}|${area ?? general}|${normalizedTitle}`)
 *
 * Async because `crypto.subtle.digest` is promise-based in Workers/Node 20+.
 */
export async function computeFeedbackFingerprintWebCrypto(args: {
  type: string;
  title: string;
  area?: string;
}): Promise<string> {
  const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
  const areaRaw =
    typeof args.area === 'string' && args.area.length > 0
      ? args.area
      : FEEDBACK_FINGERPRINT_DEFAULT_AREA;
  const normalizedTitle = normalizeFeedbackTitle(args.title);

  const payload = `${type}|${areaRaw}|${normalizedTitle}`;
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/** Convert a byte array to a lowercase hex string (`Array.prototype.map` on Uint8Array is typed loosely). */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}