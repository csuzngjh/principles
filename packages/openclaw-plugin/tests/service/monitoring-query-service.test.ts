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
    workflow_type: overrides.workflow_type ?? 'rulehost',
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
});
