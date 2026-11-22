/**
 * Model-boundary source-authorization assertion — PRI-1283 R2.
 *
 * The LAST check between context assembly and the model call (SPEC
 * PD-FEEDBACK-RESILIENCE-001 TECH §2.2 ruling 5: "装配与模型调用之间撤回 →
 * 撤回的输入不得进入模型上下文"). Shared by the split diagnostician stage
 * runners so every model invocation passes the identical judgment.
 *
 * Semantics (fail-closed):
 *   1. any evidence sourceRef governed by a now-unauthorized host → block;
 *   2. a governed diagnosis-target host (codex/workbuddy) whose consent is no
 *      longer granted, combined with a NON-EMPTY conversation window → block.
 *      Rationale: the window may carry that host's governance-observation
 *      rows (the promoted window IS the codex diagnosis window); once
 *      assembled, rows can no longer be re-attributed per entry, so the
 *      conservative refusal is the only honest outcome.
 *
 * A blocked invocation throws PDRuntimeError('input_invalid', …) with a
 * structured reason — the run fails visibly; it never quietly proceeds with
 * revoked material, and never silently re-filters an already-assembled payload
 * (that would hide the race instead of honoring the revocation).
 */

import type { DiagnosticianContextPayload } from '../context-payload.js';
import { PDRuntimeError } from '../error-categories.js';
import {
  findUnauthorizedSourceRef,
  type SourceMaterialAuthorizationPort,
  type SourceMaterialHostKind,
} from '../source-material-authorization.js';

/** Host attributions whose conversation material is governed by the consent ledger. */
const GOVERNED_TARGET_HOSTS: readonly SourceMaterialHostKind[] = ['codex', 'workbuddy'];

export function assertPayloadSourceAuthorization(
  payload: DiagnosticianContextPayload,
  port: SourceMaterialAuthorizationPort,
  taskId: string,
): void {
  // 1. Evidence refs — always precisely attributable via sourceRef.
  const evidenceRefs = (payload.diagnosisTarget?.evidence ?? []).map((entry) => entry.sourceRef);
  const unauthorizedRef = findUnauthorizedSourceRef(evidenceRefs, port);
  if (unauthorizedRef !== null) {
    throw new PDRuntimeError(
      'input_invalid',
      `source_authorization_revoked: evidence sourceRef '${unauthorizedRef.sourceRef}' (host=${unauthorizedRef.hostKind ?? 'unknown'}, reason=${unauthorizedRef.reason}) is no longer authorized; the model input for task ${taskId} is blocked (PRI-1283 R2). Revoke sweep / re-diagnosis applies after cleanup.`,
    );
  }

  // 2. Conversation window of a governed host whose consent was withdrawn.
  const hostKind = payload.diagnosisTarget?.hostKind;
  const window = payload.conversationWindow ?? [];
  if (typeof hostKind === 'string' && (GOVERNED_TARGET_HOSTS as readonly string[]).includes(hostKind) && window.length > 0) {
    const decision = port.isHostSourceMaterialAuthorized(hostKind);
    if (!decision.authorized) {
      throw new PDRuntimeError(
        'input_invalid',
        `source_authorization_revoked: conversation window for task ${taskId} may contain ${hostKind} governance material whose consent is no longer granted (reason=${decision.reason}); the model input is blocked (PRI-1283 R2).`,
      );
    }
  }
}

/**
 * PRI-1283 R2 — model-boundary check for the downstream split stages
 * (distiller / router). Their model input embeds the root-cause ARTIFACT,
 * whose evidence[] entries quote source material; a revocation landing after
 * Stage A completed must block Stages B/C the same way (the notes are
 * excerpts of the revoked source, and the refs attribute them precisely).
 */
export function assertArtifactEvidenceAuthorized(input: {
  readonly stage: string;
  readonly taskId: string;
  readonly evidenceSourceRefs: readonly string[];
  readonly port: SourceMaterialAuthorizationPort;
}): void {
  const unauthorized = findUnauthorizedSourceRef(input.evidenceSourceRefs, input.port);
  if (unauthorized !== null) {
    throw new PDRuntimeError(
      'input_invalid',
      `source_authorization_revoked: root-cause artifact evidence sourceRef '${unauthorized.sourceRef}' (host=${unauthorized.hostKind ?? 'unknown'}, reason=${unauthorized.reason}) is no longer authorized; the ${input.stage} model input for task ${input.taskId} is blocked (PRI-1283 R2).`,
    );
  }
}
