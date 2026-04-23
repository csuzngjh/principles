/**
 * TestDoubleRuntimeAdapter — test double for PDRuntimeAdapter.
 *
 * First real implementation of the M1 PDRuntimeAdapter interface.
 * Default behavior: succeed-on-first-poll with valid DiagnosticianOutputV1.
 * All methods overridable via TestDoubleBehaviorOverrides callbacks.
 */
import type {
  PDRuntimeAdapter,
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunStatus,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
  ContextItem,
} from '../runtime-protocol.js';

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

export class TestDoubleRuntimeAdapter implements PDRuntimeAdapter {
  private readonly overrides: TestDoubleBehaviorOverrides;
  private readonly defaultTaskId: string;
  private runCounter = 0;

  constructor(overrides?: TestDoubleBehaviorOverrides, defaultTaskId?: string) {
    this.overrides = overrides ?? {};
    this.defaultTaskId = defaultTaskId ?? 'td-task-default';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  kind(): RuntimeKind {
    return 'test-double';
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    if (this.overrides.onGetCapabilities) {
      return this.overrides.onGetCapabilities();
    }
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    if (this.overrides.onHealthCheck) {
      return this.overrides.onHealthCheck();
    }
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    if (this.overrides.onStartRun) {
      return this.overrides.onStartRun(input);
    }
    this.runCounter += 1;
    return {
      runId: `td-${this.runCounter}`,
      runtimeKind: 'test-double',
      startedAt: new Date().toISOString(),
    };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    if (this.overrides.onPollRun) {
      return this.overrides.onPollRun(runId);
    }
    const now = new Date().toISOString();
    return { runId, status: 'succeeded', startedAt: now, endedAt: now };
  }

  async cancelRun(runId: string): Promise<void> {
    if (this.overrides.onCancelRun) {
      return this.overrides.onCancelRun(runId);
    }
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.overrides.onFetchOutput) {
      return this.overrides.onFetchOutput(runId);
    }
    return {
      runId,
      payload: {
        valid: true,
        diagnosisId: 'td-diag-default',
        taskId: this.defaultTaskId,
        summary: 'TestDouble default summary',
        rootCause: 'TestDouble default root cause',
        violatedPrinciples: [],
        evidence: [],
        recommendations: [],
        confidence: 0.9,
      },
    };
  }

  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    if (this.overrides.onFetchArtifacts) {
      return this.overrides.onFetchArtifacts(runId);
    }
    return [];
  }

  async appendContext(runId: string, items: ContextItem[]): Promise<void> {
    if (this.overrides.onAppendContext) {
      return this.overrides.onAppendContext(runId, items);
    }
  }
}
