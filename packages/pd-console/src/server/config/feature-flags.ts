/**
 * Feature flag loader for pd-console server.
 *
 * Reads <workspaceDir>/.pd/feature-flags.yaml and merges with
 * core defaults via computeEffectiveFlags.
 *
 * Fail-closed: if loading fails, the returned result indicates failure
 * so callers can deny write paths that depend on feature flags.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
} from '@principles/core/runtime-v2';
import type { EffectiveFeatureFlags } from '@principles/core/runtime-v2';

const FEATURE_FLAGS_CONFIG_FILENAME = 'feature-flags.yaml';
const FEATURE_FLAGS_CONFIG_DIR = '.pd';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface FeatureFlagLoadResult {
  ok: true;
  flags: EffectiveFeatureFlags;
}

export interface FeatureFlagLoadError {
  ok: false;
  reason: string;
  nextAction: string;
}

export type LoadFeatureFlagsResult = FeatureFlagLoadResult | FeatureFlagLoadError;

function readConfigFile(configPath: string): { ok: true; content: string } | { ok: false; reason: string; nextAction: string } {
  try {
    return { ok: true, content: fs.readFileSync(configPath, 'utf8') };
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to read feature flags config: ${err instanceof Error ? err.message : String(err)}`,
      nextAction: 'Verify file permissions on .pd/feature-flags.yaml and retry',
    };
  }
}

function parseYaml(content: string): { ok: true; value: unknown } | { ok: false; reason: string; nextAction: string } {
  try {
    return { ok: true, value: yaml.load(content, { schema: yaml.JSON_SCHEMA }) };
  } catch {
    return {
      ok: false,
      reason: 'feature-flags.yaml: YAML parse error',
      nextAction: 'Fix YAML syntax in .pd/feature-flags.yaml or delete the file to use defaults',
    };
  }
}

/**
 * Load effective feature flags for the given workspace.
 *
 * Returns ok:false with reason+nextAction on failure (fail-closed).
 * Does NOT throw — callers must check .ok.
 */
export function loadWorkspaceFeatureFlags(workspaceDir: string): LoadFeatureFlagsResult {
  const configPath = path.join(workspaceDir, FEATURE_FLAGS_CONFIG_DIR, FEATURE_FLAGS_CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    // No config file — use defaults (feedback_channel enabled by default)
    return {
      ok: true,
      flags: computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath),
    };
  }

  const readResult = readConfigFile(configPath);
  if (!readResult.ok) {
    return readResult;
  }

  const parseResult = parseYaml(readResult.content);
  if (!parseResult.ok) {
    return parseResult;
  }

  if (!isRecord(parseResult.value)) {
    return {
      ok: false,
      reason: 'feature-flags.yaml: expected a YAML mapping, got ' + (Array.isArray(parseResult.value) ? 'array' : typeof parseResult.value),
      nextAction: 'Replace .pd/feature-flags.yaml content with a valid YAML mapping or delete it',
    };
  }

  const safeRecord: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(parseResult.value)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    if (Object.hasOwn(parseResult.value, key)) {
      safeRecord[key] = parseResult.value[key];
    }
  }

  return {
    ok: true,
    flags: computeEffectiveFlags(safeRecord, DEFAULT_FEATURE_FLAGS, configPath),
  };
}

/**
 * Build the minimal featureFlags object expected by handleFeedbackReportsRoute.
 * Fail-closed: if loading fails, returns feedback_channel enabled=false.
 */
export function buildFeedbackChannelFlags(loadResult: LoadFeatureFlagsResult): Record<string, { enabled: boolean }> {
  if (!loadResult.ok) {
    // Fail closed — disable feedback_channel when flags cannot be loaded
    return { feedback_channel: { enabled: false } };
  }

  const feedbackDef = loadResult.flags.flags.feedback_channel;
  return {
    feedback_channel: { enabled: feedbackDef?.enabled ?? false },
  };
}
