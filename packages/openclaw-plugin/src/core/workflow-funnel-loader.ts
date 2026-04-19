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
}

/**
 * A workflow funnel definition.
 */
export interface WorkflowFunnel {
  workflowId: string;
  stages: WorkflowStage[];
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
 * Failure semantics (per Codex review):
 * - Missing file: clears in-memory funnels, uses empty Map
 * - Malformed YAML: preserves last known-good config, logs warning
 * - Schema-invalid YAML: same as malformed YAML
 *
 * Usage:
 *   const loader = new WorkflowFunnelLoader(stateDir);
 *   const funnels = loader.getAllFunnels();  // Map<string, WorkflowStage[]>
 *   loader.watch();  // Enable hot reload
 */
export class WorkflowFunnelLoader {
  /** In-memory WORKFLOW_FUNNELS table: workflowId -> stages */
  private readonly funnels = new Map<string, WorkflowStage[]>();

  private readonly configPath: string;

  /** fs.watch() handle for cleanup */
  private watchHandle?: fs.FSWatcher;

  /** YAML parse warnings from last load() call */
  private readonly warnings: string[] = [];

  constructor(stateDir: string) {
    // D-02: workflows.yaml in .state/ directory
    this.configPath = path.join(stateDir, 'workflows.yaml');
    this.load();
  }

  /**
   * Load (or reload) workflows.yaml from disk.
   * On parse/validation failure, preserves the last known-good config.
   * On missing file, clears to empty.
   */
  load(): void {
    this.warnings.length = 0; // reset warnings on each load
    if (!fs.existsSync(this.configPath)) {
      this.warnings.push('workflows.yaml file not found.');
      this.funnels.clear();
      return;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      // Use safe load — no arbitrary code execution
      const config = yaml.load(content, { schema: yaml.DEFAULT_SCHEMA }) as WorkflowFunnelConfig;

      // Validate top-level structure
      if (!config || typeof config.version !== 'string' || !Array.isArray(config.funnels)) {
        const msg = 'workflows.yaml validation failed: missing version or funnels array. Preserving last valid config.';
        console.warn(`[WorkflowFunnelLoader] ${msg}`);
        this.warnings.push(msg);
        return;
      }

      // Rebuild funnels map
      const newFunnels = new Map<string, WorkflowStage[]>();
      for (const funnel of config.funnels) {
        if (funnel?.workflowId && typeof funnel.workflowId === 'string' && Array.isArray(funnel.stages)) {
          newFunnels.set(funnel.workflowId, funnel.stages);
        } else {
          const msg = 'Skipping invalid funnel entry: missing workflowId or stages.';
          console.warn(`[WorkflowFunnelLoader] ${msg}`);
          this.warnings.push(msg);
        }
      }

      // Atomic replace: only commit if entire parse/validation succeeded
      this.funnels.clear();
      for (const [k, v] of newFunnels) {
        this.funnels.set(k, v);
      }
    } catch (err) {
      // Best-effort: preserve last known-good config on parse error
      const msg = `Failed to parse workflows.yaml: ${String(err)}. Preserving last valid config.`;
      console.warn(`[WorkflowFunnelLoader] ${msg}`);
      this.warnings.push(msg);
    }
  }

  /**
   * Start watching workflows.yaml for changes.
   * Calls load() automatically when the file changes.
   * No-op if the config file does not exist.
   */
  watch(): void {
    // WATCHER-01: re-entry guard — prevent FSWatcher leak on double-watch
    if (this.watchHandle) return;
    // Guard: fs.watch fails with ENOENT if the path does not exist
    if (!fs.existsSync(this.configPath)) return;
    // Debounce: only re-read after file write settles (100ms)
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    this.watchHandle = fs.watch(this.configPath, (eventType) => {
      // PLAT-01: handle both 'change' and 'rename' events for Windows compatibility
      if (eventType !== 'change' && eventType !== 'rename') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.load();
      }, 100);
    });
  }

  /**
   * Stop watching and clean up the FSWatcher.
   */
  dispose(): void {
    if (this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = undefined;
    }
  }

  /**
   * Get all stages for a workflow.
   */
  getStages(workflowId: string): WorkflowStage[] {
    return this.funnels.get(workflowId) ?? [];
  }

  /**
   * Get the full WORKFLOW_FUNNELS table.
   * Returns a deep clone — consumer mutations do not affect internal state.
   */
  getAllFunnels(): Map<string, WorkflowStage[]> {
    const result = new Map<string, WorkflowStage[]>();
    for (const [k, v] of this.funnels) {
      // WATCHER-03: deep-clone arrays and stage objects
      result.set(k, v.map(stage => ({ ...stage })));
    }
    return result;
  }

  /**
   * Returns warnings from the last load() call.
   * Callers can inspect these and propagate them to metadata.warnings.
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Get the config file path (for testing/debugging).
   */
  getConfigPath(): string {
    return this.configPath;
  }
}
