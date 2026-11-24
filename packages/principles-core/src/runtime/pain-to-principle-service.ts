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
import { createDiagnosticianTaskId, inferProvenance, persistPendingPainSignal } from './pain-signal-bridge.js';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { PainDetectedData, PainSignalBridgeResult, PainProvenance, PainEvidenceEntry, PainProgressReport, PainCandidateOutcome } from './pain-signal-bridge.js';
import type { PainIngressV1Payload } from './pain-ingress-payload.js';
import { PDRuntimeError } from './error-categories.js';
import type { LedgerAdapter } from './candidate-intake.js';
import type { EffectivePdConfig } from './config/pd-config-types.js';
import { resolveDiagnosticianCapability } from './diagnostician-capability.js';
import type { IntentDocReader } from './intent/intent-doc-reader-port.js';
import type { TrajectoryTurnReader } from './store/context/trajectory-turn-reader.js';
import type { SourceMaterialAuthorizationPort } from './source-material-authorization.js';
import type { TelemetryEvent } from '../telemetry-event.js';

export type FailureCategory =
  | 'runtime_unavailable'
  | 'config_missing'
  | 'runtime_timeout'
  | 'output_invalid'
  | 'artifact_missing'
  | 'ledger_write_failed'
  | 'candidate_missing'
  /**
   * PRI-638: the Owner disabled the Diagnostician capability. Distinct from
   * `config_missing` on purpose — a deliberate kill switch must never be
   * reported to the Owner as a broken runtime or a bad configuration.
   */
  | 'capability_disabled';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * SPEC-PD-PIPELINE-SPINE-001 D1: the options are a discriminated union on
 * `asyncMode`. Async mode only persists the pending task and may omit the
 * sync-only collaborators; a synchronous (or possibly-synchronous) entry MUST
 * inject both `trajectoryTurnReader` and `sourceMaterialAuthorization` at the
 * type level — before D1 the sync bridge call silently fell back to
 * `denyAllSourceMaterialAuthorization` and filtered already-authorized
 * governance material as unauthorized. Unit-test helpers may explicitly pass
 * `denyAllSourceMaterialAuthorization` or an empty reader; production code
 * must never let `undefined` slip through the compile-time check.
 */
export interface PainToPrincipleServiceBaseOptions {
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
  /**
   * PRI-468: Optional INTENT.md reader for Stage A intent tension check.
   * Plugin layer supplies the concrete I/O adapter; core only consumes the port.
   */
  intentDocReader?: IntentDocReader;
  /**
   * PRI-939 Option A: optional workspace-scoped telemetry sink forwarded to
   * createPainSignalBridge so short-lived CLI processes persist the allowlisted
   * bridge events (reuse_gate_triggered / reuse_evaluation_unavailable).
   * Absent = pre-Option-A behavior (unsubscribed storeEmitter singleton).
   */
  telemetrySink?: { emitTelemetry: (event: TelemetryEvent) => void };
  /**
   * Pain Ingress SPEC §9.6: lazy Workspace-level `automatic_pain_submission`
   * authorization probe. Consulted per recordPain call — BEFORE any pending
   * task persistence (async mode) or bridge submission (sync mode) — so
   * Owner revocation takes effect immediately. Absent = fail-closed for
   * automatic_hook provenance.
   */
  isAutoPainSubmissionAuthorized?: () => boolean;
}

export type PainToPrincipleServiceOptions =
  | (PainToPrincipleServiceBaseOptions & {
      /** PRI-369: recordPain returns immediately after task creation
       * (status='submitted'); the diagnosis runs in background via
       * orchestrator wakeOnce/recovery-sweep. */
      readonly asyncMode: true;
      readonly trajectoryTurnReader?: TrajectoryTurnReader;
      readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
    })
  | (PainToPrincipleServiceBaseOptions & {
      /** Synchronous diagnosis: the two collaborators below are REQUIRED. */
      readonly asyncMode?: false;
      readonly trajectoryTurnReader: TrajectoryTurnReader;
      readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
    });

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
  /**
   * PRI-844: the Owner's verbatim correction, forwarded by hook emitters when
   * the pain carries correction context. Rides into the diagnostic task's
   * diagnosticJson via PainDetectedData — absent means no correction context,
   * never fabricated (rc-9).
   */
  correctionEvidence?: PainDetectedData['correctionEvidence'];
  recordObservability?: boolean;
  /** PRI-642 SPEC §9: validated rev-2 ingress facts persisted under painIngress.v1. */
  painIngress?: PainIngressV1Payload;
  /** SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §5.6: principle reference for principle_deviation. */
  deviationAnchor?: PainDetectedData['deviationAnchor'];
  /** SPEC §11 / TD §6.2: structured anchor for every anchor source. */
  anchor?: PainDetectedData['anchor'];
  /**
   * PRI-1274 (B1 / P1-3): submit-time admission disposition. Set when the
   * submission bound a session and named a target turn whose text is not yet
   * collectable — the task is created `waiting_for_target_evidence` and the
   * candidate picker excludes it until the worker reconcile flips it. Same
   * `recovery` JSON block the receipt fallback writes (one authority).
   */
  admissionDisposition?: PainDetectedData['admissionDisposition'];
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
  /** PRI-642 §10: aggregate progress (at-least-one semantics). */
  progress?: PainProgressReport;
  /** PRI-642 §10: per-candidate disposition — the authority for mixed results. */
  candidateOutcomes?: PainCandidateOutcome[];
  message?: string;
  observabilityWarnings: string[];
  failureCategory?: FailureCategory;
  latencyMs: number;
  nextAction?: string;
}

// ── Error classification ───────────────────────────────────────────────────

