import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkflowRow, WorkflowEventRow } from '../../src/service/subagent-workflow/types.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockStoreMethods = {
  createWorkflow: vi.fn(),
  recordEvent: vi.fn(),
  updateWorkflowState: vi.fn(),
  getWorkflow: vi.fn(),
  getEvents: vi.fn().mockReturnValue([]),
  getExpiredWorkflows: vi.fn().mockReturnValue([]),
  dispose: vi.fn(),
};

vi.mock('../../src/service/subagent-workflow/workflow-store.js', () => ({
  WorkflowStore: class MockWorkflowStore {
    createWorkflow = mockStoreMethods.createWorkflow;
    recordEvent = mockStoreMethods.recordEvent;
    updateWorkflowState = mockStoreMethods.updateWorkflowState;
    getWorkflow = mockStoreMethods.getWorkflow;
    getEvents = mockStoreMethods.getEvents;
    getExpiredWorkflows = mockStoreMethods.getExpiredWorkflows;
    dispose = mockStoreMethods.dispose;
  },
}));

vi.mock('../../src/service/nocturnal-service.js', () => ({
  executeNocturnalReflectionAsync: vi.fn(),
}));

vi.mock('../../src/utils/subagent-probe.js', () => ({
  isSubagentRuntimeAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/core/nocturnal-snapshot-contract.js', () => ({
  validateNocturnalSnapshotIngress: vi.fn().mockReturnValue({
    status: 'valid',
    snapshot: { sessionId: 'test-session', artifacts: [] },
    reasons: [],
  }),
}));

