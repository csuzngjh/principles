// PRI-966 — file-backed evidence verifier for the formal real-model study.
//
// `createAuthorizedPiTransport` (lib/actor.mjs) requires a TRUSTED
// evidenceVerifier before any transport exists. This module is that
// verifier for the formal study: it resolves Owner-decision and cost-basis
// references from FILES the Owner-side materials provide, and validates
// them against what the authorization record claims. It can NEVER mint an
// approval: `approved` must literally come from the referenced file, and a
// missing/mismatching file is a hard refusal (fail-closed, rc-3).
//
// Contract (both kinds):
//   kind 'owner-decision' — reference points at a JSON file carrying
//     {approved: true, fixtureHash, decidedBy, decidedAt, scope}. The
//     verifier re-checks approved === true and that fixtureHash equals the
//     dataset hash actually loaded (the caller passes it in expectedFixtureHash).
//   kind 'cost-basis' — reference points at a JSON file carrying
//     {provider, model, currency, inputUsdPerMillionTokens,
//      outputUsdPerMillionTokens, cacheReadUsdPerMillionTokens?,
//      effectiveDate, source}. Field equality with the authorization's
//     costBasis is checked by the authorization gate; this resolver only
//     authenticates the file's existence, shape and identity fields.

import fs from 'node:fs';
import path from 'node:path';

export function createFileEvidenceVerifier({ baseDir } = {}) {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('createFileEvidenceVerifier: baseDir is required');
  }
  return function verify({ kind, reference, expectedFixtureHash, expectedPreregistrationHash } = {}) {
    if (kind !== 'owner-decision' && kind !== 'cost-basis') {
      throw new Error(`evidenceVerifier: unsupported kind '${String(kind)}'`);
    }
    if (typeof reference !== 'string' || reference.trim().length === 0) {
      throw new Error(`evidenceVerifier(${kind}): reference is required`);
    }
    // References are RELATIVE paths into the authorization material
    // directory. Absolute paths and traversal outside baseDir are refused —
    // the resolver authenticates a bounded set of files, not the filesystem.
    if (path.isAbsolute(reference)) {
      throw new Error(`evidenceVerifier(${kind}): reference must be relative to the authorization material directory`);
    }
    const resolved = path.resolve(baseDir, reference);
    if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
      throw new Error(`evidenceVerifier(${kind}): reference '${reference}' escapes the authorization material directory`);
    }
    let raw;
    try {
      raw = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      throw new Error(`evidenceVerifier(${kind}): cannot read '${reference}': ${err?.message ?? err}`);
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new Error(`evidenceVerifier(${kind}): '${reference}' is not valid JSON: ${err?.message ?? err}`);
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`evidenceVerifier(${kind}): '${reference}' must contain a JSON object`);
    }
    if (kind === 'owner-decision') {
      if (doc.approved !== true) {
        throw new Error(`evidenceVerifier(owner-decision): '${reference}' does not carry approved: true`);
      }
      if (typeof doc.fixtureHash !== 'string' || doc.fixtureHash.length === 0) {
        throw new Error(`evidenceVerifier(owner-decision): '${reference}' must carry fixtureHash`);
      }
      if (expectedFixtureHash !== undefined && doc.fixtureHash !== expectedFixtureHash) {
        throw new Error(`evidenceVerifier(owner-decision): '${reference}' approves fixtureHash ${doc.fixtureHash.slice(0, 12)}… but the loaded dataset hashes to ${String(expectedFixtureHash).slice(0, 12)}… (drift = refusal)`);
      }
      if (expectedPreregistrationHash !== undefined) {
        if (typeof doc.preregistrationHash !== 'string' || doc.preregistrationHash.length === 0) {
          throw new Error(`evidenceVerifier(owner-decision): '${reference}' must carry preregistrationHash (the approved research protocol is hash-bound, not prose)`);
        }
        if (doc.preregistrationHash !== expectedPreregistrationHash) {
          throw new Error(`evidenceVerifier(owner-decision): '${reference}' approves preregistrationHash ${doc.preregistrationHash.slice(0, 12)}… but the loaded preregistration hashes to ${String(expectedPreregistrationHash).slice(0, 12)}… (research-protocol drift = refusal)`);
        }
      }
      if (typeof doc.decidedBy !== 'string' || doc.decidedBy.trim().length === 0) {
        throw new Error(`evidenceVerifier(owner-decision): '${reference}' must record decidedBy`);
      }
      if (typeof doc.decidedAt !== 'string' || Number.isNaN(Date.parse(doc.decidedAt))) {
        throw new Error(`evidenceVerifier(owner-decision): '${reference}' must record a valid decidedAt timestamp`);
      }
      return {
        verified: true,
        kind,
        reference,
        approved: true,
        fixtureHash: doc.fixtureHash,
        frozenFixtureHash: doc.fixtureHash,
        preregistrationHash: doc.preregistrationHash ?? null,
        frozenPreregistrationHash: doc.preregistrationHash ?? null,
        decidedBy: doc.decidedBy,
        decidedAt: doc.decidedAt,
        scope: typeof doc.scope === 'string' ? doc.scope : null,
      };
    }
    // cost-basis
    for (const field of ['provider', 'model', 'currency', 'inputUsdPerMillionTokens', 'outputUsdPerMillionTokens', 'effectiveDate']) {
      if (doc[field] === undefined) {
        throw new Error(`evidenceVerifier(cost-basis): '${reference}' is missing '${field}'`);
      }
    }
    if (doc.currency !== 'USD') {
      throw new Error(`evidenceVerifier(cost-basis): '${reference}' currency must be USD`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.effectiveDate))) {
      throw new Error(`evidenceVerifier(cost-basis): '${reference}' effectiveDate must be YYYY-MM-DD`);
    }
    return {
      verified: true,
      kind,
      reference,
      provider: doc.provider,
      model: doc.model,
      currency: doc.currency,
      inputUsdPerMillionTokens: doc.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: doc.outputUsdPerMillionTokens,
      cacheReadUsdPerMillionTokens: doc.cacheReadUsdPerMillionTokens ?? null,
      effectiveDate: doc.effectiveDate,
      source: typeof doc.source === 'string' ? doc.source : null,
      officialPriceVerified: doc.officialPriceVerified === true,
    };
  };
}

