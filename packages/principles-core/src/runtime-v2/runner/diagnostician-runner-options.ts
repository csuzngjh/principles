/**
 * Configuration options for DiagnosticianRunner.
 *
 * Per CONTEXT.md D-02: pollIntervalMs default 5000, timeout configurable.
 * Per CONTEXT.md D-04: owner and runtimeKind required for lease acquisition.
 */
import type { OutputLanguage } from '../language-directive.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';

export interface DiagnosticianRunnerOptions {
  /** Polling interval in ms (default: 5000 = 5 seconds). */
  readonly pollIntervalMs?: number;
  /** Maximum runtime execution time in ms (default: 300000 = 5 minutes). */
  readonly timeoutMs?: number;
  /** Default maxAttempts for synthetic TaskRecord in lease error path (default: 3). */
  readonly defaultMaxAttempts?: number;
  /** Lease owner identifier for acquireLease. */
  readonly owner: string;
  /** RuntimeKind value for lease/run record creation. */
  readonly runtimeKind: string;
  /**
   * Agent ID passed to the runtime adapter (default: 'diagnostician').
   * Allows CLI to forward --agent flag through to openclaw agent invocation.
   */
  readonly agentId?: string;
  /**
   * Owner's preferred language for principle generation (PRI-336).
   * When provided, the diagnostician prompt includes a language directive
   * telling the LLM to produce human-readable fields in this language.
   * Undefined = no language directive (backward compatible).
   */
  readonly outputLanguage?: OutputLanguage;
  /**
   * Effective PD config for feature flag resolution (PRI-371).
   * When provided, the runner reads `diagnostician_core_grounding` flag
   * to decide whether to inject core axioms into the prompt.
   * Undefined = flag off (backward compatible).
   */
  readonly effectiveConfig?: EffectivePdConfig;
}

/** Resolved options with defaults applied. */
export interface ResolvedDiagnosticianRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
  /** Owner's preferred language for principle generation (PRI-336). Undefined = no directive. */
  readonly outputLanguage?: OutputLanguage;
  /** Effective PD config for feature flag resolution (PRI-371). Undefined = flags off. */
  readonly effectiveConfig?: EffectivePdConfig;
}

/** Default option values. */
export const DEFAULT_RUNNER_OPTIONS: Readonly<Omit<ResolvedDiagnosticianRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'main',
} as const;

/** Resolve options by applying defaults. */
export function resolveRunnerOptions(options: DiagnosticianRunnerOptions): ResolvedDiagnosticianRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_RUNNER_OPTIONS.agentId,
    outputLanguage: options.outputLanguage,
    effectiveConfig: options.effectiveConfig,
  };
}
