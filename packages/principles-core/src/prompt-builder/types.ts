/**
 * Types for @principles/core/prompt-builder
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

/*** @alpha Reserved for Phase 2 — selectPrinciplesForInjection will use PromptInjectionPart[] */
export interface PromptInjectionPart {
  id: string;
  content: string;
}

export interface SizeGuardOptions {
  /** When true, also strip thinking_os, evolution_principles, reflection_log in addition to project_context */
  diagnosticianMode?: boolean;
  /** Content strings for exact-match replacement (matching plugin behavior) */
  blocks?: {
    projectContextContent?: string;
    /** PRI-467: intent block content (full buildIntentFrictionBlock output) for exact-match stripping */
    intentBlockContent?: string;
    thinkingOsContent?: string;
    evolutionPrinciplesContent?: string;
  };
}

export interface TruncateResult {
  prependSystemContext: string;
  prependContext: string;
  appendSystemContext: string;
  truncated: boolean;
  truncationLog: string[];
}