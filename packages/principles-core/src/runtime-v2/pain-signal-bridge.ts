import type { RuntimeStateManager, CandidateRecord } from './store/runtime-state-manager.js';
import type { DiagnosticianRunner } from './runner/diagnostician-runner.js';
import type { CandidateIntakeService } from './candidate-intake-service.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { RunnerResultStatus } from './runner/runner-result.js';
import type { PDErrorCategory } from './error-categories.js';
import type { CandidateAdmissionResult, AdmissionDecision, PainProvenance } from './admission-gate.js';
import { evaluateCandidateAdmissions } from './admission-gate.js';
import { seedIntakeTask, ROUTE_CHANNEL_MAP, MVP_ENABLED_CHANNELS } from './internalization/intake-to-internalization-bridge.js';
import type { IntakeToInternalizationBridgeInput } from './internalization/intake-to-internalization-bridge.js';
import type { InternalizationRouteKind } from './internalization/internalization-route.js';

const CANDIDATE_KIND_TO_ROUTE: Record<string, InternalizationRouteKind> = {
  principle: 'principle-ledger',
  rule: 'rule-candidate',
  implementation: 'implementation-candidate',
  prompt: 'prompt-injection-candidate',
  defer: 'deferred',
};

export type { PainProvenance };

export const MAX_EVIDENCE_ENTRIES = 4;
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
  evidence?: PainEvidenceEntry[];
}

export type PainSignalBridgeStatus = 'succeeded' | 'skipped' | 'failed' | 'retried' | 'degraded';

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
  errorCategory?: PDErrorCategory;
  message?: string;
}

export interface PainSignalBridgeOptions {
  stateManager: RuntimeStateManager;
  runner: DiagnosticianRunner;
  intakeService: CandidateIntakeService;
  ledgerAdapter: LedgerAdapter;
  owner?: string;
  autoIntakeEnabled?: boolean;
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
    return 'openclaw_context_bound';
  }
  return 'automatic_hook';
}

function provenanceReason(provenance: PainProvenance): string {
  switch (provenance) {
    case 'openclaw_context_bound':
      return 'Pain reported from an OpenClaw host session with authenticated sessionId';
    case 'owner_reported_no_host_trace':
      return 'No authenticated host session provenance available for CLI-submitted pain; fullTrace unavailable';
    case 'automatic_hook':
      return 'Pain detected by automatic hook (after_tool_call)';
  }
}

function buildDiagnosticJson(data: PainDetectedData): string {
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
    evidence: data.evidence ?? [],
  });
}

export class PainSignalBridge {
  private readonly stateManager: RuntimeStateManager;
  private readonly runner: DiagnosticianRunner;
  private readonly intakeService: CandidateIntakeService;
  private readonly ledgerAdapter: LedgerAdapter;
  private readonly owner: string;
  private readonly autoIntakeEnabled: boolean;
  private readonly eventEmitter?: PainSignalBridgeOptions['eventEmitter'];

