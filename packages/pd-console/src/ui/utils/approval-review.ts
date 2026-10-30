import { validateApprovalRecordDirect, type ApprovalRecordData } from './validators.js';

// The server and client exchange this exact snapshot, never a newly fetched guard for old text.
export type ApprovalReviewGuard = {
  schemaVersion: 'approval-review-v1'; approvalId: string; artifactId: string;
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive';
} & ({ artifactState: 'present'; artifactDigest: string } | { artifactState: 'missing' });
export interface ApprovalReviewData {
  approval: ApprovalRecordData;
  expectedReview: ApprovalReviewGuard;
  material: { availability: 'available' | 'missing' | 'unreadable'; artifactId: string; statement: string | null;
    rationale: string | null; targetBehavior: string | null; scope: string[]; risks: string[] | null; exactBody: { kind: 'principle' | 'rule_code'; text: string } | null };
}
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function validateApprovalReview(value: unknown): ApprovalReviewData | null {
  if (!record(value) || value.writeGuardVersion !== 'approval-review-v1' || !record(value.review)) return null;
  const approval = validateApprovalRecordDirect(value);
  const guard = value.review.expectedReview;
  const {material} = value.review;
  if (!approval || !record(guard) || guard.schemaVersion !== 'approval-review-v1' || guard.approvalId !== approval.approvalId
    || guard.artifactId !== approval.artifactId || guard.channel !== approval.channel
    || !['prompt', 'code_tool_hook', 'defer_archive'].includes(String(guard.channel))
    || (guard.artifactState !== 'present' && guard.artifactState !== 'missing')
    || (guard.artifactState === 'present' && (typeof guard.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(guard.artifactDigest)))
    || !record(material) || material.artifactId !== approval.artifactId
    || !['available', 'missing', 'unreadable'].includes(String(material.availability))
    || (material.statement !== null && typeof material.statement !== 'string')
    || (material.rationale !== null && typeof material.rationale !== 'string')
    || (material.targetBehavior !== null && typeof material.targetBehavior !== 'string')
    || !Array.isArray(material.scope) || !material.scope.every(item => typeof item === 'string')
    || (material.risks !== null && (!Array.isArray(material.risks) || !material.risks.every(item => typeof item === 'string')))) return null;
  if (guard.artifactState === 'missing' && (material.availability !== 'missing' || material.exactBody !== null || material.statement !== null || Object.hasOwn(guard, 'artifactDigest'))) return null;
  if (guard.artifactState === 'present' && material.availability === 'missing') return null;
  const body = material.exactBody;
  let exactBody: ApprovalReviewData['material']['exactBody'] = null;
  if (body !== null) {
    if (!record(body) || (body.kind !== 'principle' && body.kind !== 'rule_code') || typeof body.text !== 'string') return null;
    exactBody = { kind: body.kind, text: body.text };
  }
  const {channel} = guard;
  if (channel !== 'prompt' && channel !== 'code_tool_hook' && channel !== 'defer_archive') return null;
  const expectedReview: ApprovalReviewGuard = guard.artifactState === 'present' && typeof guard.artifactDigest === 'string'
    ? { schemaVersion: 'approval-review-v1', approvalId: approval.approvalId, artifactId: approval.artifactId, channel, artifactState: 'present', artifactDigest: guard.artifactDigest }
    : { schemaVersion: 'approval-review-v1', approvalId: approval.approvalId, artifactId: approval.artifactId, channel, artifactState: 'missing' };
  const {availability} = material;
  if (availability !== 'available' && availability !== 'missing' && availability !== 'unreadable') return null;
  return { approval, expectedReview, material: { availability, artifactId: approval.artifactId, statement: material.statement,
    rationale: material.rationale, targetBehavior: material.targetBehavior, scope: material.scope, risks: material.risks, exactBody } };
}
