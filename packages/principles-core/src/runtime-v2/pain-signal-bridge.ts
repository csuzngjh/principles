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

// ── Bridge options ─────────────────────────────────────────────────────────────

export interface PainSignalBridgeOptions {
  stateManager: RuntimeStateManager;
  runner: DiagnosticianRunner;
  intakeService: CandidateIntakeService;
  ledgerAdapter: LedgerAdapter;
  /** Owner tag passed to DiagnosticianRunner (default: 'pain-signal-bridge') */
  owner?: string;
  /**
   * When false (default), CandidateIntakeService.intake() is called after runner succeeds.
   * When true, intake is skipped — chain still runs but probation entry is not created.
   * HG-4: Debug mode.
   */
  autoIntakeEnabled?: boolean;
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
    this.autoIntakeEnabled = opts.autoIntakeEnabled ?? false;
  }

  /**
   * Handle a pain_detected event from openclaw-plugin.
   *
   * Flow:
   *  1. Idempotent upsert: check existing task by painId, route by status
   *     - succeeded → NO-OP (return painId); leased → SKIP; failed/retry_wait/pending → reset + re-run
   *  2. Invoke DiagnosticianRunner.run(taskId) — runner internally acquires lease (DO NOT call createRun)
   *  3. After runner succeeds, query real candidateIds via stateManager.getCandidatesByTaskId()
   *  4. Call intakeService.intake(candidateId) for each candidate → ledger probation entry
   *
   * @returns The taskId of the created diagnostician task
   */
  async onPainDetected(data: PainDetectedData): Promise<string> {
    const { painId } = data;

    // Step 1: Idempotent upsert — check existing task state before creating or re-running
    const existingTask = await this.stateManager.getTask(painId);

    if (existingTask) {
      const { status, leasedAt } = existingTask;
      const LEASE_TTL_MS = 300_000; // 5 minutes, matches DiagnosticianRunner timeoutMs
      const leaseExpired = leasedAt && (Date.now() - new Date(leasedAt).getTime()) > LEASE_TTL_MS;
      if (status === 'leased' && !leaseExpired) {
        // Rule b: another run is genuinely in progress — SKIP
        return painId;
      }
      // lease expired or status is not leased — fall through to reset + re-run
      if (status === 'leased' && leaseExpired) {
        // Lease expired — treat as stale, fall through to reset + re-run
      } else if (status !== 'succeeded') {
        // Rule c: failed / retry_wait / pending — allow re-run.
        await this.stateManager.updateTask(painId, {
          status: 'pending',
          attemptCount: 0,
          lastError: null,
          resultRef: null,
        });
      }
    } else {
      // Rule d: no existing task — create new.
      await this.stateManager.createTask({
        taskId: painId,
        taskKind: 'diagnostician',
        inputRef: painId,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
      });
    }

    const taskId = painId;

    // Step 2: Invoke DiagnosticianRunner — runner manages run lifecycle via acquireLease
    // Bridge does NOT call stateManager.createRun() — doing so would create a duplicate run.
    const result = await this.runner.run(taskId);

    if (result.status !== 'succeeded') {
      // Runner failed — task stays in whatever status the runner set
      return taskId;
    }

    // Step 3: Query real candidateIds from state store (not synthetic IDs)
    const candidates: CandidateRecord[] = await this.stateManager.getCandidatesByTaskId(taskId);

    // Step 4: Intake each candidate → PrincipleTreeLedger probation entry
    if (this.autoIntakeEnabled) {
      for (const candidate of candidates) {
        await this.intakeService.intake(candidate.candidateId);
      }
    }
    // HG-4: When autoIntakeEnabled=false, chain runs but intake is skipped
    // This allows verifying the full chain without creating ledger entries

    return taskId;
  }
}
