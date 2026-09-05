import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkflowStore, initWorkflowSchema } from '../../../src/service/subagent-workflow/workflow-store.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-workflow-store-test-'));
}

describe('WorkflowStore', () => {
  let workspaceDir: string;
  let store: WorkflowStore;

  beforeEach(() => {
    workspaceDir = tmpDir();
    store = new WorkflowStore({ workspaceDir });
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  describe('createWorkflow', () => {
    it('creates a workflow with all required fields', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-1',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-1',
        child_session_key: 'child-key-1',
        run_id: 'run-1',
        state: 'pending',
        created_at: now,
        updated_at: now,
        metadata_json: JSON.stringify({ test: 'data' }),
      });

      const result = store.getWorkflow('wf-1');
      expect(result).not.toBeNull();
      expect(result?.workflow_id).toBe('wf-1');
      expect(result?.workflow_type).toBe('empathy-observer');
      expect(result?.transport).toBe('runtime_direct');
      expect(result?.parent_session_id).toBe('parent-sess-1');
      expect(result?.child_session_key).toBe('child-key-1');
      expect(result?.run_id).toBe('run-1');
      expect(result?.state).toBe('pending');
      expect(result?.cleanup_state).toBe('none');
      expect(result?.metadata_json).toBe(JSON.stringify({ test: 'data' }));
    });

    it('defaults run_id to null when not provided', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-null-run',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-2',
        child_session_key: 'child-key-2',
        run_id: null,
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      const result = store.getWorkflow('wf-null-run');
      expect(result?.run_id).toBeNull();
    });
  });

  describe('updateWorkflowState', () => {
    it('updates state and records event when reason is provided', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-update',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-3',
        child_session_key: 'child-key-3',
        run_id: 'run-3',
        state: 'pending',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.updateWorkflowState('wf-update', 'active', 'started');

      const result = store.getWorkflow('wf-update');
      expect(result?.state).toBe('active');
      expect(result?.updated_at).toBeGreaterThanOrEqual(now);

      const events = store.getEvents('wf-update');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('state_change');
      expect(events[0].from_state).toBe('pending');
      expect(events[0].to_state).toBe('active');
      expect(events[0].reason).toBe('started');
    });

    it('does nothing when workflow does not exist', () => {
      expect(() => {
        store.updateWorkflowState('non-existent', 'active', 'test');
      }).not.toThrow();

      const events = store.getEvents('non-existent');
      expect(events).toEqual([]);
    });

    it('updates state without recording event when reason is not provided', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-no-reason',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-4',
        child_session_key: 'child-key-4',
        run_id: 'run-4',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.updateWorkflowState('wf-no-reason', 'completed');

      const result = store.getWorkflow('wf-no-reason');
      expect(result?.state).toBe('completed');

      const events = store.getEvents('wf-no-reason');
      expect(events).toEqual([]);
    });
  });

  describe('updateWorkflowRunId', () => {
    it('updates run_id and updated_at', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-run-update',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-5',
        child_session_key: 'child-key-5',
        run_id: null,
        state: 'pending',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.updateWorkflowRunId('wf-run-update', 'new-run-id');

      const result = store.getWorkflow('wf-run-update');
      expect(result?.run_id).toBe('new-run-id');
      expect(result?.updated_at).toBeGreaterThanOrEqual(now);
    });
  });

  describe('updateCleanupState', () => {
    it('updates cleanup_state and updated_at', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-cleanup',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-6',
        child_session_key: 'child-key-6',
        run_id: 'run-6',
        state: 'completed',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.updateCleanupState('wf-cleanup', 'pending');

      const result = store.getWorkflow('wf-cleanup');
      expect(result?.cleanup_state).toBe('pending');
      expect(result?.updated_at).toBeGreaterThanOrEqual(now);
    });

    it('supports all cleanup_state values', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-cleanup-all',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-7',
        child_session_key: 'child-key-7',
        run_id: 'run-7',
        state: 'completed',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.updateCleanupState('wf-cleanup-all', 'pending');
      expect(store.getWorkflow('wf-cleanup-all')?.cleanup_state).toBe('pending');

      store.updateCleanupState('wf-cleanup-all', 'failed');
      expect(store.getWorkflow('wf-cleanup-all')?.cleanup_state).toBe('failed');

      store.updateCleanupState('wf-cleanup-all', 'completed');
      expect(store.getWorkflow('wf-cleanup-all')?.cleanup_state).toBe('completed');

      store.updateCleanupState('wf-cleanup-all', 'none');
      expect(store.getWorkflow('wf-cleanup-all')?.cleanup_state).toBe('none');
    });
  });

  describe('touchWorkflow', () => {
    it('updates last_observed_at and updated_at', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-touch',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-8',
        child_session_key: 'child-key-8',
        run_id: 'run-8',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.touchWorkflow('wf-touch');

      const result = store.getWorkflow('wf-touch');
      expect(result?.last_observed_at).toBeGreaterThanOrEqual(now);
      expect(result?.updated_at).toBeGreaterThanOrEqual(now);
    });
  });

  describe('getWorkflowByChildSession', () => {
    it('finds workflow by child_session_key', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-child-lookup',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-9',
        child_session_key: 'unique-child-key',
        run_id: 'run-9',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      const result = store.getWorkflowByChildSession('unique-child-key');
      expect(result?.workflow_id).toBe('wf-child-lookup');
    });

    it('returns null when child_session_key does not exist', () => {
      const result = store.getWorkflowByChildSession('nonexistent-key');
      expect(result).toBeNull();
    });
  });

  describe('getWorkflowByParentSession', () => {
    it('finds most recent workflow by parent_session_id', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-parent-old',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-shared',
        child_session_key: 'child-key-old',
        run_id: 'run-old',
        state: 'completed',
        created_at: now - 1000,
        updated_at: now - 1000,
        metadata_json: '{}',
      });
      store.createWorkflow({
        workflow_id: 'wf-parent-new',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-shared',
        child_session_key: 'child-key-new',
        run_id: 'run-new',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      const result = store.getWorkflowByParentSession('parent-sess-shared');
      expect(result?.workflow_id).toBe('wf-parent-new');
    });

    it('filters by workflow_type when provided', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-type-empathy',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-filter',
        child_session_key: 'child-key-empathy',
        run_id: 'run-empathy',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });
      store.createWorkflow({
        workflow_id: 'wf-type-deep',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'parent-sess-filter',
        child_session_key: 'child-key-deep',
        run_id: 'run-deep',
        state: 'active',
        created_at: now + 100,
        updated_at: now + 100,
        metadata_json: '{}',
      });

      const result = store.getWorkflowByParentSession('parent-sess-filter', 'empathy-observer');
      expect(result?.workflow_id).toBe('wf-type-empathy');
    });

    it('returns null when no matching workflow exists', () => {
      const result = store.getWorkflowByParentSession('nonexistent-parent');
      expect(result).toBeNull();
    });
  });

  describe('getActiveWorkflows', () => {
    it('returns only non-terminal workflows', () => {
      const now = Date.now();
      store.createWorkflow({ workflow_id: 'wf-active-1', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p1', child_session_key: 'c1', run_id: 'r1', state: 'active', created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-active-2', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p2', child_session_key: 'c2', run_id: 'r2', state: 'pending', created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-completed', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p3', child_session_key: 'c3', run_id: 'r3', state: 'completed', created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-terminal-error', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p4', child_session_key: 'c4', run_id: 'r4', state: 'terminal_error', created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-expired', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p5', child_session_key: 'c5', run_id: 'r5', state: 'expired', created_at: now, updated_at: now, metadata_json: '{}' });

      const result = store.getActiveWorkflows();
      expect(result).toHaveLength(2);
      expect(result.map(w => w.workflow_id)).toEqual(expect.arrayContaining(['wf-active-1', 'wf-active-2']));
    });

    it('filters by workflow_type when provided', () => {
      const now = Date.now();
      store.createWorkflow({ workflow_id: 'wf-filter-empathy', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p6', child_session_key: 'c6', run_id: 'r6', state: 'active', created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-filter-deep', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p7', child_session_key: 'c7', run_id: 'r7', state: 'active', created_at: now, updated_at: now, metadata_json: '{}' });

      const result = store.getActiveWorkflows('empathy-observer');
      expect(result).toHaveLength(1);
      expect(result[0].workflow_id).toBe('wf-filter-empathy');
    });
  });

  describe('getExpiredWorkflows', () => {
    it('returns workflows older than maxAgeMs', () => {
      const now = Date.now();
      store.createWorkflow({ workflow_id: 'wf-expired-candidate', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p8', child_session_key: 'c8', run_id: 'r8', state: 'active', created_at: now - 10000, updated_at: now - 10000, last_observed_at: now - 6000, metadata_json: '{}' });

      store.createWorkflow({ workflow_id: 'wf-recent', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p9', child_session_key: 'c9', run_id: 'r9', state: 'active', created_at: now, updated_at: now, last_observed_at: now, metadata_json: '{}' });

      store.createWorkflow({ workflow_id: 'wf-no-touch', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p10', child_session_key: 'c10', run_id: 'r10', state: 'active', created_at: now - 10000, updated_at: now - 10000, metadata_json: '{}' });

      const result = store.getExpiredWorkflows(5000);
      expect(result).toHaveLength(1);
      expect(result[0].workflow_id).toBe('wf-expired-candidate');
    });
  });

  describe('listWorkflows', () => {
    it('returns all workflows ordered by created_at desc', () => {
      const now = Date.now();
      store.createWorkflow({ workflow_id: 'wf-list-1', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p11', child_session_key: 'c11', run_id: 'r11', state: 'active', created_at: now - 2000, updated_at: now - 2000, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-list-2', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p12', child_session_key: 'c12', run_id: 'r12', state: 'completed', created_at: now - 1000, updated_at: now - 1000, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-list-3', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p13', child_session_key: 'c13', run_id: 'r13', state: 'pending', created_at: now, updated_at: now, metadata_json: '{}' });

      const result = store.listWorkflows();
      expect(result).toHaveLength(3);
      expect(result[0].workflow_id).toBe('wf-list-3');
      expect(result[1].workflow_id).toBe('wf-list-2');
      expect(result[2].workflow_id).toBe('wf-list-1');
    });

    it('filters by state when provided', () => {
      const now = Date.now();
      store.createWorkflow({ workflow_id: 'wf-state-active', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p14', child_session_key: 'c14', run_id: 'r14', state: 'active', created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-state-completed', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p15', child_session_key: 'c15', run_id: 'r15', state: 'completed', created_at: now, updated_at: now, metadata_json: '{}' });

      const result = store.listWorkflows('completed');
      expect(result).toHaveLength(1);
      expect(result[0].workflow_id).toBe('wf-state-completed');
    });
  });

  describe('recordEvent', () => {
    it('records event with all fields', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-event',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'p16',
        child_session_key: 'c16',
        run_id: 'r16',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.recordEvent('wf-event', 'custom_event', 'active', 'wait_result', 'test reason', { detail: 'test' });

      const events = store.getEvents('wf-event');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('custom_event');
      expect(events[0].from_state).toBe('active');
      expect(events[0].to_state).toBe('wait_result');
      expect(events[0].reason).toBe('test reason');
      expect(JSON.parse(events[0].payload_json)).toEqual({ detail: 'test' });
    });

    it('accepts null from_state', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-event-null-from',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'p17',
        child_session_key: 'c17',
        run_id: 'r17',
        state: 'pending',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.recordEvent('wf-event-null-from', 'created', null, 'pending', 'workflow created', {});

      const events = store.getEvents('wf-event-null-from');
      expect(events[0].from_state).toBeNull();
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes workflow and cascades delete events', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-delete',
        workflow_type: 'empathy-observer',
        transport: 'runtime_direct',
        parent_session_id: 'p18',
        child_session_key: 'c18',
        run_id: 'r18',
        state: 'active',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });
      store.recordEvent('wf-delete', 'state_change', 'pending', 'active', 'started', {});

      store.deleteWorkflow('wf-delete');

      expect(store.getWorkflow('wf-delete')).toBeNull();
      expect(store.getEvents('wf-delete')).toEqual([]);
    });
  });

  describe('recordDuration', () => {
    it('records duration_ms and updates updated_at', () => {
      const now = Date.now();
      store.createWorkflow({
        workflow_id: 'wf-duration',
        workflow_type: 'test-workflow',
        transport: 'runtime_direct',
        parent_session_id: 'p19',
        child_session_key: 'c19',
        run_id: 'r19',
        state: 'completed',
        created_at: now,
        updated_at: now,
        metadata_json: '{}',
      });

      store.recordDuration('wf-duration', 15000);

      const result = store.getWorkflow('wf-duration');
      expect(result?.duration_ms).toBe(15000);
      expect(result?.updated_at).toBeGreaterThanOrEqual(now);
    });
  });

  describe('getCompletionDurations', () => {
    it('returns durations for completed workflows of specified type', () => {
      const now = Date.now();
      store.createWorkflow({ workflow_id: 'wf-dur-1', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p20', child_session_key: 'c20', run_id: 'r20', state: 'completed', duration_ms: 10000, created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-dur-2', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p21', child_session_key: 'c21', run_id: 'r21', state: 'completed', duration_ms: 20000, created_at: now + 100, updated_at: now + 100, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-dur-3', workflow_type: 'test-workflow', transport: 'runtime_direct', parent_session_id: 'p22', child_session_key: 'c22', run_id: 'r22', state: 'completed', duration_ms: 30000, created_at: now, updated_at: now, metadata_json: '{}' });
      store.createWorkflow({ workflow_id: 'wf-dur-4', workflow_type: 'empathy-observer', transport: 'runtime_direct', parent_session_id: 'p23', child_session_key: 'c23', run_id: 'r23', state: 'active', duration_ms: 5000, created_at: now, updated_at: now, metadata_json: '{}' });

      const result = store.getCompletionDurations('empathy-observer');
      expect(result).toHaveLength(2);
      expect(result).toContain(10000);
      expect(result).toContain(20000);
    });

    it('respects limit parameter', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        store.createWorkflow({
          workflow_id: `wf-dur-limit-${i}`,
          workflow_type: 'empathy-observer',
          transport: 'runtime_direct',
          parent_session_id: `p-limit-${i}`,
          child_session_key: `c-limit-${i}`,
          run_id: `r-limit-${i}`,
          state: 'completed',
          duration_ms: (i + 1) * 1000,
          created_at: now + i,
          updated_at: now + i,
          metadata_json: '{}',
        });
      }

      const result = store.getCompletionDurations('empathy-observer', 3);
      expect(result).toHaveLength(3);
    });
  });
});

describe('initWorkflowSchema', () => {
  it('creates schema and returns table names', () => {
    const workspaceDir = tmpDir();
    const result = initWorkflowSchema(workspaceDir);

    expect(result.tables).toEqual(['schema_version', 'subagent_workflows', 'subagent_workflow_events']);
    expect(result.warnings).toEqual([]);

    const dbPath = path.join(workspaceDir, '.state', 'subagent_workflows.db');
    expect(fs.existsSync(dbPath)).toBe(true);

    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('is idempotent - can be called on existing DB', () => {
    const workspaceDir = tmpDir();
    initWorkflowSchema(workspaceDir);

    const result = initWorkflowSchema(workspaceDir);
    expect(result.tables).toEqual(['schema_version', 'subagent_workflows', 'subagent_workflow_events']);
    expect(result.warnings).toEqual([]);

    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
});