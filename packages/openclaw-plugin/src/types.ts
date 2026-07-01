// Re-export from local OpenClaw SDK shims.
// These types mirror openclaw/src/plugins/types.ts exactly.
// When openclaw is available as a peer dependency, you can switch to:
//   export type { PluginCommandContext, PluginCommandResult } from 'openclaw/plugin-sdk/core';
export type { PluginCommandContext, PluginCommandResult } from './openclaw-sdk.js';

// Context Injection types — migrated to @principles/core as part of .pd/config.yaml unification (PR-xxx).
// Re-exported here so plugin consumers keep the same import path.
export type {
  ContextInjectionConfig,
  EvolutionContextConfig,
  ProjectFocusMode,
} from '@principles/core';

/**
 * Default context injection configuration
 * Based on MVP-first strategy (ADR-0014):
 * - principles: always on (not configurable)
 * - thinkingOs: false by default (MVP-Quiet, user can opt-in via /pd-context)
 * - projectFocus: 'off' (default closed, user can enable)
 *
 * Migrated to DEFAULT_CONTEXT_INJECTION in @principles/core.
 * Re-exported for backward compatibility.
 */
export { DEFAULT_CONTEXT_INJECTION as defaultContextConfig } from '@principles/core';
