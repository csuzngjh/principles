import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { SqliteConnection, SqliteActivationStateStore, computeEffectiveFlags, DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';
import type { ActivationStatusRecord, EffectiveFeatureFlags } from '@principles/core/runtime-v2';

export const RUNTIME_V2_PRINCIPLE_BUDGET = 2000;

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

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

      const activations = await store.listPromptActivations();

      for (const activation of activations) {
        if (activation.channel !== 'prompt' || activation.action !== 'prompt_activate') {
          continue;
        }

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
    const configPath = path.join(this.workspaceDir, '.pd', 'feature-flags.yaml');

    if (!fs.existsSync(configPath)) {
      return computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.logger?.warn?.(`[PD:RuntimeV2] Feature flags unreadable: ${msg} — using defaults`);
      return computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    } catch {
      this.deps.logger?.warn?.(`[PD:RuntimeV2] Feature flags YAML parse error — using defaults`);
      return {
        ...computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath),
        warnings: ['feature-flags.yaml: YAML parse error, using defaults'],
      };
    }

    if (!isRecord(parsed)) {
      this.deps.logger?.warn?.(`[PD:RuntimeV2] Feature flags not a mapping — using defaults`);
      return {
        ...computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath),
        warnings: ['feature-flags.yaml: expected a mapping, using defaults'],
      };
    }

    const parsedRecord: Record<string, unknown> = Object.create(null);
    const yamlWarnings: string[] = [];
    for (const key of Object.keys(parsed)) {
      if (DANGEROUS_KEYS.has(key)) {
        yamlWarnings.push(`feature-flags.yaml: dangerous key '${key}' rejected`);
        continue;
      }
      if (Object.hasOwn(parsed, key)) {
        parsedRecord[key] = parsed[key];
      }
    }

    const result = computeEffectiveFlags(parsedRecord, DEFAULT_FEATURE_FLAGS, configPath);
    if (yamlWarnings.length > 0) {
      result.warnings = [...yamlWarnings, ...result.warnings];
      for (const w of yamlWarnings) {
        this.deps.logger?.warn?.(`[PD:RuntimeV2] ${w}`);
      }
    }
    return result;
  }

  private resolvePrincipleFromActivation(
    sqliteConn: SqliteConnection,
    activation: ActivationStatusRecord,
  ): { ok: true; principle: ActivatedPrinciple } | { ok: false; warning: string } {
    const db = sqliteConn.getDb();

    let contentJson: string;

    try {
      const row = db.prepare(`
        SELECT artifact_id, artifact_kind, content_json, validation_status
        FROM pi_artifacts
        WHERE artifact_id = ?
      `).get(activation.artifactId);

      if (!isRecord(row)) {
        return { ok: false, warning: `artifact_query_unexpected: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table` };
      }

      const artifact_id = Object.hasOwn(row, 'artifact_id') && typeof row.artifact_id === 'string' && row.artifact_id.length > 0 ? row.artifact_id : null;
      const artifact_kind = Object.hasOwn(row, 'artifact_kind') && typeof row.artifact_kind === 'string' ? row.artifact_kind : null;
      const raw_content_json = Object.hasOwn(row, 'content_json') && typeof row.content_json === 'string' ? row.content_json : null;
      const validation_status = Object.hasOwn(row, 'validation_status') && typeof row.validation_status === 'string' ? row.validation_status : null;

      if (!artifact_id) {
        return { ok: false, warning: `artifact_not_found: artifactId=${activation.artifactId} activationId=${activation.activationId}; nextAction=verify_artifact_exists_or_remove_stale_activation` };
      }

      if (artifact_kind !== 'principle') {
        return { ok: false, warning: `artifact_not_principle: artifactId=${artifact_id} kind=${artifact_kind ?? 'missing'}; nextAction=skip_non_principle_activations` };
      }

      if (validation_status !== 'validated') {
        return { ok: false, warning: `artifact_not_validated: artifactId=${artifact_id} status=${validation_status ?? 'missing'}; nextAction=skip_unvalidated_artifacts` };
      }

      if (raw_content_json === null) {
        return { ok: false, warning: `artifact_missing_content_json: artifactId=${artifact_id}; nextAction=ensure_artifact_has_content_json` };
      }

      contentJson = raw_content_json;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, warning: `artifact_query_failed: artifactId=${activation.artifactId} reason=${msg}; nextAction=check_pi_artifacts_table` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contentJson);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, warning: `artifact_content_json_parse_error: artifactId=${activation.artifactId} reason=${msg}; nextAction=fix_artifact_content_json` };
    }

    if (!isRecord(parsed)) {
      return { ok: false, warning: `artifact_content_malformed: artifactId=${activation.artifactId} reason=parsed_to_non_object; nextAction=fix_artifact_content_json` };
    }

    const principleId = Object.hasOwn(parsed, 'principleId') && typeof parsed.principleId === 'string' ? parsed.principleId : undefined;
    const text = Object.hasOwn(parsed, 'text') && typeof parsed.text === 'string' ? parsed.text : undefined;

    const draftObj = Object.hasOwn(parsed, 'principleDraft') && isRecord(parsed.principleDraft) ? parsed.principleDraft : null;
    const draftTitle = draftObj && Object.hasOwn(draftObj, 'title') && typeof draftObj.title === 'string' ? draftObj.title : undefined;
    const draftStatement = draftObj && Object.hasOwn(draftObj, 'statement') && typeof draftObj.statement === 'string' ? draftObj.statement : undefined;

    const resolvedPrincipleId = principleId && principleId.length > 0 ? principleId : draftTitle;
    const resolvedText = text && text.length > 0 ? text : draftStatement;

    if (!resolvedPrincipleId || resolvedPrincipleId.length === 0) {
      return { ok: false, warning: `artifact_missing_principle_id: artifactId=${activation.artifactId}; nextAction=ensure_artifact_has_principleId_or_principleDraft_title` };
    }

    if (!resolvedText || resolvedText.length === 0) {
      return { ok: false, warning: `artifact_missing_text: artifactId=${activation.artifactId} principleId=${resolvedPrincipleId}; nextAction=ensure_artifact_has_text_or_principleDraft_statement` };
    }

    return {
      ok: true,
      principle: {
        principleId: resolvedPrincipleId,
        text: resolvedText,
        artifactId: activation.artifactId,
        activationId: activation.activationId,
      },
    };
  }
}
