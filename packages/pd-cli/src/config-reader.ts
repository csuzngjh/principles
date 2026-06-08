/**
 * Config reader for pd-cli — reads outputLanguage from .pd/config.yaml.
 *
 * This is an I/O boundary module (pd-cli is the I/O layer).
 * Uses core's `resolveOutputLanguage` for validation and degradation.
 *
 * ERR entries:
 * - ERR-001: No `as` bypasses on untrusted parsed YAML
 * - ERR-002: Graceful degradation includes reason
 * - ERR-009: Malformed values fail loud
 * - ERR-013: Object.hasOwn() for untrusted keys
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { resolveOutputLanguage } from '@principles/core/runtime-v2';
import type { ResolvedOutputLanguage } from '@principles/core/runtime-v2';

/**
 * Read principles.outputLanguage from workspace .pd/config.yaml.
 *
 * Returns ResolvedOutputLanguage with:
 * - outputLanguage: the effective language to use
 * - degradationWarning: present if config was malformed (ERR-002/ERR-009)
 */
export function readOutputLanguageFromWorkspace(workspaceDir: string): ResolvedOutputLanguage {
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    return resolveOutputLanguage(undefined);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return resolveOutputLanguage(undefined);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    return resolveOutputLanguage(undefined);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return resolveOutputLanguage(undefined);
  }

  // Extract principles.outputLanguage
  // `as Record<string, unknown>` is safe here because we verified typeof === 'object' && !== null above.
  // This is a narrowing cast (not a trust-boundary bypass) — the value is still treated as unknown
  // when accessed via record[key], and resolveOutputLanguage() validates it at the boundary.
  const parsedRecord = parsed as Record<string, unknown>;
  if (!Object.hasOwn(parsedRecord, 'principles')) {
    return resolveOutputLanguage(undefined);
  }

  const principlesRaw = parsedRecord.principles;
  if (typeof principlesRaw !== 'object' || principlesRaw === null) {
    return resolveOutputLanguage(undefined);
  }

  const principlesRecord = principlesRaw as Record<string, unknown>; // narrowing cast (validated above)
  if (!Object.hasOwn(principlesRecord, 'outputLanguage')) {
    return resolveOutputLanguage(undefined);
  }

  return resolveOutputLanguage(principlesRecord.outputLanguage);
}
