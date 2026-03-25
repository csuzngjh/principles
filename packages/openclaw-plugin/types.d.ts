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
    /** Reflection log - can be toggled */
    reflectionLog: boolean;
    /** Trust score awareness - can be toggled */
    trustScore: boolean;
    /** Evolution task context injection settings */
    evolutionContext: EvolutionContextConfig;
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
export declare const defaultContextConfig: ContextInjectionConfig;
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
export declare const reflectionLogRetentionDays = 7;
