/**
 * Types for @principles/core/prompt-builder
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

export interface PromptInjectionPart {
  id: string;
  content: string;
}

export interface SizeGuardOptions {
  /** When true, also strip thinking_os, evolution_principles, reflection_log in addition to project_context */
  diagnosticianMode?: boolean;
  /** Content strings for the blocks that may be stripped (needed for targeted replacement) */
  blocks?: {
    projectContextContent?: string;
    thinkingOsContent?: string;
    evolutionPrinciplesContent?: string;
  };
  /** Minimum characters to keep below budget */
  minHeadroom?: number;
}