import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  RuntimeKindSchema,
  RuntimeCapabilitiesSchema,
  RuntimeHealthSchema,
  RunHandleSchema,
  RunExecutionStatusSchema,
  RunStatusSchema,
  RunRecordSchema,
  ContextItemSchema,
  AgentSpecRefSchema,
  WorkflowRefSchema,
  TaskRefSchema,
  StartRunInputSchema,
  StructuredRunOutputSchema,
  RuntimeArtifactRefSchema,
} from '../runtime-protocol.js';
import type {
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunExecutionStatus,
  RunStatus,
  RunRecord,
  ContextItem,
  AgentSpecRef,
  WorkflowRef,
  TaskRef,
  StartRunInput,
  StructuredRunOutput,
  RuntimeArtifactRef,
} from '../runtime-protocol.js';

describe('RuntimeKindSchema', () => {
  it('validates all runtime kinds', () => {
    const kinds: RuntimeKind[] = [
      'openclaw',
      'openclaw-cli',
      'openclaw-history',
      'claude-cli',
      'codex-cli',
      'gemini-cli',
      'local-worker',
      'test-double',
      'pi-ai',
      'pi-ai-l2',
    ];
    for (const kind of kinds) {
      expect(Value.Check(RuntimeKindSchema, kind)).toBe(true);
    }
  });

  it('rejects invalid runtime kind', () => {
    expect(Value.Check(RuntimeKindSchema, 'invalid')).toBe(false);
    expect(Value.Check(RuntimeKindSchema, 123)).toBe(false);
    expect(Value.Check(RuntimeKindSchema, null)).toBe(false);
  });
});

