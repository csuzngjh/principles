import { WorkflowStore } from './subagent-workflow/workflow-store.js';

export class MonitoringQueryService {
  private readonly workspaceDir: string;
  private readonly store: WorkflowStore;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.store = new WorkflowStore({ workspaceDir });
  }

  dispose(): void {
    this.store.dispose();
  }

  getWorkflows(filters: { state?: string; type?: string } = {}): WorkflowListResponse {
    let workflows = filters.state
      ? this.store.listWorkflows(filters.state)
      : this.store.listWorkflows();

    if (filters.type) {
      workflows = workflows.filter(wf => wf.workflow_type === filters.type);
    }

    const now = Date.now();
    const workflowsWithStuckDetection = workflows.map(wf => {
      const metadata = parseWorkflowMetadata(wf.metadata_json);
      const timeoutMs = metadata.timeoutMs ?? 15 * 60 * 1000;

      const isStuck = wf.state === 'active' && (now - wf.created_at) > timeoutMs;
      const stuckDuration = isStuck ? now - wf.created_at : null;

      return {
        workflowId: wf.workflow_id,
        type: wf.workflow_type,
        state: isStuck ? 'stuck' : wf.state,
        duration: now - wf.created_at,
        createdAt: new Date(wf.created_at).toISOString(),
        stuckDuration,
      };
    });

    return { workflows: workflowsWithStuckDetection };
  }
}

function parseWorkflowMetadata(metadataJson: string): { timeoutMs?: number } {
  try {
    const parsed = JSON.parse(metadataJson) as { timeoutMs?: number };
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export interface WorkflowListResponse {
  workflows: WorkflowInfo[];
}

export interface WorkflowInfo {
  workflowId: string;
  type: string;
  state: string;
  duration: number;
  createdAt: string;
  stuckDuration: number | null;
}
