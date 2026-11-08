import { validateApprovalRecordDirect, type ApprovalRecordData } from './validators.js';

// The server and client exchange this exact snapshot, never a newly fetched guard for old text.
// PRI-1139: the server mints the version-neutral 'approval-review'; guards from
// a pre-cutover server keep 'approval-review-v1' and stay valid reads.
export type ApprovalReviewGuardSchemaVersion = 'approval-review' | 'approval-review-v1';
export type ApprovalReviewGuard = {
  schemaVersion: ApprovalReviewGuardSchemaVersion; approvalId: string; artifactId: string;
  channel: 'prompt' | 'code_tool_hook' | 'defer_archive';
} & ({ artifactState: 'present'; artifactDigest: string } | { artifactState: 'missing' });
const APPROVAL_REVIEW_GUARD_VERSIONS: ReadonlySet<string> = new Set(['approval-review', 'approval-review-v1']);
export interface ApprovalReviewData {
  approval: ApprovalRecordData;
  expectedReview: ApprovalReviewGuard;
  material: { availability: 'available' | 'missing' | 'unreadable'; artifactId: string; statement: string | null;
    rationale: string | null; targetBehavior: string | null; scope: string[]; risks: string[] | null; exactBody: { kind: 'principle' | 'rule_code'; text: string } | null };
}
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function validateApprovalReview(value: unknown): ApprovalReviewData | null {
  if (!record(value) || !APPROVAL_REVIEW_GUARD_VERSIONS.has(String(value.writeGuardVersion)) || !record(value.review)) return null;
  const approval = validateApprovalRecordDirect(value);
  const guard = value.review.expectedReview;
  const {material} = value.review;
  if (!approval || !record(guard) || !APPROVAL_REVIEW_GUARD_VERSIONS.has(String(guard.schemaVersion)) || guard.approvalId !== approval.approvalId
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
  // The reader treats a material body as present exactly when availability says so;
  // a payload that disagrees must fail loud rather than render the wrong preview.
  if ((material.availability === 'available') !== (exactBody !== null)) return null;
  if (exactBody !== null && (channel === 'code_tool_hook') !== (exactBody.kind === 'rule_code')) return null;
  // Echo the guard's own schemaVersion verbatim (PRI-1139): whichever spelling
  // the minting server used must round-trip byte-identically on submission.
  // The value is already constrained to this union by the guards above.
  const guardVersion = guard.schemaVersion as ApprovalReviewGuardSchemaVersion;
  const expectedReview: ApprovalReviewGuard = guard.artifactState === 'present' && typeof guard.artifactDigest === 'string'
    ? { schemaVersion: guardVersion, approvalId: approval.approvalId, artifactId: approval.artifactId, channel, artifactState: 'present', artifactDigest: guard.artifactDigest }
    : { schemaVersion: guardVersion, approvalId: approval.approvalId, artifactId: approval.artifactId, channel, artifactState: 'missing' };
  const {availability} = material;
  if (availability !== 'available' && availability !== 'missing' && availability !== 'unreadable') return null;
  return { approval, expectedReview, material: { availability, artifactId: approval.artifactId, statement: material.statement,
    rationale: material.rationale, targetBehavior: material.targetBehavior, scope: material.scope, risks: material.risks, exactBody } };
}
