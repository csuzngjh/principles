/**
 * Codex Evidence Recorder — the Codex source adapter for the PD v2 Phase 1
 * evidence ledger (ADR-0027). Mirrors the OpenClaw recorder but keeps the
 * Codex honesty boundaries: the subprocess stdout channel proves
 * 'submitted', never host consumption; v2 rule enforcement stays suspended
 * (PRI-780 — no context provider), so enforcement delivery and
 * runtime_verified application are declared Unknown, not Supported; there
 * is no self-report capture channel on Codex — Unsupported, not faked.
 *
 * All writes flow through the shared host-runtime ingress (SPEC §13.7 单一
 * 入口). Best-effort: degradation produces a bounded stderr diagnostic and
 * never changes the hook result.
 */
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import type {
  InterventionCapabilityDeclaration,
  InterventionEvidenceBatchInput,
  InterventionObservationInput,
} from '@principles/core/runtime-v2';

/** Evidence adapter surface version (major-series label; exact package version lives in package.json). */
export const CODEX_EVIDENCE_ADAPTER_VERSION = 'codex-adapter@2';

export type EvidenceWarn = (diagnosticLine: string) => void;

/**
 * Codex capability matrix (SPEC §13.6) — declared, never inferred from
 * record absence. 'supported' requires a proof note; Unknown is an honest
 * state, not a failure (ADR-0027 §2.4).
 */
export function codexCapabilityDeclarations(): InterventionCapabilityDeclaration[] {
  return [
    {
      hostKind: 'codex', capability: 'agent_context_delivery', status: 'supported',
      adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook:UserPromptSubmit',
      maxConfirmation: 'submitted',
      note: 'additionalContext encoded into the hook stdout hookSpecificOutput; host consumption is not confirmable',
    },
    {
      hostKind: 'codex', capability: 'enforcement_delivery', status: 'unknown',
      adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook:PreToolUse',
      note: 'v2 rule context provider not injected (PRI-780); live rule enforcement stays suspended — no runtime_loaded claims',
    },
    {
      hostKind: 'codex', capability: 'application_runtime_verified', status: 'unknown',
      adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook:PreToolUse',
      note: 'an attributed deny would be recorded after successful stdout encoding; enforcement currently suspended (PRI-780)',
    },
    {
      hostKind: 'codex', capability: 'application_self_report', status: 'unsupported',
      adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook',
      note: 'no self-report capture channel exists on the Codex host; nothing is claimed',
    },
    {
      hostKind: 'codex', capability: 'behavior_observation', status: 'unknown',
      adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION, channel: 'pd-hook:PreToolUse',
      note: 'tool episodes are recorded only on attributed gate interventions, which are currently suspended (PRI-780)',
    },
    {
      hostKind: 'codex', capability: 'outcome_observation', status: 'unknown',
      adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION, channel: 'console',
      note: 'no automated outcome source; Phase 1 outcomes enter via Owner console input only',
    },
  ];
}

function appendCodexBatch(
  workspaceDir: string,
  observations: InterventionObservationInput[],
  warn: EvidenceWarn,
): void {
  if (observations.length === 0) return;
  const ingress = getInterventionEvidenceIngress();
  const batch: InterventionEvidenceBatchInput = {
    evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
    sourceKind: 'codex_pd_hook_event_log',
    adapterVersion: CODEX_EVIDENCE_ADAPTER_VERSION,
    recordedAt: new Date().toISOString(),
    observations,
    capabilityDeclarations: codexCapabilityDeclarations(),
  };
  const result = ingress.appendObservationBatch({ workspaceDir, batch });
  if (!result.ok) {
    warn(`[PD:Evidence] codex append degraded: ${result.reason ?? 'unknown'}; next: ${result.nextAction ?? 'replay from durable source'}`);
  }
}

export interface CodexPromptDeliveryEvidenceInput {
  workspaceDir: string;
  sessionId: string;
  /** Codex turn_id as carried by the injected-event runId (optional). */
  turnId?: string;
  /** Index-aligned per-principle injection facts from the injected event. */
  injected: readonly { principleId: string; activationId: string; artifactId?: string }[];
  evidenceEnabled: boolean;
  warn: EvidenceWarn;
}

/**
 * Record one agent-context delivery attempt per injected principle after the
 * raw injected-event line has been appended to the durable Codex event log —
 * confirmation 'submitted', outcome 'attempted'.
 */