  constructor(opts: PainSignalBridgeOptions) {
    this.stateManager = opts.stateManager;
    this.runner = opts.runner;
    this.intakeService = opts.intakeService;
    this.ledgerAdapter = opts.ledgerAdapter;
    this.owner = opts.owner ?? 'pain-signal-bridge';
    this.autoIntakeEnabled = opts.autoIntakeEnabled ?? true;
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

  async onPainDetected(data: PainDetectedData): Promise<PainSignalBridgeResult> {
    const { painId } = data;
    const taskId = data.taskId ?? createDiagnosticianTaskId(painId);
    const provenance = data.provenance ?? inferProvenance(data);

    const existingTask = await this.stateManager.getTask(taskId);

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
      const diagnosticJson = buildDiagnosticJson(data);
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

    const candidates: CandidateRecord[] = await this.stateManager.getCandidatesByTaskId(taskId);
    const ledgerEntryIds: string[] = [];

    const diagnosticianOutput = result.output;
    const admissionResults = diagnosticianOutput
      ? evaluateCandidateAdmissions(candidates, diagnosticianOutput, provenance)
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
          const route = CANDIDATE_KIND_TO_ROUTE[candidate.recommendationKind ?? ''] ?? (`${candidate.recommendationKind}-candidate` as InternalizationRouteKind);
          const channel = ROUTE_CHANNEL_MAP[route];
          const bridgeInput: IntakeToInternalizationBridgeInput = {
            candidateId: candidate.candidateId,
            recommendationKind: candidate.recommendationKind ?? 'unknown',
            route,
            ready: !!channel && MVP_ENABLED_CHANNELS.has(channel),
            sourcePainId: painId,
          };
          const seedResult = await seedIntakeTask(bridgeInput, {
            getTask: (id) => this.stateManager.getTask(id),
            createTask: (input) => this.stateManager.createTask({
              taskId: input.taskId,
              taskKind: input.taskKind,
              inputRef: '',
              status: input.status as 'pending',
              attemptCount: input.attemptCount,
              maxAttempts: input.maxAttempts,
              diagnosticJson: input.diagnosticJson,
            }),
          });
          if (seedResult.decision === 'seeded') {
            this.eventEmitter?.emitTelemetry({
              eventType: 'candidate_dreamer_task_seeded',
              traceId: candidate.candidateId,
              timestamp: new Date().toISOString(),
              payload: { taskId: seedResult.taskId, channel: seedResult.channel },
            });
          }
        } catch (seedErr) {
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

    const runs = await this.stateManager.getRunsByTask(taskId);
    const latestRun = runs.at(-1);
    const firstCandidate = candidates.at(0);

    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    if (candidateIds.length === 0) {
      return {
        status: 'failed',
        painId,
        taskId,
        runnerStatus: result.status,
        runId: latestRun?.runId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        message: 'Diagnostician succeeded but produced no principle candidates',
      };
    }

    const admittedCount = admissionResults.filter((a) => a.admission.decision === 'admitted').length;
    const nonAdmittedCount = admissionResults.length - admittedCount;

    if (this.autoIntakeEnabled && admittedCount > 0 && ledgerEntryIds.length === 0) {
      return {
        status: 'failed',
        painId,
        taskId,
        runnerStatus: result.status,
        runId: latestRun?.runId,
        artifactId: firstCandidate?.artifactId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        message: 'Candidate intake did not produce a ledger entry',
      };
    }

    if (nonAdmittedCount > 0 && admittedCount === 0) {
      return {
        status: 'degraded',
        painId,
        taskId,
        runnerStatus: result.status,
        runId: latestRun?.runId,
        artifactId: firstCandidate?.artifactId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        message: `all_candidates_gated:${admissionResults.map((a) => `${a.candidateId}=${a.admission.decision}`).join(',')}`,
      };
    }

    if (nonAdmittedCount > 0 && admittedCount > 0) {
      return {
        status: 'degraded',
        painId,
        taskId,
        runnerStatus: result.status,
        runId: latestRun?.runId,
        artifactId: firstCandidate?.artifactId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        message: `partial_admission:${admittedCount}_admitted_${nonAdmittedCount}_gated`,
      };
    }

    return {
      status: 'succeeded',
      painId,
      taskId,
      runnerStatus: result.status,
      runId: latestRun?.runId,
      artifactId: firstCandidate?.artifactId,
      candidateIds,
      ledgerEntryIds,
      admissionResults,
    };
  }

  private async buildExistingResult(input: { painId: string; taskId: string }): Promise<PainSignalBridgeResult> {
    const candidates = await this.stateManager.getCandidatesByTaskId(input.taskId);
    const runs = await this.stateManager.getRunsByTask(input.taskId);
    const latestRun = runs.at(-1);
    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    const firstCandidate = candidates.at(0);
    const ledgerEntryIds: string[] = [];

    if (candidateIds.length === 0) {
      return {
        status: 'failed',
        painId: input.painId,
        taskId: input.taskId,
        runId: latestRun?.runId,
        candidateIds: [],
        ledgerEntryIds: [],
        message: 'Task has no principle candidates — treating as failed',
      };
    }

    if (this.autoIntakeEnabled) {
      for (const candidate of candidates) {
        const ledgerEntry = this.ledgerAdapter.existsForCandidate(candidate.candidateId);
        if (ledgerEntry) ledgerEntryIds.push(ledgerEntry.id);
        if (candidate.status !== 'consumed' && ledgerEntry) {
          await this.stateManager.updateCandidateStatus(candidate.candidateId, { status: 'consumed' });
        }
      }
      if (ledgerEntryIds.length === 0) {
        return {
          status: 'failed',
          painId: input.painId,
          taskId: input.taskId,
          runId: latestRun?.runId,
          artifactId: firstCandidate?.artifactId,
          candidateIds,
          ledgerEntryIds: [],
          message: 'Candidate intake did not produce a ledger entry — treating as failed',
        };
      }
    }

    return {
      status: 'succeeded',
      painId: input.painId,
      taskId: input.taskId,
      runId: latestRun?.runId,
      artifactId: firstCandidate?.artifactId,
      candidateIds,
      ledgerEntryIds,
      message: 'Task already succeeded',
    };
  }
}
