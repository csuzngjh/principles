/**
 * TestDoubleRuntimeAdapter — test double for PDRuntimeAdapter.
 *
 * First real implementation of the M1 PDRuntimeAdapter interface.
 * Default behavior: succeed-on-first-poll with valid DiagnosticianOutputV1.
 * All methods overridable via TestDoubleBehaviorOverrides callbacks.
 */
import type { PDRuntimeAdapter, RuntimeKind, RuntimeCapabilities, RuntimeHealth, RunHandle, RunStatus, StartRunInput, StructuredRunOutput, RuntimeArtifactRef, ContextItem } from '../runtime-protocol.js';
/** Optional callbacks to override default TestDoubleRuntimeAdapter behavior. */
export interface TestDoubleBehaviorOverrides {
    readonly onStartRun?: (input: StartRunInput) => RunHandle | Promise<RunHandle>;
    readonly onPollRun?: (runId: string) => RunStatus | Promise<RunStatus>;
    readonly onFetchOutput?: (runId: string) => StructuredRunOutput | null | Promise<StructuredRunOutput | null>;
    readonly onCancelRun?: (runId: string) => void | Promise<void>;
    readonly onGetCapabilities?: () => RuntimeCapabilities | Promise<RuntimeCapabilities>;
    readonly onHealthCheck?: () => RuntimeHealth | Promise<RuntimeHealth>;
    readonly onFetchArtifacts?: (runId: string) => RuntimeArtifactRef[] | Promise<RuntimeArtifactRef[]>;
    readonly onAppendContext?: (runId: string, items: ContextItem[]) => void | Promise<void>;
}
export declare class TestDoubleRuntimeAdapter implements PDRuntimeAdapter {
    private readonly overrides;
    private readonly defaultTaskId;
    private runCounter;
    constructor(overrides?: TestDoubleBehaviorOverrides, defaultTaskId?: string);
    kind(): RuntimeKind;
    getCapabilities(): Promise<RuntimeCapabilities>;
    healthCheck(): Promise<RuntimeHealth>;
    startRun(input: StartRunInput): Promise<RunHandle>;
    pollRun(runId: string): Promise<RunStatus>;
    cancelRun(runId: string): Promise<void>;
    fetchOutput(runId: string): Promise<StructuredRunOutput | null>;
    fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]>;
    appendContext(runId: string, items: ContextItem[]): Promise<void>;
}
//# sourceMappingURL=test-double-runtime-adapter.d.ts.map