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
          // P0-G (INV-05): authority 推导 — approvals 上存在 approved 行
          // (artifact_id+channel join, approvalId 确定性) → owner;否则该激活
          // 经低风险 policy 自动激活 → system_policy。查询失败不阻塞注入,
          // authority 留空 (渲染层宁缺毋假)。
          const authorityInfo = this.deriveAuthority(sqliteConn, activation.artifactId, 'prompt');
          if (authorityInfo.authority) {
            result.principle.authority = authorityInfo.authority;
            if (authorityInfo.approvedBy) result.principle.approvedBy = authorityInfo.approvedBy;
          }
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
   * P0-G (INV-05): activation authority 推导 (derived join, 无 schema 迁移)。
   * approvals 的 approvalId 是确定性的 (apr_<channel>_<artifactId>), 因此
   * artifact_id+channel 上存在 status='approved' 行 ⟺ owner 授权;
   * 无行 ⟺ 低风险 policy 自动激活 (system_policy)。rc-1/rc-5: 行字段按
   * unknown 校验, 键存在性用 Object.hasOwn。
   */
  private deriveAuthority(
    sqliteConn: SqliteConnection,
    artifactId: string,
    channel: string,
  ): { authority?: 'owner' | 'system_policy'; approvedBy?: string } {
    try {
      const db = sqliteConn.getDb();
      const row: unknown = db.prepare(`
        SELECT decided_by FROM approvals
        WHERE artifact_id = ? AND channel = ? AND status = 'approved'
        ORDER BY decided_at DESC LIMIT 1
      `).get(artifactId, channel);
      if (row !== null && typeof row === 'object' && Object.hasOwn(row, 'decided_by')) {
        const decidedBy = (row as Record<string, unknown>).decided_by;
        return {
          authority: 'owner',
          approvedBy: typeof decidedBy === 'string' && decidedBy.length > 0 ? decidedBy : undefined,
        };
      }
      return { authority: 'system_policy' };
    } catch {
      // 查询失败 (旧库无 approvals 表等) — 不阻塞注入, authority 不标注
      this.deps.logger?.warn?.(`[PD:RuntimeV2] authority derivation failed for artifactId=${artifactId}; rendering without authority attribute`);
      return {};
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
