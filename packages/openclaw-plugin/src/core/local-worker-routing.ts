/**
 * Local Worker Routing Policy — Task Classification and Routing Decisions
 * ======================================================================
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 3
 *
 * This file is now a THIN ADAPTER.
 * Pure classification logic lives in @principles/core/prompt-builder/routing-guidance.ts.
 * This file handles I/O (deployment registry, promotion state) and combines
 * pure classification with deployment checks.
 *
 * ARCHITECTURE:
 *   - Pure: classifyTaskKind, buildReason, buildBlockers, keyword constants → core
 *   - I/O: getDeployment, isRoutingEnabledForProfile, isCheckpointDeployable, getPromotionState → plugin
 *
 * TASK CLASSIFICATION TAXONOMY:
 *   reader_eligible      — clearly suitable for local-reader
 *   editor_eligible     — clearly suitable for local-editor
 *   high_entropy_disallowed — high-complexity tasks that must stay on main agent
 *   ambiguous_scope     — tasks that are unclear and need main-agent judgment
 *   deployment_unavailable — no enabled deployment exists for the target profile
 *
 * FAIL-CLOSED PRINCIPLE:
 *   - When in doubt → stay_main
 *   - Unclear intent → stay_main
 *   - High complexity → stay_main
 *   - No enabled deployment → stay_main
 */

import type { WorkerProfile } from './model-deployment-registry.js';
import {
  isRoutingEnabledForProfile,
  getDeployment,
} from './model-deployment-registry.js';
import { isCheckpointDeployable } from './model-training-registry.js';
import { getPromotionState } from './promotion-gate.js';

// Core pure functions — migrated to @principles/core/prompt-builder
import {
  type RoutingInput as CoreRoutingInput,
  classifyTaskKind as coreClassifyTaskKind,
  buildReason as coreBuildReason,
  buildBlockers as coreBuildBlockers,
} from '@principles/core/prompt-builder';

// Re-export RoutingInput from core for backward compatibility with existing imports
export type { RoutingInput } from '@principles/core/prompt-builder';

// ---------------------------------------------------------------------------
// Routing Decision Contract
// ---------------------------------------------------------------------------

/**
 * The result of a routing classification decision.
 * Always includes a `reason` and a `blockers` list for full explainability.
 */
export interface RoutingDecision {
  /**
   * The routing verdict.
   * - `route_local` — the task may be delegated to `targetProfile`
   * - `stay_main` — the task must remain on the main agent
   */
  decision: 'route_local' | 'stay_main';

  /**
   * Which profile the task should be routed to (if decision === 'route_local').
   * Null if decision === 'stay_main'.
   */
  targetProfile: WorkerProfile | null;

  /**
   * The task classification category that led to this decision.
   */
  classification:
    | 'reader_eligible'
    | 'editor_eligible'
    | 'high_entropy_disallowed'
    | 'ambiguous_scope'
    | 'profile_mismatch'
    | 'deployment_unavailable';

  /**
   * Human-readable explanation of the routing decision.
   * Must be specific enough that a developer can understand why a task was accepted/rejected.
   */
  reason: string;

  /**
   * List of specific reasons that blocked routing (if decision === 'stay_main').
   * Empty if decision === 'route_local'.
   */
  blockers: string[];

  /**
   * Whether a deployment check was performed and whether it passed.
   * Useful for diagnostics when deployment_unavailable is the classification.
   */
  deploymentCheck: {
    performed: boolean;
    profileAvailable: boolean;
    routingEnabled: boolean;
    /** Whether the active checkpoint is currently marked as deployable in the training registry. */
    checkpointDeployable: boolean;
  };

  /**
   * The active checkpoint ID that would be used for routing (if decision === 'route_local').
   * This is the checkpoint from the deployment registry.
   * Null if decision === 'stay_main' or if no checkpoint is active.
   *
   * USE FOR SHADOW OBSERVATIONS:
   * When routing in shadow mode (checkpoint is in shadow_ready state),
   * the caller should record a shadow observation using this checkpoint ID.
   */
  activeCheckpointId: string | null;