vi.mock('../../src/core/nocturnal-paths.js', () => ({
  resolveNocturnalDir: vi.fn().mockReturnValue('/tmp/nocturnal/samples'),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: {
    get: vi.fn().mockReturnValue({
      recordNocturnalDreamerCompleted: vi.fn(),
    }),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

import {
  NocturnalWorkflowManager,
  nocturnalWorkflowSpec,
  type NocturnalWorkflowOptions,
} from '../../src/service/subagent-workflow/nocturnal-workflow-manager.js';
import { WorkflowStore } from '../../src/service/subagent-workflow/workflow-store.js';
import { executeNocturnalReflectionAsync } from '../../src/service/nocturnal-service.js';
import { isSubagentRuntimeAvailable } from '../../src/utils/subagent-probe.js';
import { validateNocturnalSnapshotIngress } from '../../src/core/nocturnal-snapshot-contract.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockRuntimeAdapter() {
  return {
    execute: vi.fn(),
    isRuntimeAvailable: vi.fn().mockReturnValue(true),
  };
}

let mockLogger: ReturnType<typeof createMockLogger>;

function createManager(overrides?: Partial<NocturnalWorkflowOptions>) {
  mockLogger = createMockLogger();
  const defaults: NocturnalWorkflowOptions = {
    workspaceDir: '/tmp/test-workspace',
    stateDir: '/tmp/test-workspace/.state',
    logger: mockLogger as any,
    runtimeAdapter: createMockRuntimeAdapter() as any,
    subagent: { run: vi.fn() },
  };
  return new NocturnalWorkflowManager({ ...defaults, ...overrides });
}

function getMockStore() {
  return mockStoreMethods;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('nocturnalWorkflowSpec', () => {
  test('has correct constants', () => {
    expect(nocturnalWorkflowSpec.workflowType).toBe('nocturnal');
    expect(nocturnalWorkflowSpec.transport).toBe('runtime_direct');
    expect(nocturnalWorkflowSpec.timeoutMs).toBe(15 * 60 * 1000);
    expect(nocturnalWorkflowSpec.ttlMs).toBe(30 * 60 * 1000);
    expect(nocturnalWorkflowSpec.shouldDeleteSessionAfterFinalize).toBe(false);
  });

  test('buildPrompt returns empty string', () => {
    expect(nocturnalWorkflowSpec.buildPrompt({}, {} as any)).toBe('');
  });

  test('parseResult extracts nocturnalResult from metadata', async () => {
    const result = await nocturnalWorkflowSpec.parseResult({
      metadata: { nocturnalResult: { success: true } },
    } as any);
    expect(result).toEqual({ success: true });
  });

  test('parseResult returns null when no nocturnalResult', async () => {
    const result = await nocturnalWorkflowSpec.parseResult({
      metadata: {},
    } as any);
    expect(result).toBeNull();
  });

  test('shouldFinalizeOnWaitStatus returns true only for ok', () => {
    expect(nocturnalWorkflowSpec.shouldFinalizeOnWaitStatus('ok')).toBe(true);
    expect(nocturnalWorkflowSpec.shouldFinalizeOnWaitStatus('error')).toBe(false);
    expect(nocturnalWorkflowSpec.shouldFinalizeOnWaitStatus('timeout')).toBe(false);
  });
});

describe('NocturnalWorkflowManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSubagentRuntimeAvailable).mockReturnValue(true);
    vi.mocked(validateNocturnalSnapshotIngress).mockReturnValue({
      status: 'valid',
      snapshot: { sessionId: 'test-session', artifacts: [] },
      reasons: [],
    } as any);
  });

  // ── startWorkflow ────────────────────────────────────────────────────────

  describe('startWorkflow', () => {
    test('throws when subagent runtime is unavailable', async () => {
      vi.mocked(isSubagentRuntimeAvailable).mockReturnValue(false);
      const manager = createManager();

      await expect(
        manager.startWorkflow(nocturnalWorkflowSpec as any, {
          parentSessionId: 'sess-1',
          taskInput: {},
        })
      ).rejects.toThrow('subagent runtime unavailable');
    });

    test('returns terminal_error when snapshot is invalid', async () => {
      vi.mocked(validateNocturnalSnapshotIngress).mockReturnValue({
        status: 'invalid',
        snapshot: null,
        reasons: ['missing snapshot'],
      } as any);
      const manager = createManager();

      const handle = await manager.startWorkflow(nocturnalWorkflowSpec as any, {
        parentSessionId: 'sess-1',
        taskInput: {},
        metadata: {},
      });

      expect(handle.state).toBe('terminal_error');
      expect(handle.workflowId).toMatch(/^wf_/);
    });

    test('returns active handle and launches async pipeline on valid input', async () => {
      vi.mocked(validateNocturnalSnapshotIngress).mockReturnValue({
        status: 'valid',
        snapshot: { sessionId: 'test-session', artifacts: [] },
        reasons: [],
      } as any);
      vi.mocked(executeNocturnalReflectionAsync).mockResolvedValue({
        success: true,
        artifact: { principleId: 'p-1' },
        diagnostics: { persistedPath: '/tmp/artifact.json' },
      } as any);

      const manager = createManager();
      const handle = await manager.startWorkflow(nocturnalWorkflowSpec as any, {
        parentSessionId: 'sess-1',
        taskInput: {},
        metadata: { snapshot: { sessionId: 'test-session' } },
      });

      expect(handle.state).toBe('active');
      expect(handle.workflowId).toMatch(/^wf_/);
      expect(handle.childSessionKey).toContain('nocturnal:internal:');

      // Async pipeline runs after startWorkflow returns
      await new Promise((r) => setTimeout(r, 50));
      expect(executeNocturnalReflectionAsync).toHaveBeenCalled();
    });

    test('records nocturnal_failed when async pipeline throws', async () => {
      vi.mocked(validateNocturnalSnapshotIngress).mockReturnValue({
        status: 'valid',
        snapshot: { sessionId: 'test-session', artifacts: [] },
        reasons: [],
      } as any);
      vi.mocked(executeNocturnalReflectionAsync).mockRejectedValue(
        new Error('pipeline exploded')
      );

      const manager = createManager();
      const handle = await manager.startWorkflow(nocturnalWorkflowSpec as any, {
        parentSessionId: 'sess-1',
        taskInput: {},
        metadata: { snapshot: { sessionId: 'test-session' } },
      });

      expect(handle.state).toBe('active');

      // Wait for async pipeline to fail
      await new Promise((r) => setTimeout(r, 100));
      const store = getMockStore();
      expect(store.recordEvent).toHaveBeenCalledWith(
        handle.workflowId,
        'nocturnal_failed',
        null,
        'terminal_error',
        expect.stringContaining('pipeline exploded'),
        expect.anything()
      );
    });

    test('passes idleCheckOverride when skipPreflightGates includes idle', async () => {
      vi.mocked(validateNocturnalSnapshotIngress).mockReturnValue({
        status: 'valid',
        snapshot: { sessionId: 'test-session', artifacts: [] },
        reasons: [],
      } as any);
      vi.mocked(executeNocturnalReflectionAsync).mockResolvedValue({
        success: true,
        artifact: { principleId: 'p-1' },
        diagnostics: {},
      } as any);

      const manager = createManager();
      await manager.startWorkflow(nocturnalWorkflowSpec as any, {
        parentSessionId: 'sess-1',
        taskInput: {},
        metadata: {
          snapshot: { sessionId: 'test-session' },
          skipPreflightGates: ['idle'],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(executeNocturnalReflectionAsync).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          idleCheckOverride: expect.objectContaining({
            isIdle: true,
            reason: 'skipPreflightGates override',
          }),
        })
      );
    });

    test('passes principleIdOverride when principleId and snapshot provided', async () => {
      vi.mocked(validateNocturnalSnapshotIngress).mockReturnValue({
        status: 'valid',
        snapshot: { sessionId: 'test-session', artifacts: [] },
        reasons: [],
      } as any);
      vi.mocked(executeNocturnalReflectionAsync).mockResolvedValue({
        success: true,
        artifact: { principleId: 'p-1' },
        diagnostics: {},
      } as any);

      const manager = createManager();
      await manager.startWorkflow(nocturnalWorkflowSpec as any, {
        parentSessionId: 'sess-1',
        taskInput: {},
        metadata: {
          snapshot: { sessionId: 'test-session' },
          principleId: 'p-123',
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(executeNocturnalReflectionAsync).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          principleIdOverride: 'p-123',
          snapshotOverride: expect.anything(),
        })
      );
    });
  });

  // ── notifyWaitResult ─────────────────────────────────────────────────────

  describe('notifyWaitResult', () => {
    test('warns when workflow not found', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue(undefined);

      await manager.notifyWaitResult('missing-id', 'ok');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('workflow not found')
      );
    });

    test('skips when workflow is not active', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue({
        workflow_id: 'wf-1',
        state: 'completed',
      });

      await manager.notifyWaitResult('wf-1', 'ok');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('not in active state')
      );
    });

    test('transitions to completed on ok status', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue({
        workflow_id: 'wf-1',
        state: 'active',
      });

      await manager.notifyWaitResult('wf-1', 'ok');

      expect(store.updateWorkflowState).toHaveBeenCalledWith('wf-1', 'finalizing');
      expect(store.updateWorkflowState).toHaveBeenCalledWith('wf-1', 'completed');
      expect(store.recordEvent).toHaveBeenCalledWith(
        'wf-1',
        'trinity_completed',
        'active',
        'finalizing',
        expect.anything(),
        expect.anything()
      );
    });

    test('transitions to terminal_error on error status', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue({
        workflow_id: 'wf-1',
        state: 'active',
      });

      await manager.notifyWaitResult('wf-1', 'error', 'stage failed');

      expect(store.updateWorkflowState).toHaveBeenCalledWith('wf-1', 'terminal_error');
      expect(store.recordEvent).toHaveBeenCalledWith(
        'wf-1',
        'nocturnal_failed',
        'active',
        'terminal_error',
        'stage failed',
        expect.anything()
      );
    });
  });

  // ── finalizeOnce ─────────────────────────────────────────────────────────

  describe('finalizeOnce', () => {
    test('warns when workflow not found', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue(undefined);

      await manager.finalizeOnce('missing-id');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('workflow not found')
      );
    });

    test('skips when already completed', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue({
        workflow_id: 'wf-1',
        state: 'completed',
      });
      // Mark as completed internally
      manager['completedWorkflows'].set('wf-1', Date.now());

      await manager.finalizeOnce('wf-1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('already completed')
      );
    });

    test('marks completed for non-completed workflow', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue({
        workflow_id: 'wf-1',
        state: 'terminal_error',
      });

      await manager.finalizeOnce('wf-1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('already in terminal state')
      );
    });
  });

  // ── expireWorkflow ───────────────────────────────────────────────────────

  describe('expireWorkflow', () => {
    test('marks workflow as expired', () => {
      const manager = createManager();
      const store = getMockStore();

      manager.expireWorkflow('wf-1', 'timeout');

      expect(store.updateWorkflowState).toHaveBeenCalledWith('wf-1', 'expired');
      expect(store.recordEvent).toHaveBeenCalledWith(
        'wf-1',
        'nocturnal_expired',
        'active',
        'expired',
        'timeout',
        { reason: 'timeout' }
      );
    });
  });

  // ── sweepExpiredWorkflows ────────────────────────────────────────────────

  describe('sweepExpiredWorkflows', () => {
    test('returns 0 when no expired workflows', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getExpiredWorkflows.mockReturnValue([]);

      const count = await manager.sweepExpiredWorkflows();
      expect(count).toBe(0);
    });

    test('sweeps expired workflows and records events', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getExpiredWorkflows.mockReturnValue([
        {
          workflow_id: 'wf-old',
          state: 'active',
          child_session_key: 'nocturnal:internal:wf-old',
        },
      ]);

      const count = await manager.sweepExpiredWorkflows();

      expect(count).toBe(1);
      expect(store.updateWorkflowState).toHaveBeenCalledWith('wf-old', 'expired');
      expect(store.recordEvent).toHaveBeenCalledWith(
        'wf-old',
        'nocturnal_expired',
        'active',
        'expired',
        'TTL expired',
        expect.anything()
      );
    });

    test('cleans up completedWorkflows map entries older than 1 minute', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getExpiredWorkflows.mockReturnValue([]);

      // Add an old entry
      manager['completedWorkflows'].set('wf-old', Date.now() - 120_000);
      manager['completedWorkflows'].set('wf-recent', Date.now());

      await manager.sweepExpiredWorkflows();

      expect(manager['completedWorkflows'].has('wf-old')).toBe(false);
      expect(manager['completedWorkflows'].has('wf-recent')).toBe(true);
    });
  });

  // ── getWorkflowDebugSummary ──────────────────────────────────────────────

  describe('getWorkflowDebugSummary', () => {
    test('returns null when workflow not found', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue(undefined);

      const summary = await manager.getWorkflowDebugSummary('missing-id');
      expect(summary).toBeNull();
    });

    test('returns debug summary with events', async () => {
      const manager = createManager();
      const store = getMockStore();
      store.getWorkflow.mockReturnValue({
        workflow_id: 'wf-1',
        workflow_type: 'nocturnal',
        transport: 'runtime_direct',
        parent_session_id: 'sess-1',
        child_session_key: 'nocturnal:internal:wf-1',
        run_id: null,
        state: 'completed',
        cleanup_state: 'none',
        last_observed_at: null,
        metadata_json: '{"parentSessionId":"sess-1"}',
      });
      store.getEvents.mockReturnValue([
        {
          event_type: 'nocturnal_started',
          from_state: null,
          to_state: 'active',
          reason: 'started',
          created_at: Date.now(),
          payload_json: '{}',
        },
      ] as WorkflowEventRow[]);

      const summary = await manager.getWorkflowDebugSummary('wf-1', 5);

      expect(summary).not.toBeNull();
      expect(summary!.workflowId).toBe('wf-1');
      expect(summary!.state).toBe('completed');
      expect(summary!.recentEvents).toHaveLength(1);
      expect(summary!.recentEvents[0].eventType).toBe('nocturnal_started');
    });
  });

  // ── notifyLifecycleEvent ─────────────────────────────────────────────────

  describe('notifyLifecycleEvent', () => {
    test('is a no-op', async () => {
      const manager = createManager();
      // Should not throw
      await manager.notifyLifecycleEvent('wf-1', 'subagent_spawned');
      await manager.notifyLifecycleEvent('wf-1', 'subagent_ended');
    });
  });

  // ── dispose ──────────────────────────────────────────────────────────────

  describe('dispose', () => {
    test('disposes the store', () => {
      const manager = createManager();
      const store = getMockStore();

      manager.dispose();
      expect(store.dispose).toHaveBeenCalled();
    });
  });
});
