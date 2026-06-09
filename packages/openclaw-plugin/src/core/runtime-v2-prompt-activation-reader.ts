import { SqliteConnection, SqliteActivationStateStore, computeFeatureFlagsFromConfig, filterPromptActivations, resolvePrincipleFromArtifact } from '@principles/core/runtime-v2';
import type { FeatureFlagsResult, ActivatedPrinciple, PromptActivationReaderResult } from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin } from './pd-config-loader.js';

export { RUNTIME_V2_PRINCIPLE_BUDGET } from '@principles/core/runtime-v2';
export type { ActivatedPrinciple, PromptActivationReaderResult };

export interface PromptActivationReaderDeps {
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void; error?: (msg: string) => void };
}

export class PromptActivationReader {
  private readonly workspaceDir: string;
  private readonly deps: PromptActivationReaderDeps;

  constructor(workspaceDir: string, deps?: PromptActivationReaderDeps) {
    this.workspaceDir = workspaceDir;
    this.deps = deps ?? {};
  }

  async readActivatedPrinciples(): Promise<PromptActivationReaderResult> {
    const warnings: string[] = [];
    const principles: ActivatedPrinciple[] = [];

    const flags = this.loadFeatureFlags();
    const promptFlag = flags.flags['prompt'];
    if (!promptFlag || !promptFlag.enabled) {
      this.deps.logger?.info?.(`[PD:RuntimeV2] Prompt feature flag disabled — skipping Runtime V2 activation read`);
      return { principles, warnings: ['prompt_feature_disabled'], source: 'runtime_v2' };
    }

    let sqliteConn: SqliteConnection | null = null;
    try {
      sqliteConn = new SqliteConnection(this.workspaceDir);
      const store = new SqliteActivationStateStore(sqliteConn);

      const allActivations = await store.listPromptActivations();
      const promptActivations = filterPromptActivations(allActivations);

      for (const activation of promptActivations) {
        let artifactRow: unknown | null;
        try {
          artifactRow = this.queryArtifactRow(sqliteConn, activation.artifactId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const warning = `artifact_query_failed: artifactId=${activation.artifactId} reason=${msg}; nextAction=check_pi_artifacts_table`;
          warnings.push(warning);
          this.deps.logger?.warn?.(`[PD:RuntimeV2] ${warning}`);
          continue;
        }

        if (artifactRow === null) {
          const warning = `artifact_not_found: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table_or_remove_stale_activation`;
          warnings.push(warning);
          this.deps.logger?.info?.(`[PD:RuntimeV2] ${warning}`);
          continue;
        }

        const result = resolvePrincipleFromArtifact(artifactRow, activation);
        if (result.ok) {
          principles.push(result.principle);
        } else {
          warnings.push(result.warning);
          this.deps.logger?.warn?.(`[PD:RuntimeV2] ${result.warning}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const warning = `activation_db_unreadable: ${msg}; nextAction=check_workspace_pd_state_db`;
      warnings.push(warning);
      this.deps.logger?.warn?.(`[PD:RuntimeV2] ${warning}`);
    } finally {
      try {
        sqliteConn?.close();
      } catch {
        // best-effort
      }
    }

    return { principles, warnings, source: 'runtime_v2' };
  }

  private queryArtifactRow(sqliteConn: SqliteConnection, artifactId: string): unknown | null {
    try {
      const db = sqliteConn.getDb();
      const row = db.prepare(`
        SELECT artifact_id, artifact_kind, content_json, validation_status
        FROM pi_artifacts
        WHERE artifact_id = ?
      `).get(artifactId);
      return row ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`artifact_query_failed: artifactId=${artifactId} reason=${msg}; nextAction=check_pi_artifacts_table`);
    }
  }

  /**
   * PRI-305/PRI-307: Load feature flags from .pd/config.yaml instead of .pd/feature-flags.yaml.
   * Uses the shared plugin config loader for consistency.
   */
  private loadFeatureFlags(): FeatureFlagsResult {
    const result = loadPdConfigForPlugin(this.workspaceDir);
    const flags = computeFeatureFlagsFromConfig(result.effective);

    if (!result.ok) {
      for (const err of result.errors) {
        this.deps.logger?.warn?.(`[PD:RuntimeV2] Config error at ${err.path}: ${err.reason}`);
      }
    }

    return flags;
  }
}
