/**
 * TestDoubleRuntimeAdapter — test double for PDRuntimeAdapter.
 *
 * First real implementation of the M1 PDRuntimeAdapter interface.
 * Default behavior: succeed-on-first-poll with valid DiagnosticianOutputV2.
 * All methods overridable via TestDoubleBehaviorOverrides callbacks.
 *
 * BUG-008: Default fetchOutput dispatches stage-aware mock outputs based on
 * taskId prefix (diag_rootcause/diag_distiller/diag_router), reusing fixtures
 * from split-pipeline-fixtures.ts. Non-split taskIds fall back to a default
 * V2 diagnostician output (PRI-1146: V2 is the only contract).
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
import { MOCK_ROOT_CAUSE_OUTPUTS, MOCK_DISTILLER_OUTPUTS, MOCK_ROUTER_OUTPUTS } from './split-pipeline-fixtures.js';

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
  /** BUG-008: Map runId → taskId so fetchOutput can dispatch by stage prefix. */
  private readonly runIdToTaskId = new Map<string, string>();

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
    const runId = `td-${this.runCounter}`;
    // BUG-008: Store taskId from taskRef so fetchOutput can dispatch by stage prefix
    const taskId = input.taskRef?.taskId;
    if (typeof taskId === 'string') {
      this.runIdToTaskId.set(runId, taskId);
    }
    return {
      runId,
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

    // BUG-008: Dispatch stage-aware mock outputs based on taskId prefix.
    // Reuse fixtures from split-pipeline-fixtures.ts (R6).
    const taskId = this.runIdToTaskId.get(runId) ?? this.defaultTaskId;

    if (taskId.includes('diag_rootcause')) {
      return {
        runId,
        payload: {
          ...MOCK_ROOT_CAUSE_OUTPUTS.R6,
          taskId,
        },
      };
    }

    if (taskId.includes('diag_distiller')) {
      return {
        runId,
        payload: {
          ...MOCK_DISTILLER_OUTPUTS.R6,
          taskId,
        },
      };
    }

    if (taskId.includes('diag_router')) {
      return {
        runId,
        payload: {
          ...MOCK_ROUTER_OUTPUTS.R6,
        },
      };
    }

    // Default V2 diagnostician output for non-split taskIds (PRI-1146 V2 Only).
    // No taskId: the V2 root is closed and lineage is runner-owned.
    return {
      runId,
      payload: {
        schemaVersion: 'diagnostician-output-v2',
        valid: true,
        diagnosisId: 'td-diag-default',
        summary: 'TestDouble default summary',
        rootCause: 'TestDouble default root cause',
        violatedPrinciples: [],
        evidence: [],
        recommendations: [{ kind: 'defer', description: 'TestDouble default: no actionable recommendation', recommendationRef: 'defer-1' }],
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
