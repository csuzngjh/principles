/**
 * Types for @principles/core/prompt-builder
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

export interface SizeGuardOptions {
  /** When true, also strip thinking_os, reflection_log in addition to project_context */
  diagnosticianMode?: boolean;
  /** Content strings for exact-match replacement (matching plugin behavior) */
  blocks?: {
    projectContextContent?: string;
    /** PRI-467: intent block content (full buildIntentFrictionBlock output) for exact-match stripping */
    intentBlockContent?: string;
    thinkingOsContent?: string;
  };
}

export interface TruncateResult {
  prependSystemContext: string;
  prependContext: string;
  appendSystemContext: string;
  truncated: boolean;
  truncationLog: string[];
}