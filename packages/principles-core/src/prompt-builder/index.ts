/**
 * @principles/core/prompt-builder — Pure prompt-building primitives.
 *
 * Framework-agnostic prompt injection logic extracted from the OpenClaw plugin.
 * These functions have no I/O dependencies and can be used by any host.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

// Types
export type { PromptInjectionPart, SizeGuardOptions } from './types.js';

// Functions
export { buildAttitudeDirective } from './attitude-directive.js';
export { detectCorrectionCue } from './correction-cue.js';
export { extractMessageContent } from './message-extraction.js';
export { isMinimalTrigger } from './minimal-trigger.js';
export { truncateInjectionToBudget } from './size-guard.js';