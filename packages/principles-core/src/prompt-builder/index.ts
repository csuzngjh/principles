/**
 * @principles/core/prompt-builder — Pure prompt-building primitives.
 *
 * Framework-agnostic prompt injection logic extracted from the OpenClaw plugin.
 * These functions have no I/O dependencies and can be used by any host.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1 (attitude/correction/minimal/size)
 *        PRI-75 Prompt Injection SDK Migration Phase 2 (principle selection)
 *        PRI-75 Prompt Injection SDK Migration Phase 3 (routing guidance)
 */

// Types
export type { PromptInjectionPart, SizeGuardOptions, TruncateResult } from './types.js';
export type { InjectablePrinciple, PrincipleSelectionResult } from './principle-selection.js';
export type { RoutingInput, RoutingClassification } from './routing-guidance.js';

// Functions
export { buildAttitudeDirective } from './attitude-directive.js';
export { detectCorrectionCue } from './correction-cue.js';
export { extractMessageContent } from './message-extraction.js';
export { isMinimalTrigger } from './minimal-trigger.js';
export { truncateInjectionToBudget } from './size-guard.js';
export { formatPrinciple, selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from './principle-selection.js';
export { containsKeyword, computeCombinedText, classifyTaskKind, buildReason, buildBlockers, READER_KEYWORDS, EDITOR_KEYWORDS, HIGH_ENTROPY_KEYWORDS } from './routing-guidance.js';
