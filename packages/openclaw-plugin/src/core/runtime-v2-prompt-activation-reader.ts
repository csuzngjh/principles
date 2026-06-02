import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { SqliteConnection, SqliteActivationStateStore, computeEffectiveFlags, DEFAULT_FEATURE_FLAGS, filterPromptActivations, resolvePrincipleFromArtifact } from '@principles/core/runtime-v2';
import type { EffectiveFeatureFlags, ActivatedPrinciple, PromptActivationReaderResult } from '@principles/core/runtime-v2';

export { RUNTIME_V2_PRINCIPLE_BUDGET } from '@principles/core/runtime-v2';
export type { ActivatedPrinciple, PromptActivationReaderResult };

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

      const allActivations = await store.listPromptActivations();
      const promptActivations = filterPromptActivations(allActivations);

      for (const activation of promptActivations) {
        const artifactRow = this.queryArtifactRow(sqliteConn, activation.artifactId);
        if (artifactRow === null) {
          const warning = `artifact_not_found: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table`;
          warnings.push(warning);
          this.deps.logger?.warn?.(`[PD:RuntimeV2] ${warning}`);
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
      this.deps.logger?.warn?.(`[PD:RuntimeV2] artifact_query_failed: artifactId=${artifactId} reason=${msg}; nextAction=check_pi_artifacts_table`);
      return null;
    }
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
}
