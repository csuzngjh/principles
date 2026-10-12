/**
 * WorkBuddy Evidence Recorder — the WorkBuddy source adapter for the PD v2
 * evidence ledger (ADR-0027; SPEC workbuddy-host-adapter §4.6). Ports the
 * codex-adapter recorder pattern onto the frozen
 * `workbuddy_pd_hook_event_log` source kind with WorkBuddy's PROBE-VERIFIED
 * honesty boundaries:
 *
 * - agent_context_delivery: supported, max confirmation 'submitted' — the
 *   UserPromptSubmit additionalContext channel was verified in model-visible
 *   context by probe P04, but the adapter proves only submission on stdout;
 * - enforcement_delivery: supported, max confirmation 'runtime_loaded' —
 *   probe P02 VERIFIED a deny permissionDecision actually blocks the tool
 *   (target file not written), so unlike Codex (suspended, PRI-780) this
 *   host can honestly claim runtime enforcement for v1 live rules;
 * - application_self_report: unsupported — no self-report capture channel;
 * - v2 rule context: like Codex, WorkBuddy supplies NO runtime context
 *   provider, so v2 rules stay suspended (rule_context_v2_unavailable);
 *   nothing here claims v2 enforcement.
 *
 * All writes flow through the shared host-runtime ingress (SPEC §13.7 single
 * entry). Best-effort: degradation produces a bounded stderr diagnostic and
 * never changes an already computed tool decision (P02: an already-encoded
 * deny must survive evidence failure).
 */
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import type {
  InterventionCapabilityDeclaration,
  InterventionEvidenceBatchInput,
  InterventionObservationInput,
} from '@principles/core/runtime-v2';

/** Evidence adapter surface version (matches the frozen core contract test expectations). */
export const WORKBUDDY_EVIDENCE_ADAPTER_VERSION = 'workbuddy-adapter@0.1.0';

export type EvidenceWarn = (diagnosticLine: string) => void;

export function workbuddyCapabilityDeclarations(): InterventionCapabilityDeclaration[] {
  return [
    {
      hostKind: 'workbuddy', capability: 'agent_context_delivery', status: 'supported',
      adapterVersion: WORKBUDDY_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook:UserPromptSubmit',
      maxConfirmation: 'submitted',
      note: 'P04 probe: additionalContext verified in model-visible context as a hook system-reminder; stdout submission is the proof boundary',
    },
    {
      hostKind: 'workbuddy', capability: 'enforcement_delivery', status: 'supported',
      adapterVersion: WORKBUDDY_EVIDENCE_ADAPTER_VERSION, channel: 'code_tool_hook',
      maxConfirmation: 'runtime_loaded',
      note: 'P02 probe: PreToolUse deny verified to block tool execution (target file not written); v2 rules stay suspended (no context provider)',
    },
    {
      hostKind: 'workbuddy', capability: 'application_self_report', status: 'unsupported',
      adapterVersion: WORKBUDDY_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook',
      note: 'no self-report capture channel exists on the WorkBuddy host; nothing is claimed',
    },
    {
      hostKind: 'workbuddy', capability: 'behavior_observation', status: 'unknown',
      adapterVersion: WORKBUDDY_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook:PostToolUse',
      note: 'tool episodes are recorded through the shared pain path; no automated outcome source exists yet',
    },
    {
      hostKind: 'workbuddy', capability: 'outcome_observation', status: 'unknown',
      adapterVersion: WORKBUDDY_EVIDENCE_ADAPTER_VERSION, channel: 'console',
      note: 'no automated outcome source; outcomes enter via Owner console input only',
    },
  ];
}

