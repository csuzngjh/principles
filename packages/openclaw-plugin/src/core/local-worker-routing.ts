/**
 * Local Worker Routing Policy — Task Classification and Routing Decisions
 * ======================================================================
 *
 * PURPOSE: Provide an explainable, testable policy that decides whether a given
 * task can be delegated to a local-worker profile (local-reader or local-editor)
 * or must stay on the main agent.
 *
 * ARCHITECTURE:
 *   - This module is POLICY ONLY — it makes routing decisions but does NOT execute them
 *   - The main agent (or a delegation hook in a future phase) is responsible for
 *     actually routing the task based on the RoutingDecision returned here
 *   - All decisions are deterministic and based on structured input fields
 *   - No model inference, no learning, no dynamic adaptation
 *
 * TASK CLASSIFICATION TAXONOMY:
 *   reader_eligible      — clearly suitable for local-reader
 *   editor_eligible     — clearly suitable for local-editor
 *   high_entropy_disallowed — high-complexity tasks that must stay on main agent
 *   ambiguous_scope     — tasks that are unclear and need main-agent judgment
 *   deployment_unavailable — no enabled deployment exists for the target profile
 *
 * NOTE: risk_disallowed has been removed. Risk signals are now advisory only —
 * the main agent decides whether to delegate based on full context.
 *
 * FAIL-CLOSED PRINCIPLE:
 *   - When in doubt → stay_main
 *   - Unclear intent → stay_main
 *   - High complexity → stay_main
 *   - No enabled deployment → stay_main
 *
 * DESIGN CONSTRAINTS:
 *   - No actual task execution
 *   - No automatic learning or route optimization
 *   - No Trinity or adaptive threshold logic
 *   - Routing decisions are fully explainable (return `reason` + `blockers[]`)
 */

import type { WorkerProfile } from './model-deployment-registry.js';
import {
  isRoutingEnabledForProfile,
  getDeployment,
} from './model-deployment-registry.js';
import { isCheckpointDeployable } from './model-training-registry.js';
import { getPromotionState } from './promotion-gate.js';

// ---------------------------------------------------------------------------
// Routing Input Contract
// ---------------------------------------------------------------------------

/**
 * The input contract for a routing decision.
 * All fields are optional — the classifier handles missing data gracefully
 * by treating it as ambiguous (stay_main).
 */
export interface RoutingInput {
  /**
   * A short label or name for the task intent.
   * E.g., "read_file", "edit_config", "debug_memory_leak", "design_system"
   */
  taskIntent?: string;

  /**
   * Natural-language description of the task.
   * The classifier examines this for keywords indicating complexity/risk.
   */
  taskDescription?: string;

  /**
   * Specific tools requested or implied by the task.
   * These are examined for risk signals (e.g., bash, rm, git push).
   */
  requestedTools?: string[];

  /**
   * Specific files involved or targeted.
   * Examined for risk-path indicators (e.g., .git/, node_modules, production configs).
   */
  requestedFiles?: string[];

  /**
   * Shape of expected output.
   * E.g., "json", "markdown", "one_line", "full_report"
   */
  expectedOutputShape?: string;

  /**
   * Complexity hints for the task.
   * E.g., ["multi_step", "cross_file", "ambiguous", "requires_planning"]
   */
  complexityHints?: string[];

  /**
   * Target worker profile for routing consideration.
   * If omitted, both profiles are evaluated and the best match is returned.
   */
  targetProfile?: WorkerProfile;
}

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
// Keyword Classifiers
// ---------------------------------------------------------------------------

/**
 * Keywords that indicate a task is suitable for `local-reader`.
 * Matched against taskIntent + taskDescription.
 */
const READER_KEYWORDS = [
  'read', 'view', 'show', 'get', 'find', 'search', 'grep', 'look',
  'inspect', 'examine', 'list', 'cat', 'head', 'tail', 'diff',
  'summary', 'summarize', 'extract', 'parse', 'review',
  'check', 'verify', 'status', 'describe', 'explain_what',
  'browse', 'fetch', 'show_content', 'file_content', 'code_read',
];

/**
 * Keywords that indicate a task is suitable for `local-editor`.
 * Matched against taskIntent + taskDescription.
 */
