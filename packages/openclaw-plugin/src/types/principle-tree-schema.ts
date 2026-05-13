/**
 * Principle-Tree Schema Design
 *
 * Concept: Principles are the root of a tree that branches into Rules
 * and eventually into concrete Implementations (code, skills, LoRA weights).
 *
 * A principle without supporting rules is an empty concept — LLM may ignore it.
 * A rule without a parent principle lacks strategic direction.
 *
 * Lifecycle:
 *   Pain Signal → Diagnosis → Principle (root)
 *                              ↓
 *                         Rule (trunk)
 *                              ↓
 *                    Implementation (leaf)
 *                              ↓
 *                    Rule 100% covered → Principle deprecated
 *
 * User Focus:
 *   - Monitor new principles added by diagnostician
 *   - Monitor principles deprecated (solidified into code/weights)
 *   - Track principle value ranking (pain prevented, adherence rate)
 */

import type { Principle as CorePrinciple } from '@principles/core/runtime-v2';
import type { PrincipleDetectorSpec } from '../core/evolution-types.js';
import type {
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
} from '@principles/core/runtime-v2';

// Re-exported from core (PRI-51) for plugin consumers
export type {
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
} from '@principles/core/runtime-v2';

// =========================================================================
// 1. PRINCIPLE (Tree Root) — Highly abstract, cross-scenario, value-driven
// =========================================================================

export interface Principle extends CorePrinciple {
  // EXTENDS core.Principle (PRI-51) — plugin adds detectorMetadata
  /** For auto-training eligibility (plugin-specific, not in core) */
  detectorMetadata?: PrincipleDetectorSpec;
}

// =========================================================================
// 2. RULE (Tree Trunk) — Verifiable, actionable, principle-specific
// =========================================================================

export interface Rule {
  // Identity
  id: string;                     // e.g., "R_060_01"
  version: number;

  // Core content
  name: string;                   // Short descriptive name
  description: string;            // What this rule does
  type: RuleType;

  // Trigger and enforcement
  triggerCondition: string;       // When this rule activates (regex, tool name, context)
  enforcement: 'block' | 'warn' | 'log';  // What happens when violated
  action: string;                 // Concrete action to take

  // Association
  principleId: string;            // Parent principle ID
  parentRuleId?: string;          // If this is a sub-rule

  // Status and metrics
  status: RuleStatus;
  coverageRate: number;           // 0-100, how often this rule catches violations
  falsePositiveRate: number;      // 0-100, how often this rule fires incorrectly

  // Implementation reference
  implementationPath?: string;    // File path, skill name, or LoRA model path
  testPath?: string;              // Test file path

  // Metadata
  createdAt: string;
  updatedAt: string;
}

// =========================================================================
// 3. IMPLEMENTATION (Tree Leaf) — Concrete, executable
// =========================================================================

export interface Implementation {
  // Identity
  id: string;                     // e.g., "IMPL_060_01_hook"
  ruleId: string;                 // Parent rule ID

  // Type and location
  type: ImplementationType;
  path: string;                   // File path, skill ID, or model path
  version: string;                // Code commit hash, skill version, or LoRA version

  // Coverage
  coversCondition: string;        // What condition this implementation covers
  coveragePercentage: number;     // 0-100, how much of the rule this covers

  // Lifecycle state
  lifecycleState: ImplementationLifecycleState;

  // Rollback support: tracks which implementation was active before this one
  previousActive?: string;        // Implementation ID that was active before promotion

  // Disable metadata
  disabledAt?: string;            // ISO timestamp of disable
  disabledBy?: string;            // Who disabled (session/user)
  disabledReason?: string;        // Human-readable reason

  // Archive metadata
  archivedAt?: string;            // ISO timestamp of archive

  // Metadata
  createdAt: string;
  updatedAt: string;
}

// =========================================================================
// 4. PRINCIPLE-RELATIONSHIP GRAPH
// =========================================================================

export interface PrincipleDependency {
  principleId: string;
  dependsOn: string[];            // Principle IDs this depends on
  conflictedWith: string[];       // Principle IDs this conflicts with
  supersedes: string[];           // Principle IDs this replaces
}

// =========================================================================
// 5. VALUE METRICS (Auto-calculated)
// =========================================================================

export interface PrincipleValueMetrics {
  principleId: string;
  
  // Pain prevention
  painPreventedCount: number;     // Total pain signals prevented
  avgPainSeverityPrevented: number;  // Average severity of prevented pain
  lastPainPreventedAt?: string;
  
  // Adherence tracking
  totalOpportunities: number;     // Times the principle could have applied
  adheredCount: number;           // Times the principle was followed
  violatedCount: number;          // Times the principle was violated
  
  // Cost-benefit
  implementationCost: number;     // Dev hours to implement
  benefitScore: number;           // pain_prevented × severity × adherence_rate
  
  // Timestamps
  calculatedAt: string;
}

// =========================================================================
// 6. LIFECYCLE EVENTS (Event stream format for evolution.jsonl)
// =========================================================================

export type PrincipleEventType =
  | 'principle_created'
  | 'principle_updated'
  | 'principle_promoted'
  | 'principle_deprecated'
  | 'rule_created'
  | 'rule_enforced'
  | 'rule_retired'
  | 'implementation_added'
  | 'value_metrics_updated';

export interface PrincipleLifecycleEvent {
  ts: string;                     // ISO timestamp
  type: PrincipleEventType;
  data: {
    principleId?: string;
    ruleId?: string;
    implementationId?: string;
    reason: string;
    metrics?: Partial<PrincipleValueMetrics>;
  };
}

// =========================================================================
// 8. STORE SCHEMA (principle_training_state.json extension)
// =========================================================================

export interface PrincipleTreeStore {
  principles: Record<string, Principle>;
  rules: Record<string, Rule>;
  implementations: Record<string, Implementation>;
  metrics: Record<string, PrincipleValueMetrics>;
  lastUpdated: string;
}
