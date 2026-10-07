/**
 * Intervention Evidence Recorder — the OpenClaw source adapter for the PD v2
 * Phase 1 evidence ledger (ADR-0027).
 *
 * ONE module builds OpenClaw observations and appends them through the shared
 * host-runtime ingress; prompt/gate/llm hooks never write evidence tables
 * directly (SPEC §13.7 单一入口). Existing receipt ledger rows, event-log
 * JSONL and trajectory records keep their authority and semantics — this
 * ledger only adds normalized per-event facts.
 *
 * Honesty boundaries encoded here (SPEC §13.4–13.5):
 *   - prompt injection → delivery confirmation 'submitted', outcome
 *     'attempted' (delivery to the host channel; host consumption unproven);
 *   - RuleHost live evaluation → enforcement delivery 'runtime_loaded'/
 *     'delivered' (the enforcement runtime loaded the exact rule);
 *   - a gate block → runtime_verified application with boundary
 *     'pd_gate_block_returned_to_host' (PD decided and returned block —
 *     what is actually provable, not a host-execution claim);
 *   - self-report text → agent_claimed application only.
 *
 * Every write is best-effort: gated by the existing principle_receipt_ledger
 * flag, failure degrades to a structured warn and NEVER changes the hook's
 * allow/deny decision (rc-9 / ADR-0027 §2.4).
 */
import { getInterventionEvidenceIngress } from '@principles/host-runtime';
import { loadFeatureFlagFromConfig } from './pd-config-loader.js';
import type {
  InterventionCapabilityDeclaration,
  InterventionEvidenceBatchInput,
  InterventionObservationInput,
} from '@principles/core/runtime-v2';

/** Evidence adapter surface version (major-series label; exact package version lives in package.json). */
export const OPENCLAW_EVIDENCE_ADAPTER_VERSION = 'openclaw-plugin@2';

type RecorderLogger = { warn?: (message: string) => void; info?: (message: string) => void } | undefined;

function isEvidenceEnabled(workspaceDir: string, logger: RecorderLogger): boolean {
  try {
    return loadFeatureFlagFromConfig(workspaceDir, 'principle_receipt_ledger', logger).enabled;
  } catch {
    return false;
  }
}

/**
 * OpenClaw capability matrix (SPEC §13.6). Declared explicitly — never
 * inferred from record absence. 'supported' entries carry the proof note the
 * contract requires; maxConfirmation states the strongest boundary OpenClaw
 * can actually prove per capability.
 */
function openclawCapabilityDeclarations(): InterventionCapabilityDeclaration[] {
  return [
    {
      hostKind: 'openclaw', capability: 'agent_context_delivery', status: 'supported',
      adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION, channel: 'prompt',
      maxConfirmation: 'submitted',
      note: 'prompt hook returns the rendered principle block to the host; host consumption is not confirmable',
    },
    {
      hostKind: 'openclaw', capability: 'enforcement_delivery', status: 'supported',
      adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION, channel: 'code_tool_hook',
      maxConfirmation: 'runtime_loaded',
      note: 'RuleHost evaluates live activations from state.db artifacts inside the gate path',
    },
    {
      hostKind: 'openclaw', capability: 'application_runtime_verified', status: 'supported',
      adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION, channel: 'code_tool_hook',
      note: 'gate returns block:true to the host (pd_gate_block_returned_to_host boundary)',
    },
    {
      hostKind: 'openclaw', capability: 'application_self_report', status: 'supported',
      adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION, channel: 'prompt',
      note: 'marker parse from llm_output, membership-verified against the session injection set (principle_receipt_self_report flag)',
    },
    {
      hostKind: 'openclaw', capability: 'behavior_observation', status: 'supported',
      adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION, channel: 'code_tool_hook',
      note: 'tool request + gate outcome episodes on live-rule interventions',
    },
    {
      hostKind: 'openclaw', capability: 'outcome_observation', status: 'unknown',
      adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION, channel: 'console',
      note: 'task_outcomes keeps its original meaning; Phase 1 outcomes enter via Owner console input only',
    },
  ];
}

