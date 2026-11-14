/**
 * Shared types for the BasePeerRunner abstract class (PRI-302).
 *
 * These types replace the per-runner duplicated interfaces:
 *   - DreamerRunnerOptions / ScribeRunnerOptions / ...
 *   - DreamerRunnerDeps / ScribeRunnerDeps / ...
 *   - DreamerRunnerResult / ScribeRunnerResult / ...
 *   - FailureContext / SucceedContext / ValidationErrorContext
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { PDErrorCategory } from '../error-categories.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';
import type { TelemetryEvent } from '../../telemetry-event.js';
import type { PIArtifactStore } from '../internalization/pi-artifact.js';
import type { RunnerKind } from '../internalization/peer-runner-contracts.js';
import type { TaskRecord } from '../task-status.js';
import type { OutputLanguage } from '../language-directive.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { PendingAgentDraftStore } from '../feedback/pending-agent-draft-store.js';

// ── Options ──────────────────────────────────────────────────────────────────

/** Shared runner options. All peer runners accept this shape. */
export interface PeerRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
  /**
   * Lease validity window for this runner's execution
   * (SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.1). Defaults to the
   * shared execution-timing contract; a stage that runs longer than the TTL is
   * kept alive by the heartbeat, never by a longer default TTL.
   */
  readonly leaseTtlMs?: number;
  /** Lease renewal cadence. Resolved below the TTL by the timing contract. */
  readonly heartbeatIntervalMs?: number;
  /**
   * Owner's preferred language for principle generation (PRI-336).
   * When provided, generation prompts include a language directive.
   * Undefined = no language directive (backward compatible).
   */
  readonly outputLanguage?: OutputLanguage;
  /**
   * Whether to inject CORE_PRINCIPLES into the prompt (default: true).
   * Grounding is unconditional runner behavior — the former
   * `internalization_core_grounding` flag was retired in PRI-751 (it never
   * had a production reader).
   */
  readonly coreGrounding?: boolean;
}

/** Resolved options with defaults applied. */
export interface ResolvedPeerRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
  /** Lease validity window (SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.1). */
  readonly leaseTtlMs: number;
  /** Lease renewal cadence, resolved strictly below `leaseTtlMs`. */
  readonly heartbeatIntervalMs: number;
  /** Owner's preferred language for principle generation (PRI-336). Undefined = no directive. */
  readonly outputLanguage?: OutputLanguage;
  /** Whether to inject CORE_PRINCIPLES into the prompt (default: true). */
  readonly coreGrounding: boolean;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Minimal telemetry port used by peer runners.
 *
 * Runners only ever call `emitTelemetry`. Accepting the narrow port (instead
 * of the concrete StoreEventEmitter class) lets a workspace-scoped sink such
 * as host-runtime's WorkspaceTelemetryEmitter be injected on the production
 * path, so allowlisted runner events reach critical-events.jsonl while the
 * sink's own upstream still receives every non-allowlisted event.
 */
export type PeerRunnerTelemetryEmitter = {
  emitTelemetry: (event: TelemetryEvent) => unknown;
};

/**
 * Shared dependencies injected into all peer runners.
 *
 * Runners with additional dependencies (e.g. DiagnosticianRunner needs
 * ContextAssembler + DiagnosticianCommitter) should extend this interface.
 */
export interface PeerRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: PeerRunnerTelemetryEmitter;
  readonly artifactStore: PIArtifactStore;
  /**
   * Optional store for agent-authored draft context attached to a permanently
   * failed task (Task 12). When injected, BasePeerRunner writes an
   * AgentDraftPayload to pending_agent_drafts whenever a task enters the
   * `failed` terminal state via a permanent error category. When omitted,
   * the runner behaves as before (no draft written) — backward compatible.
   */
  readonly pendingAgentDraftStore?: PendingAgentDraftStore;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Runner-specific configuration passed to the BasePeerRunner constructor.
 * Each subclass provides its own config instance.
 */
export interface PeerRunnerConfig {
  /** Runner name for telemetry event prefix (e.g. 'dreamer', 'scribe'). */
  readonly runnerName: string;
  /** Expected taskKind for lease validation (e.g. 'dreamer', 'diag_rootcause'). */
  readonly expectedTaskKind: RunnerKind;
  /** Default agentId if not provided in options. */
  readonly defaultAgentId: string;
  /** ResultRef prefix (e.g. 'dreamer' → 'dreamer://runId'). */
  readonly resultRefPrefix: string;
  /**
   * Effective PD config for feature flag resolution (ADR-0019).
   * When provided, enables rate-limit graceful degradation via
   * the `diagnostician_llm_degradation` feature flag.
   * Undefined = no degradation (legacy behavior).
   */
  readonly effectiveConfig?: EffectivePdConfig;
}

// ── Result ───────────────────────────────────────────────────────────────────

/** Status values shared by all peer runner results. */
export type PeerRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

/**
 * Generic result type for all peer runners.
 * Replaces the per-runner result interfaces (DreamerRunnerResult, etc.).
 */
export interface PeerRunnerResult<TOutput> {
  readonly status: PeerRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: TOutput;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  /**
   * P1-3: why execution stopped when that reason is NOT the classified error.
   *
   * `errorCategory` always carries the REAL classified failure (e.g.
   * `output_invalid`). When the retry budget ran out, the task still failed for
   * that classified reason — the budget is the terminal mechanism, not the
   * cause. This field records the terminal mechanism so callers (and the
   * persisted task's `diagnosticJson.terminal_failure`) can show both, instead
   * of overwriting the diagnosis with `max_attempts_exceeded`.
   */
  readonly terminalReason?: 'max_attempts_exceeded';
  readonly attemptCount: number;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validation result returned by the abstract validateOutput() method.
 * Replaces the per-runner validation result interfaces.
 *
 * Note: named PeerRunnerValidationResult to avoid collision with
 * ValidationResult from rule-code-validator.ts.
 */
export interface PeerRunnerValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly errorCategory?: PDErrorCategory;
  /**
   * Non-fatal validation warnings (e.g. taskId re-injection notice). Present
   * when the validator corrected/normalized the output but still accepted it.
   * Callers may surface these in telemetry; they do not affect the pass/fail
   * decision (which is driven by `valid`).
   */
  readonly warnings?: readonly string[];
}

// ── Internal context types (used by base class) ──────────────────────────────

/** Context for the retryOrFail decision. */
export interface FailureContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errorCategory: PDErrorCategory;
  readonly failureReason: string;
}

/** Context for validation error handling. */
export interface ValidationErrorContext {
  readonly taskId: string;
  readonly task: TaskRecord;
  readonly errors: readonly string[];
  readonly errorCategory?: PDErrorCategory;
}
