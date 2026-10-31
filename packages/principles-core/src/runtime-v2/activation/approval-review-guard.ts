import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ApprovalRecord, PIArtifactSnapshot } from './activation-types.js';
import { computeArtifactDigest } from './promotion-evidence-snapshot.js';

const Common = {
  schemaVersion: Type.Literal('approval-review-v1'),
  approvalId: Type.String({ minLength: 1 }), artifactId: Type.String({ minLength: 1 }),
  channel: Type.Union([Type.Literal('prompt'), Type.Literal('skill'), Type.Literal('code_tool_hook'), Type.Literal('defer_archive')]),
};
export const ApprovalReviewGuardSchema = Type.Union([
  Type.Object({ ...Common, artifactState: Type.Literal('present'), artifactDigest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }) }, { additionalProperties: false }),
  Type.Object({ ...Common, artifactState: Type.Literal('missing') }, { additionalProperties: false }),
]);
export type ApprovalReviewGuard = Static<typeof ApprovalReviewGuardSchema>;
export function isApprovalReviewGuard(value: unknown): value is ApprovalReviewGuard { return Value.Check(ApprovalReviewGuardSchema, value); }
// eslint-disable-next-line @typescript-eslint/max-params -- the missing-artifact reject exception is explicit and false by default
export function matchesApprovalReview(record: ApprovalRecord, artifact: PIArtifactSnapshot | null, expected: ApprovalReviewGuard, allowMissing = false): boolean {
  if (!isApprovalReviewGuard(expected) || expected.approvalId !== record.approvalId || expected.artifactId !== record.artifactId || expected.channel !== record.channel) return false;
  if (expected.artifactState === 'missing') return allowMissing && artifact === null;
  return artifact !== null && artifact.artifactId === record.artifactId && computeArtifactDigest(artifact) === expected.artifactDigest;
}
export function staleApprovalReview() {
  return { ok: false as const, error: 'stale_review' as const, reason: 'The approval material or target changed after review.', nextAction: 'Reload this approval and review the current material before deciding again.' };
}
