/**
 * DiagnosticianRunner -- explicit runner-driven diagnostician execution.
 *
 * Replaces heartbeat-prompt-driven execution with a deterministic pipeline:
 *   lease -> build context -> invoke runtime -> poll -> fetch output -> validate -> succeed/fail
 *
 * Per D-01: Phase-based step pipeline, each phase is independent method.
 * Per D-02: Polling loop with configurable interval and timeout.
 * Per D-03: Retry with backoff on transient errors, fail on permanent.
 * Per D-04: All store operations through RuntimeStateManager.
 *
 * Runner does NOT:
 *   - Import from evolution-worker.ts or prompt.ts
 *   - Write artifact files (M5 scope)
 *   - Emit principle candidates (M5 scope)
 *   - Persist RunnerPhase to TaskStore
 */
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { ContextAssembler } from '../store/context-assembler.js';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { DiagnosticianRunnerOptions } from './diagnostician-runner-options.js';
import type { DiagnosticianValidator } from './diagnostician-validator.js';
import type { RunnerResult } from './runner-result.js';
import { RunnerPhase } from './runner-phase.js';
/** Dependencies injected into DiagnosticianRunner. */
export interface DiagnosticianRunnerDeps {
    readonly stateManager: RuntimeStateManager;
    readonly contextAssembler: ContextAssembler;
    readonly runtimeAdapter: PDRuntimeAdapter;
    readonly eventEmitter: StoreEventEmitter;
    readonly validator: DiagnosticianValidator;
}
export declare class DiagnosticianRunner {
    private phase;
    private readonly resolvedOptions;
    private readonly stateManager;
    private readonly contextAssembler;
    private readonly runtimeAdapter;
    private readonly eventEmitter;
    private readonly validator;
    constructor(deps: DiagnosticianRunnerDeps, options: DiagnosticianRunnerOptions);
    /** Get the current internal phase. For testing/observability only. */
    get currentPhase(): RunnerPhase;
    /**
     * Emit a diagnostician telemetry event via the store event emitter.
     */
    private emitDiagnosticianEvent;
    /**
     * Execute the full diagnostician lifecycle for a task.
     *
     * The runner does NOT hold mutable state between run() calls.
     * Each invocation is independent.
     */
    run(taskId: string): Promise<RunnerResult>;
    private buildContext;
    /**
     * Resolve the store's runId for the latest run of a task.
     * acquireLease creates a RunRecord with a deterministic ID (run_{taskId}_{attempt}).
     * The adapter's RunHandle.runId is separate -- we need the store's ID for
     * updateRunOutput and other store operations.
     */
    private resolveStoreRunId;
    private invokeRuntime;
    private pollUntilTerminal;
    private fetchAndParseOutput;
    private succeedTask;
    private handleRuntimeFailure;
    private handleValidationError;
    private handleLeaseOrPhaseError;
    private retryOrFail;
    private readonly PERMANENT_ERROR_CATEGORIES;
    private isPermanentError;
    private classifyError;
    private mapRunStatusToErrorCategory;
    private sleep;
}
//# sourceMappingURL=diagnostician-runner.d.ts.map