function appendBatch(
  workspaceDir: string,
  observations: InterventionObservationInput[],
  logger: RecorderLogger,
): void {
  if (observations.length === 0) return;
  const ingress = getInterventionEvidenceIngress();
  const batch: InterventionEvidenceBatchInput = {
    evidenceScopeId: ingress.evidenceScopeIdFor(workspaceDir),
    sourceKind: 'openclaw_plugin_event_log',
    adapterVersion: OPENCLAW_EVIDENCE_ADAPTER_VERSION,
    recordedAt: new Date().toISOString(),
    observations,
    capabilityDeclarations: openclawCapabilityDeclarations(),
  };
  const result = ingress.appendObservationBatch({ workspaceDir, batch });
  if (!result.ok) {
    logger?.warn?.(`[PD:Evidence] append degraded: ${result.reason ?? 'unknown'}; next: ${result.nextAction ?? 'replay from durable source'}`);
  }
}

export interface PromptInjectionEvidenceInput {
  workspaceDir: string;
  sessionId?: string;
  runId?: string;
  /** Index-aligned per-principle injection facts (principle/activation/artifact). */
  injected: ReadonlyArray<{ principleId: string; activationId: string; artifactId?: string }>;
  logger?: RecorderLogger;
}

/**
 * Record one agent-context delivery attempt per injected principle. Written
 * at the point the hook has assembled the context it will return to the
 * host — confirmation 'submitted', outcome 'attempted' (delivery unknown).
 */