const EDITOR_KEYWORDS = [
  'edit', 'update', 'modify', 'change', 'fix', 'patch', 'replace',
  'add', 'remove', 'delete', 'insert', 'rewrite', 'refactor',
  'apply', 'execute', 'run', 'transform', 'convert', 'migrate',
  'write', 'create_file', 'append', 'touch', 'rename',
];

/**
 * Keywords that indicate HIGH ENTROPY — tasks that must stay on main agent.
 * These indicate open-ended, multi-step, or ambiguous tasks.
 */
const HIGH_ENTROPY_KEYWORDS = [
  'design', 'architect', 'plan', 'strategy', 'roadmap', 'propose',
  'research', 'investigate', 'explore', 'evaluate', 'compare',
  'decide', 'choose', 'recommend', 'suggest', 'analyze_tradeoffs',
  'unclear', 'vague', 'ambiguous', 'open_ended', 'multiple_options',
  'architecture', 'system_design', 'high_level', 'blueprint',
  'thinking', 'reasoning', '思考', '分析', '设计',
];

// ---------------------------------------------------------------------------
// Classification Helpers
// ---------------------------------------------------------------------------

/**
 * Simple case-insensitive keyword match.
 */
function containsKeyword(text: string | undefined, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Compute a combined text from all input fields for keyword scanning.
 */
function computeCombinedText(input: RoutingInput): string {
  const parts: string[] = [];
  if (input.taskIntent) parts.push(input.taskIntent);
  if (input.taskDescription) parts.push(input.taskDescription);
  if (input.expectedOutputShape) parts.push(input.expectedOutputShape);
  if (input.complexityHints) parts.push(input.complexityHints.join(' '));
  return parts.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Core Classification Logic
// ---------------------------------------------------------------------------

/**
 * Classify the task based on its input fields.
 * Returns a raw classification category (before deployment check).
 */
function classifyTaskKind(input: RoutingInput): RoutingDecision['classification'] {
  const text = computeCombinedText(input);
  const { taskIntent, taskDescription, requestedFiles, complexityHints } = input;

  // --- Step 1: High-entropy keyword detection ---
  if (complexityHints?.some((h) =>
    ['multi_step', 'cross_file', 'ambiguous', 'requires_planning', 'open_ended', 'unclear'].includes(h)
  )) {
    return 'high_entropy_disallowed';
  }

  if (containsKeyword(text, HIGH_ENTROPY_KEYWORDS)) {
    return 'high_entropy_disallowed';
  }

  if (containsKeyword(taskIntent, ['design', 'architect', 'plan', 'propose']) ||
      containsKeyword(taskDescription, ['design', 'architect', 'plan', 'propose'])) {
    return 'high_entropy_disallowed';
  }

  // --- Step 2: Reader eligibility ---
  const intentIsReader = containsKeyword(taskIntent, READER_KEYWORDS);
  const descIsReader = containsKeyword(taskDescription, READER_KEYWORDS);

  if (intentIsReader && (descIsReader || !taskDescription)) {
    return 'reader_eligible';
  }

  // --- Step 3: Editor eligibility ---
  const uniqueFiles = requestedFiles
    ? [...new Set(requestedFiles.filter((f) => f.trim().length > 0))]
    : [];
  const intentIsEditor = containsKeyword(taskIntent, EDITOR_KEYWORDS);
  const descIsEditor = containsKeyword(taskDescription, EDITOR_KEYWORDS);

  if (intentIsEditor && (descIsEditor || !taskDescription)) {
    if (uniqueFiles.length >= 4) {
      return 'high_entropy_disallowed';
    }
    return 'editor_eligible';
  }

  // --- Step 4: Ambiguous scope ---
  if (taskDescription && taskDescription.trim().length > 0) {
    const trimmed = taskDescription.trim();
    if (trimmed.length < 20 || ['todo', 'fix', 'improve', 'change', 'update', 'something'].includes(trimmed.toLowerCase())) {
      return 'ambiguous_scope';
    }
    if (/\b(why|how|should|could|would|what if|should we|whether to)\b/i.test(trimmed)) {
      return 'ambiguous_scope';
    }
  }

  if (!taskIntent && !taskDescription) {
    return 'ambiguous_scope';
  }

  return 'ambiguous_scope';
}

/**
 * Build the reason string for a given classification.
 */
function buildReason(
  classification: RoutingDecision['classification'],
  input: RoutingInput
): string {
  const { taskIntent, taskDescription } = input;

  switch (classification) {
    case 'reader_eligible':
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is classified as reader_eligible. ` +
        `Keywords indicate focused reading, inspection, or information retrieval. ` +
        `No high-entropy or risk signals detected.`;

    case 'editor_eligible':
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is classified as editor_eligible. ` +
        `Keywords indicate bounded editing, modification, or repair. ` +
        `No high-entropy or risk signals detected.`;

    case 'high_entropy_disallowed': {
      const uniqueFiles = input.requestedFiles
        ? [...new Set(input.requestedFiles.filter((f) => f.trim().length > 0))]
        : [];
      const isLargeScaleEdit = uniqueFiles.length >= 4;
      if (isLargeScaleEdit) {
        return `Task "${taskIntent || taskDescription || '(unnamed)'}" is blocked as high_entropy_disallowed. ` +
          `Editing ${uniqueFiles.length} files simultaneously exceeds the bounded-scope limit for local-editor. ` +
          `Large-scale multi-file edits require the main agent's coordination and risk judgment.`;
      }
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is blocked as high_entropy_disallowed. ` +
        `Keywords indicate open-ended planning, architecture design, or ambiguous multi-step work. ` +
        `These tasks require the main agent's full reasoning capability.`;
    }

    case 'ambiguous_scope':
      return `Task "${taskIntent || taskDescription || '(unnamed)'}" is blocked as ambiguous_scope. ` +
        `The task description is too vague, too short, or contains open-ended question words. ` +
        `Main agent must clarify scope before delegation.`;

    case 'profile_mismatch':
      return `Task profile does not match the requested target profile. ` +
        `The task's natural classification is incompatible with the specified worker profile. ` +
        `Main agent must re-route or choose a compatible profile.`;

    case 'deployment_unavailable':
      return `No enabled deployment available for routing. ` +
        `Either no checkpoint is bound to the profile, or routing has been disabled. ` +
        `Main agent must handle this task.`;
  }
}

/**
 * Build the blockers list for a given classification.
 */
function buildBlockers(
  classification: RoutingDecision['classification'],
  input: RoutingInput
): string[] {
  switch (classification) {
    case 'reader_eligible':
      return [];
    case 'editor_eligible':
      return [];
    case 'high_entropy_disallowed': {
      const uniqueFiles = input.requestedFiles
        ? [...new Set(input.requestedFiles.filter((f) => f.trim().length > 0))]
        : [];
      const isLargeScaleEdit = uniqueFiles.length >= 4;
      return [
        isLargeScaleEdit
          ? `large-scale multi-file edit detected (${uniqueFiles.length} files): scope too broad for local-editor`
          : 'task contains high-entropy keywords (design/plan/architect/investigate)',
        'complexity hint indicates multi-step or open-ended work',
        'main agent required for full reasoning and judgment',
      ];
    }
    case 'ambiguous_scope':
      return [
        'task description too vague or generic',
        'task intent not provided or unclear',
        'open-ended question words detected',
        'main agent must clarify scope before delegation',
      ];
    case 'profile_mismatch':
      return [
        'task natural profile incompatible with requested target profile',
        'main agent must re-route or select a compatible profile',
      ];

    case 'deployment_unavailable':
      return [
        'no enabled deployment found for target profile',
        'routing may be disabled in deployment registry',
        'main agent must handle task directly',
      ];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a task and produce a routing decision.
 *
 * This is the main entry point for routing policy evaluation.
 * It:
 *   1. Classifies the task kind based on keywords and heuristics
 *   2. Checks deployment availability for the target profile
 *   3. Returns a fully explainable RoutingDecision
 *
 * @param input - The routing input describing the task
 * @param stateDir - Workspace state directory (for deployment registry lookup)
 * @returns RoutingDecision with classification, reason, blockers, and routing verdict
 */
export function classifyTask(
  input: RoutingInput,
  stateDir: string
): RoutingDecision {
  // --- Determine the raw task classification ---
  const classification = classifyTaskKind(input);

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

  // --- Build the decision ---
  const blockers = buildBlockers(classification, input);
  const reason = buildReason(classification, input);

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
  input: RoutingInput,
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
