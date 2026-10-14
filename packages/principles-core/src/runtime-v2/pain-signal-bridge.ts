import type { RuntimeStateManager, CandidateRecord } from './store/runtime-state-manager.js';
import type { CandidateIntakeService, ReuseRecommendationOutcome } from './candidate-intake-service.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { RunnerResult, RunnerResultStatus } from './runner/runner-result.js';
import type { PDErrorCategory } from './error-categories.js';
import type { CandidateAdmissionResult, AdmissionDecision, PainProvenance } from './admission-gate.js';
import type { DiagnosticianOutputV1 } from './diagnostician-output.js';
import { DiagnosticianOutputV1Schema } from './diagnostician-output.js';
import { Value } from '@sinclair/typebox/value';
import { evaluateCandidateAdmissions, normalizePainProvenance } from './admission-gate.js';
import { shouldShortCircuitEmptyEvidence, isOwnerStatementEvidence } from './evidence-guards.js';
import {
  ADMISSION_POLICY_VERSION,
  fingerprintMaterial,
  fingerprintStatement,
  type AdmissionEvaluationRecord,
  type AdmissionProcessingRecord,
} from './store/candidate/admission-document.js';
import { parseRootCauseCategory } from './store/pain-diagnosis/pain-diagnosis-store.js';
import { buildDreamerSeedFromCandidate, findExistingDreamerTask, ROUTE_CHANNEL_MAP, CANDIDATE_KIND_TO_ROUTE } from './internalization/intake-to-internalization-bridge.js';
import { isRetryWaitBackoffElapsed } from './internalization/internalization-task-guards.js';
import { shapeBridgeResult } from './bridge-result-shaper.js';
import { isPrincipleLedgerEligibleKind } from './store/candidate/recommendation-kind-resolver.js';
import {
  parsePainIngressV1Payload,
  checkIngressTopLevelConsistency,
  deriveProvenanceFromIngressFacts,
  isRecord,
} from './pain-ingress-payload.js';
import type { PainIngressV1Payload } from './pain-ingress-payload.js';
import { sanitizeStringUnbounded } from './evidence-sanitizer.js';
import type { PainCorrectionEvidence } from './context-payload.js';

export type { PainProvenance };

/**
 * Minimal interface for a diagnostician runner.
 * Both DiagnosticianRunner and SplitDiagnosticianRunner satisfy this.
 */
export interface DiagnosticianRunnerLike {
  run(taskId: string): Promise<RunnerResult>;
}

/** PRI-359: Increased from 4 to 8 to accommodate failed tool_calls evidence */
export const MAX_EVIDENCE_ENTRIES = 8;
export const MAX_EVIDENCE_NOTE_CHARS = 200;

/**
 * PRI-844: defensive upper bound for persisted Owner correction text.
 * This is a storage safety limit, NOT semantic truncation — the original
 * correction should remain complete when under the limit, and the whole
 * point of the field is that the Owner's own words survive verbatim.
 */
export const MAX_CORRECTION_EVIDENCE_TEXT_CHARS = 2000;

/** SPEC-CODEX-PAIN-CLOSURE-001 CR-05 (§9.2): automatic post-processing continuation budget. */
export const MAX_POST_PROCESSING_ATTEMPTS = 3;

/**
 * PRI-844: sanitize (strip PD tags / redact tokens / redact absolute paths)
 * without the 200-char generic evidence cap, then apply the defensive
 * storage bound. Deliberately NOT `sanitizeString` — its MAX_EVIDENCE_VALUE_CHARS
 * (200) head-truncation would destroy the verbatim correction this field exists
 * to preserve.
 */
export function boundCorrectionEvidenceText(
  correctionEvidence: PainCorrectionEvidence,
  workspaceDir?: string,
): PainCorrectionEvidence {
  return {
    ...correctionEvidence,
    text: sanitizeStringUnbounded(correctionEvidence.text, workspaceDir)
      .slice(0, MAX_CORRECTION_EVIDENCE_TEXT_CHARS),
  };
}

export interface PainEvidenceEntry {
  sourceRef: string;
  note: string;
}

/**
 * PRI-640 (Host Attribution SPEC §6): which agent host a pain originated from.
 * Observability metadata only — MUST NOT participate in pain identity,
 * admission, diagnosis, approval, or activation. NULL at the persistence
 * layer means legacy / manual / unknown (read models report `unknown`).
 */
export type GovernanceHostKind = 'openclaw' | 'codex';

export interface PainDetectedData {
  painId: string;
  painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  traceId?: string;
  provenance?: PainProvenance;
  /** Codex Governance Closure SPEC §12: provenance `host_context_bound` names the host. */
  hostKind?: GovernanceHostKind;
  evidence?: PainEvidenceEntry[];
  /**
   * PRI-844: the Owner's verbatim correction, when this pain's context
   * contains one. Producers with no correction context leave it absent —
   * absence must never be replaced with fabricated correction text (rc-9).
   * Flows verbatim (defensively bounded) into diagnosticJson so the
   * diagnosis prompt sees the Owner's own words, not a trigger excerpt.
   */
  correctionEvidence?: PainCorrectionEvidence;
  /**
   * PRI-642 SPEC §9: validated rev-2 ingress facts. When present,
   * buildDiagnosticJson writes them under the versioned `painIngress`
   * namespace next to the legacy top-level fields (one builder), and
   * re-entry validates the two against each other.
   */
  painIngress?: PainIngressV1Payload;
}

export type PainSignalBridgeStatus = 'succeeded' | 'skipped' | 'failed' | 'retried' | 'degraded';

/**
 * PRI-539: A candidate that was admitted and ledgered but could not be
 * internalized (e.g. its mapped channel is MVP-disabled). Surfaced so the
 * Owner can see which candidates were dropped and why instead of silently
 * assuming every candidate was internalized (rc-9-no-silent-fallback / ERR-002).
 */
export interface NotInternalizableCandidate {
  candidateId: string;
  reason: string;
}

/**
 * PRI-642 SPEC §10: aggregate progress. `furthestStage` means AT LEAST ONE
 * item reached that stage — never that all candidates did; per-candidate
 * dispositions live in `candidateOutcomes`.
 */
export type PainFurthestStage =
  | 'observed'
  | 'diagnosis_submitted'
  | 'diagnosis_completed'
  | 'candidate_processing'
  | 'internalization_seeded';

export interface PainProgressReport {
  furthestStage: PainFurthestStage;
  generatedCandidateIds: string[];
  admittedCandidateIds: string[];
  ledgerEntryIds: string[];
  seededTaskIds: string[];
}

/** PRI-642 SPEC §10: where each candidate stopped and why. */
export interface PainCandidateOutcome {
  candidateId: string;
  decision: 'admitted' | 'needs_evidence' | 'deferred';
  ledgerEntryId?: string;
  seededTaskId?: string;
  reason: string;
  nextAction: string;
  /**
   * PRI-939 Option A — narrow Owner-visible projection of the auto-path reuse
   * evaluation outcome on a CREATE disposition. `reason` is present ONLY when
   * the evaluation was `unavailable` (bounded to 200 chars): that is the
   * "duplicate protection did not run" signal. A `recommended` outcome that
   * still created means the hook answered create/uncertain. Never persisted —
   * observation only (SPEC v0.3.2 §11), the Owner's verdict stays in
   * reuseEvidence[].
   */
  reuseRecommendation?: ReuseEvaluationOutcomeSignal;
}

/**
 * PRI-939 Option A — bounded projection of the reuse evaluation outcome for
 * Owner-facing result surfaces. Deliberately narrow (status + bounded reason):
 * the full recommendation payload is carried internally by the intake result
 * and surfaced by `pd candidate review`; results here only need to answer
 * "did the semantic gate run, and if not, why".
 */
export interface ReuseEvaluationOutcomeSignal {
  status: 'recommended' | 'unavailable';
  reason?: string;
}

export interface PainSignalBridgeResult {
  status: PainSignalBridgeStatus;
  painId: string;
  taskId: string;
  runnerStatus?: RunnerResultStatus;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  admissionResults?: CandidateAdmissionResult[];
  /** PRI-539: candidates admitted+ledgered but not internalizable (MVP-disabled channel). */
  notInternalizable?: NotInternalizableCandidate[];
  /** PRI-642 §10: aggregate progress (at-least-one semantics). */
  progress?: PainProgressReport;
  /** PRI-642 §10: per-candidate disposition — the authority for mixed results. */
  candidateOutcomes?: PainCandidateOutcome[];
  /**
   * PRI-939 Option A — degradation/observability notes produced while shaping
   * this result (currently: semantic reuse evaluation unavailable on a CREATE
   * path). Merged into the CLI output by PainToPrincipleService; empty/absent
   * when everything ran clean. Observation only — never decision storage.
   */
  observabilityWarnings?: string[];
  errorCategory?: PDErrorCategory;
  message?: string;
  /**
   * PRI-638: recovery action surfaced by the runner. Only set when the failure
   * is an Owner capability decision (Diagnostician disabled), never for runtime
   * or provider faults — the two must remain distinguishable.
   */
  nextAction?: string;
}