export function recordPromptDeliveryEvidence(input: PromptInjectionEvidenceInput): void {
  if (!isEvidenceEnabled(input.workspaceDir, input.logger)) return;
  const ingress = getInterventionEvidenceIngress();
  const observations: InterventionObservationInput[] = [];
  for (const entry of input.injected) {
    const activationRef = ingress.resolveActivationOccurrenceRef(input.workspaceDir, entry.activationId);
    if (!activationRef) {
      // Honest gap: without the occurrence snapshot the delivery record
      // cannot satisfy its contract — skip with an observable reason.
      input.logger?.warn?.(`[PD:Evidence] prompt delivery skipped for activation ${entry.activationId}: occurrence snapshot unresolvable`);
      continue;
    }
    observations.push({
      observationKey: `openclaw|delivery|agent_context|${input.sessionId ?? '-'}|${input.runId ?? '-'}|${entry.activationId}`,
      sourceLocator: `openclaw-plugin-event-log:${input.sessionId ?? 'no-session'}`,
      kind: 'delivery',
      nativeRefs: {
        hostKind: 'openclaw',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
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
  appendBatch(input.workspaceDir, observations, input.logger);
}

export interface GateEnforcementEvidenceInput {
  workspaceDir: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  toolName: string;
  filePath?: string;
  activationId?: string;
  principleId?: string;
  ruleId?: string;
  reason?: string;
  decision: 'block' | 'auto_correct';
  logger?: RecorderLogger;
}

/**
 * Record the enforcement chain for one gated tool intervention: enforcement
 * delivery (runtime_loaded), runtime_verified application, behavior episode
 * and effect — one atomic batch with exact cross-references.
 */
export function recordGateEnforcementEvidence(input: GateEnforcementEvidenceInput): void {
  if (!input.activationId || !input.principleId) {
    // Without attribution the chain cannot be recorded honestly; the gap is
    // observable at the call site (legacy PRI-573 warning covers the block row).
    input.logger?.info?.('[PD:Evidence] gate enforcement skipped: decision carries no activation/principle attribution');
    return;
  }
  if (!isEvidenceEnabled(input.workspaceDir, input.logger)) return;
  const ingress = getInterventionEvidenceIngress();
  const activationRef = ingress.resolveActivationOccurrenceRef(input.workspaceDir, input.activationId);
  if (!activationRef) {
    input.logger?.warn?.(`[PD:Evidence] gate enforcement skipped for activation ${input.activationId}: occurrence snapshot unresolvable`);
    return;
  }
  const toolKey = input.toolCallId ?? input.runId ?? `hash:${activationRef.sourceSnapshotDigest.slice(7, 23)}`;
  const sessionPart = input.sessionId ?? '-';
  const episodeKey = `openclaw|episode|${sessionPart}|${toolKey}`;
  const summaryPath = input.filePath ?? '(no-path)';
  const contentRef = {
    principleId: input.principleId,
    ...(activationRef.artifactId ? { artifactId: activationRef.artifactId } : {}),
    payloadDigest: activationRef.sourceSnapshotDigest,
    resolution: 'resolved' as const,
  };
  const observations: InterventionObservationInput[] = [
    {
      observationKey: `openclaw|delivery|enforcement|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator: `openclaw-plugin-event-log:${sessionPart}`,
      kind: 'delivery',
      nativeRefs: {
        hostKind: 'openclaw',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        toolName: input.toolName,
      },
      principleId: input.principleId,
      contentRef,
      activationRef,
      payload: { targetKind: 'runtime_enforcement', confirmation: 'runtime_loaded', outcome: 'delivered' },
    },
    {
      observationKey: `openclaw|application|runtime_verified|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator: `openclaw-plugin-event-log:${sessionPart}`,
      kind: 'application',
      nativeRefs: {
        hostKind: 'openclaw',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        toolName: input.toolName,
      },
      principleId: input.principleId,
      activationRef,
      episodeKey,
      payload: input.decision === 'block'
        ? { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'pd_gate_block_returned_to_host' }
        : { proofMethod: 'runtime_verified', action: 'auto_correct_applied', enforcementBoundary: 'pd_gate_params_returned_to_host' },
    },
    {
      observationKey: episodeKey,
      sourceLocator: `openclaw-plugin-event-log:${sessionPart}`,
      kind: 'behavior_episode',
      nativeRefs: {
        hostKind: 'openclaw',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        toolName: input.toolName,
      },
      payload: {
        status: 'closed',
        actionSummary: `${input.toolName} on ${summaryPath}`,
        resultSummary: input.decision === 'block'
          ? `blocked by rule ${input.ruleId ?? 'unknown'}`
          : `params corrected by rule ${input.ruleId ?? 'unknown'}`,
      },
    },
    {
      observationKey: `openclaw|effect|${sessionPart}|${toolKey}|${input.activationId}`,
      sourceLocator: `openclaw-plugin-event-log:${sessionPart}`,
      kind: 'effect',
      nativeRefs: {
        hostKind: 'openclaw',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        toolName: input.toolName,
      },
      principleId: input.principleId,
      episodeKey,
      contentRef,
      activationRef,
      payload: {
        status: 'observed',
        observationSummary: input.decision === 'block'
          ? `rule ${input.ruleId ?? 'unknown'} blocked ${input.toolName} on ${summaryPath}`
          : `rule ${input.ruleId ?? 'unknown'} corrected ${input.toolName} params on ${summaryPath}`,
      },
    },
  ];
  appendBatch(input.workspaceDir, observations, input.logger);
}

export interface SelfReportEvidenceInput {
  workspaceDir: string;
  sessionId?: string;
  principleId: string;
  activationId?: string;
  claimText: string;
  logger?: RecorderLogger;
}

/**
 * Record an agent self-report as an agent_claimed application — the Agent
 * made a claim; nothing here upgrades it to a runtime fact (ADR-0027 §2.3).
 */
export function recordSelfReportEvidence(input: SelfReportEvidenceInput): void {
  if (!isEvidenceEnabled(input.workspaceDir, input.logger)) return;
  const ingress = getInterventionEvidenceIngress();
  const activationRef = input.activationId
    ? ingress.resolveActivationOccurrenceRef(input.workspaceDir, input.activationId)
    : null;
  const observation: InterventionObservationInput = {
    observationKey: `openclaw|application|agent_claimed|${input.sessionId ?? '-'}|${input.principleId}`,
    sourceLocator: `openclaw-application-ledger:${input.sessionId ?? 'no-session'}`,
    kind: 'application',
    nativeRefs: {
      hostKind: 'openclaw',
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    principleId: input.principleId,
    ...(activationRef ? { activationRef } : {}),
    payload: { proofMethod: 'agent_claimed', action: 'self_reported', claimText: input.claimText.slice(0, 200) },
  };
  appendBatch(input.workspaceDir, [observation], input.logger);
}