/**
 * Compose the APPROVED preregistration view the authorization gate requires,
 * WITHOUT ever rewriting the frozen preregistration file. The gate
 * (verifyRealRunAuthorization) demands prereg.status === 'OWNER_APPROVED';
 * the file itself must stay DRAFT (the G1 validator rejects any tool-forged
 * approval inside the file). The Owner's decision therefore lives in a
 * SEPARATE decision record, and this function joins the two:
 *
 *   prereg (file, untouched DRAFT) + owner-decision record (approved)
 *     → {status: 'OWNER_APPROVED', ..., approval: {decisionRef, decidedBy, decidedAt}}
 *
 * The join fails closed: a DRAFT file with no approving decision record, a
 * decision record whose fixtureHash differs from the loaded dataset, or an
 * approved file with no record at all are all refusals.
 */
export function composeApprovedPreregView({ prereg, decisionRecord }) {
  if (prereg === null || typeof prereg !== 'object') {
    throw new Error('composeApprovedPreregView: prereg must be the loaded draft object');
  }
  if (decisionRecord === null || typeof decisionRecord !== 'object') {
    throw new Error('composeApprovedPreregView: an approving Owner decision record is required (the draft itself can never authorize)');
  }
  if (decisionRecord.approved !== true) {
    throw new Error('composeApprovedPreregView: the Owner decision record does not carry approved: true');
  }
  return {
    ...prereg,
    status: 'OWNER_APPROVED',
    approval: {
      decisionRef: decisionRecord.reference,
      decidedBy: decisionRecord.decidedBy,
      decidedAt: decisionRecord.decidedAt,
      note: 'approval lives in the referenced Owner decision record — the preregistration FILE is and stays an untouched frozen draft',
    },
  };
}
