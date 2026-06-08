/**
 * Config reader for pd-cli — reads outputLanguage from .pd/config.yaml.
 *
 * This is an I/O boundary module (pd-cli is the I/O layer).
 * Uses core's `resolveOutputLanguage` for validation and degradation.
 *
 * ERR entries:
 * - ERR-001: No `as` bypasses on untrusted parsed YAML — use isRecord type guard
 * - ERR-002: Graceful degradation includes reason + nextAction
 * - ERR-009: Malformed values fail loud with structured warning
 * - ERR-013: Object.hasOwn() for untrusted keys
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { resolveOutputLanguage, DEFAULT_OUTPUT_LANGUAGE } from '@principles/core/runtime-v2';
import type { ResolvedOutputLanguage } from '@principles/core/runtime-v2';

/**
 * Type guard: checks that a value is a non-null plain object (Record<string, unknown>).
 * Per ERR-001: use type guards instead of `as` casts at trust boundaries.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a structured degradation warning for config read errors.
 * Per ERR-002/ERR-009: every degraded path must include reason + nextAction.
 */
function configDegradationWarning(
  reason: 'read_error' | 'yaml_parse_error' | 'invalid_config_root' | 'invalid_principles_structure',
  detail: string,
): string {
  const reasons: Record<typeof reason, { msg: string; action: string }> = {
    read_error: {
      msg: `Failed to read .pd/config.yaml: ${detail}`,
      action: 'Check file permissions and ensure .pd/config.yaml is readable',
    },
    yaml_parse_error: {
      msg: `Failed to parse .pd/config.yaml: ${detail}`,
      action: 'Fix YAML syntax errors in .pd/config.yaml',
    },
    invalid_config_root: {
      msg: `.pd/config.yaml root is not an object: ${detail}`,
      action: 'Ensure .pd/config.yaml has a valid YAML mapping at the top level',
    },
    invalid_principles_structure: {
      msg: `.pd/config.yaml principles field is not an object: ${detail}`,
      action: 'Ensure principles field in .pd/config.yaml is a YAML mapping (e.g. principles: { outputLanguage: zh-CN })',
    },
  };
  const entry = reasons[reason];
  return `${entry.msg}. Falling back to default: ${DEFAULT_OUTPUT_LANGUAGE}. nextAction: ${entry.action}`;
}

/**
 * Read principles.outputLanguage from workspace .pd/config.yaml.
 *
 * Returns ResolvedOutputLanguage with:
 * - outputLanguage: the effective language to use
 * - degradationWarning: present if config was malformed or unreadable (ERR-002/ERR-009)
 *
 * Distinguishes between "not configured" (legitimate default, no warning)
 * and "config broken" (degraded with reason + nextAction).
 */
export function readOutputLanguageFromWorkspace(workspaceDir: string): ResolvedOutputLanguage {
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    // No config file → legitimate default, no warning
    return resolveOutputLanguage(undefined);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return {
      outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
      degradationWarning: configDegradationWarning('read_error', String(err)),
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    return {
      outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
      degradationWarning: configDegradationWarning('yaml_parse_error', String(err)),
    };
  }

  if (!isRecord(parsed)) {
    return {
      outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
      degradationWarning: configDegradationWarning('invalid_config_root', typeof parsed),
    };
  }

  if (!Object.hasOwn(parsed, 'principles')) {
    // No principles section → legitimate default, no warning
    return resolveOutputLanguage(undefined);
  }

  const principlesRaw = parsed.principles;
  if (!isRecord(principlesRaw)) {
    return {
      outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
      degradationWarning: configDegradationWarning('invalid_principles_structure', typeof principlesRaw),
    };
  }

  if (!Object.hasOwn(principlesRaw, 'outputLanguage')) {
    // No outputLanguage key → legitimate default, no warning
    return resolveOutputLanguage(undefined);
  }

  return resolveOutputLanguage(principlesRaw.outputLanguage);
}
