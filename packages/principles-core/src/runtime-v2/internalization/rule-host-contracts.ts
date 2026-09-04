/**
 * Rule Host Contracts — Execution contracts for hosted code implementations
 *
 * PURPOSE: Define the constrained interface through which active code
 * implementations are executed. Implementations receive a frozen snapshot
 * of context and return one of four decisions.
 *
 * TRUST BOUNDARY:
 *   - RuleHostInput is a frozen snapshot — no live workspace handles
 *   - Implementations execute in a constrained vm context with minimal helpers
 *   - No filesystem, process, require, dynamic import, eval, or network access
 */

import type { CorrectionProposal } from './correction-proposal.js';
import type { RuleContextV2, CanonicalKind } from './rule-context-v2.js';

// ---------------------------------------------------------------------------
// Input: Frozen snapshot provided to implementations
// ---------------------------------------------------------------------------

export interface RuleHostInput {
  action: {
    toolName: string;
    normalizedPath: string | null;
    paramsSummary: Record<string, unknown>;
    /**
     * PRI-634-F Phase 2 (Replay/Production Input Parity): canonical tool kind
     * resolved from the ToolSemanticRegistry (same registry instance for both
     * replay and production). Optional on purpose — v1 rules that never read
     * this field see `undefined` and behave exactly as before. Builders
     * receiving a registry/kind populate it; unknown tools resolve to 'other',
     * never throw.
     */
    canonicalKind?: CanonicalKind;
  };
  workspace: {
    isRiskPath: boolean;
  };
  session: {
    sessionId?: string;
    currentGfi: number;
  };
  evolution: {
    epTier: number;
  };
  derived: {
    estimatedLineChanges: number;
    bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown';
  };
  /**
   * PRI-480 (RuleContext v2 — Phase 1): optional structured context describing
   * the recent tool-call history and derived behavior facts. Optional on purpose
   * — v1 rule implementations that never read this field see `undefined` and
   * behave exactly as before. Hosts opt in by populating the field; downstream
   * phases will gate new rule behavior on `context?.history.status === 'available'`.
   */
  context?: RuleContextV2;
}

// ---------------------------------------------------------------------------
// Decision: Four outcomes (PRI-114 adds auto_correct)
// ---------------------------------------------------------------------------

export type RuleHostDecision = 'allow' | 'block' | 'requireApproval' | 'auto_correct';

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
  ruleId?: string;
  principleId?: string;
  /** Present when decision is 'auto_correct'. Must pass validateCorrectionProposal(). */
  correctionProposal?: CorrectionProposal;
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
