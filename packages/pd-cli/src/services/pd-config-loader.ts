/**
 * PD Config Loader — PRI-305
 *
 * I/O boundary: reads `.pd/config.yaml`, validates via core, computes effective config.
 * This replaces the old `feature-flag-loader.ts` and `workflows.yaml` reading
 * for CLI production paths.
 *
 * ADR-0016: PD owns exactly one user config file.
 * - Missing config → defaults with nextAction
 * - Malformed config → fail loud with errors and nextAction
 * - No secrets in output
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  validatePdConfig,
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
  redactPdConfig,
} from '@principles/core/runtime-v2';
import type {
  EffectivePdConfig,
  PdConfigValidationResult,
  RedactedPdConfigSummary,
  FeatureFlagsResult,
} from '@principles/core/runtime-v2';

// ── Constants ────────────────────────────────────────────────────────────────

export const PD_CONFIG_DIR = '.pd';
export const PD_CONFIG_FILENAME = 'config.yaml';

// ── Types ────────────────────────────────────────────────────────────────────

export type ConfigSource = 'defaults' | 'user_config' | 'malformed';

export interface PdConfigLoadResultOk {
  ok: true;
  effective: EffectivePdConfig;
  source: ConfigSource;
  configPath: string;
  /** Warnings from config resolution (not errors) */
  warnings: string[];
  /** If legacy files were detected */
  legacyFilesDetected: string[];
  /** PRI-404: Next actions for removing legacy files (empty if none detected) */
  legacyFileNextActions: string[];
}

export interface PdConfigLoadResultErr {
  ok: false;
  source: 'malformed';
  configPath: string;
  errors: { path: string; reason: string; nextAction: string }[];
  /** Fallback defaults are still available */
  defaults: EffectivePdConfig;
  /** Warnings from config resolution */
  warnings: string[];
  legacyFilesDetected: string[];
  /** PRI-404: Next actions for removing legacy files (empty if none detected) */
  legacyFileNextActions: string[];
}

export type PdConfigLoadResult = PdConfigLoadResultOk | PdConfigLoadResultErr;

// ── Config Path ──────────────────────────────────────────────────────────────

export function getPdConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, PD_CONFIG_DIR, PD_CONFIG_FILENAME);
}

// ── Legacy File Detection ────────────────────────────────────────────────────

function detectLegacyFiles(workspaceDir: string): string[] {
  const detected: string[] = [];
  const legacyPaths = [
    path.join(workspaceDir, PD_CONFIG_DIR, 'feature-flags.yaml'),
    path.join(workspaceDir, '.state', 'workflows.yaml'),
  ];
  for (const p of legacyPaths) {
    if (fs.existsSync(p)) {
      detected.push(p);
    }
  }
  return detected;
}

/** PRI-404: Generate nextAction suggestions for removing legacy files. */
function buildLegacyFileNextActions(legacyFiles: string[]): string[] {
  return legacyFiles.map(f => {
    return `Run 'rm ${f}' to remove legacy config`;
  });
}

// ── Load PD Config ───────────────────────────────────────────────────────────

/**
 * Load and validate `.pd/config.yaml` from the workspace.
 *
 * - Missing file → returns defaults with source='defaults'
 * - Malformed file → returns error result with defaults fallback
 * - Valid file → returns effective config with source='user_config'
 *
 * Never throws on malformed input. Always provides a usable fallback.
 */
export function loadPdConfig(workspaceDir: string): PdConfigLoadResult {
  const configPath = getPdConfigPath(workspaceDir);
  const legacyFilesDetected = detectLegacyFiles(workspaceDir);
  const legacyFileNextActions = buildLegacyFileNextActions(legacyFilesDetected);

  // 1) Config file missing → use defaults
  if (!fs.existsSync(configPath)) {
    const effective = computeEffectivePdConfig(null);
    return {
      ok: true,
      effective,
      source: 'defaults',
      configPath,
      warnings: [
        ...effective.warnings,
        ...(legacyFilesDetected.length > 0
          ? [`Legacy config files detected (${legacyFilesDetected.length}): ${legacyFilesDetected.join(', ')}. PD now uses .pd/config.yaml.`]
          : []),
      ],
      legacyFilesDetected,
      legacyFileNextActions,
    };
  }

  // 2) Read the file
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const effective = computeEffectivePdConfig(null);
    return {
      ok: false,
      source: 'malformed',
      configPath,
      errors: [{ path: '', reason: `Failed to read .pd/config.yaml: ${message}`, nextAction: 'Check file permissions for .pd/config.yaml' }],
      warnings: [],
      defaults: effective,
      legacyFilesDetected,
      legacyFileNextActions,
    };
  }

  // 3) Parse YAML — treat as unknown (ERR-001)
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const effective = computeEffectivePdConfig(null);
    return {
      ok: false,
      source: 'malformed',
      configPath,
      errors: [{ path: '', reason: `YAML parse error in .pd/config.yaml: ${message}`, nextAction: 'Fix YAML syntax in .pd/config.yaml' }],
      warnings: [],
      defaults: effective,
      legacyFilesDetected,
      legacyFileNextActions,
    };
  }

  // 4) Validate via core (ERR-001, ERR-005: no `as` bypasses)
  const validationResult: PdConfigValidationResult = validatePdConfig(parsed);

  if (!validationResult.ok) {
    const effective = computeEffectivePdConfig(null);
    return {
      ok: false,
      source: 'malformed',
      configPath,
      errors: validationResult.errors.map(e => ({
        path: e.path,
        reason: e.reason,
        nextAction: e.nextAction,
      })),
      warnings: [],
      defaults: effective,
      legacyFilesDetected,
      legacyFileNextActions,
    };
  }

  // 5) Compute effective config
  const effective = computeEffectivePdConfig(validationResult.value);

  return {
    ok: true,
    effective,
    source: 'user_config',
    configPath,
    warnings: [
      ...effective.warnings,
      ...(legacyFilesDetected.length > 0
        ? [`Legacy config files detected (${legacyFilesDetected.length}): ${legacyFilesDetected.join(', ')}. PD now uses .pd/config.yaml.`]
        : []),
    ],
    legacyFilesDetected,
    legacyFileNextActions,
  };
}

