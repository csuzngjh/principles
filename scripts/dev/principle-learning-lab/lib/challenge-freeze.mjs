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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey, verify as verifySignature } from 'node:crypto';

export { canonicalJson, sha256 };

export const HASH_ALGORITHM = 'sha256';
export const CANONICALIZATION_RULE =
  'fixture.mjs canonicalJson: UTF-8, object keys sorted lexicographically, no whitespace, arrays keep order; sha256 over the canonical string encoded utf8';

export function hashOfCanonical(value) {
  return sha256(canonicalJson(value));
}

/** Pin the complete local execution implementation, including transitive lab
 * modules and Node version, rather than only the scoring contract JSON. */
export function challengeImplementationManifest() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22 || nodeMajor > 26) throw new Error('UNVERIFIED_NODE_RUNTIME');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort()
    .map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(dir, name))) }));
  return { node: 'node-22-to-26-offline-js-v1', files };
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

// v0.5 admission consumes an explicit OFFLINE source package. Historical
// freezeMapping remains a hash primitive; it never pretends to verify sources.
export function verifyExaminerSourceBundle({ bundle, mappingId, mappingHash, inputManifestHash, mode, reviewTrust = null }) {
  const problems = [];
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!object(bundle) || !object(bundle.mapping) || !Array.isArray(bundle.sourceArtifacts)) {
    return { ok: false, status: 'NO_GO', reasonCode: 'SOURCE_PACKAGE_MISSING', problems: ['mapping and offline sourceArtifacts are required'], nextAction: 'Supply the independently reviewed offline source package.' };
  }
  const mapping = bundle.mapping;
  if (mapping.schema !== 'PainMechanismMappingV1') problems.push('unknown mapping schema');
  if (mapping.mappingId !== mappingId || mapping.mappingHash !== mappingHash || freezeMapping(mapping).mappingHash !== mappingHash) problems.push('mapping identity/hash mismatch');
  const artifacts = new Map();
  for (const a of bundle.sourceArtifacts) {
    if (!object(a) || !text(a.ref) || !Object.hasOwn(a, 'content') || typeof a.contentHash !== 'string' || hashOfCanonical(a.content) !== a.contentHash || artifacts.has(a.ref)) {
      problems.push('malformed, duplicate or hash-mismatched source artifact');
      continue;
    }
    artifacts.set(a.ref, a);
  }
  const fields = ['observedFailure', 'failureMechanism', 'ownerGroundedGoal', 'sourceScribeArtifactId', 'principleContentHash'];
  for (const f of fields) if (!text(mapping[f])) problems.push(`mapping.${f} required`);
  for (const f of ['applicabilityConditions', 'exceptionConditions', 'observableActions', 'objectiveConsequences', 'scoringPredicates', 'legalAlternativePaths']) {
    if (!Array.isArray(mapping[f]) || mapping[f].length === 0 || !mapping[f].every(text)) problems.push(`mapping.${f} must contain non-empty strings`);
  }
  if (!Array.isArray(mapping.sourcePainRefs) || mapping.sourcePainRefs.length === 0) problems.push('mapping.sourcePainRefs required');
  for (const ref of Array.isArray(mapping.sourcePainRefs) ? mapping.sourcePainRefs : []) {
    const artifact = object(ref) && artifacts.get(ref.id);
    if (!artifact || artifact.contentHash !== ref.evidenceHash) problems.push('Pain source missing or evidence hash mismatch');
  }
  if (!Array.isArray(mapping.trustedGoldSourceRefs) || mapping.trustedGoldSourceRefs.length === 0) problems.push('mapping.trustedGoldSourceRefs required');
  for (const ref of Array.isArray(mapping.trustedGoldSourceRefs) ? mapping.trustedGoldSourceRefs : []) {
    const artifact = object(ref) && artifacts.get(ref.ref);
    if (!artifact || artifact.contentHash !== ref.hash) problems.push('mapping trusted Gold source missing/hash mismatch');
  }
  const scribe = artifacts.get(mapping.sourceScribeArtifactId);
  const principle = artifacts.get('principle');
  const manifest = artifacts.get('input-manifest');
  if (!manifest || manifest.contentHash !== inputManifestHash) problems.push('input manifest missing/hash mismatch');
  if (!scribe || !object(scribe.content) || scribe.content.artifactId !== mapping.sourceScribeArtifactId || scribe.content.principleContentHash !== mapping.principleContentHash) problems.push('Scribe artifact identity/principle lineage mismatch');
  if (!principle || principle.contentHash !== mapping.principleContentHash) problems.push('Principle source missing/hash mismatch');
  if (scribe && object(scribe.content) && (!Array.isArray(scribe.content.sourcePainRefs) || !Array.isArray(mapping.sourcePainRefs) || !mapping.sourcePainRefs.every((p) => object(p) && scribe.content.sourcePainRefs.includes(p.id)))) problems.push('Scribe/Pain lineage mismatch');
  const review = verifyExaminerReview({ review: bundle.mappingReview, schema: 'examiner-mapping-review.v1', mode, reviewTrust });
  problems.push(...review.problems);
  if (bundle.mappingReview?.mappingHash !== mappingHash) problems.push('mapping review is not bound to current mappingHash');
  return { ok: problems.length === 0, status: problems.length ? 'NO_GO' : mode === 'calibration' ? 'CALIBRATION_ONLY' : 'SOURCE_VERIFIED', reasonCode: problems.length ? 'SOURCE_OR_REVIEW_INVALID' : null, problems, nextAction: problems.length ? 'Provide matching offline evidence and an independent review of the current mapping.' : null, eligibleForFormalSet: problems.length === 0 && mode === 'formal' };
}

