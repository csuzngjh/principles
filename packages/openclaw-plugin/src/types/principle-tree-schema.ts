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

// Re-exported from core (PRI-51) for plugin consumers
export type {
  PrinciplePriority,
  PrincipleScope,
  PrincipleEvaluability,
  RuleStatus,
  RuleType,
  ImplementationLifecycleState,
  ImplementationType,
  Rule,
  Implementation,
  PrincipleDependency,
  PrincipleValueMetrics,
  PrincipleEventType,
  PrincipleLifecycleEvent,
  PrincipleTreeStore,
} from '@principles/core/runtime-v2';

// =========================================================================
// 1. PRINCIPLE (Tree Root) — Highly abstract, cross-scenario, value-driven
// =========================================================================

export interface Principle extends CorePrinciple {
  detectorMetadata?: PrincipleDetectorSpec;
}
