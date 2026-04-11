/**
 * Rule Host Types — Execution contracts for hosted code implementations
 *
 * PURPOSE: Define the constrained interface through which active code
 * implementations are executed. Implementations receive a frozen snapshot
 * of context and return one of three decisions.
 *
 * TRUST BOUNDARY:
 *   - RuleHostInput is a frozen snapshot — no live workspace handles
 *   - Implementations execute in a constrained vm context with minimal helpers
 *   - No filesystem, process, require, dynamic import, eval, or network access
 */

// ---------------------------------------------------------------------------
// Input: Frozen snapshot provided to implementations
// ---------------------------------------------------------------------------

export interface RuleHostInput {
  action: {
    toolName: string;
    normalizedPath: string | null;
    paramsSummary: Record<string, unknown>;
  };
  workspace: {
    isRiskPath: boolean;
    planStatus: 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN';
    hasPlanFile: boolean;
  };
  session: {
    sessionId?: string;
    currentGfi: number;
    recentThinking: boolean;
  };
  evolution: {
    epTier: number;
  };
  derived: {
    estimatedLineChanges: number;
    bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown';
  };
}

// ---------------------------------------------------------------------------
// Decision: Limited to three outcomes
// ---------------------------------------------------------------------------

export type RuleHostDecision = 'allow' | 'block' | 'requireApproval';

// ---------------------------------------------------------------------------
// Meta: Exported by each implementation for identification
// ---------------------------------------------------------------------------

export interface RuleHostMeta {
  name: string;
  version: string;
  ruleId: string;
  coversCondition: string;
}

// ---------------------------------------------------------------------------
// Result: Structured output from a single implementation evaluation
// ---------------------------------------------------------------------------

export interface RuleHostResult {
  decision: RuleHostDecision;
  matched: boolean;
  reason: string;
  diagnostics?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LoadedImplementation: A successfully loaded active implementation
// ---------------------------------------------------------------------------

export interface LoadedImplementation {
  implId: string;
  ruleId: string;
  meta: RuleHostMeta;
   
  evaluate: (_input: RuleHostInput) => RuleHostResult;
   
}
