import * as path from 'path';
import * as fs from 'fs';
import { SqliteConnection, SqliteActivationStateStore, computeEffectiveFlags, DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, EffectiveFeatureFlags } from '@principles/core/runtime-v2';

export interface ActivatedPrinciple {
  principleId: string;
  text: string;
  artifactId: string;
  activationId: string;
}

export interface PromptActivationReaderResult {
  principles: ActivatedPrinciple[];
  warnings: string[];
  source: 'runtime_v2';
}

export interface PromptActivationReaderDeps {
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void; error?: (msg: string) => void };
}

export class PromptActivationReader {
  private readonly stateDir: string;
  private readonly workspaceDir: string;
  private readonly deps: PromptActivationReaderDeps;

  constructor(workspaceDir: string, deps?: PromptActivationReaderDeps) {
    this.workspaceDir = workspaceDir;
    this.stateDir = path.join(workspaceDir, '.pd');
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

      const activations = await store.listPromptActivations();

      for (const activation of activations) {
        const result = this.resolvePrincipleFromActivation(sqliteConn, activation);
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

  private loadFeatureFlags(): EffectiveFeatureFlags {
    const configPath = path.join(this.stateDir, 'feature-flags.yaml');
    let userFlags: Record<string, unknown> = {};

    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        userFlags = this.parseSimpleYaml(raw);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.logger?.warn?.(`[PD:RuntimeV2] Feature flags unreadable: ${msg} — using defaults`);
    }

    return computeEffectiveFlags(userFlags, DEFAULT_FEATURE_FLAGS, configPath);
  }

  private parseSimpleYaml(raw: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentKey = '';

    for (const line of raw.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const topMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
      if (topMatch) {
        currentKey = topMatch[1];
        result[currentKey] = {};
        continue;
      }

      const propMatch = trimmed.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/);
      if (propMatch && currentKey) {
        const propKey = propMatch[1];
        const propVal = propMatch[2].trim();
        const parent = result[currentKey];
        if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
          if (propVal === 'true') {
            (parent as Record<string, unknown>)[propKey] = true;
          } else if (propVal === 'false') {
            (parent as Record<string, unknown>)[propKey] = false;
          } else {
            (parent as Record<string, unknown>)[propKey] = propVal;
          }
        }
      }
    }

    return result;
  }

  private resolvePrincipleFromActivation(
    sqliteConn: SqliteConnection,
    activation: ActivationStatusRecord,
  ): { ok: true; principle: ActivatedPrinciple } | { ok: false; warning: string } {
    const db = sqliteConn.getDb();

    let artifactRow: {
      artifact_id: string;
      artifact_kind: string;
      content_json: string;
      validation_status: string;
    } | undefined;

    try {
      artifactRow = db.prepare(`
        SELECT artifact_id, artifact_kind, content_json, validation_status
        FROM pi_artifacts
        WHERE artifact_id = ?
      `).get(activation.artifactId) as typeof artifactRow | undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, warning: `artifact_query_failed: artifactId=${activation.artifactId} reason=${msg}; nextAction=check_pi_artifacts_table` };
    }

    if (!artifactRow) {
      return { ok: false, warning: `artifact_not_found: artifactId=${activation.artifactId} activationId=${activation.activationId}; nextAction=verify_artifact_exists_or_remove_stale_activation` };
    }

    if (artifactRow.artifact_kind !== 'principle') {
      return { ok: false, warning: `artifact_not_principle: artifactId=${activation.artifactId} kind=${artifactRow.artifact_kind}; nextAction=skip_non_principle_activations` };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(artifactRow.content_json);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, warning: `artifact_content_malformed: artifactId=${activation.artifactId} reason=parsed_to_non_object; nextAction=fix_artifact_content_json` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, warning: `artifact_content_json_parse_error: artifactId=${activation.artifactId} reason=${msg}; nextAction=fix_artifact_content_json` };
    }

    const principleId = Object.hasOwn(parsed, 'principleId') ? parsed.principleId : undefined;
    const text = Object.hasOwn(parsed, 'text') ? parsed.text : undefined;

    if (typeof principleId !== 'string' || principleId.length === 0) {
      return { ok: false, warning: `artifact_missing_principle_id: artifactId=${activation.artifactId}; nextAction=ensure_artifact_has_principleId` };
    }

    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, warning: `artifact_missing_text: artifactId=${activation.artifactId} principleId=${principleId}; nextAction=ensure_artifact_has_text` };
    }

    return {
      ok: true,
      principle: {
        principleId,
        text,
        artifactId: activation.artifactId,
        activationId: activation.activationId,
      },
    };
  }
}
