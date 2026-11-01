import type { previewApprovedRuleRevision, reviseApprovedRuleOnce } from '@principles/core/runtime-v2';

/** Wire projections of the core authority; no independent revision state. */
export type ApprovedRuleRevisionPreview = Awaited<ReturnType<typeof previewApprovedRuleRevision>>;
export type ApprovedRuleRevisionResult = Awaited<ReturnType<typeof reviseApprovedRuleOnce>>;
export type ApprovedRuleRevisionRequest = Pick<Parameters<typeof reviseApprovedRuleOnce>[0],
  'expectedArtifactId' | 'expectedArtifactDigest' | 'expectedBindingRevision' |
  'expectedControlVersion' | 'expectedTaskRevisionEpoch' | 'requestId' | 'feedback'>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function version(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

export function validateApprovedRuleRevisionRequest(value: unknown): ApprovedRuleRevisionRequest | null {
  if (!record(value) || !text(value.expectedArtifactId) || !text(value.expectedArtifactDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(value.expectedArtifactDigest)
    || !version(value.expectedBindingRevision) || !version(value.expectedControlVersion)
    || !version(value.expectedTaskRevisionEpoch) || !text(value.requestId) || value.requestId.length > 200
    || !text(value.feedback) || value.feedback.length > 4000) return null;
  return { expectedArtifactId: value.expectedArtifactId, expectedArtifactDigest: value.expectedArtifactDigest,
    expectedBindingRevision: value.expectedBindingRevision, expectedControlVersion: value.expectedControlVersion,
    expectedTaskRevisionEpoch: value.expectedTaskRevisionEpoch, requestId: value.requestId, feedback: value.feedback.trim() };
}

function refused(value: Record<string, unknown>): { status: 'refused'; reason: string; nextAction: string } | null {
  return value.status === 'refused' && text(value.reason) && text(value.nextAction)
    ? { status: 'refused', reason: value.reason, nextAction: value.nextAction } : null;
}

export function validateApprovedRuleRevisionPreview(value: unknown): ApprovedRuleRevisionPreview | null {
  if (!record(value)) return null;
  if (value.status === 'refused') return refused(value);
  if (value.status !== 'ready' || !text(value.activationId) || !text(value.candidateId)
    || !text(value.principleId) || !text(value.artificerTaskId) || !text(value.expectedArtifactId)
    || !text(value.expectedArtifactDigest) || !/^sha256:[a-f0-9]{64}$/.test(value.expectedArtifactDigest)
    || !version(value.expectedBindingRevision) || !version(value.expectedControlVersion)
    || !version(value.expectedTaskRevisionEpoch)) return null;
  return { status: 'ready', activationId: value.activationId, candidateId: value.candidateId,
    principleId: value.principleId, artificerTaskId: value.artificerTaskId,
    expectedArtifactId: value.expectedArtifactId, expectedArtifactDigest: value.expectedArtifactDigest,
    expectedBindingRevision: value.expectedBindingRevision, expectedControlVersion: value.expectedControlVersion,
    expectedTaskRevisionEpoch: value.expectedTaskRevisionEpoch };
}

export function validateApprovedRuleRevisionResult(value: unknown): ApprovedRuleRevisionResult | null {
  if (!record(value)) return null;
  if (value.status === 'refused') return refused(value);
  if ((value.status !== 'started' && value.status !== 'already_started') || !text(value.artificerTaskId)
    || !text(value.causeId) || !version(value.taskRevisionEpoch)) return null;
  return { status: value.status, artificerTaskId: value.artificerTaskId,
    causeId: value.causeId, taskRevisionEpoch: value.taskRevisionEpoch };
}
