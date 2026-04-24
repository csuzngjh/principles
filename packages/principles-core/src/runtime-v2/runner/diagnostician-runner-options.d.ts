/**
 * Configuration options for DiagnosticianRunner.
 *
 * Per CONTEXT.md D-02: pollIntervalMs default 5000, timeout configurable.
 * Per CONTEXT.md D-04: owner and runtimeKind required for lease acquisition.
 */
export interface DiagnosticianRunnerOptions {
    /** Polling interval in ms (default: 5000 = 5 seconds). */
    readonly pollIntervalMs?: number;
    /** Maximum runtime execution time in ms (default: 300000 = 5 minutes). */
    readonly timeoutMs?: number;
    /** Lease owner identifier for acquireLease. */
    readonly owner: string;
    /** RuntimeKind value for lease/run record creation. */
    readonly runtimeKind: string;
}
/** Resolved options with defaults applied. */
export interface ResolvedDiagnosticianRunnerOptions {
    readonly pollIntervalMs: number;
    readonly timeoutMs: number;
    readonly owner: string;
    readonly runtimeKind: string;
}
/** Default option values. */
export declare const DEFAULT_RUNNER_OPTIONS: Readonly<Omit<ResolvedDiagnosticianRunnerOptions, 'owner' | 'runtimeKind'>>;
/** Resolve options by applying defaults. */
export declare function resolveRunnerOptions(options: DiagnosticianRunnerOptions): ResolvedDiagnosticianRunnerOptions;
//# sourceMappingURL=diagnostician-runner-options.d.ts.map