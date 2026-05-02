/**
 * PainToPrincipleService — core-owned facade for the pain-to-principle chain.
 *
 * Wraps PainSignalBridge + observability + error classification + latency.
 * Callers (pd-cli, openclaw-plugin) should use this instead of composing
 * bridge/observability/classification manually.
 *
 * PRI-12: Introduce facade without migrating callers.
 */
import { createPainSignalBridge } from './pain-signal-runtime-factory.js';
import { recordPainSignalObservability } from './pain-signal-observability.js';
import { FAILURE_CATEGORY_MAP } from './error-categories.js';
import { createDiagnosticianTaskId } from './pain-signal-bridge.js';
import type { PainDetectedData, PainSignalBridgeResult } from './pain-signal-bridge.js';
import { PDRuntimeError } from './error-categories.js';
import type { LedgerAdapter } from './candidate-intake.js';

export type FailureCategory =
  | 'runtime_unavailable'
  | 'config_missing'
  | 'runtime_timeout'
  | 'output_invalid'
  | 'artifact_missing'
  | 'ledger_write_failed'
  | 'candidate_missing';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PainToPrincipleServiceOptions {
  workspaceDir: string;
  stateDir: string;
  ledgerAdapter: LedgerAdapter;
  owner?: string;
  autoIntakeEnabled?: boolean;
}

export interface PainToPrincipleInput {
  painId: string;
  painType: PainDetectedData['painType'];
  source: string;
  reason: string;
  score?: number;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  traceId?: string;
  recordObservability?: boolean;
}

export interface PainToPrincipleOutput {
  status: 'succeeded' | 'skipped' | 'failed' | 'retried';
  painId: string;
  taskId: string;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  message?: string;
  observabilityWarnings: string[];
  failureCategory?: FailureCategory;
  latencyMs: number;
}

// ── Error classification ───────────────────────────────────────────────────

function classifyFromBridge(result: PainSignalBridgeResult): FailureCategory | undefined {
  if (result.errorCategory) {
    return (FAILURE_CATEGORY_MAP[result.errorCategory] as FailureCategory) ?? 'runtime_unavailable';
  }
  if (result.status === 'failed') {
    if (result.candidateIds.length === 0) return 'candidate_missing';
    if (result.ledgerEntryIds.length === 0) return 'ledger_write_failed';
  }
  return undefined;
}

function classifyFromError(err: unknown): FailureCategory {
  if (err instanceof PDRuntimeError && err.category) {
    return (FAILURE_CATEGORY_MAP[err.category] as FailureCategory) ?? 'runtime_unavailable';
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/api[_\s]?key|not found in env|missing required/i.test(msg)) return 'config_missing';
  if (/timeout|timed[_\s]?out/i.test(msg)) return 'runtime_timeout';
  if (/output.*invalid|validation.*fail/i.test(msg)) return 'output_invalid';
  return 'runtime_unavailable';
}

// ── Service ────────────────────────────────────────────────────────────────

export class PainToPrincipleService {
  private readonly opts: PainToPrincipleServiceOptions;

  constructor(opts: PainToPrincipleServiceOptions) {
    this.opts = opts;
  }

  async recordPain(input: PainToPrincipleInput): Promise<PainToPrincipleOutput> {
    const startTime = Date.now();
    const {painId} = input;
    const taskId = input.taskId ?? createDiagnosticianTaskId(painId);

    const painData: PainDetectedData = {
      painId,
      painType: input.painType,
      source: input.source,
      reason: input.reason,
      score: input.score,
      sessionId: input.sessionId,
      agentId: input.agentId,
      taskId,
      traceId: input.traceId,
    };

    try {
      const bridge = await createPainSignalBridge({
        workspaceDir: this.opts.workspaceDir,
        stateDir: this.opts.stateDir,
        ledgerAdapter: this.opts.ledgerAdapter,
        owner: this.opts.owner,
        autoIntakeEnabled: this.opts.autoIntakeEnabled,
      });

      const bridgeResult = await bridge.onPainDetected(painData);

      let observabilityWarnings: string[] = [];
      if (input.recordObservability !== false) {
        const obs = recordPainSignalObservability({
          workspaceDir: this.opts.workspaceDir,
          stateDir: this.opts.stateDir,
          data: painData,
        });
        observabilityWarnings = obs.warnings;
      }

      const latencyMs = Date.now() - startTime;

      return {
        status: bridgeResult.status,
        painId: bridgeResult.painId,
        taskId: bridgeResult.taskId,
        runId: bridgeResult.runId,
        artifactId: bridgeResult.artifactId,
        candidateIds: bridgeResult.candidateIds,
        ledgerEntryIds: bridgeResult.ledgerEntryIds,
        message: bridgeResult.message,
        observabilityWarnings,
        failureCategory: classifyFromBridge(bridgeResult),
        latencyMs,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      return {
        status: 'failed',
        painId,
        taskId,
        candidateIds: [],
        ledgerEntryIds: [],
        message: err instanceof Error ? err.message : String(err),
        observabilityWarnings: [],
        failureCategory: classifyFromError(err),
        latencyMs,
      };
    }
  }
}