function appendWorkbuddyBatch(
  workspaceDir: string,
  observations: InterventionObservationInput[],
  warn: EvidenceWarn,
): void {
  if (observations.length === 0) return;
  const ingress = getInterventionEvidenceIngress();
  const batch: InterventionEvidenceBatchInput = {
    evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
    sourceKind: 'workbuddy_pd_hook_event_log',
    adapterVersion: WORKBUDDY_EVIDENCE_ADAPTER_VERSION,
    recordedAt: new Date().toISOString(),
    observations,
    capabilityDeclarations: workbuddyCapabilityDeclarations(),
  };
  const result = ingress.appendObservationBatch({ workspaceDir, batch });
  if (!result.ok) {
    warn(`[PD:Evidence] workbuddy append degraded: ${result.reason ?? 'unknown'}; next: ${result.nextAction ?? 'replay from durable source'}`);
  }
}

export interface WorkbuddyPromptDeliveryEvidenceInput {
  workspaceDir: string;
  sessionId: string;
  /** WorkBuddy generation_id as carried by the injected-event runId (optional). */
  turnId?: string;
  /** Index-aligned per-principle injection facts from the injected event. */
  injected: readonly { principleId: string; activationId: string; artifactId?: string }[];
  evidenceEnabled: boolean;
  warn: EvidenceWarn;
}

/**
 * Record one agent-context delivery attempt per injected principle after the
 * raw injected-event line has been appended to the durable WorkBuddy event
 * log — confirmation 'submitted', outcome 'attempted' (submitted ≠ delivered,
 * SPEC §4.6).
 */
export function recordWorkbuddyPromptDeliveryEvidence(input: WorkbuddyPromptDeliveryEvidenceInput): void {
  if (!input.evidenceEnabled || input.injected.length === 0) return;
  const ingress = getInterventionEvidenceIngress();
  const observations: InterventionObservationInput[] = [];
  for (const entry of input.injected) {
    const observationKey = `workbuddy|delivery|agent_context|${input.sessionId}|${input.turnId ?? '-'}|${entry.activationId}`;
    const sourceLocator = `workbuddy-pd-hook-event-log:${input.sessionId}`;
    const existing = ingress.existingObservationRefs(input.workspaceDir, {
      sourceKind: 'workbuddy_pd_hook_event_log', sourceLocator, observationKey,
      principleId: entry.principleId, activationId: entry.activationId, ...(entry.artifactId ? { artifactId: entry.artifactId } : {}),
    });
    const activationRef = existing?.activationRef ?? ingress.resolveActivationOccurrenceRef(input.workspaceDir, entry.activationId);
    if (!activationRef) {
      input.warn(`[PD:Evidence] workbuddy prompt delivery skipped for activation ${entry.activationId}: occurrence snapshot unresolvable`);
      continue;
    }
    if (entry.artifactId !== undefined && activationRef.artifactId !== entry.artifactId) {
      input.warn(`[PD:Evidence] workbuddy prompt delivery skipped for activation ${entry.activationId}: source artifact does not match occurrence`);
      continue;
    }
    const contentRef = existing?.contentRef ?? ingress.resolveInterventionContentRef(input.workspaceDir, activationRef, entry.principleId);
    observations.push({
      observationKey,
      sourceLocator,
      kind: 'delivery',
      nativeRefs: {
        hostKind: 'workbuddy',
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      },
      principleId: entry.principleId,
      contentRef: {
        principleId: entry.principleId,
        ...(activationRef.artifactId ? { artifactId: activationRef.artifactId } : {}),
        ...(contentRef?.payloadDigest ? { payloadDigest: contentRef.payloadDigest } : {}),
        // A stored contentRef is an OBJECT — its truthiness must not upgrade
        // resolution: only a digest-carrying reference counts as resolved.
        resolution: contentRef?.payloadDigest !== undefined ? 'resolved' : 'revision_reference_unresolved',
      },
      activationRef,
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    });
  }
  appendWorkbuddyBatch(input.workspaceDir, observations, input.warn);
}

export interface WorkbuddyDenyEvidenceInput {
  workspaceDir: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  activationId?: string;
  principleId?: string;
  ruleId?: string;
  reason?: string;
  evidenceEnabled: boolean;
  warn: EvidenceWarn;
}