export interface PainSignalBridgeOptions {
  stateManager: RuntimeStateManager;
  runner: DiagnosticianRunnerLike;
  intakeService: CandidateIntakeService;
  ledgerAdapter: LedgerAdapter;
  owner?: string;
  autoIntakeEnabled?: boolean;
  /** Workspace directory — written into diagnosticJson so the diagnostician can locate files. */
  workspaceDir?: string;
  /**
   * Pain Diagnosis Persistence: persist the diagnostician's root-cause
   * attribution into state.db pain_diagnoses (keyed by the canonical pain_id)
   * on diagnosis completion. Gated by the `pain_diagnosis_persistence`
   * feature flag — the factory resolves it from effectiveConfig; default
   * false keeps the pre-feature behavior (no writes).
   */
  diagnosisPersistenceEnabled?: boolean;
  /**
   * PRI-720: seed NEW prompt/defer_archive chains with the explicit full-chain
   * topology override (pipelineMode='full_chain') instead of the channel-aware
   * short path. Resolved by the factory from the `prompt_full_pipeline`
   * feature flag (Owner switch: Console settings / .pd/config.yaml). Default
   * false = standard channel-aware topology. Affects only newly seeded chains.
   */
  fullPipelinePromptSeeds?: boolean;
  eventEmitter?: {
    emitTelemetry: (event: { eventType: string; traceId: string; timestamp: string; payload: Record<string, unknown> }) => void;
  };
  /**
   * PRI-624: resources the factory created for this bridge (its extra
   * SqliteConnection) that `dispose()` must release. Long-running workers
   * dispose bridges per cycle so file handles do not pin the workspace DB.
   */
  ownedResources?: readonly { close: () => void | Promise<void> }[];
  /**
   * PRI-638 P1-A: set ONLY by the factory's capability-disabled bridge.
   * While the Owner has switched the Diagnostician off, `onPainDetected` /
   * `executePendingDiagnosis` must ENSURE a durable task exists for new Pain
   * but must NEVER reset/re-trigger an existing task (that would erase
   * retry_wait/failed history and the retry budget). The runner is not
   * invoked, so provider calls stay 0.
   */
  capabilityDisabled?: { readonly reason: string; readonly nextAction: string };
}

export function createDiagnosticianTaskId(painId: string): string {
  return `diagnosis_${painId}`;
}

function severityFromScore(score: number | undefined): string {
  if (score === undefined) return 'moderate';
  if (score >= 70) return 'severe';
  if (score >= 40) return 'moderate';
  return 'mild';
}

/** PRI-624: bounded, validated evidence-count recovery from a submitted task's diagnosticJson (rc-1). */
function countSubmittedEvidence(diagnosticJson: string | undefined): number {
  if (typeof diagnosticJson !== 'string' || diagnosticJson.length === 0) return 0;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0;
    const {evidence} = (parsed as { evidence?: unknown });
    return Array.isArray(evidence) ? evidence.length : 0;
  } catch {
    return 0;
  }
}

/** Owner-explicit sources — mirrors shouldShortCircuitEmptyEvidence and the plugin funnel's MANUAL_SOURCES (PRI-642). */
const OWNER_MANUAL_SOURCES = new Set(['manual', 'pain', 'skill:pain']);

function inferProvenance(data: PainDetectedData): PainProvenance {
  if (OWNER_MANUAL_SOURCES.has(data.source) && (!data.sessionId || data.sessionId === 'cli' || data.sessionId === 'unknown')) {
    return 'owner_reported_no_host_trace';
  }
  if (data.sessionId && data.sessionId !== 'cli' && data.sessionId !== 'unknown') {
    return 'host_context_bound';
  }
  return 'automatic_hook';
}

/**
 * PRI-642 SPEC §9: re-entry validation of the persisted diagnostic payload.
 *
 * The payload is the single authority for admission provenance and the
 * input-evidence count; when the versioned `painIngress` namespace is
 * present it must agree with the legacy top-level fields produced by the
 * same builder.
 *
 * A payload WITHOUT top-level provenance (pre-PRI-453-style raw rows) goes
 * through the SPEC §9 legacy normalization branch: `inferProvenance`
 * re-derives the classification from the payload's OWN persisted fields
 * (`source`, `sessionIdHint`) exactly as the historical writer did. It
 * never fabricates `host_context_bound` — binding is derived only when the
 * payload itself carries a real (non-sentinel) session hint; a manual
 * source without a session normalizes to `owner_reported_no_host_trace`.
 */
