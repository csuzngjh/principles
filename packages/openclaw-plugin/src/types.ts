// Re-export from local OpenClaw SDK shims.
// These types mirror openclaw/src/plugins/types.ts exactly.
// When openclaw is available as a peer dependency, you can switch to:
//   export type { PluginCommandContext, PluginCommandResult } from 'openclaw/plugin-sdk/core';
export type { PluginCommandContext, PluginCommandResult } from './openclaw-sdk.js';

/**
 * Context Injection Configuration
 * Controls what content gets injected into the LLM prompt.
 * 
 * NOTE: Core Principles (PRINCIPLES.md) are ALWAYS injected and cannot be disabled.
 * This is by design - principles are the foundation of the agent's behavior.
 */
export type ProjectFocusMode = 'full' | 'summary' | 'off';

export interface EvolutionContextConfig {
  /** Enable conversation context in evolution task (default: true) */
  enabled: boolean;

  /** Max recent messages included in evolution task (default: 4) */
  maxMessages: number;

  /** Max chars per message snippet (default: 200) */
  maxCharsPerMessage: number;
}

export interface ContextInjectionConfig {
  /** Thinking OS (mental models) - can be toggled */
  thinkingOs: boolean;
  
  /** Project context (CURRENT_FOCUS.md) mode */
  projectFocus: ProjectFocusMode;
  
  /** Evolution task context injection settings */
  evolutionContext: EvolutionContextConfig;
}

/**
 * Default context injection configuration
 * Based on user requirements:
 * - principles: always on (not configurable)
 * - thinkingOs: true (can be turned off)
 * - projectFocus: 'off' (default closed, user can enable)
 */
export const defaultContextConfig: ContextInjectionConfig = {
  thinkingOs: true,
  projectFocus: 'off',
  evolutionContext: {
    enabled: true,
    maxMessages: 4,
    maxCharsPerMessage: 200,
  },
};
