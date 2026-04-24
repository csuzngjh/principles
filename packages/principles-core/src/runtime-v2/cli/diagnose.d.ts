/**
 * CLI surface for diagnostician execution.
 *
 * Per D-02: Library function exports, no bin scripts, no CLI framework dependency.
 * External code (e.g., OpenClaw plugin) imports and calls these functions.
 *
 * Per D-03: status() returns TaskRecord key fields only (taskId, status, attemptCount, maxAttempts, lastError).
 * No Run history.
 */
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { DiagnosticianRunner } from '../runner/diagnostician-runner.js';
import type { RunnerResult } from '../runner/runner-result.js';
import type { TaskRecord } from '../task-status.js';
/** Options for the run() CLI function. */
export interface DiagnoseRunOptions {
    /** Task ID to execute diagnostician for. */
    taskId: string;
    /** Initialized RuntimeStateManager instance. */
    stateManager: RuntimeStateManager;
    /** DiagnosticianRunner instance (already configured with deps). */
    runner: DiagnosticianRunner;
}
/** Options for the status() CLI function. */
export interface DiagnoseStatusOptions {
    /** Task ID to inspect. */
    taskId: string;
    /** Initialized RuntimeStateManager instance. */
    stateManager: RuntimeStateManager;
}
/** Structured status result per D-03. */
export interface DiagnoseStatusResult {
    readonly taskId: string;
    readonly status: TaskRecord['status'];
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly lastError: TaskRecord['lastError'];
}
/**
 * Execute the diagnostician runner for a task.
 *
 * Thin wrapper over DiagnosticianRunner.run().
 * Returns the raw RunnerResult for full visibility.
 */
export declare function run(options: DiagnoseRunOptions): Promise<RunnerResult>;
/**
 * Inspect diagnostician task status.
 *
 * Per D-03: Returns key TaskRecord fields only.
 * Returns null if the task does not exist.
 */
export declare function status(options: DiagnoseStatusOptions): Promise<DiagnoseStatusResult | null>;
//# sourceMappingURL=diagnose.d.ts.map