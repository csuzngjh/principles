import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import {
  computeEffectiveFlags,
  DEFAULT_FEATURE_FLAGS,
} from '@principles/core/runtime-v2';
import type { EffectiveFeatureFlags } from '@principles/core/runtime-v2';

export const FEATURE_FLAGS_CONFIG_FILENAME = 'feature-flags.yaml';
export const FEATURE_FLAGS_CONFIG_DIR = '.pd';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getFeatureFlagsConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, FEATURE_FLAGS_CONFIG_DIR, FEATURE_FLAGS_CONFIG_FILENAME);
}

export function loadEffectiveFeatureFlags(workspaceDir: string): EffectiveFeatureFlags {
  const configPath = getFeatureFlagsConfigPath(workspaceDir);

  if (!fs.existsSync(configPath)) {
    return computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath);
  }

  const raw = fs.readFileSync(configPath, 'utf8');

  // eslint-disable-next-line @typescript-eslint/init-declarations -- reassigned in try block below
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    return {
      ...computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath),
      warnings: ['feature-flags.yaml: YAML parse error, using defaults'],
    };
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...computeEffectiveFlags({}, DEFAULT_FEATURE_FLAGS, configPath),
      warnings: ['feature-flags.yaml: expected a mapping, using defaults'],
    };
  }

  const parsedRecord: Record<string, unknown> = Object.create(null);
  const warnings: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (DANGEROUS_KEYS.has(key)) {
      warnings.push(`feature-flags.yaml: dangerous key '${key}' rejected`);
      continue;
    }
    if (Object.hasOwn(parsed, key)) {
      parsedRecord[key] = (parsed as Record<string, unknown>)[key];
    }
  }

  const result = computeEffectiveFlags(
    parsedRecord,
    DEFAULT_FEATURE_FLAGS,
    configPath,
  );

  if (warnings.length > 0) {
    result.warnings = [...warnings, ...result.warnings];
  }

  return result;
}
