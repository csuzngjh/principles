/**
 * Thinking Models — Plugin I/O Adapter (Stage 3 slim)
 *
 * Pure logic (BUILTIN_PATTERNS, BUILTIN_PATTERN_MAP, getFallbackName,
 * getFallbackDescription, deriveThinkingScenarios, types) lives in
 * @principles/core/runtime-v2/thinking-models.
 *
 * This file owns only the I/O boundary: reading THINKING_OS.md from a
 * workspace dir and merging it with the builtin patterns. It re-exports
 * the pure functions and types so existing relative imports
 * (../core/thinking-models.js) continue to resolve.
 */

import { loadThinkingOsFromWorkspace, generateDetectionPatterns } from './thinking-os-parser.js';
import {
  BUILTIN_PATTERN_MAP,
  getFallbackName,
  getFallbackDescription,
  type ThinkingModelDefinition,
  type ThinkingModelMatch,
} from '@principles/core/runtime-v2';

// Re-export pure logic + types so existing imports from this module keep working.
export {
  BUILTIN_PATTERN_MAP,
  getFallbackName,
  getFallbackDescription,
} from '@principles/core/runtime-v2';
export { deriveThinkingScenarios } from '@principles/core/runtime-v2';
export type {
  ThinkingModelDefinition,
  ThinkingModelMatch,
  ThinkingScenarioContext,
} from '@principles/core/runtime-v2';

// ---------------------------------------------------------------------------
// Runtime model definitions — merged from THINKING_OS.md + builtin patterns
// ---------------------------------------------------------------------------

let _cachedDefinitions: ThinkingModelDefinition[] | null = null;
let _cachedWorkspace: string | null = null;

/**
 * Load thinking model definitions dynamically from THINKING_OS.md.
 * Falls back to built-in definitions if parsing fails.
 *
 * @param workspaceDir Optional. If provided, loads from that workspace's THINKING_OS.md.
 */
export function listThinkingModels(workspaceDir?: string): ThinkingModelDefinition[] {
  const cacheKey = workspaceDir ?? '__global__';
  if (_cachedDefinitions && _cachedWorkspace === cacheKey) {
    return _cachedDefinitions.slice();
  }

  const models: ThinkingModelDefinition[] = [];

  if (workspaceDir) {
    // Try to load from THINKING_OS.md
    const directives = loadThinkingOsFromWorkspace(workspaceDir);
    if (directives.length > 0) {
      for (const dir of directives) {
        const builtin = BUILTIN_PATTERN_MAP.get(dir.id);
        const patterns = builtin?.patterns ?? generateDetectionPatterns(dir.trigger);
        if (patterns.length === 0) {
          console.warn(`[PD:thinking-models] No detection patterns for ${dir.id}: "${dir.trigger}"`);
        }
        models.push({
          id: dir.id,
          name: dir.name,
          description: dir.must,
          antiPattern: dir.forbidden || undefined,
          patterns,
          baselineScenarios: builtin?.baselineScenarios ?? [],
        });
      }
      _cachedDefinitions = models;
      _cachedWorkspace = cacheKey;
      return models.slice();
    }
  }

  // Fallback: built-in definitions
  for (const [id, builtin] of BUILTIN_PATTERN_MAP) {
    models.push({
      id,
      name: getFallbackName(id),
      description: getFallbackDescription(id),
      patterns: builtin.patterns,
      baselineScenarios: builtin.baselineScenarios,
    });
  }
  _cachedDefinitions = models;
  _cachedWorkspace = cacheKey;
  return models.slice();
}

export function getThinkingModel(modelId: string, workspaceDir?: string): ThinkingModelDefinition | undefined {
  const models = listThinkingModels(workspaceDir);
  return models.find(m => m.id === modelId);
}

export function detectThinkingModelMatches(text: string, workspaceDir?: string): ThinkingModelMatch[] {
  if (!text) return [];

  const models = listThinkingModels(workspaceDir);
  const matches: ThinkingModelMatch[] = [];

  for (const model of models) {
    for (const pattern of model.patterns) {
      if (pattern.test(text)) {
        matches.push({
          modelId: model.id,
          matchedPattern: pattern.source,
        });
        break;
      }
    }
  }
  return matches;
}