  /**
   * The promotion state of the active checkpoint.
   * Indicates whether this is a regular deployment or a shadow rollout.
   * Useful for determining whether to record shadow observations.
   */
  activeCheckpointState?: 'promotable' | 'shadow_ready' | 'candidate_only';

  /**
   * Deprecated: runtime shadow observations are now recorded from real
   * subagent lifecycle hooks instead of from classifyTask().
   */
  shadowObservationId?: string;

}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a task and produce a routing decision.
 *
 * This is the main entry point for routing policy evaluation.
 * It:
 *   1. Classifies the task kind based on keywords and heuristics (core pure function)
 *   2. Checks deployment availability for the target profile (plugin I/O)
 *   3. Returns a fully explainable RoutingDecision
 *
 * @param input - The routing input describing the task
 * @param stateDir - Workspace state directory (for deployment registry lookup)
 * @returns RoutingDecision with classification, reason, blockers, and routing verdict
 */
export function classifyTask(
  input: CoreRoutingInput,
  stateDir: string
): RoutingDecision {
  // --- Determine the raw task classification (delegated to core pure function) ---
  const classification = coreClassifyTaskKind(input);

  // --- Determine the target profile ---
  // If input specifies a target, use it. Otherwise, pick based on classification.
  // NOTE: When explicitly specified, we must validate profile-task compatibility below.
  const targetProfile: WorkerProfile | null =
    input.targetProfile ??
    (classification === 'reader_eligible'
      ? 'local-reader'
      : classification === 'editor_eligible'
      ? 'local-editor'
      : null);

  // --- Profile-task compatibility check ---
  // Only applies when input.targetProfile is EXPLICITLY set.
  // When auto-derived (input.targetProfile is null), compatibility is already
  // guaranteed by the auto-derivation logic above (reader_eligible → local-reader).
  // This check prevents routing a reader task to an editor profile (or vice versa)
  // when the caller explicitly requests the wrong profile.
  const isProfileCompatible =
    input.targetProfile === undefined
      ? true // Auto-derived profile is always compatible by construction
      : targetProfile === 'local-reader'
        ? classification === 'reader_eligible'
        : targetProfile === 'local-editor'
          ? classification === 'editor_eligible'
          : false;

  // --- Deployment availability check ---
  let deploymentCheck: RoutingDecision['deploymentCheck'] = {
    performed: false,
    profileAvailable: false,
    routingEnabled: false,
    checkpointDeployable: false,
  };

  if (targetProfile) {
    const deployment = getDeployment(stateDir, targetProfile);
    const activeCheckpointId = deployment?.activeCheckpointId ?? null;
    // Re-check deployability on every routing decision — a checkpoint may have been revoked
    const checkpointDeployable = activeCheckpointId
      ? isCheckpointDeployable(stateDir, activeCheckpointId)
      : false;
    deploymentCheck = {
      performed: true,
      profileAvailable: deployment !== null,
      routingEnabled: isRoutingEnabledForProfile(stateDir, targetProfile),
      checkpointDeployable,
    };
  }

  // --- Build the decision (delegated to core pure functions) ---
  const blockers = coreBuildBlockers(classification, input);
  const reason = coreBuildReason(classification, input);

  // FAIL-CLOSED: route_local only if:
  //   1. Classification is eligible (reader_eligible or editor_eligible)
  //   2. A target profile was identified
  //   3. The task's natural profile is compatible with the target profile
  //   4. Deployment is available and routing is enabled
  const isEligibleForRouting =
    (classification === 'reader_eligible' || classification === 'editor_eligible') &&
    targetProfile !== null &&
    isProfileCompatible &&
    deploymentCheck.routingEnabled;

  const decision: RoutingDecision['decision'] = isEligibleForRouting
    ? 'route_local'
    : 'stay_main';

  // Derive the final classification — preserves the root cause of stay_main:
  //   - profile_mismatch: task would be eligible but wrong profile requested
  //   - deployment_unavailable: eligible and compatible but no routing enabled
  //   - raw classification: blocked by high_entropy / risk / ambiguous
  const isEligible = classification === 'reader_eligible' || classification === 'editor_eligible';
  const finalClassification: RoutingDecision['classification'] =
    isEligibleForRouting
      ? classification
      : isEligible && targetProfile !== null && !isProfileCompatible
      ? 'profile_mismatch'
      : isEligible
      ? 'deployment_unavailable'
      : classification;

  // Build explainability fields specific to the stay_main reason
  let finalReason = reason;
  let finalBlockers = blockers;

  if (decision === 'stay_main') {
    if (finalClassification === 'profile_mismatch') {
      const wanted = classification === 'reader_eligible' ? 'local-reader' : 'local-editor';
      finalReason = `Task is ${classification} but was explicitly targeted at ${targetProfile}. ` +
        `Routing requires "${wanted}" profile. Ensure the task intent matches the requested profile.`;
      finalBlockers = [
        `profile mismatch: task is ${classification} but targetProfile is ${targetProfile}`,
        `required profile: ${wanted}`,
      ];
    } else if (finalClassification === 'deployment_unavailable') {
      if (!deploymentCheck.performed) {
        finalReason = reason;
      } else if (!deploymentCheck.profileAvailable) {
        finalReason = `Task is ${classification} but no deployment exists for ${targetProfile}. ` +
          `Bind a checkpoint via bindCheckpointToWorkerProfile() and enable routing.`;
        finalBlockers = [`no deployment found for profile: ${targetProfile}`];
      } else if (!deploymentCheck.checkpointDeployable) {
        finalReason = `Task is ${classification} but the active checkpoint has been revoked (no longer deployable). ` +
          `Re-bind a passing checkpoint or re-evaluate the current one.`;
        finalBlockers = [
          `active checkpoint is no longer deployable: ${targetProfile}`,
          'revoked checkpoints must not be used for routing',
        ];
      } else if (!deploymentCheck.routingEnabled) {
        finalReason = `Task is ${classification} and deployment exists for ${targetProfile} but routing is not enabled. ` +
          `Enable routing via enableRoutingForProfile() in the deployment registry.`;
        finalBlockers = [`routing is disabled for profile: ${targetProfile}`];
      }
    }
  }

  // --- Get active checkpoint ID and state for shadow observation integration ---
  let activeCheckpointId: string | null = null;
  let activeCheckpointState: 'promotable' | 'shadow_ready' | 'candidate_only' | null = null;

  if (targetProfile && deploymentCheck.performed) {
    const deployment = getDeployment(stateDir, targetProfile);
    activeCheckpointId = deployment?.activeCheckpointId ?? null;
    if (activeCheckpointId) {
      const promotionState = getPromotionState(stateDir, activeCheckpointId);
      if (promotionState === 'shadow_ready' || promotionState === 'promotable' || promotionState === 'candidate_only') {
        activeCheckpointState = promotionState;
      }
    }
  }

  return {
    decision,
    targetProfile: decision === 'route_local' ? targetProfile : null,
    classification: finalClassification,
    reason: finalReason,
    blockers: decision === 'stay_main' ? finalBlockers : [],
    deploymentCheck,
    activeCheckpointId,
    activeCheckpointState: activeCheckpointState ?? undefined,
    shadowObservationId: undefined,
  };
}

/**
 * Convenience: check if a specific profile can handle a task.
 * Equivalent to calling classifyTask with targetProfile set.
 */
export function canRouteToProfile(
  input: CoreRoutingInput,
  stateDir: string,
  profile: WorkerProfile
): boolean {
  const decision = classifyTask({ ...input, targetProfile: profile }, stateDir);
  return decision.decision === 'route_local';
}

// ---------------------------------------------------------------------------
// Read-Only Query Helpers
// ---------------------------------------------------------------------------

/**
 * Check if any local worker routing is currently enabled for any profile.
 */
export function isAnyLocalRoutingEnabled(stateDir: string): boolean {
  return isRoutingEnabledForProfile(stateDir, 'local-reader') ||
    isRoutingEnabledForProfile(stateDir, 'local-editor');
}

/**
 * List all profiles that currently have routing enabled.
 */
export function listEnabledProfiles(stateDir: string): WorkerProfile[] {
  const enabled: WorkerProfile[] = [];
  if (isRoutingEnabledForProfile(stateDir, 'local-reader')) enabled.push('local-reader');
  if (isRoutingEnabledForProfile(stateDir, 'local-editor')) enabled.push('local-editor');
  return enabled;
}
