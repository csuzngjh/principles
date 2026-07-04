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
import type { StoreEventEmitter } from '../store/event-emitter.js';
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
   * Owner's preferred language for principle generation (PRI-336).
   * When provided, generation prompts include a language directive.
   * Undefined = no language directive (backward compatible).
   */
  readonly outputLanguage?: OutputLanguage;
  /**
   * Whether to inject CORE_PRINCIPLES into the prompt (default: true).
   * Controlled by the `internalization_core_grounding` feature flag.
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
  /** Owner's preferred language for principle generation (PRI-336). Undefined = no directive. */
  readonly outputLanguage?: OutputLanguage;
  /** Whether to inject CORE_PRINCIPLES into the prompt (default: true). */
  readonly coreGrounding: boolean;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Shared dependencies injected into all peer runners.
 *
 * Runners with additional dependencies (e.g. DiagnosticianRunner needs
 * ContextAssembler + DiagnosticianCommitter) should extend this interface.
 */
export interface PeerRunnerDeps {
  readonly stateManager: RuntimeStateManager;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly eventEmitter: StoreEventEmitter;
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