function classifyFromBridge(result: PainSignalBridgeResult): FailureCategory | undefined {
  // PRI-638 P1-D: ONLY a DisabledDiagnosticianRunner result — which uniquely
  // carries a nextAction — is an Owner capability decision. A
  // `capability_missing` from a real runner stage (e.g. a missing intent
  // capability) must NOT be relabeled as an Owner disable.
  if (result.errorCategory === 'capability_missing' && result.nextAction !== undefined) {
    return 'capability_disabled';
  }
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

    // PRI-638: read the canonical capability authority once per call. The
    // factory applies the same resolver, so this is a consistent second read of
    // one truth, not a second authority. It is what lets this service report
    // "Owner disabled" instead of misclassifying it as a runtime fault.
    const capability = resolveDiagnosticianCapability(this.opts.effectiveConfig);

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
      ...(input.correctionEvidence ? { correctionEvidence: input.correctionEvidence } : {}),
      painIngress: input.painIngress,
      ...(input.deviationAnchor ? { deviationAnchor: input.deviationAnchor } : {}),
      ...(input.anchor ? { anchor: input.anchor } : {}),
      ...(input.admissionDisposition ? { admissionDisposition: input.admissionDisposition } : {}),
    };

    // SPEC §9.6: B-class authorization is enforced BEFORE the submission
    // chain — ahead of the async pending-task persist AND the synchronous
    // bridge path. Unauthorized automatic_hook produces no pending
    // diagnosis, no task mutation, no run. The observation-only record is
    // the caller's responsibility (the hook logs PAIN_INGRESS_UNAUTHORIZED).
    if ((painData.provenance ?? inferProvenance(painData)) === 'automatic_hook'
        && !(this.opts.isAutoPainSubmissionAuthorized?.() ?? false)) {
      return {
        status: 'skipped',
        painId,
        taskId,
        candidateIds: [],
        ledgerEntryIds: [],
        observabilityWarnings: [],
        latencyMs: Date.now() - startTime,
        message: 'auto_pain_unauthorized',
        nextAction: 'Enable features.automatic_pain_submission in this workspace .pd/config.yaml to allow automatic Pain submission.',
      };
    }

    try {
      // ── Async mode: create task as pending, return immediately ──
      if (this.opts.asyncMode) {
        const observabilityWarnings: string[] = [];
        const stateManager = new RuntimeStateManager({ workspaceDir: this.opts.workspaceDir });
        try {
          await stateManager.initialize();
          await persistPendingPainSignal(stateManager, painData, this.opts.workspaceDir);
        } finally {
          // The pending write is authoritative even if cleanup fails.
          await stateManager.close().catch(() => {
            observabilityWarnings.push('diagnosis_task_store_close_failed');
          });
        }

        // Record observability
        if (input.recordObservability !== false) {
          const obs = recordPainSignalObservability({
            workspaceDir: this.opts.workspaceDir,
            stateDir: this.opts.stateDir,
            data: painData,
            canonicalPainId: painId,
            runtimeTaskId: taskId,
          });
          observabilityWarnings.push(...obs.warnings);
        }

        const latencyMs = Date.now() - startTime;

        return {
          status: 'submitted',
          painId,
          taskId,
          candidateIds: [],
          ledgerEntryIds: [],
          observabilityWarnings,
          latencyMs,
          message: `Diagnosis submitted. Use 'pd task show ${taskId}' to check progress.`,
          // PRI-638: an async submission against a disabled capability stays
          // durable but will not progress until the Owner re-enables the agent.
          ...(capability.available ? {} : { nextAction: capability.nextAction, failureCategory: 'capability_disabled' as const }),
        };
      }

      let releaseBridge: (() => Promise<void>) | undefined;
      try {
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
          // SPEC-PD-PIPELINE-SPINE-001 D1: forward the sync entry's
          // authorization so authorized governance material survives the
          // bridge's latest-consent gate instead of silently falling back to
          // deny-all.
          sourceMaterialAuthorization: this.opts.sourceMaterialAuthorization,
          // PRI-939 Option A: workspace-scoped persistence for allowlisted events.
          ...(this.opts.telemetrySink ? { telemetrySink: this.opts.telemetrySink } : {}),
          isAutoPainSubmissionAuthorized: this.opts.isAutoPainSubmissionAuthorized,
        }, (release) => { releaseBridge = release; });

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
          progress: bridgeResult.progress,
          candidateOutcomes: bridgeResult.candidateOutcomes,
          message: bridgeResult.message,
          // PRI-939 Option A: bridge-shaped degradation notes (semantic reuse
          // evaluation unavailable on a CREATE path) merge ahead of the
          // observability-write warnings — both are rc-9 signals for the Owner.
          observabilityWarnings: [
            ...(bridgeResult.observabilityWarnings ?? []),
            ...observabilityWarnings,
          ],
          // PRI-638 P1-D: classification comes from the bridge result itself —
          // `capability_disabled` only when DisabledDiagnosticianRunner returned
          // (errorCategory capability_missing + nextAction). A real persistence /
          // runtime exception below must keep its own category; the capability
          // state is context, never an exception-classification override.
          failureCategory: classifyFromBridge(bridgeResult),
          ...(bridgeResult.nextAction !== undefined ? { nextAction: bridgeResult.nextAction } : {}),
          latencyMs,
        };
      } finally {
        await releaseBridge?.();
      }

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
        // PRI-638 P1-D: a real throw (SQLite write failure, state init failure,
        // storage_unavailable, malformed config, …) is classified on its own
        // terms — the capability being disabled must not mask it.
        failureCategory: classifyFromError(err),
        latencyMs,
      };
    }
  }
}
