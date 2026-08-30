import type { RuntimeStateManager, CandidateRecord } from './store/runtime-state-manager.js';
import type { CandidateIntakeService } from './candidate-intake-service.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { RunnerResult, RunnerResultStatus } from './runner/runner-result.js';
import type { PDErrorCategory } from './error-categories.js';
import type { CandidateAdmissionResult, AdmissionDecision, PainProvenance } from './admission-gate.js';
import type { DiagnosticianOutputV1 } from './diagnostician-output.js';
import { evaluateCandidateAdmissions } from './admission-gate.js';
import { shouldShortCircuitEmptyEvidence } from './evidence-guards.js';
import { parseRootCauseCategory } from './store/pain-diagnosis/pain-diagnosis-store.js';
import { buildDreamerSeedFromCandidate, ROUTE_CHANNEL_MAP, CANDIDATE_KIND_TO_ROUTE } from './internalization/intake-to-internalization-bridge.js';
import { shapeBridgeResult } from './bridge-result-shaper.js';

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

export interface PainEvidenceEntry {
  sourceRef: string;
  note: string;
}

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
  hostKind?: 'openclaw' | 'codex';
  evidence?: PainEvidenceEntry[];
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
  errorCategory?: PDErrorCategory;
  message?: string;
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
  eventEmitter?: {
    emitTelemetry: (event: { eventType: string; traceId: string; timestamp: string; payload: Record<string, unknown> }) => void;
  };
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

function inferProvenance(data: PainDetectedData): PainProvenance {
  if (data.source === 'manual' && (!data.sessionId || data.sessionId === 'cli' || data.sessionId === 'unknown')) {
    return 'owner_reported_no_host_trace';
  }
  if (data.sessionId && data.sessionId !== 'cli' && data.sessionId !== 'unknown') {
    return 'host_context_bound';
  }
  return 'automatic_hook';
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
  });
}

export class PainSignalBridge {
  private readonly stateManager: RuntimeStateManager;
  private readonly runner: DiagnosticianRunnerLike;
  private readonly intakeService: CandidateIntakeService;
  private readonly ledgerAdapter: LedgerAdapter;
  private readonly owner: string;
  private readonly autoIntakeEnabled: boolean;
  private readonly diagnosisPersistenceEnabled: boolean;
  private readonly workspaceDir: string | undefined;
  private readonly eventEmitter?: PainSignalBridgeOptions['eventEmitter'];

  constructor(opts: PainSignalBridgeOptions) {
    this.stateManager = opts.stateManager;
    this.runner = opts.runner;
    this.intakeService = opts.intakeService;
    this.ledgerAdapter = opts.ledgerAdapter;
    this.owner = opts.owner ?? 'pain-signal-bridge';
    this.autoIntakeEnabled = opts.autoIntakeEnabled ?? true;
    this.diagnosisPersistenceEnabled = opts.diagnosisPersistenceEnabled ?? false;
    this.workspaceDir = opts.workspaceDir;
    this.eventEmitter = opts.eventEmitter;
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

    // Check for existing task FIRST — idempotency takes priority over short-circuit
    const existingTask = await this.stateManager.getTask(taskId);

    // PRI-345: short-circuit before any I/O when input evidence is empty
    // and source is not owner-initiated (manual/pain/skill:pain).
    // Zero side effects: no task creation, no runner call, no ledger writes.
    // IMPORTANT: Only short-circuit when there is NO existing task — idempotency must work.
    if (!existingTask && shouldShortCircuitEmptyEvidence(data.evidence?.length ?? 0, data.source)) {
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
      return {
        status: result.status === 'retried' ? 'retried' : 'failed',
        painId,
        taskId,
        runnerStatus: result.status,
        candidateIds: [],
        ledgerEntryIds: [],
        errorCategory: result.errorCategory,
        message: result.failureReason,
      };
    }

    return this.onDiagnosisComplete({
      taskId,
      diagnosticianOutput: result.output,
      painId,
      provenance,
      inputEvidenceCount: data.evidence?.length ?? 0,
    });
  }

