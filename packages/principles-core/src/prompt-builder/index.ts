/**
 * @principles/core/prompt-builder — Pure prompt-building primitives.
 *
 * Framework-agnostic prompt injection logic extracted from the OpenClaw plugin.
 * These functions have no I/O dependencies and can be used by any host.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1 (attitude/correction/minimal/size)
 *        PRI-75 Prompt Injection SDK Migration Phase 2 (principle selection)
 *        PRI-75 Prompt Injection SDK Migration Phase 3 (routing guidance)
 *        PRI-74 Routing Guidance Migration (follow-up to PRI-75 Phase 3)
 *        PRI-81 Empathy Keyword Matching Migration (Phase A)
 *        PRI-81 Focus Compression Migration (Phase B)
 */

// Types
export type { PromptInjectionPart, SizeGuardOptions, TruncateResult } from './types.js';
export type { InjectablePrinciple, PrincipleSelectionResult } from './principle-selection.js';
export type { RoutingInput, RoutingClassification } from './routing-guidance.js';
export type { EmpathyKeywordStore, EmpathyKeywordEntry, EmpathyKeywordStats, EmpathyMatchResult, EmpathyKeywordUpdate, EmpathyOptimizationResult, SeedKeywordEntry, EmpathyKeywordConfig } from './empathy-types.js';
export type { FileArtifact, WorkingMemorySnapshot, FocusCompressionOptions, FocusCompressionResult } from './focus-compression.js';
export type { CoreLogger, ModelConfigObject } from './model-config.js';

// Functions
export { buildAttitudeDirective } from './attitude-directive.js';
export { detectCorrectionCue } from './correction-cue.js';
export { escapeXml } from './xml-escape.js';
export { extractMessageContent } from './message-extraction.js';
export { isMinimalTrigger } from './minimal-trigger.js';
export { truncateInjectionToBudget } from './size-guard.js';
export { formatPrinciple, selectPrinciplesForInjection, DEFAULT_PRINCIPLE_BUDGET } from './principle-selection.js';
export { containsKeyword, computeCombinedText, classifyTaskKind, buildReason, buildBlockers, READER_KEYWORDS, EDITOR_KEYWORDS, HIGH_ENTROPY_KEYWORDS } from './routing-guidance.js';
export { isValidModelFormat, resolveModelFromConfig } from './model-config.js';

// PRI-81 Phase A: Empathy keyword matching
export { matchEmpathyKeywords, createDefaultKeywordStore, applyKeywordUpdates, shouldTriggerOptimization, getKeywordStoreSummary } from './empathy-keyword-matching.js';
export { EMPATHY_SEED_KEYWORDS, DEFAULT_EMPATHY_KEYWORD_CONFIG, scoreToSeverity, severityToPenalty, normalizeSeverity } from './empathy-types.js';

// PRI-81 Phase B: Focus compression
export { extractVersion, extractDate, extractSummary, parseWorkingMemorySection, workingMemoryToInjection, extractMilestones, validateCurrentFocus, mergeWorkingMemory, compressFocusContent, cleanupStaleInfoPure, DEFAULT_FOCUS_COMPRESSION_OPTIONS, extractDescription, extractProblems, extractNextActions, deduplicateArtifacts } from './focus-compression.js';
