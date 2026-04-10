import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEventRow, WorkflowRow } from '../../src/service/subagent-workflow/types.js';

const mockListWorkflows = vi.fn<() => WorkflowRow[]>();
const mockGetWorkflow = vi.fn<(workflowId: string) => WorkflowRow | null>();
const mockGetEvents = vi.fn<(workflowId: string) => WorkflowEventRow[]>();
const mockGetStageOutputs = vi.fn<(workflowId: string) => Array<{ stage: string }>>();
const mockDispose = vi.fn();

vi.mock('../../src/service/subagent-workflow/workflow-store.js', () => ({
  WorkflowStore: class {
    listWorkflows = mockListWorkflows;
    getWorkflow = mockGetWorkflow;
    getEvents = mockGetEvents;
    getStageOutputs = mockGetStageOutputs;
    dispose = mockDispose;
  },
}));

import { MonitoringQueryService } from '../../src/service/monitoring-query-service.js';

function createWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: overrides.workflow_id ?? 'wf-1',
    workflow_type: overrides.workflow_type ?? 'nocturnal',
    transport: overrides.transport ?? 'runtime_direct',
    parent_session_id: overrides.parent_session_id ?? 'parent-1',
    child_session_key: overrides.child_session_key ?? 'child-1',
    run_id: overrides.run_id ?? null,
    state: overrides.state ?? 'completed',
    cleanup_state: overrides.cleanup_state ?? 'none',
    created_at: overrides.created_at ?? Date.UTC(2026, 3, 10, 0, 0, 0),
    updated_at: overrides.updated_at ?? Date.UTC(2026, 3, 10, 0, 5, 0),
    last_observed_at: overrides.last_observed_at ?? null,
    duration_ms: overrides.duration_ms ?? 1_000,
    metadata_json: overrides.metadata_json ?? '{}',
  };
}

function createEvent(
  workflowId: string,
  eventType: string,
  createdAt: number,
  reason = ''
): WorkflowEventRow {
  return {
    workflow_id: workflowId,
    event_type: eventType,
    from_state: null,
    to_state: 'completed',
    reason,
    payload_json: '{}',
    created_at: createdAt,
  };
}

describe('MonitoringQueryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListWorkflows.mockReturnValue([]);
    mockGetWorkflow.mockReturnValue(null);
    mockGetEvents.mockReturnValue([]);
    mockGetStageOutputs.mockReturnValue([]);
  });

  it('ignores malformed workflow metadata when listing workflows', () => {
    mockListWorkflows.mockReturnValue([
      createWorkflow({
        workflow_id: 'wf-malformed',
        metadata_json: '{invalid',
      }),
    ]);

    const service = new MonitoringQueryService('/workspace');
    const result = service.getWorkflows();

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      workflowId: 'wf-malformed',
      state: 'completed',
      stuckDuration: null,
    });
  });

  it('computes failure rate per terminal workflow instead of per failed stage', () => {
    mockListWorkflows.mockReturnValue([
      createWorkflow({ workflow_id: 'wf-complete', state: 'completed', duration_ms: 500 }),
      createWorkflow({ workflow_id: 'wf-failed', state: 'terminal_error', duration_ms: 750 }),
    ]);
    mockGetEvents.mockImplementation((workflowId: string) => {
      if (workflowId === 'wf-failed') {
        return [
          createEvent(workflowId, 'trinity_dreamer_start', 1),
          createEvent(workflowId, 'trinity_dreamer_failed', 2, 'dreamer failed'),
          createEvent(workflowId, 'trinity_philosopher_start', 3),
          createEvent(workflowId, 'trinity_philosopher_failed', 4, 'philosopher failed'),
        ];
      }
      return [
        createEvent(workflowId, 'trinity_dreamer_start', 1),
        createEvent(workflowId, 'trinity_dreamer_complete', 2),
      ];
    });

    const service = new MonitoringQueryService('/workspace');
    const result = service.getTrinityHealth();

    expect(result.totalCalls).toBe(2);
    expect(result.failureRate).toBe(0.5);
    expect(result.stageStats.dreamer.failed).toBe(1);
    expect(result.stageStats.philosopher.failed).toBe(1);
  });
});