// ── Feature Flags from Config ────────────────────────────────────────────────

/**
 * Compute feature flags from the loaded PD config.
 * Works with both ok and error results (uses defaults for errors).
 */
export function computeFlagsFromLoadResult(result: PdConfigLoadResult): FeatureFlagsResult {
  const effective = result.ok ? result.effective : result.defaults;
  return computeFeatureFlagsFromConfig(effective);
}

// ── Redacted Summary from Config ─────────────────────────────────────────────

/**
 * Produce a redacted summary of the PD config for CLI/Console display.
 * Never includes token/API key values or raw provider objects.
 */
export function redactLoadResult(result: PdConfigLoadResult): RedactedPdConfigSummary {
  const effective = result.ok ? result.effective : result.defaults;
  return redactPdConfig(effective);
}

// ── Workspace Discovery ──────────────────────────────────────────────────────

/** Result of workspace.default discovery from config files. */
export interface WorkspaceDiscoveryResult {
  /** The extracted workspace.default path. */
  workspaceDefault: string;
  /** Path to the config file that provided workspace.default. */
  configPath: string;
  /** How the config location was found. */
  source: 'env_var' | 'openclaw_default' | 'openclaw_plugin_config';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** Check if a path is absolute (Windows or POSIX). */
function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/**
 * Lightweight extraction of workspace.default from a config file.
 * Does NOT run full validation — just parses YAML and reads the field.
 * Rejects relative paths to prevent PD from writing to unpredictable locations.
 */
function extractWorkspaceDefault(configPath: string): string | null {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
    if (
      isRecord(parsed) &&
      isRecord(parsed.workspace) &&
      typeof parsed.workspace.default === 'string' &&
      parsed.workspace.default.length > 0 &&
      isAbsolutePath(parsed.workspace.default)
    ) {
      return parsed.workspace.default;
    }
  } catch (err) {
    // Graceful degradation with observability: log but don't throw
    process.stderr.write(
      `[PD:workspace] WARN: Failed to parse workspace config at ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return null;
}

/**
 * Read the OpenClaw plugin config file for workspace field.
 * Reuses the same search locations as PathResolver.
 * Returns null if no valid config is found (graceful degradation).
 */
function loadOpenClawPluginConfig(): { workspace?: string } | null {
  const configLocations = [
    path.join(process.cwd(), 'principles-disciple.json'),
    path.join(os.homedir(), '.openclaw', 'principles-disciple.json'),
    path.join(os.homedir(), '.principles', 'principles-disciple.json'),
  ];
  for (const loc of configLocations) {
    if (fs.existsSync(loc)) {
      try {
        const content = fs.readFileSync(loc, 'utf8');
        const parsed: unknown = JSON.parse(content);
        // Runtime type guard: validate workspace is a non-empty string
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Object.hasOwn(parsed, 'workspace') &&
          typeof (parsed as Record<string, unknown>).workspace === 'string' &&
          ((parsed as Record<string, unknown>).workspace as string).length > 0
        ) {
          return { workspace: (parsed as Record<string, unknown>).workspace as string };
        }
      } catch (err) {
        // Graceful degradation with observability: log but continue to next location
        process.stderr.write(
          `[PD:workspace] WARN: Failed to parse plugin config at ${loc}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
  return null;
}

/**
 * Search known locations for a .pd/config.yaml that contains a workspace.default field.
 * This runs BEFORE workspace resolution and does NOT require knowing the workspace dir.
 *
 * Returns the extracted workspace.default path, or null if not found.
 */
export function discoverWorkspaceDefault(): WorkspaceDiscoveryResult | null {
  const candidates: { dir: string; source: 'env_var' | 'openclaw_default' | 'openclaw_plugin_config' }[] = [];

  // 1. If PD_WORKSPACE_DIR is set, check there first
  const envWorkspace = process.env.PD_WORKSPACE_DIR?.trim();
  if (envWorkspace) {
    candidates.push({ dir: envWorkspace, source: 'env_var' });
  }

  // 2. OpenClaw default workspace
  const homeDir = os.homedir();
  candidates.push({
    dir: path.join(homeDir, '.openclaw', 'workspace'),
    source: 'openclaw_default',
  });

  // 3. OpenClaw plugin config (principles-disciple.json) may have workspace field
  const pluginConfig = loadOpenClawPluginConfig();
  if (pluginConfig?.workspace) {
    candidates.push({ dir: pluginConfig.workspace, source: 'openclaw_plugin_config' });
  }

  // Search each candidate for .pd/config.yaml with workspace.default
  for (const { dir, source } of candidates) {
    const configPath = path.join(dir, PD_CONFIG_DIR, PD_CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      const workspaceDefault = extractWorkspaceDefault(configPath);
      if (workspaceDefault) {
        return { workspaceDefault, configPath, source };
      }
    }
  }

  return null;
}