/**
 * Record the enforcement chain for an ATTRIBUTED deny that was successfully
 * encoded to the WorkBuddy stdout channel. The proof boundary is the encoded
 * permissionDecision (probe P02 verified the host honors it by blocking the
 * tool) — PD claims exactly that, nothing broader.
 *
 * Episode identity requires the per-call toolCallId (WorkBuddy call_id).
 * Without it the chain is skipped: a hash fallback would mint an episode
 * with NO native event key, which the normalizer rejects and drops the
 * whole batch.
 */
export function recordWorkbuddyDenyEvidence(input: WorkbuddyDenyEvidenceInput): void {
  if (!input.activationId || !input.principleId) return;
  if (!input.toolCallId) {
    input.warn('[PD:Evidence] workbuddy deny chain skipped: no toolCallId — episode identity would lack a native event key');
    return;
  }
  if (!input.evidenceEnabled) return;
  const ingress = getInterventionEvidenceIngress();
  const toolKey = input.toolCallId;
  const sessionPart = input.sessionId ?? '-';
  const deliveryKey = `workbuddy|delivery|enforcement|${sessionPart}|${toolKey}|${input.activationId}`;
  const sourceLocator = `workbuddy-pd-hook-event-log:${sessionPart}`;
  const existing = ingress.existingObservationRefs(input.workspaceDir, {
    sourceKind: 'workbuddy_pd_hook_event_log', sourceLocator, observationKey: deliveryKey,
    principleId: input.principleId, activationId: input.activationId,
  });
  const activationRef = existing?.activationRef ?? ingress.resolveActivationOccurrenceRef(input.workspaceDir, input.activationId);
  if (!activationRef) {
    input.warn(`[PD:Evidence] workbuddy deny chain skipped for activation ${input.activationId}: occurrence snapshot unresolvable`);
    return;
  }
  const episodeKey = `workbuddy|episode|${sessionPart}|${toolKey}`;
  const content = existing?.contentRef ?? ingress.resolveInterventionContentRef(input.workspaceDir, activationRef, input.principleId);
  const contentRef = {
    principleId: input.principleId,
    ...(activationRef.artifactId ? { artifactId: activationRef.artifactId } : {}),
    ...(content?.payloadDigest ? { payloadDigest: content.payloadDigest } : {}),
    resolution: content?.payloadDigest !== undefined ? 'resolved' as const : 'revision_reference_unresolved' as const,
  };
  const observations: InterventionObservationInput[] = [
    {
      observationKey: deliveryKey,
      sourceLocator,
      kind: 'delivery',
      nativeRefs: {
        hostKind: 'workbuddy',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
      principleId: input.principleId,
      contentRef,
      activationRef,
      payload: { targetKind: 'runtime_enforcement', confirmation: 'runtime_loaded', outcome: 'delivered' },
    },
    {
      observationKey: `workbuddy|application|runtime_verified|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator,
      kind: 'application',
      nativeRefs: {
        hostKind: 'workbuddy',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
      principleId: input.principleId,
      activationRef,
      episodeKey,
      payload: { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'workbuddy_permission_decision_encoded_p02_verified' },
    },
    {
      observationKey: episodeKey,
      sourceLocator,
      kind: 'behavior_episode',
      nativeRefs: {
        hostKind: 'workbuddy',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
      payload: {
        status: 'closed',
        actionSummary: `${input.toolName} denied by rule ${input.ruleId ?? 'unknown'}`,
        resultSummary: 'deny encoded to WorkBuddy permission decision (P02 verified blocking)',
      },
    },
    {
      observationKey: `workbuddy|effect|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator,
      kind: 'effect',
      nativeRefs: {
        hostKind: 'workbuddy',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      },
      principleId: input.principleId,
      episodeKey,
      contentRef,
      activationRef,
      payload: {
        status: 'observed',
        observationSummary: `rule ${input.ruleId ?? 'unknown'} denied ${input.toolName}`,
      },
    },
  ];
  appendWorkbuddyBatch(input.workspaceDir, observations, input.warn);
}
