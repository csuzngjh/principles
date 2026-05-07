/**
 * @principles/core/prompt-builder — Pure prompt-building primitives.
 *
 * Framework-agnostic prompt injection logic extracted from the OpenClaw plugin.
 * These functions have no I/O dependencies and can be used by any host.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1 (attitude/correction/minimal/size)
 *        PRI-75 Prompt Injection SDK Migration Phase 2 (principle selection)
 */

// Types
export type { PromptInjectionPart, SizeGuardOptions, TruncateResult } from './types.js';
export type { InjectablePrinciple, PrincipleSelectionResult } from './principle-selection.js';

// Functions
export { buildAttitudeDirective } from './attitude-directive.js';
export { detectCorrectionCue } from './correction-cue.js';
export { extractMessageContent } from './message-extraction.js';
export { isMinimalTrigger } from './minimal-trigger.js';
export { truncateInjectionToBudget } from './size-guard.js';
export { formatPrinciple, selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from './principle-selection.js';