export function verifyExaminerReview({ review, schema, mode, reviewTrust = null }) {
  const problems = [];
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return { ok: false, problems: ['review receipt missing'] };
  if (!['formal', 'calibration'].includes(mode)) problems.push('unknown review mode');
  // There is no trusted human-review authority installed by this offline
  // sprint. A role string supplied alongside model/fixture data is not one.
  if (mode === 'formal') problems.push(...verifyHumanReviewSignature({ review, schema, reviewTrust }).problems);
  if (review.schema !== schema || review.decision !== 'APPROVED') problems.push('review receipt schema/decision invalid or GOLD_REVIEW_PENDING');
  if (!text(review.reviewerId) || !text(review.reason) || !text(review.reviewedAt) || !Number.isFinite(Date.parse(review.reviewedAt))) problems.push('reviewer, reason and timestamp required');
  if (!['INDEPENDENT_REVIEWER', 'FIXTURE'].includes(review.reviewerRole) || (mode === 'formal' && review.reviewerRole !== 'INDEPENDENT_REVIEWER')) problems.push('independent reviewer required; fixture receipt is calibration only');
  return { ok: problems.length === 0, problems };
}

/** Trust is supplied by the offline operator, never by a candidate/receipt.
 * The Owner pin is intentionally separate from the untrusted authority file. */
