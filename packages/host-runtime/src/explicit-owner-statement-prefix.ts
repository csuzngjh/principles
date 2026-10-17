/** The exact prefix (fullwidth colon) defined by SPEC §6.4. */
export const OWNER_STATEMENT_PREFIX = 'PD记录痛苦：';
/** SPEC §6.1: reject instead of truncating the Owner's intent. */
export const MAX_OWNER_STATEMENT_CHARS = 500;

export type OwnerStatementPrefixParse =
  | { matched: false }
  | { matched: true; text: string | null; reason?: 'statement_empty' | 'statement_too_long' };

/**
 * Deterministic prefix parse of the CURRENT user prompt. `text === null` means
 * the prefix matched but the remainder was empty/blank — an explicit request
 * with no content is a bounded rejection, never a fabricated statement.
 */
export function parseOwnerStatementPrefix(prompt: unknown): OwnerStatementPrefixParse {
  if (typeof prompt !== 'string') return { matched: false };
  if (!prompt.startsWith(OWNER_STATEMENT_PREFIX)) return { matched: false };
  const remainder = prompt.slice(OWNER_STATEMENT_PREFIX.length).trim();
  if (remainder.length === 0) return { matched: true, text: null, reason: 'statement_empty' };
  if (remainder.length > MAX_OWNER_STATEMENT_CHARS) return { matched: true, text: null, reason: 'statement_too_long' };
  return { matched: true, text: remainder };
}

