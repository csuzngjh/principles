// SPEC-PD-EXAMINER-001 v0.3 — Phase 1A freeze/hash primitives for challenge studies.
//
// Canonicalization and sha256 are REUSED from fixture.mjs (single source of
// truth for the lab's hash basis). The same algorithm produced the Phase 0
// verified source hashes (principleContentHash 8ac06edd…, statementSha256
// ae275f0f…, painEventRowSha256 679f23d6…, diagnosisRowsSha256 f396fb6a…),
// so frozen assets hash-compatibly with the Phase 0 audit evidence.
//
// Hash rule (recorded in every study's hashes.json):
//   sha256( canonicalJson(value) ) where canonicalJson sorts object keys,
//   emits no whitespace, keeps array order, and encodes UTF-8.

import { canonicalJson, sha256 } from './fixture.mjs';

export { canonicalJson, sha256 };

export const HASH_ALGORITHM = 'sha256';
export const CANONICALIZATION_RULE =
  'fixture.mjs canonicalJson: UTF-8, object keys sorted lexicographically, no whitespace, arrays keep order; sha256 over the canonical string encoded utf8';

export function hashOfCanonical(value) {
  return sha256(canonicalJson(value));
}

/**
 * Freeze a PainMechanismMappingV1 object: mappingHash is computed over the
 * mapping with the mappingHash field REMOVED (a hash cannot contain itself).
 * The same rule must be used by every verifier — it is recorded in hashes.json.
 */
export function freezeMapping(mapping) {
  const { mappingHash: _omitted, ...rest } = mapping;
  return { mappingHash: hashOfCanonical(rest) };
}

/**
 * Recompute and compare a recorded hash for a JSON asset.
 * `stripFields` names self-referential hash fields to remove before hashing.
 */
export function verifyCanonicalHash(value, recordedHash, { stripFields = [] } = {}) {
  const clone = { ...value };
  for (const f of stripFields) delete clone[f];
  const recomputed = hashOfCanonical(clone);
  return { ok: recomputed === recordedHash, recomputed, recordedHash };
}