export function verifyHumanReviewSignature({ review, schema, reviewTrust }) {
  const fail = (reason) => ({ ok: false, problems: [`GOLD_REVIEW_PENDING: ${reason}`] });
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const iso = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!object(reviewTrust) || !object(reviewTrust.authority) || !/^[a-f0-9]{64}$/.test(reviewTrust.trustedAuthorityHash || '')) return fail('independent human-review authority is not established');
  const authority = reviewTrust.authority;
  if (hashOfCanonical(authority) !== reviewTrust.trustedAuthorityHash) return fail('Owner authority pin mismatch');
  if (authority.schema !== 'examiner-review-authority.v1' || typeof authority.ownerDesignationRef !== 'string' || !authority.ownerDesignationRef.trim() || !Array.isArray(authority.reviewers) || !Array.isArray(authority.excludedAuthors) || !authority.excludedAuthors.every((value) => typeof value === 'string')) return fail('invalid Owner-designated authority');
  if (!object(review) || review.schema !== schema || review.scope !== 'OFFLINE_GOLD_ONLY' || review.subjectHash !== reviewTrust.subjectHash || !/^[a-f0-9]{64}$/.test(review.subjectHash || '')) return fail('review subject/schema/scope mismatch');
  if (!iso(reviewTrust.now) || !iso(review.reviewedAt) || Date.parse(review.reviewedAt) > Date.parse(reviewTrust.now)) return fail('invalid/future review time');
  const matches = authority.reviewers.filter((entry) => object(entry) && entry.id === review.reviewerId);
  if (matches.length !== 1) return fail('unknown/ambiguous reviewer identity');
  const signer = matches[0];
  if (signer.kind !== 'HUMAN' || signer.independent !== true || signer.revoked !== false || signer.canApproveGold !== true || authority.excludedAuthors.includes(signer.id) || typeof signer.identityEvidenceRef !== 'string' || !signer.identityEvidenceRef.trim()) return fail('reviewer permission or independence denied');
  if (!Array.isArray(signer.allowedSchemas) || !signer.allowedSchemas.every((value) => typeof value === 'string') || !signer.allowedSchemas.includes(schema) || !Array.isArray(signer.allowedSubjects) || !signer.allowedSubjects.every((value) => typeof value === 'string') || !signer.allowedSubjects.includes(review.subjectHash)) return fail('reviewer is not authorized for this schema/subject');
  if (!iso(signer.validFrom) || !iso(signer.validUntil) || Date.parse(signer.validFrom) > Date.parse(review.reviewedAt) || Date.parse(signer.validUntil) < Date.parse(reviewTrust.now)) return fail('reviewer grant not valid now');
  const keys = ['schema', 'reviewerId', 'reviewerRole', 'decision', 'reviewedAt', 'reason', 'mappingHash', 'caseId', 'goldHash', 'sourceRefs', 'subjectHash', 'scope', 'goldSourcesVerified', 'signature'];
  if (Object.keys(review).some((key) => !keys.includes(key)) || review.goldSourcesVerified !== true) return fail('unrecognized receipt fields or missing explicit source review');
  try {
    const key = createPublicKey(signer.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || typeof review.signature !== 'string') return fail('Ed25519 signature required');
    const bytes = Buffer.from(review.signature, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== review.signature) return fail('invalid signature encoding');
    const { signature: _signature, ...payload } = review;
    if (!verifySignature(null, Buffer.from(canonicalJson(payload)), key, bytes)) return fail('signature mismatch');
  } catch { return fail('invalid signature/key material'); }
  return { ok: true, problems: [] };
}

export function offlineReviewSubjectHash(dir) {
  const manifest = verifyOfflinePackage(dir);
  // Full input includes cases, source bundle, strategies and runner hash.
  // Real source files and implementation are bound too. Receipts/mechanical
  // outputs are excluded: their later addition must not create a hash cycle.
  const files = manifest.files.filter((entry) => entry.path === 'inputs.json' || entry.path === 'source-verification.json' || entry.path === 'source-audit.json' || entry.path.startsWith('real-source/'));
  if (!files.some((entry) => entry.path === 'inputs.json') || !files.some((entry) => entry.path === 'source-verification.json')) throw new Error('REVIEW_SUBJECT_INCOMPLETE');
  return hashOfCanonical({ schema: 'examiner-review-subject.v1', files, implementation: manifest.implementation });
}

// Content-addressed offline package. Review status is data to freeze, never
// something this integrity checker can promote or approve.
export function offlinePackageManifest(dir) {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === 'package-manifest.json') continue;
      if (entry.isSymbolicLink()) throw new Error('offline package symlink refused');
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push({ path: name, sha256: sha256(fs.readFileSync(path.join(dir, name))) });
      else throw new Error('unsupported offline package entry');
    }
  };
  walk('');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const core = { schema: 'examiner-offline-package.v1', studyId: 'EXM-MVP-001',
    status: 'OFFLINE_ONLY_NOT_AUTHORIZED', implementation: challengeImplementationManifest(), files };
  return { ...core, packageHash: hashOfCanonical(core) };
}

export function verifyOfflinePackage(dir) {
  const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'package-manifest.json'), 'utf8'));
  const actual = offlinePackageManifest(dir);
  if (hashOfCanonical(recorded) !== hashOfCanonical(actual)) throw new Error('OFFLINE_PACKAGE_DRIFT');
  return actual;
}