describe('RuntimeCapabilitiesSchema', () => {
  it('validates minimal capabilities', () => {
    const capabilities: RuntimeCapabilities = {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: true,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
    expect(Value.Check(RuntimeCapabilitiesSchema, capabilities)).toBe(true);
  });

  it('validates capabilities with optional fields', () => {
    const capabilities: RuntimeCapabilities = {
      supportsStructuredJsonOutput: true,
      supportsToolUse: true,
      supportsWorkingDirectory: true,
      supportsModelSelection: true,
      supportsLongRunningSessions: true,
      supportsCancellation: true,
      supportsArtifactWriteBack: true,
      supportsConcurrentRuns: true,
      supportsStreaming: true,
      capabilitiesValidUntil: '2026-07-01T00:00:00.000Z',
      dynamicCapabilities: {
        toolsAvailable: ['search', 'code'],
        modelOptions: ['gpt-4', 'gpt-3.5'],
      },
    };
    expect(Value.Check(RuntimeCapabilitiesSchema, capabilities)).toBe(true);
  });

  it('rejects capabilities with missing required fields', () => {
    expect(Value.Check(RuntimeCapabilitiesSchema, {})).toBe(false);
    expect(Value.Check(RuntimeCapabilitiesSchema, { supportsStructuredJsonOutput: true })).toBe(false);
  });
});

describe('RuntimeHealthSchema', () => {
  it('validates healthy runtime', () => {
    const health: RuntimeHealth = {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(Value.Check(RuntimeHealthSchema, health)).toBe(true);
  });

  it('validates degraded runtime with warnings', () => {
    const health: RuntimeHealth = {
      healthy: false,
      degraded: true,
      warnings: ['High latency detected', 'Rate limited'],
      lastCheckedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(Value.Check(RuntimeHealthSchema, health)).toBe(true);
  });

  it('rejects health without lastCheckedAt', () => {
    expect(Value.Check(RuntimeHealthSchema, { healthy: true, degraded: false, warnings: [] })).toBe(false);
  });
});

describe('RunHandleSchema', () => {
  it('validates run handle', () => {
    const handle: RunHandle = {
      runId: 'run-123',
      runtimeKind: 'pi-ai',
      startedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(Value.Check(RunHandleSchema, handle)).toBe(true);
  });

  it('rejects run handle with empty runId', () => {
    expect(Value.Check(RunHandleSchema, { runId: '', runtimeKind: 'pi-ai', startedAt: '2026-07-01T00:00:00.000Z' })).toBe(false);
  });
});

describe('RunExecutionStatusSchema', () => {
  it('validates all execution status values', () => {
    const statuses: RunExecutionStatus[] = ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'];
    for (const status of statuses) {
      expect(Value.Check(RunExecutionStatusSchema, status)).toBe(true);
    }
  });

  it('rejects invalid execution status', () => {
    expect(Value.Check(RunExecutionStatusSchema, 'invalid')).toBe(false);
  });
});

describe('RunStatusSchema', () => {
  it('validates minimal run status', () => {
    const status: RunStatus = {
      runId: 'run-123',
      status: 'running',
    };
    expect(Value.Check(RunStatusSchema, status)).toBe(true);
  });

  it('validates complete run status', () => {
    const status: RunStatus = {
      runId: 'run-123',
      status: 'succeeded',
      startedAt: '2026-07-01T00:00:00.000Z',
      endedAt: '2026-07-01T00:05:00.000Z',
      reason: 'Execution completed successfully',
    };
    expect(Value.Check(RunStatusSchema, status)).toBe(true);
  });
});

describe('RunRecordSchema', () => {
  it('validates run record', () => {
    const record: RunRecord = {
      runId: 'run-123',
      runtimeKind: 'pi-ai',
      startedAt: '2026-07-01T00:00:00.000Z',
      taskId: 'task-456',
      attemptNumber: 1,
      executionStatus: 'succeeded',
      endedAt: '2026-07-01T00:05:00.000Z',
      reason: 'Success',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:05:00.000Z',
    };
    expect(Value.Check(RunRecordSchema, record)).toBe(true);
  });

  it('rejects run record with negative attempt number', () => {
    const record: Partial<RunRecord> = {
      runId: 'run-123',
      runtimeKind: 'pi-ai',
      startedAt: '2026-07-01T00:00:00.000Z',
      taskId: 'task-456',
      attemptNumber: -1,
      executionStatus: 'failed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:05:00.000Z',
    };
    expect(Value.Check(RunRecordSchema, record)).toBe(false);
  });
});

describe('ContextItemSchema', () => {
  it('validates user context item', () => {
    const item: ContextItem = { role: 'user', content: 'Hello' };
    expect(Value.Check(ContextItemSchema, item)).toBe(true);
  });

  it('validates system context item', () => {
    const item: ContextItem = { role: 'system', content: 'You are a helpful assistant' };
    expect(Value.Check(ContextItemSchema, item)).toBe(true);
  });

  it('validates tool context item', () => {
    const item: ContextItem = { role: 'tool', content: JSON.stringify({ result: 'success' }) };
    expect(Value.Check(ContextItemSchema, item)).toBe(true);
  });

  it('rejects context item with invalid role', () => {
    expect(Value.Check(ContextItemSchema, { role: 'invalid', content: 'test' })).toBe(false);
  });
});

describe('AgentSpecRefSchema', () => {
  it('validates agent spec reference', () => {
    const ref: AgentSpecRef = { agentId: 'agent-1', schemaVersion: 'v1' };
    expect(Value.Check(AgentSpecRefSchema, ref)).toBe(true);
  });

  it('rejects agent spec reference with empty agentId', () => {
    expect(Value.Check(AgentSpecRefSchema, { agentId: '', schemaVersion: 'v1' })).toBe(false);
  });
});

describe('WorkflowRefSchema', () => {
  it('validates workflow reference', () => {
    const ref: WorkflowRef = { workflowId: 'workflow-1' };
    expect(Value.Check(WorkflowRefSchema, ref)).toBe(true);
  });
});

describe('TaskRefSchema', () => {
  it('validates task reference', () => {
    const ref: TaskRef = { taskId: 'task-1' };
    expect(Value.Check(TaskRefSchema, ref)).toBe(true);
  });
});

describe('StartRunInputSchema', () => {
  it('validates minimal start run input', () => {
    const input: StartRunInput = {
      agentSpec: { agentId: 'agent-1', schemaVersion: 'v1' },
      inputPayload: {},
      contextItems: [],
      timeoutMs: 300000,
    };
    expect(Value.Check(StartRunInputSchema, input)).toBe(true);
  });

  it('validates complete start run input', () => {
    const input: StartRunInput = {
      agentSpec: { agentId: 'agent-1', schemaVersion: 'v1' },
      workflowRef: { workflowId: 'workflow-1' },
      taskRef: { taskId: 'task-1' },
      inputPayload: { prompt: 'Hello' },
      contextItems: [{ role: 'user', content: 'Hello' }],
      outputSchemaRef: 'schema-1',
      artifactContractRef: 'artifact-1',
      timeoutMs: 300000,
      idempotencyKey: 'key-1',
      preferredModel: 'gpt-4',
      preferredRuntimeProfile: 'profile-1',
    };
    expect(Value.Check(StartRunInputSchema, input)).toBe(true);
  });

  it('rejects start run input with negative timeout', () => {
    const input: Partial<StartRunInput> = {
      agentSpec: { agentId: 'agent-1', schemaVersion: 'v1' },
      contextItems: [],
      timeoutMs: -1000,
    };
    expect(Value.Check(StartRunInputSchema, input)).toBe(false);
  });
});

describe('StructuredRunOutputSchema', () => {
  it('validates structured run output', () => {
    const output: StructuredRunOutput = {
      runId: 'run-123',
      payload: { result: 'success' },
    };
    expect(Value.Check(StructuredRunOutputSchema, output)).toBe(true);
  });
});

describe('RuntimeArtifactRefSchema', () => {
  it('validates runtime artifact reference', () => {
    const ref: RuntimeArtifactRef = {
      artifactType: 'document',
      ref: 'artifact-123',
    };
    expect(Value.Check(RuntimeArtifactRefSchema, ref)).toBe(true);
  });
});