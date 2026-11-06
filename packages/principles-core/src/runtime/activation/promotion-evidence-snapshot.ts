import type { PIArtifactSnapshot } from './activation-types.js';
import type { PromotionEvidenceSnapshot, OwnerPromotionActor } from './rulecode-owner-decision-service.js';
import { mapPiArtifactRow } from '../store/artifact/sqlite-pi-artifact-store.js';
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

/**
 * Outcome of enforcement-time digest re-verification (security audit run-1,
 * rulecode-approval-content-unbound).
 *
 * - `verified` — the row's recomputed digest matches the approved digest.
 * - `tampered` — the row recomputed cleanly but diverges from the approved
 *   digest: an integrity failure. Callers must skip the activation (and
 *   surface a structured warning); they must NOT evaluate the content.
 * - `unverifiable` — the row is malformed (or the approved digest is not a
 *   string) so no comparison was possible. Callers apply their own policy.
 * - `no_binding` — no activation-scoped decision exists for this activation
 *   (pre-owner-decision legacy row): nothing to verify against; callers keep
 *   their prior behavior.
 */
export type ArtifactDigestCheck =
  | { outcome: 'verified' }
  | { outcome: 'tampered'; actualDigest: string }
  | { outcome: 'unverifiable'; error: string }
  | { outcome: 'no_binding' };

/**
 * Re-verify a pi_artifacts row (as freshly read from state.db, fields treated
 * as unknown per rc-1) against the digest the Owner decision recorded at
 * promotion time. THE single implementation of this check — the host-runtime
 * production gate and the OpenClaw plugin RuleHost both call this; do not
 * hand-roll a second copy (the mapping/ordering inside mapPiArtifactRow is
 * what makes the recomputed digest byte-identical to the promotion-time one).
 */
export function verifyPiArtifactRowDigest(
  row: Record<string, unknown>,
  contentJson: string,
  approvedDigest: string | null,
): ArtifactDigestCheck {
  if (typeof approvedDigest !== 'string' || approvedDigest.length === 0) {
    return { outcome: 'no_binding' };
  }
  const artifactId = row.artifact_id;
  const artifactKind = row.artifact_kind;
  const sourceTaskId = row.source_task_id;
  const sourcePrincipleId = row.source_principle_id;
  const sourceRuleId = row.source_rule_id;
  const lineageArtifactIds = row.lineage_artifact_ids;
  const validationStatus = row.validation_status;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  const rowReady =
    typeof artifactId === 'string' && artifactId.length > 0
    && typeof artifactKind === 'string'
    && typeof sourceTaskId === 'string'
    && (typeof sourcePrincipleId === 'string' || sourcePrincipleId === null)
    && (typeof sourceRuleId === 'string' || sourceRuleId === null)
    && typeof lineageArtifactIds === 'string'
    && typeof validationStatus === 'string'
    && typeof createdAt === 'string'
    && typeof updatedAt === 'string';
  if (!rowReady) {
    return { outcome: 'unverifiable', error: 'artifact row integrity does not allow digest re-verification' };
  }
  let actualDigest: string;
  try {
    actualDigest = computeArtifactDigest(mapPiArtifactRow({
      artifact_id: artifactId,
      artifact_kind: artifactKind,
      source_task_id: sourceTaskId,
      source_principle_id: sourcePrincipleId,
      source_rule_id: sourceRuleId,
      lineage_artifact_ids: lineageArtifactIds,
      validation_status: validationStatus,
      content_json: contentJson,
      created_at: createdAt,
      updated_at: updatedAt,
    }));
  } catch (error: unknown) {
    return { outcome: 'unverifiable', error: error instanceof Error ? error.message : String(error) };
  }
  if (actualDigest !== approvedDigest) {
    return { outcome: 'tampered', actualDigest };
  }
  return { outcome: 'verified' };
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
