/**
 * Trigger Controller — PEAT-B2
 *
 * Pure core module that connects triage/admission decisions to a concrete
 * trigger outcome. This is the ONLY module that decides whether a diagnostic
 * task is created.
 *
 * Input:  triage result + source descriptor + minimal evidence metadata
 * Output: TriggerDecision with structured outcome
 *
 * Every output carries reason + nextAction (ERR-002).
 * No raw sensitive data in outputs (privacy boundary).
 *
 * ERR checklist:
 * - ERR-001: No `as` casts. Input validated with runtime guards.
 * - ERR-002: Every decision carries reason + nextAction.
 * - ERR-009: Malformed/missing state fails loud with reason.
 * - ERR-025: Production-path wiring, not just helper tests.
 * - ERR-031/034: Config source alignment — decisions from canonical descriptors.
 * - ERR-048: Activation/write-read disconnect prevented by recording decisions.
 */

import type { SourceKind, TriageDecision, TriageResult } from './types.js';
import type { SourceDescriptor } from './source-descriptors.js';
import { getSourceDescriptor } from './source-descriptors.js';

// ── Trigger Decision Types ──────────────────────────────────────────────────

/**
 * The outcome of a trigger controller evaluation.
 *
 * Each variant represents a distinct state that is observable by the owner:
 * - evidence_only: recorded but no diagnosis created
 * - diagnosis_created: diagnostician task was/will be created
 * - diagnosis_skipped: admission was 'admit' but something prevented diagnosis
 * - cooldown_skipped: admitted but cooldown prevented creation
 * - manual_owner_admitted: owner explicit pain bypasses normal gate
 * - refused: malformed or invalid input rejected
 * - health_only: infrastructure health signal only
 * - owner_confirm_required: needs owner confirmation before diagnosis
 */
export type TriggerOutcome =
  | 'evidence_only'
  | 'diagnosis_created'
  | 'diagnosis_skipped'
  | 'cooldown_skipped'
  | 'manual_owner_admitted'
  | 'refused'
  | 'health_only'
  | 'owner_confirm_required';

/**
 * Structured trigger decision returned by the controller.
 *
 * Every field is required to prevent silent degradation (ERR-002).
 */
export interface TriggerDecision {
  /** The trigger outcome */
  readonly outcome: TriggerOutcome;
  /** Human-readable reason for this decision */
  readonly reason: string;
  /** What should happen next */
  readonly nextAction: string;
  /** Source kind that was evaluated */
  readonly sourceKind: SourceKind;
  /** The triage decision that led to this trigger outcome */
  readonly triageDecision: TriageDecision;
  /** Whether this decision should result in a diagnostic task */
  readonly shouldCreateDiagnosticTask: boolean;
  /** Timestamp of the decision */
  readonly decidedAt: string;
  /** Optional operator note for debugging */
  readonly operatorNote?: string;
}

// ── Trigger Controller Input ────────────────────────────────────────────────

/**
 * Input to the trigger controller.
 *
 * Combines triage result with additional context that the trigger controller
 * needs but the triage policy does not.
 */
export interface TriggerControllerInput {
  /** Result from evidence triage (PEAT-B1) */
  readonly triageResult: TriageResult;
  /** Whether this is an owner manual pain signal */
  readonly isOwnerManual: boolean;
  /** Whether cooldown is currently active for this source/session */
  readonly isCooldownActive: boolean;
  /** Whether the input was valid (malformed → refused) */
  readonly isValid: boolean;
  /** Optional validation error message when isValid is false */
  readonly validationError?: string;
  /** Pain score (0-100) */
  readonly score: number;
  /** Optional session ID for cooldown scoping */
  readonly sessionId?: string;
  /** Whether cooldown bypass is allowed (owner manual always bypasses) */
  readonly cooldownBypassAllowed?: boolean;
}

// ── Helper ──────────────────────────────────────────────────────────────────

function buildOperatorNote(descriptor: SourceDescriptor | undefined, input: TriggerControllerInput): string {
  const parts: string[] = [];
  if (descriptor) {
    parts.push(`canUpgrade=${descriptor.canUpgrade}`);
  }
  parts.push(`score=${input.score}`);
  if (input.sessionId) {
    parts.push(`session=${input.sessionId.slice(0, 8)}`);
  }
  return parts.join(', ');
}

// ── Decision Functions ──────────────────────────────────────────────────────

/**
 * Decide trigger outcome for malformed/invalid input.
 *
 * ERR-009: malformed state fails loud with reason and nextAction.
 */
function decideRefused(input: TriggerControllerInput): TriggerDecision {
  return {
    outcome: 'refused',
    reason: input.validationError ?? 'Input validation failed. Evidence is malformed or incomplete.',
    nextAction: 'fix_input_and_retry_or_classify_as_unknown',
    sourceKind: input.triageResult.sourceKind,
    triageDecision: input.triageResult.decision,
    shouldCreateDiagnosticTask: false,
    decidedAt: new Date().toISOString(),
    operatorNote: `validationError=${input.validationError ?? 'unknown'}`,
  };
}

/**
 * Decide trigger outcome for owner manual pain.
 *
 * Owner explicit manual pain always bypasses triage and cooldown.
 * This is the highest-confidence path (PRODUCT_IDENTITY: owner-governed).
 */
function decideManualOwnerAdmitted(input: TriggerControllerInput): TriggerDecision {
  return {
    outcome: 'manual_owner_admitted',
    reason: 'Owner explicit manual pain. Bypasses triage and cooldown. Highest confidence signal.',
    nextAction: 'create_diagnostic_task',
    sourceKind: input.triageResult.sourceKind,
    triageDecision: input.triageResult.decision,
    shouldCreateDiagnosticTask: true,
    decidedAt: new Date().toISOString(),
    operatorNote: `score=${input.score}, sessionId=${input.sessionId ?? 'unknown'}`,
  };
}

