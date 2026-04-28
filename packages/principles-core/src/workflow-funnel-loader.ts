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
  /** Stage name within the funnel (e.g., 'dreamer_completed') */
  name: string;
  /** Event type string (e.g., 'nocturnal_dreamer_completed') */
  eventType: string;
  /** Event category (e.g., 'completed', 'created', 'blocked') */
  eventCategory: string;
  /** Dot-path to stats field (e.g., 'evolution.nocturnalDreamerCompleted') */
  statsField: string;
  /** Optional per-stage timeout in milliseconds (overrides funnel-level timeout) */
  timeoutMs?: number;
  /** Optional success criteria expression for this stage */
  successCriteria?: string;
  /** When true, this stage is disabled and skipped by consumers */
  legacyDisabled?: boolean;
  /** Observability tags for this stage */
  observability?: {
    enabled?: boolean;
    emitEvents?: string[];
  };
}

/**
 * Funnel-level policy that applies to all stages unless overridden per-stage.
 */
export interface FunnelPolicy {
  /** Default timeout for all stages in this funnel (ms) */
  timeoutMs?: number;
  /** Stage execution order enforcement */
  stageOrder?: 'strict' | 'relaxed';
  /** Legacy flag — when true, funnel is superseded by a newer implementation */
  legacyDisabled?: boolean;
  /** Observability configuration for the entire funnel */
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
  /** Optional funnel-level policy applied to all stages */
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

/**
 * Loads and watches workflows.yaml, building an in-memory WORKFLOW_FUNNELS table.
 *
 * Failure semantics:
 * - Missing file: clears in-memory funnels, uses empty Map
 * - Malformed YAML: preserves last known-good config, logs warning
 * - Schema-invalid YAML: same as malformed YAML
 */
export class WorkflowFunnelLoader {
  /** In-memory WORKFLOW_FUNNELS table: workflowId -> stages */
  private readonly funnels = new Map<string, WorkflowStage[]>();

  /** Full funnel table with policy: workflowId -> WorkflowFunnel */
  private readonly fullFunnels = new Map<string, WorkflowFunnel>();

  private readonly configPath: string;

  /** fs.watch() handle for cleanup */
  private watchHandle?: fs.FSWatcher;

  /** YAML parse warnings from last load() call */
  private readonly warnings: string[] = [];

  constructor(stateDir: string) {
    this.configPath = path.join(stateDir, 'workflows.yaml');
    this.load();
  }

  /**
   * Load (or reload) workflows.yaml from disk.
   * On parse/validation failure, preserves the last known-good config.
   * On missing file, clears to empty.
   */
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
      for (const [k, v] of newFunnels) {
        this.funnels.set(k, v);
      }
      for (const [k, v] of newFullFunnels) {
        this.fullFunnels.set(k, v);
      }
    } catch (err) {
      const msg = `Failed to parse workflows.yaml: ${String(err)}. Preserving last valid config.`;
      console.warn(`[WorkflowFunnelLoader] ${msg}`);
      this.warnings.push(msg);
    }
  }

  /**
   * Start watching workflows.yaml for changes.
   */
  watch(): void {
    if (this.watchHandle) return;
    if (!fs.existsSync(this.configPath)) return;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    this.watchHandle = fs.watch(this.configPath, (eventType) => {
      if (eventType !== 'change' && eventType !== 'rename') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this.load(), 100);
    });
  }

  /** Stop watching and clean up the FSWatcher. */
  dispose(): void {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = undefined;
    }
  }

  /** Get all stages for a workflow. */
  getStages(workflowId: string): WorkflowStage[] {
    return this.funnels.get(workflowId) ?? [];
  }

  /**
   * Get the full funnel definition (including policy) for a workflow.
   * Returns undefined if the funnel is not found.
   * Returns a deep clone — consumer mutations do not affect internal state.
   */
  getFunnel(workflowId: string): WorkflowFunnel | undefined {
    const funnel = this.fullFunnels.get(workflowId);
    if (!funnel) return undefined;
    return WorkflowFunnelLoader.cloneFunnel(funnel);
  }

  /**
   * Get the full WORKFLOW_FUNNELS table.
   * Returns a deep clone — consumer mutations do not affect internal state.
   */
  getAllFunnels(): Map<string, WorkflowStage[]> {
    const result = new Map<string, WorkflowStage[]>();
    for (const [k, v] of this.funnels) {
      result.set(k, v.map(stage => ({ ...stage })));
    }
    return result;
  }

  /**
   * Get the full WORKFLOW_FUNNELS table including policy.
   * Returns a Map of workflowId -> WorkflowFunnel (stages and policy cloned).
   */
  getAllFunnelsWithPolicy(): Map<string, WorkflowFunnel> {
    const result = new Map<string, WorkflowFunnel>();
    for (const [k, v] of this.fullFunnels) {
      result.set(k, WorkflowFunnelLoader.cloneFunnel(v));
    }
    return result;
  }

  /** Returns warnings from the last load() call. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Get the config file path. */
  getConfigPath(): string {
    return this.configPath;
  }

  /** Deep clone a funnel to prevent consumer mutations. */
  private static cloneFunnel(funnel: WorkflowFunnel): WorkflowFunnel {
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