  /**
   * Pain Diagnosis Persistence: link the diagnostician's root-cause attribution
   * to the canonical pain_id in state.db pain_diagnoses. Runs BEFORE admission
   * so the attribution is durably recorded even when every candidate is later
   * rejected — the pain's diagnosis history must not depend on admission
   * outcome. Persistence is auxiliary to the admission→intake flow: failures
   * degrade observably via telemetry and never break the main pipeline
   * (rc-9-no-silent-fallback).
   */
  private async persistPainDiagnosis(opts: {
    painId: string;
    taskId: string;
    diagnosticianOutput: DiagnosticianOutputV1;
    artifactId: string | null;
  }): Promise<void> {
    const { painId, taskId, diagnosticianOutput, artifactId } = opts;
    const category = parseRootCauseCategory(diagnosticianOutput.rootCause);
    if (!category) {
      this.eventEmitter?.emitTelemetry({
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
      await this.stateManager.recordPainDiagnosis({
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
      this.eventEmitter?.emitTelemetry({
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
   * PRI-372 (T-G): Post-diagnosis processing extracted from onPainDetected().
   * Handles admission → intake → seedDreamer after a successful diagnosis.
   * Also called by DiagRouterRunner's onDiagnosisComplete callback.
   */
  async onDiagnosisComplete(opts: {
    taskId: string;
    diagnosticianOutput: DiagnosticianOutputV1 | undefined;
    painId: string;
    provenance: PainProvenance;
    inputEvidenceCount?: number;
  }): Promise<PainSignalBridgeResult> {
    const { taskId, diagnosticianOutput, painId, provenance, inputEvidenceCount = 0 } = opts;
    const candidates: CandidateRecord[] = await this.stateManager.getCandidatesByTaskId(taskId);
    const ledgerEntryIds: string[] = [];

    if (this.diagnosisPersistenceEnabled && diagnosticianOutput) {
      await this.persistPainDiagnosis({
        painId,
        taskId,
        diagnosticianOutput,
        artifactId: candidates[0]?.artifactId ?? null,
      });
    }

    const admissionResults = diagnosticianOutput
      ? evaluateCandidateAdmissions(candidates, diagnosticianOutput, { provenance, inputEvidenceCount })
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

    const seedFailureCandidateIds: string[] = [];
    const notInternalizable: NotInternalizableCandidate[] = [];

    if (this.autoIntakeEnabled) {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const admission = admissionResults[i];
        if (!candidate || !admission) continue;

        if (admission.admission.decision !== 'admitted') {
          this.emitAdmissionEvent(candidate.candidateId, admission.admission);
          continue;
        }

        const intakeResult = await this.intakeService.intake(candidate.candidateId);
        ledgerEntryIds.push(intakeResult.id);

        try {
          const route = CANDIDATE_KIND_TO_ROUTE[candidate.recommendationKind ?? ''];
          if (route) {
            // PRI-539: `ready` reflects only whether the route maps to a channel.
            // Let computeBridgeDecision() itself decide MVP-disabled so the
            // not_internalizable reason is accurate ("Channel ... MVP-disabled")
            // instead of the misleading "not ready — missing required fields".
            const channel = ROUTE_CHANNEL_MAP[route];
            const ready = !!channel;
            const seed = buildDreamerSeedFromCandidate(candidate, { route, ready, sourcePainId: painId });
            // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
            if (!('decision' in seed)) {
              const existingTask = await this.stateManager.getTask(seed.taskId);
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
                this.eventEmitter?.emitTelemetry({
                  eventType: 'candidate_dreamer_task_seeded',
                  traceId: candidate.candidateId,
                  timestamp: new Date().toISOString(),
                  payload: { taskId: seed.taskId, channel: seed.channel },
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
        }

        if (candidate.status !== 'consumed') {
          await this.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' });
        }
      }
    }

    const seedFailureNote = seedFailureCandidateIds.length > 0
      ? `dreamer_seed_failed:${seedFailureCandidateIds.join(',')}`
      : '';

    const runs = await this.stateManager.getRunsByTask(taskId);
    const latestRun = runs.at(-1);
    const firstCandidate = candidates.at(0);

    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    return shapeBridgeResult({
      path: 'fresh',
      painId,
      taskId,
      candidateIds,
      ledgerEntryIds,
      runId: latestRun?.runId,
      artifactId: firstCandidate?.artifactId,
      autoIntakeEnabled: this.autoIntakeEnabled,
      admissionResults,
      seedFailureNote,
      notInternalizable: notInternalizable.length > 0 ? notInternalizable : undefined,
    });
  }

  private async buildExistingResult(input: { painId: string; taskId: string }): Promise<PainSignalBridgeResult> {
    const candidates = await this.stateManager.getCandidatesByTaskId(input.taskId);
    const runs = await this.stateManager.getRunsByTask(input.taskId);
    const latestRun = runs.at(-1);
    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    const firstCandidate = candidates.at(0);
    const ledgerEntryIds: string[] = [];

    if (this.autoIntakeEnabled) {
      for (const candidate of candidates) {
        const ledgerEntry = this.ledgerAdapter.existsForCandidate(candidate.candidateId);
        if (ledgerEntry) ledgerEntryIds.push(ledgerEntry.id);
        if (candidate.status !== 'consumed' && ledgerEntry) {
          await this.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' });
        }
      }
    }

    return shapeBridgeResult({
      path: 'existing',
      painId: input.painId,
      taskId: input.taskId,
      candidateIds,
      ledgerEntryIds,
      runId: latestRun?.runId,
      artifactId: firstCandidate?.artifactId,
      autoIntakeEnabled: this.autoIntakeEnabled,
    });
  }
}