/**
 * Decide trigger outcome based on triage decision.
 */
function decideFromTriage(input: TriggerControllerInput): TriggerDecision {
  const { triageResult } = input;
  const descriptor = getSourceDescriptor(triageResult.sourceKind);
  const decidedAt = new Date().toISOString();

  switch (triageResult.decision) {
    case 'admit': {
      // Check cooldown — only applies to non-owner paths
      if (input.isCooldownActive && !input.cooldownBypassAllowed) {
        return {
          outcome: 'cooldown_skipped',
          reason: `Admitted by triage but cooldown is active for source '${triageResult.sourceKind}'. Cooldown prevents diagnosis to avoid duplicate tasks.`,
          nextAction: 'wait_for_cooldown_or_manual_retrigger',
          sourceKind: triageResult.sourceKind,
          triageDecision: triageResult.decision,
          shouldCreateDiagnosticTask: false,
          decidedAt,
          operatorNote: `cooldown_active=true, score=${input.score}`,
        };
      }
      return {
        outcome: 'diagnosis_created',
        reason: triageResult.reason,
        nextAction: triageResult.nextAction === 'none' ? 'proceed_with_diagnostic_task' : triageResult.nextAction,
        sourceKind: triageResult.sourceKind,
        triageDecision: triageResult.decision,
        shouldCreateDiagnosticTask: true,
        decidedAt,
        operatorNote: buildOperatorNote(descriptor, input),
      };
    }

    case 'evidence_only': {
      return {
        outcome: 'evidence_only',
        reason: triageResult.reason,
        nextAction: triageResult.nextAction,
        sourceKind: triageResult.sourceKind,
        triageDecision: triageResult.decision,
        shouldCreateDiagnosticTask: false,
        decidedAt,
        operatorNote: buildOperatorNote(descriptor, input),
      };
    }

    case 'health_only': {
      return {
        outcome: 'health_only',
        reason: triageResult.reason,
        nextAction: triageResult.nextAction,
        sourceKind: triageResult.sourceKind,
        triageDecision: triageResult.decision,
        shouldCreateDiagnosticTask: false,
        decidedAt,
        operatorNote: `provider_signal, score=${input.score}`,
      };
    }

    case 'owner_confirm': {
      return {
        outcome: 'owner_confirm_required',
        reason: triageResult.reason,
        nextAction: triageResult.nextAction,
        sourceKind: triageResult.sourceKind,
        triageDecision: triageResult.decision,
        shouldCreateDiagnosticTask: false,
        decidedAt,
        operatorNote: `requires_confirmation, score=${input.score}`,
      };
    }

    case 'reject': {
      return {
        outcome: 'refused',
        reason: triageResult.reason,
        nextAction: triageResult.nextAction,
        sourceKind: triageResult.sourceKind,
        triageDecision: triageResult.decision,
        shouldCreateDiagnosticTask: false,
        decidedAt,
        operatorNote: `rejected, score=${input.score}`,
      };
    }

    default: {
      // Exhaustiveness check — should never reach here
      const _exhaustive: never = triageResult.decision;
      return {
        outcome: 'refused',
        reason: `Unhandled triage decision: ${String(triageResult.decision)}. Conservative refusal.`,
        nextAction: 'investigate_unknown_triage_decision',
        sourceKind: triageResult.sourceKind,
        triageDecision: triageResult.decision,
        shouldCreateDiagnosticTask: false,
        decidedAt,
      };
    }
  }
}

// ── Main Evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluate trigger controller for incoming pain evidence.
 *
 * This is the ONLY function that decides whether a diagnostic task is created.
 * The production path (hooks, CLI, manual) must call this before creating tasks.
 *
 * Decision precedence:
 * 1. Invalid input → refused
 * 2. Owner manual → manual_owner_admitted (always creates task)
 * 3. Triage decision → evidence_only / diagnosis_created / health_only / etc.
 * 4. Cooldown check → cooldown_skipped (within 'admit' branch)
 *
 * @param input - Trigger controller input with triage result and context
 * @returns Structured trigger decision
 */
export function evaluateTriggerController(input: TriggerControllerInput): TriggerDecision {
  // 1. Invalid input → refused (ERR-009)
  if (!input.isValid) {
    return decideRefused(input);
  }

  // 2. Owner manual → always creates diagnostic task
  if (input.isOwnerManual) {
    return decideManualOwnerAdmitted(input);
  }

  // 3. Triage-based decision
  return decideFromTriage(input);
}

// ── Decision Classification ─────────────────────────────────────────────────

/**
 * Check if a trigger outcome should result in a diagnostic task being created.
 *
 * Convenience function for callers that just need the boolean.
 */
export function shouldCreateTask(decision: TriggerDecision): boolean {
  return decision.shouldCreateDiagnosticTask;
}

/**
 * Check if a trigger outcome represents an "admitted" state
 * (i.e., the signal was accepted into the pipeline, even if it didn't create a task).
 */
export function isAdmittedOutcome(outcome: TriggerOutcome): boolean {
  return outcome === 'diagnosis_created' || outcome === 'manual_owner_admitted';
}

/**
 * Check if a trigger outcome represents a "skipped" state
 * (i.e., the signal was valid but something prevented task creation).
 */
export function isSkippedOutcome(outcome: TriggerOutcome): boolean {
  return outcome === 'diagnosis_skipped' || outcome === 'cooldown_skipped';
}
