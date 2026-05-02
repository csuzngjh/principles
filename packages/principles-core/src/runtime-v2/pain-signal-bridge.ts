/**
 * PainSignalBridge — bridges openclaw-plugin pain_detected events to the runtime-v2 diagnostician pipeline.
 *
 * M8 single-path architecture:
 *   pain_detected event → PainSignalBridge → DiagnosticianRunner → SqliteDiagnosticianCommitter
 *   → CandidateIntakeService → PrincipleTreeLedger probation entry
 *
 * Lives in principles-core. Does NOT import PainFlagData/PainDetectedData from openclaw-plugin.
 * Receives pain events via callback from the plugin, which owns the EvolutionReducer.
 *
 * M8 success endpoint (HG-1): PrincipleTreeLedger probation entry created.
 * Candidate intake is happy path (HG-2).
 */

import type { RuntimeStateManager, CandidateRecord } from './store/runtime-state-manager.js';
import type { DiagnosticianRunner } from './runner/diagnostician-runner.js';
import type { CandidateIntakeService } from './candidate-intake-service.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { RunnerResultStatus } from './runner/runner-result.js';
import type { PDErrorCategory } from './error-categories.js';

// ── Input type (defined here — not imported from openclaw-plugin) ───────────────

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
}

export type PainSignalBridgeStatus = 'succeeded' | 'skipped' | 'failed' | 'retried';

export interface PainSignalBridgeResult {
  status: PainSignalBridgeStatus;
  painId: string;
  taskId: string;
  runnerStatus?: RunnerResultStatus;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  errorCategory?: PDErrorCategory;
  message?: string;
}

// ── Bridge options ─────────────────────────────────────────────────────────────

export interface PainSignalBridgeOptions {
  stateManager: RuntimeStateManager;
  runner: DiagnosticianRunner;
  intakeService: CandidateIntakeService;
  ledgerAdapter: LedgerAdapter;
  /** Owner tag passed to DiagnosticianRunner (default: 'pain-signal-bridge') */
  owner?: string;
  /**
   * When true (default), CandidateIntakeService.intake() is called after runner succeeds.
   * When false, intake is skipped — chain still runs but probation entry is not created.
   * HG-4: Debug mode.
   */
  autoIntakeEnabled?: boolean;
}

export function createDiagnosticianTaskId(painId: string): string {
  return `diagnosis_${painId}`;
}

// ── Bridge ───────────────────────────────────────────────────────────────────

export class PainSignalBridge {
  private readonly stateManager: RuntimeStateManager;
  private readonly runner: DiagnosticianRunner;
  private readonly intakeService: CandidateIntakeService;
  private readonly ledgerAdapter: LedgerAdapter;
  private readonly owner: string;
  private readonly autoIntakeEnabled: boolean;

  constructor(opts: PainSignalBridgeOptions) {
    this.stateManager = opts.stateManager;
    this.runner = opts.runner;
    this.intakeService = opts.intakeService;
    this.ledgerAdapter = opts.ledgerAdapter;
    this.owner = opts.owner ?? 'pain-signal-bridge';
    this.autoIntakeEnabled = opts.autoIntakeEnabled ?? true;
  }