function validatePersistedIngressFacts(diagnosticJson: string | undefined): { provenance: PainProvenance; evidenceCount: number; errorCode: null; correctionEvidence?: PainCorrectionEvidence } | { provenance: null; evidenceCount: null; errorCode: string } {
  if (typeof diagnosticJson !== 'string' || diagnosticJson.length === 0) {
    return { provenance: null, evidenceCount: null, errorCode: 'diagnostic_payload_invalid:missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnosticJson);
  } catch {
    return { provenance: null, evidenceCount: null, errorCode: 'diagnostic_payload_invalid:unparseable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { provenance: null, evidenceCount: null, errorCode: 'diagnostic_payload_invalid:not_an_object' };
  }
  if (!isRecord(parsed)) {
    return { provenance: null, evidenceCount: null, errorCode: 'diagnostic_payload_invalid:not_an_object' };
  }
  const record = parsed;

  // CR-02: the persisted correction evidence (including an explicit Owner
  // statement) is part of the re-entry material — validated, never fabricated.
  const persistedCorrection = record.correctionEvidence;
  const correctionEvidence: PainCorrectionEvidence | undefined
    = typeof persistedCorrection === 'object' && persistedCorrection !== null && !Array.isArray(persistedCorrection)
      && typeof (persistedCorrection as Record<string, unknown>).text === 'string'
      && ((persistedCorrection as Record<string, unknown>).text as string).length > 0
      ? persistedCorrection as PainCorrectionEvidence
      : undefined;

  const evidenceCount = countSubmittedEvidence(diagnosticJson);
  const hasProvenanceField = Object.hasOwn(record, 'provenance');
  const provenance = hasProvenanceField ? normalizePainProvenance(record.provenance) : undefined;

  if (Object.hasOwn(record, 'painIngress')) {
    if (provenance === undefined) {
      // A rev-2 payload must carry both namespaces consistently; a missing
      // top-level provenance beside a painIngress block is a contradiction
      // (rc-3), not a legacy row.
      return { provenance: null, evidenceCount: null, errorCode: 'diagnostic_payload_invalid:provenance_missing' };
    }
    const ingress = parsePainIngressV1Payload(record.painIngress);
    if (!ingress.ok) {
      return { provenance: null, evidenceCount: null, errorCode: ingress.reasonCode };
    }
    const mismatch = checkIngressTopLevelConsistency({
      payload: ingress.payload,
      topLevelProvenance: record.provenance,
      topLevelSessionIdHint: Object.hasOwn(record, 'sessionIdHint') ? record.sessionIdHint : null,
      topLevelEvidenceCount: evidenceCount,
    });
    if (mismatch !== null) {
      return { provenance: null, evidenceCount: null, errorCode: mismatch };
    }
    return {
      provenance: deriveProvenanceFromIngressFacts(ingress.payload.origin, ingress.payload.correlation),
      evidenceCount,
      errorCode: null,
      ...(correctionEvidence !== undefined ? { correctionEvidence } : {}),
    };
  }

  // Legacy payload without the v1 namespace: the persisted top-level
  // provenance is the authority. This branch fabricates nothing — it only
  // reads what the writer persisted.
  if (provenance !== undefined) {
    return { provenance, evidenceCount, errorCode: null, ...(correctionEvidence !== undefined ? { correctionEvidence } : {}) };
  }

  // Legacy normalization branch (SPEC §9): no top-level provenance and no
  // painIngress block — re-derive from the payload's own persisted fields
  // exactly as the historical writer did (never a host-bound default).
  const recordData: PainDetectedData = {
    painId: typeof record.sourcePainId === 'string' ? record.sourcePainId : '',
    painType: 'user_frustration',
    source: typeof record.source === 'string' ? record.source : '',
    reason: typeof record.reasonSummary === 'string' ? record.reasonSummary : '',
    sessionId: typeof record.sessionIdHint === 'string' ? record.sessionIdHint : undefined,
  };
  return { provenance: inferProvenance(recordData), evidenceCount, errorCode: null, ...(correctionEvidence !== undefined ? { correctionEvidence } : {}) };
}

function provenanceReason(provenance: PainProvenance): string {
  switch (provenance) {
    case 'host_context_bound':
      return 'Pain reported from an authenticated host session with a bound host context';
    case 'owner_reported_no_host_trace':
      return 'No authenticated host session provenance available for CLI-submitted pain; fullTrace unavailable';
    case 'automatic_hook':
      return 'Pain detected by automatic hook (after_tool_call)';
  }
}

function buildDiagnosticJson(data: PainDetectedData, workspaceDir?: string): string {
  const provenance = data.provenance ?? inferProvenance(data);
  return JSON.stringify({
    sourcePainId: data.painId,
    reasonSummary: data.reason,
    source: data.source,
    severity: severityFromScore(data.score),
    sessionIdHint: data.sessionId ?? null,
    agentIdHint: data.agentId ?? null,
    provenance,
    provenanceReason: provenanceReason(provenance),
    ...(data.hostKind ? { hostKind: data.hostKind } : {}),
    evidence: data.evidence ?? [],
    workspaceDir: workspaceDir ?? null,
    // PRI-844: the Owner's verbatim correction rides as its own top-level
    // field (NOT inside evidence[], whose notes are capped at 200 chars).
    // Absent when the producer had no correction context — never fabricated.
    ...(data.correctionEvidence
      ? { correctionEvidence: boundCorrectionEvidenceText(data.correctionEvidence, workspaceDir) }
      : {}),
    // PRI-642 SPEC §9: one builder produces BOTH the legacy top-level fields
    // and the versioned nested namespace; re-entry validates consistency.
    ...(data.painIngress ? { painIngress: data.painIngress } : {}),
  });
}

/**
 * Pain Diagnosis Persistence: link the diagnostician's root-cause attribution
 * to the canonical pain_id in state.db pain_diagnoses. Runs BEFORE admission
 * so the attribution is durable even when every candidate is later rejected —
 * the pain's diagnosis history must not depend on admission outcome.
 * Persistence is auxiliary to the admission→intake flow: failures degrade
 * observably via telemetry and never break the main pipeline
 * (rc-9-no-silent-fallback).
 *
 * PRI-935: module-level single authority. The bridge's onDiagnosisComplete
 * and the CLI diagnosis paths (`pd diagnose run`, `pd pain retry`) all write
 * through this function so the pain_diagnoses ledger cannot drift per-caller.
 * Callers own the `pain_diagnosis_persistence` flag gate — this function
 * persists whenever invoked.
 */
export async function persistPainDiagnosis(deps: {
  stateManager: RuntimeStateManager;
  eventEmitter?: PainSignalBridgeOptions['eventEmitter'];
}, opts: {
  painId: string;
  taskId: string;
  diagnosticianOutput: DiagnosticianOutputV1;
  artifactId: string | null;
}): Promise<void> {
  const { painId, taskId, diagnosticianOutput, artifactId } = opts;
  const category = parseRootCauseCategory(diagnosticianOutput.rootCause);
  if (!category) {
    deps.eventEmitter?.emitTelemetry({
      eventType: 'pain_diagnosis_persist_skipped',
      traceId: painId,
      timestamp: new Date().toISOString(),
      payload: {
        reason: 'unparseable_root_cause_prefix',
        nextAction: 'Inspect the diagnostician output — rootCause must start with "People: "/"Design: "/"Assumption: "/"Tooling: ".',
        rootCausePreview: diagnosticianOutput.rootCause.slice(0, 80),
      },
    });
    return;
  }
  try {
    await deps.stateManager.recordPainDiagnosis({
      painId,
      taskId,
      diagnosisId: diagnosticianOutput.diagnosisId,
      category,
      rootCause: diagnosticianOutput.rootCause,
      evidence: diagnosticianOutput.evidence,
      confidence: typeof diagnosticianOutput.confidence === 'number' ? diagnosticianOutput.confidence : null,
      artifactId,
    });
  } catch (error) {
    deps.eventEmitter?.emitTelemetry({
      eventType: 'pain_diagnosis_persist_failed',
      traceId: painId,
      timestamp: new Date().toISOString(),
      payload: {
        reason: error instanceof Error ? error.message : String(error),
        nextAction: 'Inspect state.db pain_diagnoses and re-run the diagnosis if the attribution history is required.',
        taskId,
      },
    });
  }
}



/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-03 (§7.2): full-gate re-evaluation from
 * PERSISTED materials only (task diagnosticJson + latest run output), shared
 * by the CLI mutation paths so their write permission can never contradict
 * the production gate on the same material. The evaluation is PERSISTED as a
 * new admission version (append-only; idempotent by material fingerprint).
 */
export async function evaluateAndPersistAdmissionFromStore(
  stateManager: Pick<RuntimeStateManager, 'getTask' | 'getRunsByTask' | 'getRun' | 'getArtifact' | 'getCandidatesByTaskId' | 'appendAdmissionEvaluation'>,
  candidateIds: readonly string[],
  input: { taskId: string },
): Promise<
  { ok: true; decisions: Map<string, { decision: AdmissionDecision; reason: string; nextAction: string }> }
  | { ok: false; reason: string; nextAction: string }
> {
  // SPEC review round-4 P1: resolve the REAL diagnosis lineage. A split-pipeline
  // candidate hangs off the diag_router SUBTASK; the PARENT diagnostician task
  // holds the original pain input (feedback + Owner statement + evidence) and
  // the router subtask's own succeeded runs hold the diagnostic output. A flat
  // pipeline keeps task === ingress === output source. The parent–child relation
  // is validated (subtask.inputRef === parent.taskId, parent kind/status) — a
  // mismatch refuses with a lineage reason instead of re-typing materials.
  const task = await stateManager.getTask(input.taskId);
  if (task === null) return { ok: false, reason: 'task_missing', nextAction: 'the diagnosis task no longer exists; re-run the diagnosis' };
  // Persisted rows always carry task_kind (NOT NULL DDL); an undefined kind
  // can only come from a partial test-double fixture and follows the flat path.
  const isSplitSubtask = typeof task.taskKind === 'string' && task.taskKind.startsWith('diag_');
  let ingressTask = task;
  if (isSplitSubtask) {
    const parentRef = typeof task.inputRef === 'string' ? task.inputRef : '';
    const parent = parentRef.length > 0 ? await stateManager.getTask(parentRef) : null;
    if (parent === null || parent.taskKind !== 'diagnostician' || parentRef !== task.inputRef || parent.status !== 'succeeded') {
      return { ok: false, reason: 'diagnosis_lineage_inconsistent', nextAction: 'the router subtask does not resolve to a succeeded diagnostician parent; re-run the diagnosis before intake' };
    }
    ingressTask = parent;
  } else if (typeof task.taskKind === 'string' && task.taskKind !== 'diagnostician') {
    return { ok: false, reason: 'diagnosis_lineage_inconsistent', nextAction: `candidate task kind '${task.taskKind}' is not a diagnostician task or split stage; re-run the diagnosis` };
  }
  const reentry = validatePersistedIngressFacts(ingressTask.diagnosticJson);
  if (reentry.errorCode !== null) {
    return { ok: false, reason: reentry.errorCode, nextAction: 'the persisted diagnosis payload is unusable; re-run the diagnosis before intake' };
  }
  const parseV1 = (payload: string | undefined | null): DiagnosticianOutputV1 | undefined => {
    if (typeof payload !== 'string' || payload.length === 0) return undefined;
    try {
      const parsedOutput: unknown = JSON.parse(payload);
      return Value.Check(DiagnosticianOutputV1Schema, parsedOutput) ? parsedOutput : undefined;
    } catch {
      return undefined;
    }
  };
  const ownerStatementPresent = isOwnerStatementEvidence(reentry.correctionEvidence);
  const candidates = (await stateManager.getCandidatesByTaskId(ingressTask.taskId))
    .filter((candidate) => candidateIds.includes(candidate.candidateId))
    .filter((candidate) => candidate.taskId === input.taskId || candidate.taskId === ingressTask.taskId);
  if (candidates.length !== candidateIds.length) {
    return { ok: false, reason: 'diagnosis_lineage_inconsistent', nextAction: 'requested candidates do not resolve through the validated diagnosis lineage; re-run the diagnosis' };
  }

  /**
   * SPEC review round-4 P1 (round binding): the diagnostic output is resolved
   * PER CANDIDATE from that candidate's OWN `source_run_id`, cross-checked
   * against its `artifact_id` + `task_id`. The previous shape picked the first
   * parseable run by reverse task order and evaluated EVERY candidate against
   * that one shared output, so a later round (r2) silently rewrote an earlier
   * round's (r1) admission basis — confidence, evidence count and material
   * fingerprint all came from the wrong diagnosis.
   *
   * Fail-closed (rc-3/rc-9): a missing run row, a non-succeeded run, a
   * run/task mismatch, an artifact that belongs to a different run, or an
   * unparseable owning output refuses the candidate. It NEVER falls back to
   * another historical successful run of the same task — substituting a
   * different round's material is the exact defect being closed.
   */
  type ResolvedRound = { output: DiagnosticianOutputV1; sourceRunId: string; artifactId: string };
  const resolveOwningRound = async (candidate: { candidateId: string; sourceRunId: string; artifactId: string; taskId: string }):
    Promise<{ ok: true; round: ResolvedRound } | { ok: false; reason: string }> => {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    const sourceRunId = typeof candidate.sourceRunId === 'string' ? candidate.sourceRunId : '';
    if (sourceRunId.length === 0) {
      return refuse(`candidate_round_unresolved:${candidate.candidateId}:missing_source_run_id`);
    }
    let run;
    try {
      run = await stateManager.getRun(sourceRunId);
    } catch {
      return refuse(`candidate_round_unresolved:${candidate.candidateId}:source_run_lookup_failed`);
    }
    // Defensive null/undefined: the store contract is `RunRecord | null`, but
    // a partial or throwing-adjacent implementation can yield undefined — and
    // a crash here would abort the whole gate instead of refusing this one
    // candidate. Treat both as "the owning run is missing".
    if (run === null || run === undefined) {
      return refuse(`candidate_round_unresolved:${candidate.candidateId}:source_run_missing`);
    }
    if (run.taskId !== candidate.taskId) {
      return refuse(`candidate_round_unresolved:${candidate.candidateId}:source_run_task_mismatch`);
    }
    if (run.executionStatus !== 'succeeded') {
      return refuse(`candidate_round_unresolved:${candidate.candidateId}:source_run_not_succeeded`);
    }
    const artifactId = typeof candidate.artifactId === 'string' ? candidate.artifactId : '';
    if (artifactId.length > 0) {
      let artifact;
      try {
        artifact = await stateManager.getArtifact(artifactId);
      } catch {
        return refuse(`candidate_round_unresolved:${candidate.candidateId}:artifact_lookup_failed`);
      }
      // A missing artifact row (null OR undefined) is tolerated for
      // pre-artifact candidates, but a PRESENT artifact belonging to another
      // run/task is lineage corruption and refuses. The truthiness check keeps
      // a partial implementation from crashing the gate.
      if (artifact && (artifact.runId !== sourceRunId || artifact.taskId !== candidate.taskId)) {
        return refuse(`candidate_round_unresolved:${candidate.candidateId}:artifact_run_mismatch`);
      }
    }
    const output = parseV1(run.outputPayload);
    if (output === undefined) {
      return refuse(`candidate_round_unresolved:${candidate.candidateId}:owning_output_unparseable`);
    }
    return { ok: true, round: { output, sourceRunId, artifactId } };
  };

  // Resolve EVERY candidate's own round BEFORE any evaluation, so a single
  // unresolved round refuses the whole call with zero writes instead of
  // partially persisting a mixed-round admission set.
  const resolvedRounds = new Map<string, ResolvedRound>();
  for (const candidate of candidates) {
    const resolved = await resolveOwningRound(candidate);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: 'candidate_diagnosis_round_unresolved',
        nextAction: `candidate ${candidate.candidateId} does not resolve to its own diagnosis run output (${resolved.reason}); re-run the diagnosis for this round before intake`,
      };
    }
    resolvedRounds.set(candidate.candidateId, resolved.round);
  }

  const decisions = new Map<string, { decision: AdmissionDecision; reason: string; nextAction: string }>();
  const evaluatedAt = new Date().toISOString();
  for (const candidate of candidates) {
    const round = resolvedRounds.get(candidate.candidateId);
    if (round === undefined) continue;
    const {output} = round;
    // The fingerprint is computed from THIS candidate's own material, so two
    // rounds never collide on the same idempotency key.
    const materialFingerprint = fingerprintMaterial([
      JSON.stringify(output),
      reentry.provenance,
      String(reentry.evidenceCount),
      ownerStatementPresent && reentry.correctionEvidence ? fingerprintStatement(reentry.correctionEvidence.text) : 'no-owner-statement',
      round.sourceRunId,
      candidate.candidateId,
    ]);
    const [admission] = evaluateCandidateAdmissions([candidate], output, {
      provenance: reentry.provenance,
      inputEvidenceCount: reentry.evidenceCount,
      ...(ownerStatementPresent ? { ownerStatementPresent } : {}),
    });
    if (admission === undefined) continue;
    decisions.set(candidate.candidateId, {
      decision: admission.admission.decision,
      reason: admission.admission.reason,
      nextAction: admission.admission.nextAction,
    });
    const persisted = await stateManager.appendAdmissionEvaluation(candidate.candidateId, {
      evaluationId: `ae_${fingerprintMaterial([candidate.candidateId, materialFingerprint, ADMISSION_POLICY_VERSION]).slice(0, 16)}`,
      decision: admission.admission.decision,
      reason: admission.admission.reason,
      nextAction: admission.admission.nextAction,
      evaluatedAt,
      policyVersion: ADMISSION_POLICY_VERSION,
      provenance: reentry.provenance,
      inputEvidenceCount: reentry.evidenceCount,
      ownerStatementPresent,
      recommendationKind: candidate.rawRecommendationKind,
      confidence: output.confidence,
      materialFingerprint,
      materialSummary: {
        inputEvidenceCount: reentry.evidenceCount,
        outputEvidenceCount: output.evidence.length,
        ownerStatementPresent,
        ...(ownerStatementPresent && reentry.correctionEvidence ? { statementFingerprint: fingerprintStatement(reentry.correctionEvidence.text) } : {}),
      },
    });
    if (persisted.status === 'refused') {
      return { ok: false, reason: `admission_persistence_failed:${persisted.reason}`, nextAction: 'inspect state.db principle_candidates; the evaluation was not saved and intake is blocked' };
    }
  }
  return { ok: true, decisions };
}

