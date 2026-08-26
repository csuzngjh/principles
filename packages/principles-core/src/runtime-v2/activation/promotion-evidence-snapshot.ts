import type { PIArtifactSnapshot } from './activation-types.js';
import type { PromotionEvidenceSnapshot, OwnerPromotionActor } from './rulecode-owner-decision-service.js';
import { createHash, randomUUID } from 'node:crypto';

export interface PromotionEvidenceOwnerIdentity {
  principalKind: string;
  actorId: string;
  authenticationMethod: string;
  credentialId?: string | null;
}

export interface BuildPromotionEvidenceSnapshotInput {
  activationId?: string;
  evaluationId?: string;
  checks: { checkId: string; status: 'passed' | 'failed'; reasonCode?: string }[];
  artifact?: PIArtifactSnapshot;
  expectedArtifactDigest?: string;
  ownerIdentity?: PromotionEvidenceOwnerIdentity | OwnerPromotionActor | null;
  hostRuntimeVersion?: string;
  shadowSummary?: PromotionEvidenceSnapshot['shadowSummary'];
  lineageRefs?: string[];
  configurationVersion?: string;
  now?: () => string;
  newSnapshotId?: () => string;
}

export function computeArtifactDigest(artifact: PIArtifactSnapshot): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(artifact), 'utf8').digest('hex')}`;
}

export function normalizeOwnerIdentity(
  actor?: PromotionEvidenceOwnerIdentity | OwnerPromotionActor | null,
): PromotionEvidenceOwnerIdentity | null {
  if (!actor) return null;
  if (Object.hasOwn(actor, 'principal') && Object.hasOwn(actor, 'authentication')) {
    const typed = actor as OwnerPromotionActor;
    const principalKind = typed.principal.kind;
    const actorId =
      typed.principal.kind === 'configured_owner'
        ? typed.principal.ownerId
        : typed.principal.kind === 'system_safety'
          ? typed.principal.policyVersion
          : typed.principal.reason;
    const authenticationMethod = typed.authentication.method;
    const credentialId =
      Object.hasOwn(typed.authentication, 'credentialId')
        ? (typed.authentication as { credentialId?: string | null }).credentialId ?? null
        : null;
    return { principalKind, actorId, authenticationMethod, credentialId };
  }
  const flat = actor as PromotionEvidenceOwnerIdentity;
  return {
    principalKind: flat.principalKind,
    actorId: flat.actorId,
    authenticationMethod: flat.authenticationMethod,
    credentialId: flat.credentialId ?? null,
  };
}

export function buildPromotionEvidenceSnapshot(
  input: BuildPromotionEvidenceSnapshotInput,
): PromotionEvidenceSnapshot {
  const createdAt = input.now ? input.now() : new Date().toISOString();
  const artifactDigest = input.artifact
    ? computeArtifactDigest(input.artifact)
    : (input.expectedArtifactDigest ?? '');
  const hostRuntimeVersion = input.hostRuntimeVersion ?? 'openclaw-legacy@1';
  const lineageRefs =
    input.lineageRefs ??
    (input.artifact ? [input.artifact.sourceTaskId, ...input.artifact.lineageArtifactIds] : []);
  const shadowSummary = input.shadowSummary ?? {
    observed: null,
    matched: null,
    wouldBlock: null,
    wouldAllow: null,
    requireApproval: null,
    autoCorrect: null,
    errors: null,
    neutralControl: null,
    firstObservedAt: null,
    lastObservedAt: null,
  };
  const configurationVersion = input.configurationVersion ?? 'pd-config-current';
  const redaction = { version: 'v1', rawParametersStored: false } as const;
  const ownerIdentity = normalizeOwnerIdentity(input.ownerIdentity);

  // snapshotDigest is a JOINT attestation, not standalone-recomputable from one
  // row: every field below must stay recoverable from persisted data —
  // activationId / evaluationId / ownerIdentity via the activation_decisions
  // row that references this snapshot, all remaining fields via
  // activation_evidence_snapshots columns. Adding a field here requires a
  // matching persisted column or decision-row source.
  const digestBody = JSON.stringify({
    activationId: input.activationId ?? null,
    evaluationId: input.evaluationId ?? null,
    artifactDigest,
    lineageRefs,
    checks: input.checks,
    ownerIdentity,
    hostRuntimeVersion,
    shadowSummary,
    configurationVersion,
    redaction,
    createdAt,
  });

  const snapshotDigest = `sha256:${createHash('sha256').update(digestBody, 'utf8').digest('hex')}`;
  const snapshotId = input.newSnapshotId ? input.newSnapshotId() : `snapshot-${randomUUID()}`;

  return {
    snapshotId,
    snapshotDigest,
    artifactDigest,
    lineageRefs,
    hostRuntimeVersion,
    safetyGateResults: input.checks,
    shadowSummary,
    configurationVersion,
    redaction,
    createdAt,
  };
}
