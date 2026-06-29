/**
 * Intent content hashing — isolated from intent-doc.ts because it depends on
 * node:crypto, which is not available in the browser bundle. Pure parsing /
 * assembly logic in intent-doc.ts can be safely bundled for the browser.
 */
import { createHash } from 'node:crypto';

export function computeIntentContentHash(raw: string): string {
  return `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}
