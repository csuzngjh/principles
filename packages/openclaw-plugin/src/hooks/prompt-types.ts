/**
 * Type definitions for prompt assembly.
 *
 * Extracted from hooks/prompt.ts per PRI-444 to enable independent testing
 * of pure-logic helpers without importing the full hook module.
 *
 * ERR checklist:
 * EP-01: All unknown inputs use typeof/Object.hasOwn guards, never `as`
 * EP-03: Pure functions never swallow errors silently
 * EP-09: Pure functions are independently unit-testable without mocks
 */

import type { PluginLogger, OpenClawPluginApi } from '../openclaw-sdk.js';

/** Cached file entry for TTL-based file reading. */
export interface CachedFile {
  content: string;
  mtime: number;   // file modification time at read
  loadedAt: number; // when we cached it
}

/** Per-workspace empathy session state. */
export interface EmpathySessionState {
  turnCounter: number;
  keywordCache: { store: unknown; lang: string } | null;
}

/** API surface exposed to the prompt hook by the plugin runtime. */
export interface PromptHookApi {
  config?: {
    empathy_engine?: {
      enabled?: boolean;
    };
  };
  runtime: OpenClawPluginApi['runtime'];
  logger: PluginLogger;
}

/** Result of extracting the user message from the raw prompt text. */
export interface ExtractedUserMessage {
  /** Cleaned user message (empty string for boot checks). */
  message: string;
  /** True if the message appears to be from another agent (skip empathy). */
  isAgentToAgent: boolean;
  /** True if the message looks like empathy observer output (prevent recursion). */
  isEmpathyPrompt: boolean;
}

/** Input for formatting core principles into prompt text. */
export interface CorePrincipleEntry {
  id: string;
  text: string;
}

/** Input for formatting evolution principles (active + probation). */
export interface EvolutionPrincipleEntry extends CorePrincipleEntry {
  // Inherits id + text; probation entries are tagged separately by the formatter.
}

/** Parts assembled into appendSystemContext. Order = priority (low → high). */
export interface AppendSystemContextParts {
  behavioralConstraints?: string;
  projectContext?: string;
  workingMemory?: string;
  thinkingOs?: string;
  evolutionPrinciples?: string;
  corePrinciples?: string;
}

/** Input for the heartbeat checklist wrapper. */
export interface HeartbeatChecklistInput {
  content: string;
}