  /**
   * Handle a pain_detected event from openclaw-plugin.
   *
   * Flow:
   *  1. Idempotent upsert: derive a diagnostician taskId from the source painId,
   *     check existing task by taskId, route by status
   *     - succeeded → NO-OP; leased → SKIP; failed/retry_wait/pending → reset + re-run
   *  2. Invoke DiagnosticianRunner.run(taskId) — runner internally acquires lease (DO NOT call createRun)
   *  3. After runner succeeds, query real candidateIds via stateManager.getCandidatesByTaskId()
   *  4. Call intakeService.intake(candidateId) for each candidate → ledger probation entry
   *
   * @returns Structured result for the pain → task → candidate → ledger chain.
   */
  async onPainDetected(data: PainDetectedData): Promise<PainSignalBridgeResult> {
    const { painId } = data;
    const taskId = data.taskId ?? createDiagnosticianTaskId(painId);

    // Step 1: Idempotent upsert — check existing task state before creating or re-running.
    // painId is provenance; taskId is the executable Runtime v2 task identity.
    const existingTask = await this.stateManager.getTask(taskId);

    if (existingTask) {
      const { status, leaseExpiresAt } = existingTask;
      const LEASE_TTL_MS = 300_000; // 5 minutes, matches DiagnosticianRunner timeoutMs
      const leaseExpired = leaseExpiresAt && (Date.now() - new Date(leaseExpiresAt).getTime()) > LEASE_TTL_MS;
      if (status === 'succeeded') {
        return this.buildExistingResult({ painId, taskId });
      }
      if (status === 'leased' && !leaseExpired) {
        // Rule b: another run is genuinely in progress — SKIP
        return {
          status: 'skipped',
          painId,
          taskId,
          candidateIds: [],
          ledgerEntryIds: [],
          message: 'Task is already leased',
        };
      }
      // lease expired or status is not leased — fall through to reset + re-run
      if (status === 'leased' && leaseExpired) {
        // Lease expired — treat as stale, fall through to reset + re-run
      } else {
        // Rule c: failed / retry_wait / pending — allow re-run.
        await this.stateManager.updateTask(taskId, {
          status: 'pending',
          attemptCount: 0,
          lastError: null,
          resultRef: null,
        });
      }
    } else {
      // Rule d: no existing task — create new.
      await this.stateManager.createTask({
        taskId,
        taskKind: 'diagnostician',
        inputRef: painId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
      });
    }

    // Step 2: Invoke DiagnosticianRunner — runner manages run lifecycle via acquireLease
    // Bridge does NOT call stateManager.createRun() — doing so would create a duplicate run.
    const result = await this.runner.run(taskId);

    if (result.status !== 'succeeded') {
      // Runner failed — task stays in whatever status the runner set
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

    // Step 3: Query real candidateIds from state store (not synthetic IDs)
    const candidates: CandidateRecord[] = await this.stateManager.getCandidatesByTaskId(taskId);
    const ledgerEntryIds: string[] = [];

    // Step 4: Intake each candidate → PrincipleTreeLedger probation entry
    if (this.autoIntakeEnabled) {
      for (const candidate of candidates) {
        const intakeResult = await this.intakeService.intake(candidate.candidateId);
        ledgerEntryIds.push(intakeResult.id);
      }
    }
    // HG-4: When autoIntakeEnabled=false, chain runs but intake is skipped
    // This allows verifying the full chain without creating ledger entries

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
        message: 'Diagnostician succeeded but produced no principle candidates',
      };
    }
    if (this.autoIntakeEnabled && ledgerEntryIds.length === 0) {
      return {
        status: 'failed',
        painId,
        taskId,
        runnerStatus: result.status,
        runId: latestRun?.runId,
        artifactId: firstCandidate?.artifactId,
        candidateIds,
        ledgerEntryIds,
        message: 'Candidate intake did not produce a ledger entry',
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
    };
  }

  private async buildExistingResult(input: { painId: string; taskId: string }): Promise<PainSignalBridgeResult> {
    const candidates = await this.stateManager.getCandidatesByTaskId(input.taskId);
    const runs = await this.stateManager.getRunsByTask(input.taskId);
    const latestRun = runs.at(-1);
    const candidateIds = candidates.map((candidate) => candidate.candidateId);
    const firstCandidate = candidates.at(0);
    const ledgerEntryIds: string[] = [];

    // P8 (LOCKED): succeeded requires candidates. Without candidates the task
    // produced no output — this is a partial/silent failure, not a success.
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

    // HG-4: When autoIntakeEnabled=true, succeeded also requires ledger entries.
    if (this.autoIntakeEnabled) {
      for (const candidate of candidates) {
        const ledgerEntry = this.ledgerAdapter.existsForCandidate(candidate.candidateId);
        if (ledgerEntry) ledgerEntryIds.push(ledgerEntry.id);
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
