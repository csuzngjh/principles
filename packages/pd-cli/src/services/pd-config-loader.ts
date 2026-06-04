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
import yaml from 'js-yaml';
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