export class PainSignalBridge {
  private readonly stateManager: RuntimeStateManager;
  private readonly runner: DiagnosticianRunnerLike;
  private readonly intakeService: CandidateIntakeService;
  private readonly ledgerAdapter: LedgerAdapter;
  private readonly owner: string;
  private readonly autoIntakeEnabled: boolean;
  private readonly diagnosisPersistenceEnabled: boolean;
  private readonly fullPipelinePromptSeeds: boolean;
  private readonly workspaceDir: string | undefined;
  private readonly eventEmitter?: PainSignalBridgeOptions['eventEmitter'];
  private readonly ownedResources: readonly { close: () => void | Promise<void> }[];
  private readonly capabilityDisabled: PainSignalBridgeOptions['capabilityDisabled'];

  constructor(opts: PainSignalBridgeOptions) {
    this.stateManager = opts.stateManager;
    this.runner = opts.runner;
    this.intakeService = opts.intakeService;
    this.ledgerAdapter = opts.ledgerAdapter;
    this.owner = opts.owner ?? 'pain-signal-bridge';
    this.autoIntakeEnabled = opts.autoIntakeEnabled ?? true;
    this.diagnosisPersistenceEnabled = opts.diagnosisPersistenceEnabled ?? false;
    this.fullPipelinePromptSeeds = opts.fullPipelinePromptSeeds ?? false;
    this.workspaceDir = opts.workspaceDir;
    this.eventEmitter = opts.eventEmitter;
    this.ownedResources = opts.ownedResources ?? [];
    this.capabilityDisabled = opts.capabilityDisabled;
  }

  /**
   * PRI-638 P1-A: the unified disabled outcome. `status: 'failed'` is kept
   * (existing RunnerResult vocabulary) but carries `capability_missing` +
   * `nextAction`, so no caller can mistake it for a provider/runtime fault.
   */
  private disabledResult(input: { painId: string; taskId: string }): PainSignalBridgeResult {
    return {
      status: 'failed',
      painId: input.painId,
      taskId: input.taskId,
      candidateIds: [],
      ledgerEntryIds: [],
      errorCategory: 'capability_missing',
      message: this.capabilityDisabled?.reason ?? 'Diagnostician capability is disabled by Owner configuration',
      nextAction: this.capabilityDisabled?.nextAction,
    };
  }

  /**
   * PRI-624: release every handle this bridge holds (state manager + the
   * factory-owned connection). Callers that keep the cached bridge (plugin
   * host process) may skip this; per-cycle workers MUST dispose to avoid
   * pinning the workspace SQLite files.
   */
  /**
   * SPEC-CODEX-PAIN-CLOSURE-001 CR-05 (SPEC §9.1): continue the post-processing
   * of a SUCCEEDED diagnosis whose candidates never finished admission /
   * intake / seeding (crash between router `markTaskSucceeded` and this
   * bridge's post-processing, intake/seed exceptions, consumed-but-unseeded
   * orphans, pre-CR-03 rows with no persisted disposition).
   *
   * Hard guarantees:
   *   - NEVER re-runs the diagnosis LLM (materials come from the persisted
   *     run output + diagnosticJson);
   *   - idempotent (Ledger writes dedup via existsForCandidate, seeds dedup
   *     via findExistingDreamerTask, admission appends dedup by material
   *     fingerprint);
   *   - bounded (candidates whose processing state is terminal — complete /
   *     awaiting_owner / exhausted — are skipped and reported, not rescanned);
   *   - read/CLI paths never call this; only the worker continuation does.
   */
  async resumeSucceededDiagnosisPostProcessing(input: { taskId: string }): Promise<{
    status: 'resumed' | 'not_applicable' | 'blocked';
    reason?: string;
    nextAction?: string;
    result?: PainSignalBridgeResult;
    processedCandidateIds?: string[];
    skipped?: { candidateId: string; reason: string }[];
    remainingCount?: number;
  }> {
    const task = await this.stateManager.getTask(input.taskId);
    if (task === null) return { status: 'not_applicable', reason: 'task_missing' };
    if (task.status !== 'succeeded') return { status: 'not_applicable', reason: `task_not_succeeded:${task.status}` };

    const candidates = await this.stateManager.getCandidatesByTaskId(input.taskId);
    if (candidates.length === 0) return { status: 'not_applicable', reason: 'no_candidates' };

    // Reconstruct the persisted diagnosis materials (output + ingress facts +
    // correction evidence) — exactly what a fresh post-processing round sees.
    const reentry = validatePersistedIngressFacts(task.diagnosticJson);
    if (reentry.errorCode !== null) {
      // SPEC §9.2 (review round-3 P1):确定无效材料不得每周期反复占预算。每个
      // 候选持久化一条 needs_evidence 处置（材料不可解析）+ exhausted 终态，
      // backlog 不再返回；原因与恢复入口（修复诊断）可查、可恢复。
      const blockedAt = new Date().toISOString();
      for (const candidate of candidates) {
        try {
          await this.stateManager.appendAdmissionEvaluation(candidate.candidateId, {
            evaluationId: `ae_blocked_${fingerprintMaterial([candidate.candidateId, reentry.errorCode]).slice(0, 16)}`,
            decision: 'needs_evidence',
            reason: `diagnostic_material_unusable:${reentry.errorCode}`,
            nextAction: 'repair or re-run the diagnosis via the supported CLI command; the candidate resumes automatically afterwards',
            evaluatedAt: blockedAt,
            policyVersion: ADMISSION_POLICY_VERSION,
            provenance: 'automatic_hook',
            inputEvidenceCount: 0,
            ownerStatementPresent: false,
            recommendationKind: candidate.rawRecommendationKind,
            confidence: null,
            materialFingerprint: fingerprintMaterial(['unusable', reentry.errorCode]),
            materialSummary: { inputEvidenceCount: 0, outputEvidenceCount: 0, ownerStatementPresent: false },
          });
          await this.stateManager.updateAdmissionProcessing(candidate.candidateId, {
            state: 'exhausted',
            attempts: MAX_POST_PROCESSING_ATTEMPTS,
            blockedReason: `diagnostic_material_unusable:${reentry.errorCode}`,
          });
        } catch {
          // persistence of the terminal state itself failed → stay scannable
          // (rc-9: the next cycle retries this bookkeeping)
        }
      }
      return { status: 'blocked', reason: reentry.errorCode, nextAction: 'the persisted diagnosis payload is unusable; repair or re-run the diagnosis via the supported CLI command (candidates recorded terminal manual_action_required states)' };
    }
    const runs = await this.stateManager.getRunsByTask(input.taskId);
    let output: DiagnosticianOutputV1 | undefined;
    const parseV1 = (payload: string | undefined | null): DiagnosticianOutputV1 | undefined => {
      if (typeof payload !== 'string' || payload.length === 0) return undefined;
      try {
        const parsedOutput: unknown = JSON.parse(payload);
        return Value.Check(DiagnosticianOutputV1Schema, parsedOutput) ? parsedOutput : undefined;
      } catch {
        return undefined;
      }
    };
    // SPEC §9.1 (review P1): the split pipeline commits candidates from the
    // diag_router SUBTASK — the router's latest run output is the authoritative
    // diagnostician output for continuation. The parent task's own run output
    // is only a fallback for legacy flat pipelines (never a cache bypass: both
    // sources are validated DiagnosticianOutputV1 persisted by the real run).
    const routerRuns = await this.stateManager.getRunsByTask(`diag_router-${input.taskId}`);
    for (let i = routerRuns.length - 1; i >= 0 && output === undefined; i -= 1) {
      output = parseV1(routerRuns[i]?.outputPayload);
    }
    if (output === undefined) {
      const latestRun = runs.at(-1);
      output = parseV1(latestRun?.outputPayload);
    }

    // Skip candidates whose processing domain says the work is finished or
    // blocked-with-budget-spent; they stay visible in `skipped`.
    const skipped: { candidateId: string; reason: string }[] = [];
    const eligible: typeof candidates = [];
    for (const candidate of candidates) {
      const admission = await this.stateManager.getAdmissionDocument(candidate.candidateId);
      if (!admission.ok) {
        skipped.push({ candidateId: candidate.candidateId, reason: `admission_document_unreadable:${admission.reason}` });
        continue;
      }
      const processingState = admission.document?.processing?.state;
      if (processingState === 'complete' || processingState === 'awaiting_owner' || processingState === 'exhausted') {
        skipped.push({ candidateId: candidate.candidateId, reason: `processing_${processingState}` });
        continue;
      }
      eligible.push(candidate);
    }
    if (eligible.length === 0) {
      return { status: 'not_applicable', reason: 'no_eligible_candidates', skipped, remainingCount: 0 };
    }

    const result = await this.onDiagnosisComplete({
      taskId: input.taskId,
      diagnosticianOutput: output,
      painId: typeof task.inputRef === 'string' && task.inputRef.length > 0 ? task.inputRef : `diagnosis-source:${input.taskId}`,
      provenance: reentry.provenance,
      inputEvidenceCount: reentry.evidenceCount,
      ...(reentry.correctionEvidence !== undefined ? { correctionEvidence: reentry.correctionEvidence } : {}),
    });
    return {
      status: 'resumed',
      result,
      processedCandidateIds: eligible.map((c) => c.candidateId),
      skipped,
      remainingCount: 0,
    };
  }

