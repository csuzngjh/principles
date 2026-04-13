/* eslint-disable @typescript-eslint/no-use-before-define */
import { WorkflowStore } from './subagent-workflow/workflow-store.js';

/**
 * Monitoring query service for Nocturnal workflows and Trinity stages.
 * Encapsulates all monitoring data queries, keeping logic separate from API routes.
 */
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

  /**
   * Get workflows with optional filtering and stuck detection.
   * @param filters - Optional state and type filters
   * @returns Workflow list with stuck detection
   */
  getWorkflows(filters: { state?: string; type?: string } = {}): WorkflowListResponse {
    // Query workflows from WorkflowStore
    let workflows = filters.state
      ? this.store.listWorkflows(filters.state)
      : this.store.listWorkflows();

    // Filter by workflow type if specified
    if (filters.type) {
      workflows = workflows.filter(wf => wf.workflow_type === filters.type);
    }

    const now = Date.now();
    const workflowsWithStuckDetection = workflows.map(wf => {
      // Parse metadata for timeout configuration
      const metadata = parseWorkflowMetadata(wf.metadata_json);
      const timeoutMs = metadata.timeoutMs ?? 15 * 60 * 1000; // Default 15 minutes

      // Check if workflow is stuck (active and exceeded timeout)
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

  /**
   * Get Trinity stage status for a specific workflow.
   * @param workflowId - Workflow ID to query
   * @returns Trinity stage status or null if workflow not found
   */
  getTrinityStatus(workflowId: string): TrinityStatusResponse | null {
    // Get workflow and validate
    const workflow = this.store.getWorkflow(workflowId);
    if (!workflow) {
      return null;
    }

    // Fetch stage data
    const events = this.store.getEvents(workflowId);
    const stageOutputs = this.store.getStageOutputs(workflowId);

    // Define stage types
    const stages = ['dreamer', 'philosopher', 'scribe'] as const;

    // Compute stage states from events
    const stagesInfo: TrinityStageInfo[] = stages.map(stage => {
      // Find events for this stage
      const startEvent = events.find(e => e.event_type === `trinity_${stage}_start`);
      const completeEvent = events.find(e => e.event_type === `trinity_${stage}_complete`);
      const failedEvent = events.find(e => e.event_type === `trinity_${stage}_failed`);

      // Determine status
       
      let status!: 'pending' | 'running' | 'completed' | 'failed';
       
      let reason = '' as string | undefined;

      if (!startEvent) {
        status = 'pending';
        reason = undefined;
      } else if (failedEvent) {
        status = 'failed';
        ({ reason } = failedEvent);
      } else if (completeEvent) {
        status = 'completed';
        reason = undefined;
      } else {
        status = 'running';
        reason = undefined;
      }

      // Count outputs for this stage
      const outputCount = stageOutputs.filter(so => so.stage === stage).length;

      // Calculate duration if stage started and completed/failed
       
      let duration = 0 as number | undefined;
      if (startEvent && (completeEvent || failedEvent)) {
        const endEvent = completeEvent || failedEvent;
        if (endEvent) {
          duration = endEvent.created_at - startEvent.created_at;
        }
      }

      return {
        stage,
        status,
        reason,
        outputCount,
        duration,
      };
    });

    return {
      workflowId,
      stages: stagesInfo,
    };
  }

  /**
   * Get aggregate health metrics for all Trinity workflows.
   * @returns Aggregate health statistics
   */
  getTrinityHealth(): TrinityHealthResponse {
    // Get all workflows
    const workflows = this.store.listWorkflows();

    // Initialize counters
    let totalCalls = 0;
    let totalDuration = 0;
    let failedCalls = 0;

    // Initialize stage statistics
    const stageStats = {
      dreamer: { total: 0, completed: 0, failed: 0 },
      philosopher: { total: 0, completed: 0, failed: 0 },
      scribe: { total: 0, completed: 0, failed: 0 },
    };

    // Iterate through workflows and aggregate
    for (const workflow of workflows) {
      const events = this.store.getEvents(workflow.workflow_id);
      const isTerminal =
        workflow.state === 'completed'
        || workflow.state === 'terminal_error'
        || workflow.state === 'expired'
        || workflow.state === 'cleanup_pending';
      let workflowFailed = false;

      // Aggregate stage statistics
      for (const stage of ['dreamer', 'philosopher', 'scribe'] as const) {
        // Check if stage started
        const started = events.some(e => e.event_type === `trinity_${stage}_start`);
        if (started) {
          stageStats[stage].total++;
        }

        // Check if completed
        const completed = events.some(e => e.event_type === `trinity_${stage}_complete`);
        if (completed) {
          stageStats[stage].completed++;
        }

        // Check if failed
        const failed = events.some(e => e.event_type === `trinity_${stage}_failed`);
        if (failed) {
          stageStats[stage].failed++;
          workflowFailed = true;
        }
      }

      // Calculate duration for terminal workflows so the aggregate reflects all finished runs.
      if (isTerminal) {
        totalCalls++;
        const duration = workflow.duration_ms ?? (Date.now() - workflow.created_at);
        totalDuration += duration;
        if (workflowFailed || workflow.state === 'terminal_error' || workflow.state === 'expired') {
          failedCalls++;
        }
      }
    }

    // Calculate derived metrics
    const avgDuration = totalCalls > 0 ? totalDuration / totalCalls : 0;
    const failureRate = totalCalls > 0 ? failedCalls / totalCalls : 0;

    return {
      totalCalls,
      avgDuration: Math.round(avgDuration),
      failureRate: Number(failureRate.toFixed(4)),
      stageStats,
    };
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

/**
 * Response type for workflow listing endpoint.
 */
export interface WorkflowListResponse {
  workflows: WorkflowInfo[];
}

/**
 * Enriched workflow information with stuck detection.
 */
export interface WorkflowInfo {
  workflowId: string;
  type: string;
  state: string;
  duration: number;
  createdAt: string;
  stuckDuration: number | null;
}

/**
 * Response type for Trinity status endpoint.
 */
export interface TrinityStatusResponse {
  workflowId: string;
  stages: TrinityStageInfo[];
}

/**
 * Information about a single Trinity stage.
 */
export interface TrinityStageInfo {
  stage: 'dreamer' | 'philosopher' | 'scribe';
  status: 'pending' | 'running' | 'completed' | 'failed';
  reason?: string;
  outputCount: number;
  duration?: number;
}

/**
 * Response type for Trinity health metrics endpoint.
 */
export interface TrinityHealthResponse {
  totalCalls: number;
  avgDuration: number;
  failureRate: number;
  stageStats: {
    dreamer: StageStats;
    philosopher: StageStats;
    scribe: StageStats;
  };
}

/**
 * Per-stage statistics.
 */
export interface StageStats {
  total: number;
  completed: number;
  failed: number;
}
