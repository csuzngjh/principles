/**
 * WorkflowFunnelLoader — Loads and watches workflows.yaml as the SSOT
 * for WORKFLOW_FUNNELS definition table.
 *
 * D-01: workflows.yaml is the single source of truth (SSOT).
 * D-02: workflows.yaml lives in .state/ directory per workspace.
 * D-03: Developers manually maintain workflows.yaml (no auto-registration).
 * D-04: Code only reads YAML, never writes it.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single stage in a workflow funnel.
 * Policy fields are optional — existing stages without policy fields remain valid.
 */
export interface WorkflowStage {
  name: string;
  eventType: string;
  eventCategory: string;
  statsField: string;
  timeoutMs?: number;
  successCriteria?: string;
  legacyDisabled?: boolean;
  observability?: {
    enabled?: boolean;
    emitEvents?: string[];
  };
}

/**
 * Funnel-level policy that applies to all stages unless overridden per-stage.
 */
export interface FunnelPolicy {
  timeoutMs?: number;
  stageOrder?: 'strict' | 'relaxed';
  legacyDisabled?: boolean;
  observability?: {
    enabled?: boolean;
    emitEvents?: string[];
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
  };
}

/**
 * A workflow funnel definition.
 */
export interface WorkflowFunnel {
  workflowId: string;
  stages: WorkflowStage[];
  policy?: FunnelPolicy;
}

/**
 * Root of workflows.yaml schema.
 */
export interface WorkflowFunnelConfig {
  version: string;
  funnels: WorkflowFunnel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowFunnelLoader
// ─────────────────────────────────────────────────────────────────────────────

export class WorkflowFunnelLoader {
  private readonly funnels = new Map<string, WorkflowStage[]>();
  private readonly fullFunnels = new Map<string, WorkflowFunnel>();
  private readonly configPath: string;
  private watchHandle?: fs.FSWatcher;
  private readonly warnings: string[] = [];

  constructor(stateDir: string) {
    this.configPath = path.join(stateDir, 'workflows.yaml');
    this.load();
  }

  load(): void {
    this.warnings.length = 0;
    if (!fs.existsSync(this.configPath)) {
      this.warnings.push('workflows.yaml file not found.');
      this.funnels.clear();
      this.fullFunnels.clear();
      return;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const config = yaml.load(content, { schema: yaml.DEFAULT_SCHEMA }) as WorkflowFunnelConfig;

      if (!config || typeof config.version !== 'string' || !Array.isArray(config.funnels)) {
        const msg = 'workflows.yaml validation failed: missing version or funnels array. Preserving last valid config.';
        console.warn(`[WorkflowFunnelLoader] ${msg}`);
        this.warnings.push(msg);
        return;
      }

      const newFunnels = new Map<string, WorkflowStage[]>();
      const newFullFunnels = new Map<string, WorkflowFunnel>();
      for (const funnel of config.funnels) {
        if (funnel?.workflowId && typeof funnel.workflowId === 'string' && Array.isArray(funnel.stages)) {
          newFunnels.set(funnel.workflowId, funnel.stages);
          newFullFunnels.set(funnel.workflowId, funnel);
        } else {
          const msg = 'Skipping invalid funnel entry: missing workflowId or stages.';
          console.warn(`[WorkflowFunnelLoader] ${msg}`);
          this.warnings.push(msg);
        }
      }

      this.funnels.clear();
      this.fullFunnels.clear();
      for (const [k, v] of newFunnels) { this.funnels.set(k, v); }
      for (const [k, v] of newFullFunnels) { this.fullFunnels.set(k, v); }
    } catch (err) {
      const msg = `Failed to parse workflows.yaml: ${String(err)}. Preserving last valid config.`;
      console.warn(`[WorkflowFunnelLoader] ${msg}`);
      this.warnings.push(msg);
    }
  }

  watch(): void {
    if (this.watchHandle) return;
    if (!fs.existsSync(this.configPath)) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    this.watchHandle = fs.watch(this.configPath, (eventType) => {
      if (eventType !== 'change' && eventType !== 'rename') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this.load(), 100);
    });
  }

  dispose(): void {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = undefined;
    }
  }

  getStages(workflowId: string): WorkflowStage[] {
    return this.funnels.get(workflowId) ?? [];
  }

  getFunnel(workflowId: string): WorkflowFunnel | undefined {
    const funnel = this.fullFunnels.get(workflowId);
    if (!funnel) return undefined;
    return this.cloneFunnel(funnel);
  }

  getAllFunnels(): Map<string, WorkflowStage[]> {
    const result = new Map<string, WorkflowStage[]>();
    for (const [k, v] of this.funnels) {
      result.set(k, v.map(stage => ({ ...stage })));
    }
    return result;
  }

  getAllFunnelsWithPolicy(): Map<string, WorkflowFunnel> {
    const result = new Map<string, WorkflowFunnel>();
    for (const [k, v] of this.fullFunnels) {
      result.set(k, this.cloneFunnel(v));
    }
    return result;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getConfigPath(): string {
    return this.configPath;
  }

  private cloneFunnel(funnel: WorkflowFunnel): WorkflowFunnel {
    return {
      ...funnel,
      stages: funnel.stages.map(stage => ({ ...stage })),
      policy: funnel.policy ? {
        ...funnel.policy,
        observability: funnel.policy.observability ? {
          ...funnel.policy.observability,
          emitEvents: funnel.policy.observability.emitEvents
            ? [...funnel.policy.observability.emitEvents]
            : undefined,
        } : undefined,
      } : undefined,
    };
  }
}
