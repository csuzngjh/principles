import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV1Schema, DiagnosticianRecommendationSchema } from '../diagnostician-output.js';
import type { RuleCandidateBinding, RuleCandidateBindingRevision, RuleCandidateMaterial, CandidatePrincipleIdentityResolution } from '../types/rule-candidate-binding.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
export class RuleCandidateBindingCorruptionError extends Error {
  constructor(message: string) { super(message); this.name = 'RuleCandidateBindingCorruptionError'; }
}
export function parseRuleCandidateBindings(raw: unknown): Record<string, RuleCandidateBinding> {
  const fail = (): never => { throw new RuleCandidateBindingCorruptionError('Malformed ruleCandidateBindings; preserve the ledger and repair from audited evidence.'); };
  if (!record(raw)) return fail();
  const bindings: Record<string, RuleCandidateBinding> = Object.create(null);
  const decisions = new Set<string>();
  const requests = new Set<string>();
  for (const [candidateId, value] of Object.entries(raw)) {
    if (!text(candidateId) || !record(value) || value.candidateId !== candidateId || !Array.isArray(value.revisions) || value.revisions.length === 0) return fail();
    const revisions: RuleCandidateBindingRevision[] = [];
    for (const [index, entry] of value.revisions.entries()) {
      if (!record(entry) || entry.revision !== index + 1 || !text(entry.decisionId) || !UUID.test(entry.decisionId) || decisions.has(entry.decisionId)
        || !text(entry.requestId) || entry.requestId.length > 200 || !['bind', 'revoke'].includes(String(entry.action))
        || !text(entry.principleId) || !UUID.test(entry.principleId) || !text(entry.reason) || entry.reason.length > 2000
        || !text(entry.decidedAt) || !Number.isFinite(Date.parse(entry.decidedAt)) || new Date(entry.decidedAt).toISOString() !== entry.decidedAt
        || !record(entry.owner) || !text(entry.owner.actorId) || entry.owner.source !== 'authenticated_console'
        || typeof entry.reviewedCandidateDigest !== 'string' || !DIGEST.test(entry.reviewedCandidateDigest)
        || typeof entry.reviewedPrincipleDigest !== 'string' || !DIGEST.test(entry.reviewedPrincipleDigest)) return fail();
      const requestKey = JSON.stringify([entry.owner.actorId, entry.requestId]);
      if (requests.has(requestKey)) return fail();
      const previous = revisions.at(-1);
      if ((entry.action === 'revoke' && (!previous || previous.action !== 'bind' || previous.principleId !== entry.principleId))
        || (entry.action === 'bind' && previous?.action === 'bind')) return fail();
      requests.add(requestKey); decisions.add(entry.decisionId);
      revisions.push({ ...entry, revision: index + 1, decisionId: entry.decisionId, requestId: entry.requestId,
        action: entry.action === 'bind' ? 'bind' : 'revoke', principleId: entry.principleId, reason: entry.reason,
        decidedAt: entry.decidedAt, owner: { ...entry.owner, actorId: entry.owner.actorId, source: 'authenticated_console' },
        reviewedCandidateDigest: entry.reviewedCandidateDigest, reviewedPrincipleDigest: entry.reviewedPrincipleDigest });
    }
    bindings[candidateId] = { ...value, candidateId, revisions };
  }
  return bindings;
}
/** Stable digest of JSON-compatible server snapshots; object ordering does not affect review CAS. */
export function computeRuleCandidateReviewDigest(value: unknown): string {
  const seen = new Set<object>();
  const canonical = (input: unknown): string => {
    const kind = typeof input;
    if (kind === 'boolean' || kind === 'string') return JSON.stringify(input);
    if (kind === 'number') {
      if (!Number.isFinite(input)) throw new Error('Review snapshot is not finite JSON data.');
      return JSON.stringify(input);
    }
    if (kind !== 'object') throw new Error('Review snapshot is not finite JSON data.');
    // null is the only falsy value whose typeof is 'object'; it serializes as "null".
    if (!input) return JSON.stringify(input);
    if (seen.has(input)) throw new Error('Review snapshot is not finite JSON data.');
    seen.add(input);
    let result: string;
    if (Array.isArray(input)) {
      result = '[' + input.map(canonical).join(',') + ']';
    } else if (record(input)) {
      const obj: Record<string, unknown> = input;
      result = '{' + Object.keys(obj).sort().filter(key => obj[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(obj[key])).join(',') + '}';
    } else {
      throw new Error('Review snapshot is not finite JSON data.');
    }
    seen.delete(input);
    return result;
  };
  return 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
}
export function isRuleCandidateMaterial(material: unknown, candidateId: string, kind: 'rule' | 'principle'): material is RuleCandidateMaterial {
  if (!record(material) || !record(material.candidate) || !record(material.task) || !record(material.run) || !record(material.artifact)) return false;
  const { candidate, task, run, artifact } = material;
  // Split diagnoses commit recommendations on the router's own run/artifact.
  // Its inputRef identifies the parent diagnosis, whose inputRef is the pain.
  const parent = material.parentTask;
  const diagnosisLineage = task.taskKind === 'diagnostician'
    ? text(task.inputRef)
    : task.taskKind === 'diag_router' && record(parent) && text(task.inputRef)
      && parent.taskId === task.inputRef && parent.taskKind === 'diagnostician'
      && parent.status === 'succeeded' && text(parent.inputRef);
  const linked = candidate.candidateId === candidateId && candidate.rawRecommendationKind === kind
    && text(candidate.taskId) && candidate.taskId === task.taskId && candidate.taskId === run.taskId && candidate.taskId === artifact.taskId
    && text(candidate.sourceRunId) && candidate.sourceRunId === run.runId && candidate.sourceRunId === artifact.runId
    && text(candidate.artifactId) && candidate.artifactId === artifact.artifactId
    && diagnosisLineage && run.executionStatus === 'succeeded'
    && text(candidate.sourceRecommendationJson) && text(artifact.contentJson) && text(run.outputPayload);
  if (!linked || typeof candidate.sourceRecommendationJson !== 'string' || typeof artifact.contentJson !== 'string' || typeof run.outputPayload !== 'string') return false;
  try {
    const recommendation: unknown = JSON.parse(candidate.sourceRecommendationJson);
    const output: unknown = JSON.parse(run.outputPayload);
    const committed: unknown = JSON.parse(artifact.contentJson);
    if (!Value.Check(DiagnosticianRecommendationSchema, recommendation) || recommendation.kind !== kind
      || !Value.Check(DiagnosticianOutputV1Schema, output) || !output.valid
      || !Value.Check(DiagnosticianOutputV1Schema, committed) || !committed.valid) return false;
    const expected = computeRuleCandidateReviewDigest(recommendation);
    return output.recommendations.some(rec => computeRuleCandidateReviewDigest(rec) === expected)
      && committed.recommendations.some(rec => computeRuleCandidateReviewDigest(rec) === expected);
  } catch { return false; }
}
export function validateCandidateIdentityReceipt(receipt: unknown, current: CandidatePrincipleIdentityResolution): boolean {
  if (!record(receipt) || current.status !== 'resolved') return false;
  return receipt.candidateId === current.candidateId && receipt.basis === current.basis && receipt.principleId === current.principleId
    && receipt.bindingRevision === current.bindingRevision && receipt.decisionId === current.decisionId;
}
export function isCanonicalBindingPrincipleId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function isBindingDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value); }