export function recordCodexPromptDeliveryEvidence(input: CodexPromptDeliveryEvidenceInput): void {
  if (!input.evidenceEnabled || input.injected.length === 0) return;
  const ingress = getInterventionEvidenceIngress();
  const observations: InterventionObservationInput[] = [];
  for (const entry of input.injected) {
    const activationRef = ingress.resolveActivationOccurrenceRef(input.workspaceDir, entry.activationId);
    if (!activationRef) {
      input.warn(`[PD:Evidence] codex prompt delivery skipped for activation ${entry.activationId}: occurrence snapshot unresolvable`);
      continue;
    }
    observations.push({
      observationKey: `codex|delivery|agent_context|${input.sessionId}|${input.turnId ?? '-'}|${entry.activationId}`,
      sourceLocator: `codex-pd-hook-event-log:${input.sessionId}`,
      kind: 'delivery',
      nativeRefs: {
        hostKind: 'codex',
        sessionId: input.sessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      },
      principleId: entry.principleId,
      contentRef: {
        principleId: entry.principleId,
        ...(entry.artifactId ? { artifactId: entry.artifactId } : {}),
        payloadDigest: activationRef.sourceSnapshotDigest,
        resolution: 'resolved',
      },
      activationRef,
      payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    });
  }
  appendCodexBatch(input.workspaceDir, observations, input.warn);
}

export interface CodexDenyEvidenceInput {  workspaceDir: string;
  sessionId?: string;
  toolUseId?: string;
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
 * encoded to the Codex stdout channel. The proof boundary is the encoded
 * permissionDecision — PD does not claim the host executed anything broader.
 * Currently dormant while v2 rule enforcement is suspended (PRI-780), but
 * wired so an attributed deny is recorded honestly if one ever occurs.
 */
export function recordCodexDenyEvidence(input: CodexDenyEvidenceInput): void {
  if (!input.activationId || !input.principleId) return;
  if (!input.evidenceEnabled) return;
  const ingress = getInterventionEvidenceIngress();
  const activationRef = ingress.resolveActivationOccurrenceRef(input.workspaceDir, input.activationId);
  if (!activationRef) {
    input.warn(`[PD:Evidence] codex deny chain skipped for activation ${input.activationId}: occurrence snapshot unresolvable`);
    return;
  }
  const toolKey = input.toolUseId ?? `hash:${activationRef.sourceSnapshotDigest.slice(7, 23)}`;
  const sessionPart = input.sessionId ?? '-';
  const episodeKey = `codex|episode|${sessionPart}|${toolKey}`;
  const contentRef = {
    principleId: input.principleId,
    ...(activationRef.artifactId ? { artifactId: activationRef.artifactId } : {}),
    payloadDigest: activationRef.sourceSnapshotDigest,
    resolution: 'resolved' as const,
  };
  const observations: InterventionObservationInput[] = [
    {
      observationKey: `codex|delivery|enforcement|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator: `codex-pd-hook-event-log:${sessionPart}`,
      kind: 'delivery',
      nativeRefs: {
        hostKind: 'codex',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.toolUseId ? { toolCallId: input.toolUseId } : {}),
        toolName: input.toolName,
      },
      principleId: input.principleId,
      contentRef,
      activationRef,
      payload: { targetKind: 'runtime_enforcement', confirmation: 'runtime_loaded', outcome: 'delivered' },
    },
    {
      observationKey: `codex|application|runtime_verified|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator: `codex-pd-hook-event-log:${sessionPart}`,
      kind: 'application',
      nativeRefs: {
        hostKind: 'codex',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.toolUseId ? { toolCallId: input.toolUseId } : {}),
        toolName: input.toolName,
      },
      principleId: input.principleId,
      activationRef,
      episodeKey,
      payload: { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'codex_permission_decision_encoded' },
    },
    {
      observationKey: episodeKey,
      sourceLocator: `codex-pd-hook-event-log:${sessionPart}`,
      kind: 'behavior_episode',
      nativeRefs: {
        hostKind: 'codex',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.toolUseId ? { toolCallId: input.toolUseId } : {}),
        toolName: input.toolName,
      },
      payload: {
        status: 'closed',
        actionSummary: `${input.toolName} denied by rule ${input.ruleId ?? 'unknown'}`,
        resultSummary: 'deny encoded to Codex permission decision',
      },
    },
    {
      observationKey: `codex|effect|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator: `codex-pd-hook-event-log:${sessionPart}`,
      kind: 'effect',
      nativeRefs: {
        hostKind: 'codex',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.toolUseId ? { toolCallId: input.toolUseId } : {}),
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
  appendCodexBatch(input.workspaceDir, observations, input.warn);
}
