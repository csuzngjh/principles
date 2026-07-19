import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { RuntimeSelectionCriteriaSchema } from '../runtime-selector.js';
import type { RuntimeSelectionCriteria, RuntimeSelectionResult, RuntimeSelector } from '../runtime-selector.js';
import type { PDRuntimeAdapter, RuntimeCapabilities, RuntimeHealth, RuntimeKind } from '../runtime-protocol.js';

const createValidAgentSpec = () => ({
  agentId: 'agent-1',
  role: 'test-agent',
  schemaVersion: 'v1',
  inputSchemaRef: 'input-schema-1',
  outputSchemaRef: 'output-schema-1',
  timeoutPolicy: { defaultTimeoutMs: 300000 },
  retryPolicy: { maxAttempts: 3 },
  capabilitiesRequired: { structuredJson: true },
});

describe('RuntimeSelectionCriteriaSchema', () => {
  it('validates minimal selection criteria', () => {
    const criteria: RuntimeSelectionCriteria = {
      agentSpec: createValidAgentSpec(),
    };
    expect(Value.Check(RuntimeSelectionCriteriaSchema, criteria)).toBe(true);
  });

  it('validates selection criteria with workspace policy', () => {
    const criteria: RuntimeSelectionCriteria = {
      agentSpec: createValidAgentSpec(),
      workspacePolicy: {
        allowedRuntimes: ['pi-ai', 'openclaw-cli'],
        blockedRuntimes: ['test-double'],
      },
      fallbackEnabled: true,
    };
    expect(Value.Check(RuntimeSelectionCriteriaSchema, criteria)).toBe(true);
  });

  it('validates selection criteria with only allowedRuntimes', () => {
    const criteria: RuntimeSelectionCriteria = {
      agentSpec: createValidAgentSpec(),
      workspacePolicy: {
        allowedRuntimes: ['pi-ai'],
      },
    };
    expect(Value.Check(RuntimeSelectionCriteriaSchema, criteria)).toBe(true);
  });

  it('validates selection criteria with only blockedRuntimes', () => {
    const criteria: RuntimeSelectionCriteria = {
      agentSpec: createValidAgentSpec(),
      workspacePolicy: {
        blockedRuntimes: ['local-worker'],
      },
    };
    expect(Value.Check(RuntimeSelectionCriteriaSchema, criteria)).toBe(true);
  });

  it('validates selection criteria with fallback disabled', () => {
    const criteria: RuntimeSelectionCriteria = {
      agentSpec: createValidAgentSpec(),
      fallbackEnabled: false,
    };
    expect(Value.Check(RuntimeSelectionCriteriaSchema, criteria)).toBe(true);
  });

  it('rejects selection criteria without agentSpec', () => {
    expect(Value.Check(RuntimeSelectionCriteriaSchema, {})).toBe(false);
    expect(Value.Check(RuntimeSelectionCriteriaSchema, { workspacePolicy: {} })).toBe(false);
  });

  it('rejects selection criteria with empty agentId', () => {
    const invalidSpec = { ...createValidAgentSpec(), agentId: '' };
    expect(Value.Check(RuntimeSelectionCriteriaSchema, { agentSpec: invalidSpec })).toBe(false);
  });
});

describe('RuntimeSelectionResult', () => {
  it('defines correct type structure', () => {
    const mockAdapter: Partial<PDRuntimeAdapter> = {
      kind: () => 'pi-ai' as RuntimeKind,
      getCapabilities: async () => ({
        supportsStructuredJsonOutput: true,
        supportsToolUse: false,
        supportsWorkingDirectory: true,
        supportsModelSelection: false,
        supportsLongRunningSessions: false,
        supportsCancellation: true,
        supportsArtifactWriteBack: false,
        supportsConcurrentRuns: false,
        supportsStreaming: false,
      }),
      healthCheck: async () => ({ healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-07-01T00:00:00.000Z' }),
    };

    const result: RuntimeSelectionResult = {
      adapter: mockAdapter as PDRuntimeAdapter,
      reason: 'Selected based on agent preferences',
      isFallback: false,
    };

    expect(result.adapter).toBeDefined();
    expect(result.reason).toBe('Selected based on agent preferences');
    expect(result.isFallback).toBe(false);
    expect(typeof result.adapter.kind()).toBe('string');
  });
});

describe('RuntimeSelector interface', () => {
  it('defines all required methods', () => {
    const mockCapabilities: RuntimeCapabilities = {
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

    const mockHealth: RuntimeHealth = {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: '2026-07-01T00:00:00.000Z',
    };

    const mockAdapter: PDRuntimeAdapter = {
      kind: () => 'pi-ai',
      getCapabilities: async () => mockCapabilities,
      healthCheck: async () => mockHealth,
      startRun: async () => ({ runId: 'run-1', runtimeKind: 'pi-ai', startedAt: '2026-07-01T00:00:00.000Z' }),
      pollRun: async () => ({ runId: 'run-1', status: 'running' }),
      cancelRun: async () => {},
      fetchOutput: async () => null,
      fetchArtifacts: async () => [],
    };

    const selector: RuntimeSelector = {
      select: async (criteria) => ({
        adapter: mockAdapter,
        reason: 'Test selection',
        isFallback: false,
      }),
      register: (adapter) => {
        void adapter;
      },
      getHealthSnapshot: async () => new Map([['pi-ai', mockHealth]]),
      getCapabilitiesSnapshot: async () => new Map([['pi-ai', mockCapabilities]]),
    };

    expect(typeof selector.select).toBe('function');
    expect(typeof selector.register).toBe('function');
    expect(typeof selector.getHealthSnapshot).toBe('function');
    expect(typeof selector.getCapabilitiesSnapshot).toBe('function');
  });
});