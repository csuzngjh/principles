import type { RuleBindingReviewView, RuleBindingQueueView } from '../../shared/rule-candidate-binding-contract.js';
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
export function validateBindingQueue(value: unknown): RuleBindingQueueView | null {
  if (!record(value) || !Array.isArray(value.items)) return null;
  const items: RuleBindingQueueView['items'] = [];
  for (const item of value.items) {
    if (!record(item) || typeof item.candidateId !== 'string' || typeof item.text !== 'string' || typeof item.reason !== 'string') return null;
    items.push({ candidateId: item.candidateId, text: item.text, reason: item.reason });
  }
  return { items };
}
export function validateBindingReview(value: unknown): RuleBindingReviewView | null {
  if (!record(value) || typeof value.candidateId !== 'string' || typeof value.candidateText !== 'string' || typeof value.sourcePainId !== 'string'
    || typeof value.evidence !== 'string' || typeof value.candidateDigest !== 'string' || !integer(value.currentRevision)
    || typeof value.resumeNotice !== 'string' || !Array.isArray(value.eligibleTargets) || value.eligibleTargets.length > 20) return null;
  let currentBinding: RuleBindingReviewView['currentBinding'] = null;
  if (value.currentBinding !== null) {
    const b = value.currentBinding;
    if (!record(b) || (b.action !== 'bind' && b.action !== 'revoke') || typeof b.principleId !== 'string' || typeof b.reason !== 'string' || !integer(b.revision)) return null;
    currentBinding = { action: b.action, principleId: b.principleId, reason: b.reason, revision: b.revision };
  }
  const eligibleTargets: RuleBindingReviewView['eligibleTargets'] = [];
  for (const p of value.eligibleTargets) {
    if (!record(p) || typeof p.principleId !== 'string' || typeof p.text !== 'string' || typeof p.status !== 'string' || !integer(p.version) || typeof p.digest !== 'string') return null;
    eligibleTargets.push({ principleId: p.principleId, text: p.text, status: p.status, version: p.version, digest: p.digest });
  }
  return { candidateId: value.candidateId, candidateText: value.candidateText, sourcePainId: value.sourcePainId, evidence: value.evidence,
    candidateDigest: value.candidateDigest, currentRevision: value.currentRevision, currentBinding, eligibleTargets, resumeNotice: value.resumeNotice };
}
export function validateBindingMutation(value: unknown): { status: string; revisionStatus?: string; nextAction?: string } | null {
  if (!record(value) || !['bound', 'already_bound', 'revoked', 'already_revoked'].includes(String(value.status)) || typeof value.status !== 'string') return null;
  if (value.runtimeDeactivated !== false || value.inFlightOperationsMayComplete !== true) return null;
  if (value.nextAction !== undefined && typeof value.nextAction !== 'string') return null;
  if (value.revision !== undefined && (!record(value.revision) || typeof value.revision.status !== 'string')) return null;
  return { status: value.status, ...(record(value.revision) && typeof value.revision.status === 'string' ? { revisionStatus: value.revision.status } : {}),
    ...(typeof value.nextAction === 'string' ? { nextAction: value.nextAction } : {}) };
}
