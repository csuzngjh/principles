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
import type { PainDetectedData, PainSignalBridgeResult, PainProvenance, PainEvidenceEntry } from './pain-signal-bridge.js';
import { PDRuntimeError } from './error-categories.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { EffectivePdConfig } from './config/pd-config-types.js';
import type { IntentDocReader } from './intent/intent-doc-reader-port.js';
import type { TrajectoryTurnReader } from './store/context/trajectory-turn-reader.js';

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
  /** PRI-306: Effective PD config for config-driven runtime binding.
   *  When provided, createPainSignalBridge uses config-based binding resolution
   *  instead of the legacy WorkflowFunnelLoader path. */
  effectiveConfig?: EffectivePdConfig;
  /** PRI-306: Env var accessor for readiness checks. Defaults to process.env. */
  getEnvVar?: (name: string) => string | undefined;
  /** PRI-369: When true, recordPain returns immediately after task creation (status='submitted').
   *  The diagnosis runs in background via orchestrator wakeOnce/recovery-sweep. */
  asyncMode?: boolean;
  /**
   * PRI-468: Optional INTENT.md reader for Stage A intent tension check.
   * Plugin layer supplies the concrete I/O adapter; core only consumes the port.
   */
  intentDocReader?: IntentDocReader;
  trajectoryTurnReader?: TrajectoryTurnReader;
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
  provenance?: PainProvenance;
  hostKind?: PainDetectedData['hostKind'];
  evidence?: PainEvidenceEntry[];
  recordObservability?: boolean;
}

export interface PainToPrincipleOutput {
  status: 'succeeded' | 'skipped' | 'failed' | 'retried' | 'degraded' | 'submitted';
  painId: string;
  taskId: string;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  admissionResults?: {
    candidateId: string;
    recommendationKind: string;
    admission: { decision: string; reason: string; nextAction: string; evidenceStatus: string };
  }[];
  message?: string;
  observabilityWarnings: string[];
  failureCategory?: FailureCategory;
  latencyMs: number;
  nextAction?: string;
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
      provenance: input.provenance,
      hostKind: input.hostKind,
      evidence: input.evidence,
    };

    try {
      // ── Async mode: create task as pending, return immediately ──
      if (this.opts.asyncMode) {
        const bridge = await createPainSignalBridge({
          workspaceDir: this.opts.workspaceDir,
          stateDir: this.opts.stateDir,
          ledgerAdapter: this.opts.ledgerAdapter,
          owner: this.opts.owner,
          autoIntakeEnabled: false, // No intake in async mode — intake happens after diagnosis completes
          effectiveConfig: this.opts.effectiveConfig,
          getEnvVar: this.opts.getEnvVar,
          intentDocReader: this.opts.intentDocReader,
          trajectoryTurnReader: this.opts.trajectoryTurnReader,
        });

        // Create task as pending (does not run diagnosis)
        const taskIdResult = await bridge.submitPainSignal(painData);

        // Record observability
        let observabilityWarnings: string[] = [];
        if (input.recordObservability !== false) {
          const obs = recordPainSignalObservability({
            workspaceDir: this.opts.workspaceDir,
            stateDir: this.opts.stateDir,
            data: painData,
            canonicalPainId: painId,
            runtimeTaskId: taskIdResult.taskId,
          });
          observabilityWarnings = obs.warnings;
        }

        const latencyMs = Date.now() - startTime;

        return {
          status: 'submitted',
          painId,
          taskId: taskIdResult.taskId,
          candidateIds: [],
          ledgerEntryIds: [],
          observabilityWarnings,
          latencyMs,
          message: `Diagnosis submitted. Use 'pd task show ${taskIdResult.taskId}' to check progress.`,
        };
      }

      const bridge = await createPainSignalBridge({
        workspaceDir: this.opts.workspaceDir,
        stateDir: this.opts.stateDir,
        ledgerAdapter: this.opts.ledgerAdapter,
        owner: this.opts.owner,
        autoIntakeEnabled: this.opts.autoIntakeEnabled,
        effectiveConfig: this.opts.effectiveConfig,
        getEnvVar: this.opts.getEnvVar,
        intentDocReader: this.opts.intentDocReader,
        trajectoryTurnReader: this.opts.trajectoryTurnReader,
      });

      const bridgeResult = await bridge.onPainDetected(painData);

      let observabilityWarnings: string[] = [];
      if (input.recordObservability !== false) {
        const obs = recordPainSignalObservability({
          workspaceDir: this.opts.workspaceDir,
          stateDir: this.opts.stateDir,
          data: painData,
          canonicalPainId: painId,
          runtimeTaskId: taskId,
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
        admissionResults: bridgeResult.admissionResults,
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