  async dispose(): Promise<void> {
    for (const resource of this.ownedResources) {
      try { await resource.close(); } catch { /* best-effort cleanup */ }
    }
    await this.stateManager.close();
  }

  private emitAdmissionEvent(
    candidateId: string,
    admission: { decision: AdmissionDecision; reason: string; nextAction: string },
  ): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emitTelemetry({
      eventType: 'candidate_admission_decision',
      traceId: candidateId,
      timestamp: new Date().toISOString(),
      payload: { decision: admission.decision, reason: admission.reason, nextAction: admission.nextAction },
    });
  }

  /**
   * Submit a pain signal without running diagnosis.
   * Creates the task as 'pending' for later execution by orchestrator wakeOnce/recovery-sweep.
   * Returns the taskId for progress tracking.
   * PRI-369: async pain-record CLI — fire-and-forget submission.
   */
  async submitPainSignal(data: PainDetectedData): Promise<{ taskId: string }> {
    const taskId = data.taskId ?? createDiagnosticianTaskId(data.painId);
    const diagnosticJson = buildDiagnosticJson(data, this.workspaceDir);

    await this.stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      inputRef: data.painId,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson,
    });

    return { taskId };
  }

  async onPainDetected(data: PainDetectedData): Promise<PainSignalBridgeResult> {
    const { painId } = data;
    const taskId = data.taskId ?? createDiagnosticianTaskId(painId);
    const provenance = data.provenance ?? inferProvenance(data);

    // PRI-638 P1-A: while the Owner has disabled the Diagnostician, this call
    // only ENSURES a durable diagnosis task exists for new Pain. It must NOT
    // reuse the re-trigger semantics below — an existing retry_wait / failed /
    // needs_human_review task keeps its status, attemptCount, lastError and
    // lease untouched (durable history preserved, retry budget preserved), and
    // the disabled runner is never invoked (provider calls stay 0).
    if (this.capabilityDisabled !== undefined) {
      const existing = await this.stateManager.getTask(taskId);
      if (existing === null) {
        await this.stateManager.createTask({
          taskId,
          taskKind: 'diagnostician',
          inputRef: painId,
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
          diagnosticJson: buildDiagnosticJson(data, this.workspaceDir),
        });
      } else if (existing.status === 'succeeded') {
        return this.buildExistingResult({ painId, taskId });
      }
      return this.disabledResult({ painId, taskId });
    }

    // Check for existing task FIRST — idempotency takes priority over short-circuit
    const existingTask = await this.stateManager.getTask(taskId);

    // PRI-345: short-circuit before any I/O when input evidence is empty
    // and source is not owner-initiated (manual/pain/skill:pain).
    // Zero side effects: no task creation, no runner call, no ledger writes.
    // IMPORTANT: Only short-circuit when there is NO existing task — idempotency must work.
    if (!existingTask && !isOwnerStatementEvidence(data.correctionEvidence)
        && shouldShortCircuitEmptyEvidence(data.evidence?.length ?? 0, data.source)) {
      return {
        status: 'skipped',
        painId,
        taskId,
        candidateIds: [],
        ledgerEntryIds: [],
        message: 'short_circuited: input evidence empty; re-trigger after evidence collected',
      };
    }

    if (existingTask) {
      const { status, leaseExpiresAt } = existingTask;
      const LEASE_TTL_MS = 300_000;
      const leaseExpired = leaseExpiresAt && (Date.now() - new Date(leaseExpiresAt).getTime()) > LEASE_TTL_MS;
      if (status === 'succeeded') {
        return this.buildExistingResult({ painId, taskId });
      }
      if (status === 'leased' && !leaseExpired) {
        return {
          status: 'skipped',
          painId,
          taskId,
          candidateIds: [],
          ledgerEntryIds: [],
          message: 'Task is already leased',
        };
      }
      if (status === 'leased' && leaseExpired) {
        // fall through
      } else {
        await this.stateManager.updateTask(taskId, {
          status: 'pending',
          attemptCount: 0,
          lastError: null,
          resultRef: null,
        });
      }
    } else {
      const diagnosticJson = buildDiagnosticJson(data, this.workspaceDir);
      await this.stateManager.createTask({
        taskId,
        taskKind: 'diagnostician',
        inputRef: painId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        diagnosticJson,
      });
    }

    const result = await this.runner.run(taskId);

    if (result.status !== 'succeeded') {
      // PRI-638: the task is deliberately left in its prior state (pending /
      // retry_wait) with its attemptCount untouched. A capability-disabled run
      // is not a failed attempt, so it must never consume LLM retry budget.
      return {
        status: result.status === 'retried' ? 'retried' : 'failed',
        painId,
        taskId,
        runnerStatus: result.status,
        candidateIds: [],
        ledgerEntryIds: [],
        errorCategory: result.errorCategory,
        message: result.failureReason,
        ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
      };
    }

    return this.onDiagnosisComplete({
      taskId,
      diagnosticianOutput: result.output,
      painId,
      provenance,
      inputEvidenceCount: data.evidence?.length ?? 0,
      ...(data.correctionEvidence !== undefined ? { correctionEvidence: data.correctionEvidence } : {}),
    });
  }

  /**
   * PRI-624 (Codex Closure Slice C): execute one already-submitted
   * Diagnostician task — the async counterpart of `submitPainSignal`. A
   * worker (Companion) or CLI uses this to advance a task that Slice B
   * admission enqueued without running an LLM in the hook.
   *
   * Unlike `onPainDetected` this NEVER resets task state: a worker retry
   * loop must preserve the retry budget (attemptCount/maxAttempts) exactly
   * like the peer-runner consumers do. The lease is acquired inside
   * `runner.run` via the existing Runtime V2 lease manager.
   *
   * Eligibility: 'pending', or 'retry_wait' whose backoff deadline
   * (lease_expires_at) has elapsed (isRetryWaitBackoffElapsed — the same
   * guard wakeOnce applies). 'leased' is skipped — the existing lease wins;
   * expired leases are the recovery sweep's job, not ours. 'succeeded'
   * returns the existing result (idempotent). 'failed' /
   * 'needs_human_review' are skipped: terminal states need explicit
   * Owner/manual action, never silent worker retries.
   */
  async executePendingDiagnosis(input: {
    taskId: string;
    /**
     * @deprecated PRI-642 SPEC §9: re-entry reads the provenance from the
     * persisted task payload; a caller-supplied value no longer overrides
     * it (no host-binding defaults, single authority).
     */
    provenance?: PainProvenance;
  }): Promise<PainSignalBridgeResult> {
    const { taskId } = input;
    // PRI-638 P1-A: on a capability-disabled bridge execution is paused, never
    // failed. The task keeps its exact durable state (including retry budget);
    // no runner invocation, so provider calls stay 0. Callers should normally
    // gate on the canonical capability before reaching here (Codex worker
    // does), this is the defensive seam.
    if (this.capabilityDisabled !== undefined) {
      const task = await this.stateManager.getTask(taskId);
      if (task === null) {
        return { status: 'failed', painId: '', taskId, candidateIds: [], ledgerEntryIds: [], errorCategory: 'input_invalid', message: 'task_not_found' };
      }
      const painId = typeof task.inputRef === 'string' && task.inputRef.length > 0 ? task.inputRef : taskId;
      if (task.status === 'succeeded') {
        return this.buildExistingResult({ painId, taskId });
      }
      return this.disabledResult({ painId, taskId });
    }
    const task = await this.stateManager.getTask(taskId);
    if (task === null) {
      return { status: 'failed', painId: '', taskId, candidateIds: [], ledgerEntryIds: [], errorCategory: 'input_invalid', message: 'task_not_found' };
    }
    const painId = typeof task.inputRef === 'string' && task.inputRef.length > 0 ? task.inputRef : taskId;
    if (task.status === 'succeeded') {
      return this.buildExistingResult({ painId, taskId });
    }
    if (task.status === 'leased') {
      return { status: 'skipped', painId, taskId, candidateIds: [], ledgerEntryIds: [], message: 'task_already_leased' };
    }
    if (task.status === 'failed' || task.status === 'needs_human_review') {
      return { status: 'skipped', painId, taskId, candidateIds: [], ledgerEntryIds: [], message: `task_${task.status}` };
    }
    if (!isRetryWaitBackoffElapsed(task.status, task.leaseExpiresAt)) {
      return { status: 'skipped', painId, taskId, candidateIds: [], ledgerEntryIds: [], message: 'retry_wait_pending' };
    }

    // PRI-642 SPEC §9: re-entry validates the persisted rev-2 facts BEFORE
    // any LLM run — the payload is the authority for provenance/correlation
    // (never a host_context_bound default), and a nested/top-level
    // contradiction is rejected instead of silently resolved.
    const reentry = validatePersistedIngressFacts(task.diagnosticJson);
    if (reentry.errorCode !== null) {
      return {
        status: 'failed',
        painId,
        taskId,
        candidateIds: [],
        ledgerEntryIds: [],
        errorCategory: 'input_invalid',
        message: reentry.errorCode,
      };
    }

    const result = await this.runner.run(taskId);
    if (result.status !== 'succeeded') {
      // PRI-638: the task is deliberately left in its prior state (pending /
      // retry_wait) with its attemptCount untouched. A capability-disabled run
      // is not a failed attempt, so it must never consume LLM retry budget.
      return {
        status: result.status === 'retried' ? 'retried' : 'failed',
        painId,
        taskId,
        runnerStatus: result.status,
        candidateIds: [],
        ledgerEntryIds: [],
        errorCategory: result.errorCategory,
        message: result.failureReason,
        ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
      };
    }
    return this.onDiagnosisComplete({
      taskId,
      diagnosticianOutput: result.output,
      painId,
      provenance: reentry.provenance,
      inputEvidenceCount: reentry.evidenceCount,
      ...(reentry.correctionEvidence !== undefined ? { correctionEvidence: reentry.correctionEvidence } : {}),
    });
  }

  /** Fire-and-forget processing-domain update that must never break the loop (sync-safe). */
  private safeUpdateAdmissionProcessing(candidateId: string, processing: AdmissionProcessingRecord): void {
    try {
      void this.stateManager.updateAdmissionProcessing(candidateId, processing).catch(() => undefined);
    } catch {
      // partial state-manager seams (test doubles) may not implement the
      // processing domain; the primary outcome path stays authoritative
    }
  }

  /**
   * SPEC-CODEX-PAIN-CLOSURE-001 CR-05 (§9.2): bounded post-processing
   * failure bookkeeping in the independent processing domain. Default budget
   * is 3 automatic continuation attempts; exhaustion is a saved, readable
   * terminal state (manual_action_required), never a silent loop. The
   * diagnosis task's own attemptCount is never consumed by this.
   */
  private async recordPostProcessingFailure(candidateId: string, rawReason: string): Promise<void> {
    try {
      const read = await this.stateManager.getAdmissionDocument(candidateId);
      if (!read.ok) return;
      const current = read.document?.processing;
      const attempts = (current?.attempts ?? 0) + 1;
      const nowIso = new Date().toISOString();
      const reason = rawReason.slice(0, 300);
      const processing: AdmissionProcessingRecord = attempts >= MAX_POST_PROCESSING_ATTEMPTS
        ? {
          state: 'exhausted',
          attempts,
          lastAttemptAt: nowIso,
          lastFailure: { reason, nextAction: 'manual_action_required: post-processing retry budget exhausted; inspect state.db principle_candidates and telemetry, then use the supported recovery command', at: nowIso },
          blockedReason: `post_processing_attempts_exhausted:${rawReason.slice(0, 120)}`,
        }
        : {
          state: 'in_progress',
          attempts,
          lastAttemptAt: nowIso,
          lastFailure: { reason, nextAction: 'the workspace worker continuation retries this candidate automatically', at: nowIso },
          nextRetryAt: new Date(Date.now() + Math.min(60_000 * 2 ** attempts, 15 * 60_000)).toISOString(),
        };
      await this.stateManager.updateAdmissionProcessing(candidateId, processing);
    } catch {
      // telemetry for the failure itself was already emitted by the caller;
      // this bookkeeping must never mask the original processing result.
    }
  }

  /**
   * PRI-372 (T-G): Post-diagnosis processing extracted from onPainDetected().
   * Handles admission → intake → seedDreamer after a successful diagnosis.
   * Reached only via onPainDetected / re-run above — DiagRouterRunner does
   * NOT call it (INF-9, PRI-857): the router only commits stage output.
   */
  async onDiagnosisComplete(opts: {
    taskId: string;
    diagnosticianOutput: DiagnosticianOutputV1 | undefined;
    painId: string;
    provenance: PainProvenance;
    inputEvidenceCount?: number;
    /** SPEC-CODEX-PAIN-CLOSURE-001 CR-02: the pain's correction evidence, when one was submitted. */
    correctionEvidence?: PainCorrectionEvidence;
  }): Promise<PainSignalBridgeResult> {
    const { taskId, diagnosticianOutput, painId, provenance, inputEvidenceCount = 0, correctionEvidence } = opts;
    const ownerStatementPresent = isOwnerStatementEvidence(correctionEvidence);
    const statementFingerprint = ownerStatementPresent && correctionEvidence ? fingerprintStatement(correctionEvidence.text) : undefined;
    const candidates: CandidateRecord[] = await this.stateManager.getCandidatesByTaskId(taskId);
    const ledgerEntryIds: string[] = [];

    if (this.diagnosisPersistenceEnabled && diagnosticianOutput) {
      await persistPainDiagnosis(
        { stateManager: this.stateManager, eventEmitter: this.eventEmitter },
        {
          painId,
          taskId,
          diagnosticianOutput,
          artifactId: candidates[0]?.artifactId ?? null,
        },
      );
    }

    const admissionResults = diagnosticianOutput
      ? evaluateCandidateAdmissions(candidates, diagnosticianOutput, { provenance, inputEvidenceCount, ...(ownerStatementPresent ? { ownerStatementPresent } : {}) })
      : candidates.map((c) => ({
          candidateId: c.candidateId,
          recommendationKind: c.recommendationKind,
          admission: {
            decision: 'needs_evidence' as const,
            reason: 'diagnostician_output_unavailable',
            nextAction: 're_run_diagnosis_or_manual_review',
            evidenceStatus: provenance,
          },
        }));

    // SPEC-CODEX-PAIN-CLOSURE-001 CR-03 (PRI-958): persist every full-gate
    // disposition on the candidate row BEFORE any intake/seed/consume write.
    // A persistence failure must block this candidate's governance writes for
    // the round (SPEC §7.1) — the diagnosis-success fact itself is untouched.
    const admissionPersistBlocked = new Set<string>();
    if (candidates.length > 0) {
      const evaluatedAt = new Date().toISOString();
      const materialFingerprint = fingerprintMaterial([
        diagnosticianOutput ? JSON.stringify(diagnosticianOutput) : 'output-unavailable',
        provenance,
        String(inputEvidenceCount),
        statementFingerprint ?? 'no-owner-statement',
      ]);
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const admission = admissionResults[i];
        if (!candidate || !admission) continue;
        const evaluation: AdmissionEvaluationRecord = {
          evaluationId: `ae_${fingerprintMaterial([candidate.candidateId, materialFingerprint, ADMISSION_POLICY_VERSION]).slice(0, 16)}`,
          decision: admission.admission.decision,
          reason: admission.admission.reason,
          nextAction: admission.admission.nextAction,
          evaluatedAt,
          policyVersion: ADMISSION_POLICY_VERSION,
          provenance,
          inputEvidenceCount,
          ownerStatementPresent,
          recommendationKind: candidate.rawRecommendationKind,
          confidence: diagnosticianOutput ? diagnosticianOutput.confidence : null,
          materialFingerprint,
          materialSummary: {
            inputEvidenceCount,
            outputEvidenceCount: diagnosticianOutput ? diagnosticianOutput.evidence.length : 0,
            ownerStatementPresent,
            ...(statementFingerprint !== undefined ? { statementFingerprint } : {}),
          },
        };
        try {
          if (typeof this.stateManager.appendAdmissionEvaluation !== 'function') {
            throw new Error('state_manager_admission_persistence_unavailable');
          }
          const persisted = await this.stateManager.appendAdmissionEvaluation(candidate.candidateId, evaluation);
          if (persisted.status === 'refused') {
            admissionPersistBlocked.add(candidate.candidateId);
            this.eventEmitter?.emitTelemetry({
              eventType: 'admission_persistence_failed',
              traceId: candidate.candidateId,
              timestamp: evaluatedAt,
              payload: { reason: persisted.reason, nextAction: 'inspect state.db principle_candidates; the disposition was not saved and intake is blocked for this candidate this round' },
            });
          }
        } catch (persistErr) {
          admissionPersistBlocked.add(candidate.candidateId);
          this.eventEmitter?.emitTelemetry({
            eventType: 'admission_persistence_failed',
            traceId: candidate.candidateId,
            timestamp: evaluatedAt,
            payload: { reason: persistErr instanceof Error ? persistErr.message : String(persistErr), nextAction: 'inspect state.db principle_candidates; the disposition was not saved and intake is blocked for this candidate this round' },
          });
        }
      }
    }

    const seedFailureCandidateIds: string[] = [];
    const notInternalizable: NotInternalizableCandidate[] = [];
    // PRI-642 §10: per-candidate ledger/seed linkage for outcome reporting.
    const ledgerEntryByCandidate = new Map<string, string>();
    const seededTaskByCandidate = new Map<string, string>();
    // PRI-917 v0.3.3: candidates parked by the Reuse Review Gate (suspected
    // duplicates awaiting the Owner) — kept OUT of seeding/consumption.
    const reuseReviewRequiredByCandidate = new Map<string, { selectedPrincipleId?: string; confidence?: number }>();
    // PRI-939 Option A: auto-path hook outcomes for CREATE dispositions —
    // `unavailable` must reach the Owner's output, not die at the gate.
    const reuseRecommendationByCandidate = new Map<string, ReuseRecommendationOutcome>();

    if (this.autoIntakeEnabled) {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const admission = admissionResults[i];
        if (!candidate || !admission) continue;

        if (admission.admission.decision !== 'admitted') {
          this.emitAdmissionEvent(candidate.candidateId, admission.admission);
          // CR-03: a non-admitted disposition is a saved, explainable terminal
          // state for this material — the worker must not keep rescanning it.
          this.safeUpdateAdmissionProcessing(candidate.candidateId, {
            state: 'awaiting_owner',
            attempts: 0,
            blockedReason: `${admission.admission.decision}:${admission.admission.reason}`,
          });
          continue;
        }

        // CR-03 (SPEC §7.1): the disposition itself failed to persist — no
        // Ledger write, no consume, no seed for this candidate this round.
        if (admissionPersistBlocked.has(candidate.candidateId)) {
          continue;
        }

        // CR-05 (SPEC §9.1): resume idempotency — when a previous round already
        // wrote this candidate's Ledger entry, skip intake (no duplicate
        // writes) and fall through to seed/link recovery below.
        // CR-05 resume idempotency (guarded for adapters whose seam returns
        // undefined instead of null): only a REAL persisted entry short-circuits.
        const existingLedgerEntry = this.ledgerAdapter.existsForCandidate(candidate.candidateId) ?? null;
        if (existingLedgerEntry !== null && typeof existingLedgerEntry.id === 'string') {
          ledgerEntryIds.push(existingLedgerEntry.id);
          ledgerEntryByCandidate.set(candidate.candidateId, existingLedgerEntry.id);
        }

        // sibling 隔离：一个 candidate 的 intake 失败不应中止整批（ERR-089 模式）
        let intakeResult;
        try {
          if (existingLedgerEntry !== null && typeof existingLedgerEntry.id === 'string') {
            intakeResult = { outcome: 'ledger_entry' as const, written: false, entry: existingLedgerEntry };
          } else {
            intakeResult = await this.intakeService.intake(candidate.candidateId);
          }
        } catch (intakeErr) {
          this.eventEmitter?.emitTelemetry({
            eventType: 'candidate_intake_failed',
            traceId: candidate.candidateId,
            timestamp: new Date().toISOString(),
            payload: { reason: intakeErr instanceof Error ? intakeErr.message : String(intakeErr) },
          });
          // CR-05 (SPEC §9.1): the succeeded diagnosis with an unfinished
          // intake is an orphan the worker continuation must pick up — record
          // the attempt in the independent processing domain.
          void this.recordPostProcessingFailure(candidate.candidateId, `intake_failed:${intakeErr instanceof Error ? intakeErr.message : String(intakeErr)}`).catch(() => undefined);
          continue;
        }
        // Phase 1 / PR1 (Principle Ledger write boundary): the intake service only
        // writes the ledger when the candidate's persisted recommendation_kind is
        // a validated 'principle'. A refusal is an explicit disposition, not a
        // drop — the kind-aware routing below still runs, so rule/prompt
        // candidates keep their existing channel handling and
        // implementation/defer candidates keep their existing
        // not_internalizable reporting.
        if (intakeResult.outcome === 'ledger_entry') {
          ledgerEntryIds.push(intakeResult.entry.id);
          ledgerEntryByCandidate.set(candidate.candidateId, intakeResult.entry.id);
          // PRI-939 Option A: keep the auto-path hook outcome (if any) so the
          // outcome loop can surface an `unavailable` degradation on the
          // CREATE disposition instead of silently dropping the reason here.
          if (intakeResult.reuseRecommendation !== undefined) {
            reuseRecommendationByCandidate.set(candidate.candidateId, intakeResult.reuseRecommendation);
          }
        }

        // PRI-917 v0.3.3 — Reuse Review Gate: a parked candidate is a suspected
        // duplicate awaiting the Owner. It must stay PENDING: skip the
        // kind-aware dreamer seeding below AND the consumed marking at loop
        // end, and make the park observable (telemetry + outcome reporting).
        // The park writes NOTHING (no ledger entry, no evidence — T7).
        if (intakeResult.outcome === 'refused' && intakeResult.reason === 'reuse_pending_owner') {
          const recommendation = intakeResult.reuseRecommendation;
          const recommended = recommendation?.status === 'recommended' ? recommendation : undefined;
          this.eventEmitter?.emitTelemetry({
            eventType: 'reuse_gate_triggered',
            traceId: candidate.candidateId,
            timestamp: new Date().toISOString(),
            payload: {
              candidateId: candidate.candidateId,
              ...(recommended?.selectedPrincipleId !== undefined
                ? { selectedPrincipleId: recommended.selectedPrincipleId }
                : {}),
              ...(recommended ? { confidence: recommended.confidence, recommendation: recommended.recommendation } : {}),
            },
          });
          reuseReviewRequiredByCandidate.set(candidate.candidateId, {
            selectedPrincipleId: recommended?.selectedPrincipleId,
            confidence: recommended?.confidence,
          });
          // CR-05: waiting for the Owner's reuse decision is a saved
          // awaiting-owner state, not a technical retry.
          this.safeUpdateAdmissionProcessing(candidate.candidateId, {
            state: 'awaiting_owner',
            attempts: 0,
            blockedReason: 'reuse_pending_owner',
          });
          continue;
        }

        try {
          const route = CANDIDATE_KIND_TO_ROUTE[candidate.recommendationKind ?? ''];
          if (route) {
            // PRI-539: `ready` reflects only whether the route maps to a channel.
            // Let computeBridgeDecision() itself decide MVP-disabled so the
            // not_internalizable reason is accurate ("Channel ... MVP-disabled")
            // instead of the misleading "not ready — missing required fields".
            const channel = ROUTE_CHANNEL_MAP[route];
            const ready = !!channel;
            const seed = buildDreamerSeedFromCandidate(candidate, {
              route,
              ready,
              sourcePainId: painId,
              // PRI-720: explicit full-chain override when the Owner switched
              // prompt_full_pipeline on. Seed-time application — in-flight
              // chains keep their seeded topology.
              pipelineMode: this.fullPipelinePromptSeeds ? 'full_chain' : undefined,
            });
            // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
            if (!('decision' in seed)) {
              // PRI-720 C6: dedup at candidate level — the demotion may have
              // changed the derived channel suffix vs a pre-existing chain.
              const existingTask = await findExistingDreamerTask(
                (id) => this.stateManager.getTask(id),
                candidate.candidateId,
              );
              if (!existingTask) {
                await this.stateManager.createTask({
                  taskId: seed.taskId,
                  taskKind: seed.taskKind,
                  inputRef: '',
                  status: seed.status,
                  attemptCount: seed.attemptCount,
                  maxAttempts: seed.maxAttempts,
                  diagnosticJson: seed.diagnosticJson,
                });
                seededTaskByCandidate.set(candidate.candidateId, seed.taskId);
                this.eventEmitter?.emitTelemetry({
                  eventType: 'candidate_dreamer_task_seeded',
                  traceId: candidate.candidateId,
                  timestamp: new Date().toISOString(),
                  // rc-9: the full-chain override and the C6 channel demotion
                  // must both be observable at seed time.
                  payload: {
                    taskId: seed.taskId,
                    channel: seed.channel,
                    ...(seed.pipelineMode ? { pipelineMode: seed.pipelineMode } : {}),
                    ...(seed.demotedFromChannel ? { demotedFromChannel: seed.demotedFromChannel } : {}),
                  },
                });
              }
            } else if (seed.decision === 'not_internalizable') {
              // PRI-539: surface MVP-disabled candidates instead of silently
              // marking them consumed (rc-9-no-silent-fallback / ERR-002).
              notInternalizable.push({ candidateId: candidate.candidateId, reason: seed.reason });
              this.eventEmitter?.emitTelemetry({
                eventType: 'candidate_not_internalizable',
                traceId: candidate.candidateId,
                timestamp: new Date().toISOString(),
                payload: { reason: seed.reason, channel: channel ?? null, route },
              });
            }
          }
        } catch (seedErr) {
          seedFailureCandidateIds.push(candidate.candidateId);
          this.eventEmitter?.emitTelemetry({
            eventType: 'candidate_dreamer_task_seed_failed',
            traceId: candidate.candidateId,
            timestamp: new Date().toISOString(),
            payload: { error: String(seedErr) },
          });
          // CR-05 (SPEC §9.1): seed failure is a post-processing orphan —
          // consumed-but-unseeded must stay discoverable by the worker
          // continuation (never hidden behind the consumed status).
          void this.recordPostProcessingFailure(candidate.candidateId, `seed_failed:${String(seedErr)}`).catch(() => undefined);
        }

        if (candidate.status !== 'consumed') {
          await this.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' });
        }
      }
    }

    // CR-03/CR-05: mark the candidates whose post-processing reached a real
    // terminal state (seeded / ledger-written / not internalizable) complete
    // so the worker continuation stops rescanning them.
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const admission = admissionResults[i];
      if (!candidate || !admission || admission.admission.decision !== 'admitted') continue;
      if (admissionPersistBlocked.has(candidate.candidateId)) continue;
      if (seedFailureCandidateIds.includes(candidate.candidateId)) continue;
      if (reuseReviewRequiredByCandidate.has(candidate.candidateId)) continue;
      this.safeUpdateAdmissionProcessing(candidate.candidateId, {
        state: 'complete',
        attempts: 0,
        completedAt: new Date().toISOString(),
      });
    }

    const seedFailureNote = seedFailureCandidateIds.length > 0
      ? `dreamer_seed_failed:${seedFailureCandidateIds.join(',')}`
      : '';

    const runs = await this.stateManager.getRunsByTask(taskId);
    const latestRun = runs.at(-1);
    const firstCandidate = candidates.at(0);

    const candidateIds = candidates.map((candidate) => candidate.candidateId);

    // PRI-642 SPEC §10: execution status, aggregate progress and per-candidate
    // outcomes are independent dimensions — build the latter two here so mixed
    // results can never be read as completed internalization.
    const candidateOutcomes: PainCandidateOutcome[] = candidates.map((candidate, i) => {
      const admission = admissionResults[i]?.admission;
      const decision = admission?.decision ?? 'needs_evidence';
      const outcome: PainCandidateOutcome = {
        candidateId: candidate.candidateId,
        decision,
        reason: admission?.reason ?? 'diagnostician_output_unavailable',
        nextAction: admission?.nextAction ?? 're_run_diagnosis_or_manual_review',
      };
      const ledgerEntryId = ledgerEntryByCandidate.get(candidate.candidateId);
      if (ledgerEntryId !== undefined) outcome.ledgerEntryId = ledgerEntryId;
      const seededTaskId = seededTaskByCandidate.get(candidate.candidateId);
      if (seededTaskId !== undefined) outcome.seededTaskId = seededTaskId;
      if (decision === 'admitted' && outcome.seededTaskId === undefined) {
        const notInternalizableEntry = notInternalizable.find((n) => n.candidateId === candidate.candidateId);
        const seedFailed = seedFailureCandidateIds.includes(candidate.candidateId);
        if (notInternalizableEntry !== undefined) {
          outcome.reason = notInternalizableEntry.reason;
          outcome.nextAction = 'Enable the mapped channel or archive this candidate.';
        } else if (seedFailed) {
          outcome.reason = 'dreamer_seed_failed';
          outcome.nextAction = 'Inspect state.db and telemetry; re-run intake.';
        }
      }
      // PRI-917 v0.3.3 — park override LAST: a Reuse-Review-Gate candidate is
      // neither seed-failed nor not-internalizable; it is deliberately awaiting
      // the Owner (rc-9: the waiting state must be visible, not silent).
      const parked = reuseReviewRequiredByCandidate.get(candidate.candidateId);
      if (parked !== undefined) {
        outcome.reason = 'reuse_review_required';
        outcome.nextAction = `pd candidate review --candidate-id ${candidate.candidateId} --decide reuse|create --reason "..."`;
      }
      // PRI-939 Option A — surface the auto-path evaluation outcome on the
      // CREATE disposition (status + bounded reason only; the park shape
      // already carries its own recommendation fields via reason/nextAction).
      const autoRecommendation = reuseRecommendationByCandidate.get(candidate.candidateId);
      if (autoRecommendation !== undefined) {
        outcome.reuseRecommendation = autoRecommendation.status === 'unavailable'
          ? { status: 'unavailable', reason: autoRecommendation.reason.slice(0, 200) }
          : { status: 'recommended' };
      }
      return outcome;
    });

    // PRI-939 Option A — collect the degradation notes so the CLI envelope can
    // carry them in observabilityWarnings (rc-9: degraded reuse protection
    // must be visible, not silent; learning still proceeds under Rule 4).
    const observabilityWarnings: string[] = [];
    for (const candidate of candidates) {
      const autoRecommendation = reuseRecommendationByCandidate.get(candidate.candidateId);
      if (autoRecommendation?.status === 'unavailable') {
        observabilityWarnings.push(
          `semantic reuse evaluation unavailable for candidate ${candidate.candidateId} ` +
          `(${autoRecommendation.reason.slice(0, 200)}) — learning proceeded without duplicate protection (Rule 4); ` +
          `nextAction: pd candidate review --candidate-id ${candidate.candidateId} to resolve manually`,
        );
        // PRI-939 review fix (Codex P1 / CodeRabbit): the degradation must also
        // REACH THE DURABLE WORKSPACE SINK on the automatic path — before this
        // emission the event existed only on the review surface, so auto-path
        // degradations never landed in critical-events.jsonl nor pd health.
        // The mapped emitter forwards this type verbatim (see
        // mapBridgeTelemetryToStoreEvent); without an injected sink it
        // degrades to the pre-Option-A in-process singleton (unchanged).
        this.eventEmitter?.emitTelemetry({
          eventType: 'reuse_evaluation_unavailable',
          traceId: candidate.candidateId,
          timestamp: new Date().toISOString(),
          payload: {
            candidateId: candidate.candidateId,
            reason: autoRecommendation.reason.slice(0, 200),
          },
        });
      }
    }

    const admittedCandidateIds = candidateOutcomes
      .filter((o) => o.decision === 'admitted')
      .map((o) => o.candidateId);
    const seededTaskIds = [...seededTaskByCandidate.values()];
    const furthestStage: PainFurthestStage = seededTaskIds.length > 0
      ? 'internalization_seeded'
      : ledgerEntryIds.length > 0
        ? 'candidate_processing'
        : 'diagnosis_completed';

    const shaped = shapeBridgeResult({
      path: 'fresh',
      painId,
      taskId,
      candidateIds,
      ledgerEntryIds,
      // Phase 1 / PR1: a ledger entry is only EXPECTED for admitted candidates
      // whose validated recommendation_kind targets the Principle Ledger.
      // Without this, a batch of non-principle candidates that the write
      // boundary correctly refused would be misreported as an intake FAILURE
      // instead of their real disposition (routed / not_internalizable).
      ledgerEligibleCandidateCount: candidates.filter((candidate, i) =>
        admissionResults[i]?.admission.decision === 'admitted'
        && isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind),
      ).length,
      // PRI-917 v0.3.3: parked candidates intentionally have no ledger entry —
      // a fully-parked batch is "awaiting the Owner", not an intake failure.
      reuseReviewRequiredCandidateIds: [...reuseReviewRequiredByCandidate.keys()],
      runId: latestRun?.runId,
      artifactId: firstCandidate?.artifactId,
      autoIntakeEnabled: this.autoIntakeEnabled,
      admissionResults,
      seedFailureNote,
      notInternalizable: notInternalizable.length > 0 ? notInternalizable : undefined,
    });
    shaped.progress = {
      furthestStage,
      generatedCandidateIds: candidateIds,
      admittedCandidateIds,
      ledgerEntryIds,
      seededTaskIds,
    };
    shaped.candidateOutcomes = candidateOutcomes;
    // PRI-939 Option A: degradation notes ride on the bridge result so every
    // consumer (CLI envelope, workers) sees them, not just the outcomes array.
    if (observabilityWarnings.length > 0) {
      shaped.observabilityWarnings = observabilityWarnings;
    }
    return shaped;
  }

  private async buildExistingResult(input: { painId: string; taskId: string }): Promise<PainSignalBridgeResult> {
    const candidates = await this.stateManager.getCandidatesByTaskId(input.taskId);
    const runs = await this.stateManager.getRunsByTask(input.taskId);
    const latestRun = runs.at(-1);
    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    const firstCandidate = candidates.at(0);
    const ledgerEntryIds: string[] = [];
    // Pending also represents admission refusal and intake failure. Re-check
    // admission and the read-only reuse gate instead of inferring a park.
    const pendingReviewCandidateIds: string[] = [];
    const reviewFailures: string[] = [];

    if (this.autoIntakeEnabled) {
      for (const candidate of candidates) {
        const ledgerEntry = this.ledgerAdapter.existsForCandidate(candidate.candidateId);
        if (ledgerEntry) ledgerEntryIds.push(ledgerEntry.id);
        if (candidate.status !== 'consumed' && ledgerEntry) {
          await this.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' });
        }
        if (candidate.status === 'pending' && !ledgerEntry && isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind) && this.intakeService?.reuseReviewEnabled) {
          try {
            const task = await this.stateManager.getTask(input.taskId);
            const ingress = validatePersistedIngressFacts(task?.diagnosticJson);
            if (ingress.errorCode !== null) continue;
            const sourceRun = await this.stateManager.getRun(candidate.sourceRunId);
            if (!sourceRun || sourceRun.taskId !== candidate.taskId || sourceRun.executionStatus !== 'succeeded' || !sourceRun.outputPayload) continue;
            const output: unknown = JSON.parse(sourceRun.outputPayload);
            if (!Value.Check(DiagnosticianOutputV1Schema, output) || !output.valid) continue;
            const [admission] = evaluateCandidateAdmissions([candidate], output, {
              provenance: ingress.provenance,
              inputEvidenceCount: ingress.evidenceCount,
            });
            if (admission?.admission.decision !== 'admitted') continue;
            const review = await this.intakeService.reviewReuse(candidate.candidateId);
            if (review?.outcome === 'refused' && review.reason === 'reuse_pending_owner') {
              pendingReviewCandidateIds.push(candidate.candidateId);
            }
          } catch (err: unknown) {
            reviewFailures.push(`${candidate.candidateId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    const shaped = shapeBridgeResult({
      path: 'existing',
      painId: input.painId,
      taskId: input.taskId,
      candidateIds,
      ledgerEntryIds,
      // Phase 1 / PR1: only ledger-eligible candidates can be "missing" an
      // entry here — see the fresh path for the rationale.
      ledgerEligibleCandidateCount: candidates.filter((candidate) =>
        isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind),
      ).length,
      reuseReviewRequiredCandidateIds: pendingReviewCandidateIds,
      runId: latestRun?.runId,
      artifactId: firstCandidate?.artifactId,
      autoIntakeEnabled: this.autoIntakeEnabled,
    });
    if (reviewFailures.length > 0) {
      shaped.status = 'failed';
      shaped.message = `Replay intake review failed: ${reviewFailures.join('; ')}. nextAction: inspect the candidate artifacts and retry intake.`;
    }
    // P2-2/F3: candidate-level dispositions for the parked subset so callers
    // (worker report, CLI nextAction) see WHAT awaits the Owner. Other
    // candidates are omitted on this path — admission results are not
    // replayed, so their dispositions are unknown, not fabricable
    // ('needs_evidence' is the established admission-unknown value).
    if (pendingReviewCandidateIds.length > 0) {
      shaped.candidateOutcomes = pendingReviewCandidateIds.map((candidateId) => ({
        candidateId,
        decision: 'needs_evidence' as const,
        reason: 'reuse_review_required',
        nextAction: `pd candidate review --candidate-id ${candidateId} --decide reuse|create`,
      }));
    }
    return shaped;
  }
}
