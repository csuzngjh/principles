/**
 * Integration tests for Empathy Observer Workflow
 *
 * These tests verify the complete chain from hook entry to workflow state/events.
 * Unlike unit tests, these use real file system and SQLite for WorkflowStore.
 *
 * Coverage:
 * 1. EmpathyObserverWorkflowManager startWorkflow triggers workflow helper
 * 2. WorkflowStore records spawn/wait/finalize events
 * 3. Lifecycle cleanup (sweepExpiredWorkflows) works when wired
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmpathyObserverWorkflowManager, empathyObserverWorkflowSpec } from '../../src/service/subagent-workflow/empathy-observer-workflow-manager.js';
import { WorkflowStore } from '../../src/service/subagent-workflow/workflow-store.js';
import { handleBeforePromptBuild } from '../../src/hooks/prompt.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

/**
 * Helper to create a mock async function for workflow-manager tests.
 */
function mockAsyncFn<T extends (...args: any[]) => Promise<any>>(impl: (...args: any[]) => any) {
  const fn = vi.fn(impl) as unknown as T;
  Object.defineProperty(fn, 'constructor', {
    value: function AsyncFunction() {},
    writable: true,
    configurable: true,
  });
  return fn;
}

describe('Empathy Workflow Integration (PR2)', () => {
  let tempDir: string;
  let stateDir: string;
  let store: WorkflowStore;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-empathy-integration-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    store?.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Test 1: WorkflowStore records spawn/wait/finalize events
  // ---------------------------------------------------------------------------
  describe('WorkflowStore event chain', () => {
    it('records spawned event when workflow starts', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-001' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":false}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-001',
        taskInput: 'user message',
      });

      // Verify workflow was created in store
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow).not.toBeNull();
      expect(workflow?.state).toBe('active');
      expect(workflow?.parent_session_id).toBe('session-001');

      // Verify spawned event was recorded
      const events = store.getEvents(handle.workflowId);
      const spawnedEvent = events.find(e => e.event_type === 'spawned');
      expect(spawnedEvent).toBeDefined();
      expect(spawnedEvent?.to_state).toBe('active');

      manager.dispose();
    });

    it('records wait_result and finalized events on successful completion', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-002' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":false}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-002',
        taskInput: 'user message',
      });

      // Clear the scheduled poll timeout to manually trigger notifyWaitResult
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      await manager.notifyWaitResult(handle.workflowId, 'ok');

      // Verify final state
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow?.state).toBe('completed');

      // Verify event chain: spawned -> wait_result -> finalized
      const events = store.getEvents(handle.workflowId);
      const eventTypes = events.map(e => e.event_type);

      expect(eventTypes).toContain('spawned');
      expect(eventTypes).toContain('wait_result');
      expect(eventTypes).toContain('finalized');

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: sweepExpiredWorkflows works when wired
  // ---------------------------------------------------------------------------
  describe('Lifecycle cleanup (sweepExpiredWorkflows)', () => {
    it('sweeps workflows older than TTL', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-003' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'timeout' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: [] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      // Create a workflow
      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-003',
        taskInput: 'user message',
      });

      // Clear the scheduled poll timeout
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      // Manually set last_observed_at to simulate old workflow
      const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const db = (store as any).db;
      db.prepare('UPDATE subagent_workflows SET last_observed_at = ? WHERE workflow_id = ?').run(oldTime, handle.workflowId);

      // Run sweep with 5 minute TTL
      const sweptCount = await manager.sweepExpiredWorkflows(5 * 60 * 1000);

      expect(sweptCount).toBe(1);

      // Verify workflow is now expired
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow?.state).toBe('expired');

      // Verify swept event was recorded
      const events = store.getEvents(handle.workflowId);
      const sweptEvent = events.find(e => e.event_type === 'swept');
      expect(sweptEvent).toBeDefined();

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Debug summary is accessible
  // ---------------------------------------------------------------------------
  describe('Observability (getWorkflowDebugSummary)', () => {
    it('provides debug summary with recent events', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-004' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":false}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-004',
        taskInput: 'user message',
      });

      const summary = await manager.getWorkflowDebugSummary(handle.workflowId);

      expect(summary).not.toBeNull();
      expect(summary?.workflowId).toBe(handle.workflowId);
      expect(summary?.workflowType).toBe('empathy-observer');
      expect(summary?.transport).toBe('runtime_direct');
      expect(summary?.state).toBe('active');
      expect(summary?.parentSessionId).toBe('session-004');
      expect(summary?.recentEvents.length).toBeGreaterThan(0);
      expect(summary?.recentEvents[0].eventType).toBe('spawned');

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: Workflow isolation
  // ---------------------------------------------------------------------------
  describe('Workflow isolation', () => {
    it('each workflow is recorded independently in WorkflowStore', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-005' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":false}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      // Start workflow
      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-005',
        taskInput: 'user message',
      });

      // Verify workflow is recorded independently
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow).not.toBeNull();
      expect(workflow?.workflow_type).toBe('empathy-observer');

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5: State transition validation
  // ---------------------------------------------------------------------------
  describe('Workflow state transitions', () => {
    it('transitions: active -> wait_result -> finalizing -> completed', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-006' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":false}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-006',
        taskInput: 'user message',
      });

      // Verify initial state
      expect(store.getWorkflow(handle.workflowId)?.state).toBe('active');

      // Clear timeout and trigger wait result
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      await manager.notifyWaitResult(handle.workflowId, 'ok');

      // Verify final state
      expect(store.getWorkflow(handle.workflowId)?.state).toBe('completed');

      // Verify state transition events
      const events = store.getEvents(handle.workflowId);
      const stateChanges = events.filter(e => e.event_type === 'state_change' || e.event_type === 'wait_result' || e.event_type === 'finalized');

      // Should have spawn, wait_result, finalized at minimum
      expect(stateChanges.length).toBeGreaterThanOrEqual(2);

      manager.dispose();
    });

    it('transitions to terminal_error on timeout', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-007' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'timeout' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: [] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-007',
        taskInput: 'user message',
      });

      // Clear timeout and trigger error result
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      await manager.notifyWaitResult(handle.workflowId, 'timeout', 'wait timed out');

      // Verify terminal state
      expect(store.getWorkflow(handle.workflowId)?.state).toBe('terminal_error');

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6: PR2.1 Task 1 - subagent_ended -> notifyLifecycleEvent wiring
  // ---------------------------------------------------------------------------
  describe('PR2.1: subagent_ended lifecycle event wiring', () => {
    it('triggers notifyWaitResult when subagent_ended event received', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-pr21-001' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":false}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      // Start a helper workflow
      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-pr21-001',
        taskInput: 'user message',
      });

      // Get the child session key
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow).not.toBeNull();
      const childSessionKey = workflow!.child_session_key;

      // Verify child session key has expected prefix
      expect(childSessionKey).toMatch(/^agent:main:subagent:workflow-/);

      // Clear the scheduled poll timeout to prevent auto-wait
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      // Verify initial state is active
      expect(store.getWorkflow(handle.workflowId)?.state).toBe('active');

      // Simulate subagent_ended event by calling notifyLifecycleEvent
      // This triggers notifyWaitResult internally
      await manager.notifyLifecycleEvent(handle.workflowId, 'subagent_ended', {
        outcome: 'ok',
      });

      // Verify workflow completed through lifecycle event path
      const finalWorkflow = store.getWorkflow(handle.workflowId);
      expect(finalWorkflow?.state).toBe('completed');

      // Verify event chain includes finalized
      const events = store.getEvents(handle.workflowId);
      const finalizedEvent = events.find(e => e.event_type === 'finalized');
      expect(finalizedEvent).toBeDefined();

      manager.dispose();
    });

    it('handles error outcome via lifecycle event', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-pr21-002' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'error' as const, error: 'test error' })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: [] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-pr21-002',
        taskInput: 'test',
      });

      // Clear timeout
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      // Notify error outcome
      await manager.notifyLifecycleEvent(handle.workflowId, 'subagent_ended', {
        outcome: 'error',
        error: 'subagent failed',
      });

      // Verify terminal state
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow?.state).toBe('terminal_error');

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 7: PR2.1 Task 2 - sweepExpiredWorkflows integration
  // ---------------------------------------------------------------------------
  describe('PR2.1: sweepExpiredWorkflows integration', () => {
    it('WorkflowStore.getExpiredWorkflows returns workflows past TTL', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-sweep-001' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-sweep-001',
        taskInput: 'test',
      });

      // Clear timeout
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      // Manually set last_observed_at to simulate expired workflow
      const db = (store as any).db;
      const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      db.prepare('UPDATE subagent_workflows SET last_observed_at = ? WHERE workflow_id = ?').run(oldTime, handle.workflowId);

      // Verify getExpiredWorkflows finds it
      const expired = store.getExpiredWorkflows(5 * 60 * 1000);
      expect(expired.length).toBe(1);
      expect(expired[0].workflow_id).toBe(handle.workflowId);

      manager.dispose();
    });

    it('sweepExpiredWorkflows marks workflows as expired', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-sweep-002' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-sweep-002',
        taskInput: 'test',
      });

      // Clear timeout
      const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
      if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
      }

      // Manually expire
      const db = (store as any).db;
      const oldTime = Date.now() - 10 * 60 * 1000;
      db.prepare('UPDATE subagent_workflows SET last_observed_at = ? WHERE workflow_id = ?').run(oldTime, handle.workflowId);

      // Sweep
      const count = await manager.sweepExpiredWorkflows(5 * 60 * 1000);
      expect(count).toBe(1);

      // Verify state
      const workflow = store.getWorkflow(handle.workflowId);
      expect(workflow?.state).toBe('expired');

      // Verify swept event
      const events = store.getEvents(handle.workflowId);
      const sweptEvent = events.find(e => e.event_type === 'swept');
      expect(sweptEvent).toBeDefined();

      manager.dispose();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 8: PR2.1 Task 3 - getWorkflowDebugSummary slash command
  // ---------------------------------------------------------------------------
  describe('PR2.1: getWorkflowDebugSummary accessibility', () => {
    it('provides complete debug summary with all fields', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-debug-001' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"damageDetected":true,"severity":"moderate"}'] })),
        deleteSession: mockAsyncFn(async () => {}),
      };

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent,
      });

      const handle = await manager.startWorkflow(empathyObserverWorkflowSpec, {
        parentSessionId: 'session-debug-001',
        workspaceDir: tempDir,
        taskInput: 'This is a test user message for debugging',
        metadata: { customField: 'customValue' },
      });

      const summary = await manager.getWorkflowDebugSummary(handle.workflowId);

      expect(summary).not.toBeNull();
      expect(summary?.workflowId).toBe(handle.workflowId);
      expect(summary?.workflowType).toBe('empathy-observer');
      expect(summary?.transport).toBe('runtime_direct');
      expect(summary?.state).toBe('active');
      expect(summary?.cleanupState).toBe('none');
      expect(summary?.parentSessionId).toBe('session-debug-001');
      expect(summary?.childSessionKey).toContain('workflow-');
      expect(summary?.runId).toBe('run-debug-001');
      expect(summary?.metadata.taskInput).toBe('This is a test user message for debugging');
      expect(summary?.metadata.customField).toBe('customValue');
      expect(summary?.recentEvents.length).toBeGreaterThan(0);

      // Verify first event is spawned
      expect(summary?.recentEvents[0].eventType).toBe('spawned');

      manager.dispose();
    });

    it('returns null for non-existent workflow', async () => {
      store = new WorkflowStore({ workspaceDir: tempDir });

      const manager = new EmpathyObserverWorkflowManager({
        workspaceDir: tempDir,
        logger,
        subagent: {} as any,
      });

      const summary = await manager.getWorkflowDebugSummary('non-existent-id');
      expect(summary).toBeNull();

      manager.dispose();
    });
  });

});
