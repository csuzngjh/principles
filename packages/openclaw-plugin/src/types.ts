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

export interface ContextInjectionConfig {
  /** Thinking OS (mental models) - can be toggled */
  thinkingOs: boolean;
  
  /** Project context (CURRENT_FOCUS.md) mode */
  projectFocus: ProjectFocusMode;
  
  /** Reflection log - can be toggled */
  reflectionLog: boolean;
  
  /** Trust score awareness - can be toggled */
  trustScore: boolean;
}

/**
 * Default context injection configuration
 * Based on user requirements:
 * - principles: always on (not configurable)
 * - thinkingOs: true (can be turned off)
 * - projectFocus: 'off' (default closed, user can enable)
 * - reflectionLog: true (default on)
 * - trustScore: true (can be turned off)
 */
export const defaultContextConfig: ContextInjectionConfig = {
  thinkingOs: true,
  projectFocus: 'off',
  reflectionLog: true,
  trustScore: true,
};

/**
 * Reflection log entry structure
 */
export interface ReflectionLogEntry {
  timestamp: string;
  context: string;
  insights: string;
  modelId?: string;
  depth?: number;
}

/**
 * Reflection log retention configuration
 */
export const reflectionLogRetentionDays = 7;
