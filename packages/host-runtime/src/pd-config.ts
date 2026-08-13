import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
  validatePdConfig,
  type EffectivePdConfig,
  type PdConfigValidationResult,
} from '@principles/core/runtime-v2';

export const PD_CONFIG_DIR = '.pd';
export const PD_CONFIG_FILENAME = 'config.yaml';

export interface PluginConfigLoadResult {
  ok: boolean;
  effective: EffectivePdConfig;
  source: 'defaults' | 'user_config' | 'malformed';
  configPath: string;
  warnings: string[];
  errors: { path: string; reason: string; nextAction: string }[];
}

export type PdWorkspaceResolution =
  | { ok: true; workspaceDir: string; configPath: string; source: 'nearest' | 'legacy_fallback' }
  | { ok: false; cwd: string; reason: 'cwd_not_absolute' | 'config_not_found'; nextAction: string };

export function getPdConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, PD_CONFIG_DIR, PD_CONFIG_FILENAME);
}

export function resolveNearestPdWorkspace(cwd: string, legacyFallback?: string): PdWorkspaceResolution {
  if (!path.isAbsolute(cwd)) {
    return { ok: false, cwd, reason: 'cwd_not_absolute', nextAction: 'Provide an absolute cwd before resolving the PD Workspace' };
  }
  let current = path.resolve(cwd);
  while (true) {
    const configPath = getPdConfigPath(current);
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      return { ok: true, workspaceDir: current, configPath, source: 'nearest' };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (legacyFallback && path.isAbsolute(legacyFallback)) {
    const workspaceDir = path.resolve(legacyFallback);
    const configPath = getPdConfigPath(workspaceDir);
    if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
      return { ok: true, workspaceDir, configPath, source: 'legacy_fallback' };
    }
  }
  return {
    ok: false,
    cwd,
    reason: 'config_not_found',
    nextAction: 'Create .pd/config.yaml in the Workspace or provide an absolute legacy fallback containing it',
  };
}

export function loadPdConfigForPlugin(workspaceDir: string): PluginConfigLoadResult {
  const configPath = getPdConfigPath(workspaceDir);
  if (!fs.existsSync(configPath)) {
    const effective = computeEffectivePdConfig(null);
    return { ok: true, effective, source: 'defaults', configPath, warnings: effective.warnings, errors: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, effective: computeEffectivePdConfig(null), source: 'malformed', configPath, warnings: [],
      errors: [{ path: '', reason: `Failed to read .pd/config.yaml: ${message}`, nextAction: 'Check file permissions for .pd/config.yaml' }],
    };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, effective: computeEffectivePdConfig(null), source: 'malformed', configPath, warnings: [],
      errors: [{ path: '', reason: `YAML parse error in .pd/config.yaml: ${message}`, nextAction: 'Fix YAML syntax in .pd/config.yaml' }],
    };
  }
  const validation: PdConfigValidationResult = validatePdConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false, effective: computeEffectivePdConfig(null), source: 'malformed', configPath, warnings: [],
      errors: validation.errors.map(({ path: errorPath, reason, nextAction }) => ({ path: errorPath, reason, nextAction })),
    };
  }
  const effective = computeEffectivePdConfig(validation.value);
  return { ok: true, effective, source: 'user_config', configPath, warnings: effective.warnings, errors: [] };
}

export function loadFeatureFlagFromConfig(
  workspaceDir: string,
  flagId: string,
  logger?: { warn?: (message: string) => void; info?: (message: string) => void },
): { enabled: boolean; source: string } {
  const result = loadPdConfigForPlugin(workspaceDir);
  const flag = computeFeatureFlagsFromConfig(result.effective).flags[flagId];
  if (!result.ok) {
    logger?.warn?.(`[PD:Config] Config validation failed: ${result.errors.map((error) => error.reason).join('; ')} — using defaults`);
  }
  return { enabled: flag?.enabled ?? false, source: result.source };
}
