// PRI-1182 approval gate.
//
// One Owner approval authorises ONE batch. This module binds that approval to
// the exact execution inputs (code head/tree, frozen manifest, the isolated
// config the runner actually loads), to the route/envelope/criteria it was
// approved for, and to the request cap. It then implements the two refusals
// the acceptance card requires:
//
//   - duplicate: the claim file is created with `wx`, so a second run of the
//     same approval cannot start;
//   - over-cap: the caller must reserve BEFORE spawning a case that may send,
//     and the reservation is refused once the batch cap would be exceeded.
//
// Pure except for the exclusive claim write; no network, no process spawning.

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function hashBuildArtifacts(root) {
  const files = [];
  for (const name of ['codex-adapter', 'host-runtime', 'principles-core', 'install-layout']) {
    const dist = path.join(root, 'packages', name, 'dist');
    for (const entry of fs.readdirSync(dist, {recursive: true, withFileTypes: true})) {
      if (entry.isDirectory()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (!entry.isFile()) throw new Error('Unexpected build artifact: ' + file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      files.push([relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

const REQUIRED_APPROVAL_FIELDS = [
  'codeHead',
  'treeHash',
  'manifestSha256',
  'isolatedConfigSha256',
  'buildArtifactsSha256',
  'route',
  'envelopeTotalMs',
  'criteriaVersion',
  'maxRequests',
  'expiresAt',
];

const REQUIRED_ROUTE_FIELDS = ['endpoint', 'model', 'provider', 'responseModels'];

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * @param {unknown} approval parsed approval file
 * @param {{codeHead:string, treeHash:string, manifestSha256:string,
 *   isolatedConfigSha256:string, buildArtifactsSha256:string, route:object, envelopeTotalMs:number,
 *   criteriaVersion:string, maxRequests:number}} binding what will actually run
 * @param {number} now epoch ms
 */
export function verifyApproval({approval, binding, now = Date.now()}) {
  const problems = [];
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return {ok: false, problems: [{code: 'APPROVAL_NOT_AN_OBJECT'}]};
  }
  for (const field of REQUIRED_APPROVAL_FIELDS) {
    if (isEmpty(approval[field])) problems.push({code: 'APPROVAL_FIELD_MISSING', field});
  }
  for (const field of ['codeHead', 'treeHash', 'manifestSha256', 'isolatedConfigSha256', 'buildArtifactsSha256']) {
    if (!isEmpty(approval[field]) && approval[field] !== binding[field]) {
      problems.push({code: 'APPROVAL_MISMATCH', field, approved: approval[field], actual: binding[field]});
    }
  }
  if (!isEmpty(approval.route)) {
    for (const field of REQUIRED_ROUTE_FIELDS) {
      if (isEmpty(approval.route?.[field])) {
        problems.push({code: 'APPROVAL_ROUTE_FIELD_MISSING', field});
      } else if (!sameJson(approval.route[field], binding.route[field])) {
        problems.push({
          code: 'APPROVAL_MISMATCH',
          field: `route.${field}`,
          approved: approval.route[field],
          actual: binding.route[field],
        });
      }
    }
  }
  if (!isEmpty(approval.envelopeTotalMs) && approval.envelopeTotalMs !== binding.envelopeTotalMs) {
    problems.push({
      code: 'APPROVAL_MISMATCH',
      field: 'envelopeTotalMs',
      approved: approval.envelopeTotalMs,
      actual: binding.envelopeTotalMs,
    });
  }
  if (!isEmpty(approval.criteriaVersion) && approval.criteriaVersion !== binding.criteriaVersion) {
    problems.push({
      code: 'APPROVAL_MISMATCH',
      field: 'criteriaVersion',
      approved: approval.criteriaVersion,
      actual: binding.criteriaVersion,
    });
  }
  if (!isEmpty(approval.maxRequests) && approval.maxRequests !== binding.maxRequests) {
    problems.push({
      code: 'APPROVAL_CAP_MISMATCH',
      field: 'maxRequests',
      approved: approval.maxRequests,
      actual: binding.maxRequests,
    });
  }
  // Expiry is a time decision, not an equality check: an approval may name an
  // earlier expiry than the card's, never a later one.
  const expiresAt = Date.parse(approval.expiresAt);
  if (Number.isNaN(expiresAt)) {
    problems.push({code: 'APPROVAL_EXPIRY_INVALID', value: String(approval.expiresAt)});
  } else if (expiresAt <= now) {
    problems.push({code: 'APPROVAL_EXPIRED', expiresAt: approval.expiresAt});
  } else if (expiresAt > Date.parse(binding.cardExpiresAt)) {
    problems.push({
      code: 'APPROVAL_EXPIRY_AFTER_CARD',
      approved: approval.expiresAt,
      card: binding.cardExpiresAt,
    });
  }
  return {ok: problems.length === 0, problems};
}

/**
 * Create the single-use claim. `wx` is the whole duplicate guard: the file is
 * created only when it does not exist, so a second run of the same approval
 * fails instead of silently spending another batch.
 */
export function claimApproval({claimPath, record}) {
  try {
    const fd = fs.openSync(claimPath, 'wx');
    try {
      fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return {ok: true, claimPath};
  } catch (error) {
    if (error?.code === 'EEXIST') return {ok: false, reason: 'CLAIM_ALREADY_EXISTS', claimPath};
    throw error;
  }
}

/** A results artifact is evidence, never a file a later run may overwrite. */
export function assertFreshResults(resultsPath) {
  if (fs.existsSync(resultsPath)) return {ok: false, reason: 'RESULTS_ALREADY_EXISTS', resultsPath};
  return {ok: true};
}

/**
 * Reserve before spawning a case that may send. Fail-closed: the caller must
 * not spawn when `ok` is false. A reservation is permission to make at most
 * one request, not a claim that one was made.
 */
export function reserveRequest({sentSoFar, cap, caseId}) {
  if (!Number.isInteger(cap) || cap < 0) {
    return {ok: false, reason: 'REQUEST_CAP_INVALID', caseId, cap};
  }
  if (sentSoFar + 1 > cap) {
    return {ok: false, reason: 'REQUEST_CAP_EXCEEDED', caseId, sentSoFar, cap};
  }
  return {ok: true, caseId, sentSoFar, cap};
}

/** The artifact record that ties an approval file to what actually ran. */
export function claimRecord({approvalSha256, approvalFile, binding, caseIds, maxRequests}) {
  return {
    schemaVersion: 'pd-pri-1182-approval-claim/v1',
    claimedAt: new Date().toISOString(),
    approvalFile,
    approvalSha256,
    ...binding,
    maxRequests,
    caseIds,
  };
}
