/**
 * Model Deployment Registry — Worker Profile → Checkpoint Binding & Routing Control
 * ===============================================================================
 *
 * PURPOSE: Establish auditable, reversible bindings between worker profiles and
 * trained model checkpoints so that routing decisions are code-governed and
 * rollback-safe.
 *
 * ARCHITECTURE:
 *   - Registry file: {stateDir}/.state/nocturnal/deployment-registry.json
 *   - File locking on all write operations
 *   - Immutable deployment records — rollback uses previousCheckpointId
 *   - Tight integration with model-training-registry for checkpoint validation
 *
 * PROFILE CONSTRAINTS (Phase 5 only):
 *   - local-reader  → must bind a checkpoint whose targetModelFamily is a "reader" family
 *   - local-editor  → must bind a checkpoint whose targetModelFamily is an "editor" family
 *   - No other profiles are accepted
 *
 * BINDING RULES:
 *   - Only a deployable checkpoint can be bound
 *   - The checkpoint's targetModelFamily must satisfy the profile's family constraint
 *   - binding sets routingEnabled = false; enableRoutingForProfile() must be called explicitly
 *   - rollbackDeployment() returns to previousCheckpointId (if any)
 *
 * DESIGN CONSTRAINTS:
 *   - No actual task routing execution (Phase 5 only)
 *   - No automatic promotion or failover
 *   - Registry is append-only for deployments; rollback creates a new binding
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { withLock } from '../utils/file-lock.js';
import type { Checkpoint } from './model-training-registry.js';
import {
  getCheckpoint,
  isCheckpointDeployable,
} from './model-training-registry.js';
import { getPromotionState } from './promotion-gate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_FILE = '.state/nocturnal/deployment-registry.json';

/**
 * Worker profiles supported in Phase 5.
 * Only these two profiles may be registered.
 */
export type WorkerProfile = 'local-reader' | 'local-editor';

/**
 * The set of valid Phase 5 worker profile names.
 */
export const SUPPORTED_PROFILES: readonly WorkerProfile[] = ['local-reader', 'local-editor'];

// ---------------------------------------------------------------------------
// Profile–Family Constraint System
// ---------------------------------------------------------------------------

/**
 * Known model family name prefixes/suffixes recognized as "reader" families.
 * Any targetModelFamily string containing one of these tokens is considered a reader family.
 *
 * This is a first-iteration heuristic. Real systems may use explicit tag registries.
 */
const READER_FAMILY_KEYWORDS = ['reader', 'read', 'claude-haiku', 'qwen-lite', 'phi-mini'];

/**
 * Known model family name prefixes/suffixes recognized as "editor" families.
 * Any targetModelFamily string containing one of these tokens is considered an editor family.
 */
const EDITOR_FAMILY_KEYWORDS = ['editor', 'edit', 'code', 'claude-sonnet', 'gpt-4o-mini'];

/**
 * Determine whether a target model family name qualifies as a "reader" family.
 * Returns true if any known reader keyword appears in the family name (case-insensitive).
 */
function isReaderFamily(targetModelFamily: string): boolean {
  const lower = targetModelFamily.toLowerCase();
  return READER_FAMILY_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Determine whether a target model family name qualifies as an "editor" family.
 * Returns true if any known editor keyword appears in the family name (case-insensitive).
 */
function isEditorFamily(targetModelFamily: string): boolean {
  const lower = targetModelFamily.toLowerCase();
  return EDITOR_FAMILY_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Validate that a given targetModelFamily satisfies a worker's family constraint.
 *
 * @param profile - The worker profile requesting the binding
 * @param targetModelFamily - The checkpoint's target model family
 * @throws Error if the family is incompatible with the profile
 */
function validateProfileFamilyConstraint(profile: WorkerProfile, targetModelFamily: string): void {
  if (profile === 'local-reader') {
    if (!isReaderFamily(targetModelFamily)) {
      throw new Error(
        `Family constraint violated: profile "${profile}" requires a reader-family checkpoint ` +
          `but checkpoint targets "${targetModelFamily}". ` +
          `Reader families must contain one of: ${READER_FAMILY_KEYWORDS.join(', ')}. ` +
          `If you are deploying a new model family, update the READER_FAMILY_KEYWORDS or ` +
          `EDITOR_FAMILY_KEYWORDS constants in model-deployment-registry.ts.`
      );
    }
  } else if (profile === 'local-editor') {
    if (!isEditorFamily(targetModelFamily)) {
      throw new Error(
        `Family constraint violated: profile "${profile}" requires an editor-family checkpoint ` +
          `but checkpoint targets "${targetModelFamily}". ` +
          `Editor families must contain one of: ${EDITOR_FAMILY_KEYWORDS.join(', ')}. ` +
          `If you are deploying a new model family, update the EDITOR_FAMILY_KEYWORDS constant ` +
          `in model-deployment-registry.ts.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A deployment record — binds a worker profile to a specific checkpoint
 * and controls whether routing is enabled for that profile.
 */
export interface Deployment {
  /** Unique identifier for this deployment record */
  deploymentId: string;

  /** Worker profile this deployment targets (local-reader | local-editor) */
  workerProfile: WorkerProfile;

  /**
   * The model family this deployment targets.
   * Derived from the bound checkpoint at bind time; stored for quick queries.
   */
  targetModelFamily: string;

  /**
   * The currently active checkpoint for this profile.
   * null means the profile is bound but no checkpoint is active (e.g., after rollback).
   */
  activeCheckpointId: string | null;

  /**
   * The previously active checkpoint (before the current activeCheckpointId).
   * Used for rollback. null if no previous checkpoint exists.
   */
  previousCheckpointId: string | null;

  /**
   * Whether routing to this worker profile is currently permitted.
   * Must be explicitly enabled via enableRoutingForProfile().
   * Cannot be true if activeCheckpointId is null.
   */
  routingEnabled: boolean;

  /** ISO-8601 timestamp — when this binding was first created */
  deployedAt: string;

  /** ISO-8601 timestamp — when this binding was last updated (checkpoint change or flag toggle) */
  updatedAt: string;

  /**
   * Optional human-readable note about this deployment.
   * E.g., "initial deployment", "rollback from eval failure", "promoted after 30-day holdout".
   */
  note?: string;
}

/**
 * The complete deployment registry — all deployment records in one store.
 */
export interface ModelDeploymentRegistry {
  deployments: Deployment[];
}

// ---------------------------------------------------------------------------
// Registry Path
// ---------------------------------------------------------------------------

function getRegistryPath(stateDir: string): string {
  return path.join(stateDir, REGISTRY_FILE);
}

/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir(stateDir: string): void {
  const registryPath = getRegistryPath(stateDir);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

/**
 * Read the registry from disk. Returns empty registry if missing.
 * Throws if the file exists but contains invalid JSON — fail-closed
 * to prevent silent data loss when a corrupt registry would otherwise
 * be overwritten on the next write.
 */
function readRegistry(stateDir: string): ModelDeploymentRegistry {
  const registryPath = getRegistryPath(stateDir);
  if (!fs.existsSync(registryPath)) {
    return { deployments: [] };
  }
  try {
    const content = fs.readFileSync(registryPath, 'utf-8');
    const registry = JSON.parse(content) as ModelDeploymentRegistry;
    // Validate required structure — fail closed on malformed registry
    if (!Array.isArray(registry.deployments)) {
      throw new Error(`Corrupt deployment registry at "${registryPath}": missing or invalid "deployments" field`);
    }
    return registry;
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof Error) {
      throw new Error(`Failed to read deployment registry from "${registryPath}": ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Write the registry to disk atomically.
 * Caller must hold the registry lock.
 */
function writeRegistry(stateDir: string, registry: ModelDeploymentRegistry): void {
  ensureRegistryDir(stateDir);
  const registryPath = getRegistryPath(stateDir);
  const tmpPath = `${registryPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
  fs.renameSync(tmpPath, registryPath);
}

/**
 * Execute a read-modify-write under an exclusive file lock.
 */
/* eslint-disable no-unused-vars -- Reason: _registry is a type signature parameter */
function withDeploymentRegistryLock<T>(
  stateDir: string,
  fn: (_registry: ModelDeploymentRegistry) => T
): T {
  const registryPath = getRegistryPath(stateDir);
  return withLock(registryPath, () => {
    const registry = readRegistry(stateDir);
    return fn(registry);
  });
}

// ---------------------------------------------------------------------------
// Profile Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a worker profile name is supported in Phase 5.
 *
 * @throws Error if the profile is not in SUPPORTED_PROFILES
 */
export function assertSupportedProfile(profile: string): asserts profile is WorkerProfile {
  if (!SUPPORTED_PROFILES.includes(profile as WorkerProfile)) {
    throw new Error(
      `Unsupported worker profile: "${profile}". ` +
        `Phase 5 only supports: ${SUPPORTED_PROFILES.join(', ')}. ` +
        `Do not add new profiles in Phase 5.`
    );
  }
}

// ---------------------------------------------------------------------------
// Promotion Gate Integration (Phase 7)
// ---------------------------------------------------------------------------

/**
 * Check if a checkpoint has passed the promotion gate and can be deployed.
 *
 * This function checks:
 * 1. The checkpoint has an eval summary attached (lineage complete)
 * 2. The promotion state is 'shadow_ready' or 'promotable' (gate passed)
 *
 * @param stateDir - Workspace state directory
 * @param checkpointId - Checkpoint to verify
 * @returns true if the checkpoint can be deployed, false otherwise
 */
export function hasPassedPromotionGate(stateDir: string, checkpointId: string): boolean {
  const checkpoint = getCheckpoint(stateDir, checkpointId);
  if (!checkpoint) return false;

  // Must have eval summary attached
  if (!checkpoint.lastEvalSummaryRef) return false;

  // Check promotion state
  const state = getPromotionState(stateDir, checkpointId);
  return state === 'shadow_ready' || state === 'promotable';
}

/**
 * Assert that a checkpoint has passed the promotion gate.
 * Throws if the checkpoint cannot be deployed.
 *
 * @param stateDir - Workspace state directory
 * @param checkpointId - Checkpoint to verify
 * @throws Error if the checkpoint has not passed the promotion gate
 */
export function assertPromotionGatePassed(stateDir: string, checkpointId: string): void {
  if (!hasPassedPromotionGate(stateDir, checkpointId)) {
    throw new Error(
      `Checkpoint "${checkpointId}" has not passed the promotion gate. ` +
        `A checkpoint must pass the promotion gate (state: shadow_ready or promotable) ` +
        `before it can be bound to a worker profile. ` +
        `Ensure the promotion gate has been evaluated and approved.`
    );
  }
}

// ---------------------------------------------------------------------------
// Core Operations
// ---------------------------------------------------------------------------

/**
 * Bind a checkpoint to a worker profile, creating or updating the deployment record.
 *
 * BINDING RULE (fail-closed):
 *   Only a checkpoint that is marked deployable in the training registry may be bound.
 *
 * PROFILE-FAMILY CONSTRAINT:
 *   The checkpoint's targetModelFamily must satisfy the profile's family keyword constraint.
 *   See: validateProfileFamilyConstraint()
 *
 * @param stateDir - Workspace state directory
 * @param workerProfile - Target worker profile (local-reader | local-editor)
 * @param checkpointId - Checkpoint to bind (must be deployable)
 * @param note - Optional human-readable note
 * @returns The new or updated Deployment record
 *
 * @throws Error if checkpoint is not found or not deployable
 * @throws Error if checkpoint's targetModelFamily violates profile constraints
 */
// eslint-disable-next-line @typescript-eslint/max-params -- Reason: checkpoint binding requires state + profile + checkpoint - refactoring would break API
export function bindCheckpointToWorkerProfile(
  stateDir: string,
  workerProfile: WorkerProfile,
  checkpointId: string,
  note?: string
): Deployment {
  assertSupportedProfile(workerProfile);

  return withDeploymentRegistryLock(stateDir, (registry) => {
    const now = new Date().toISOString();

    // --- Validate checkpoint exists and is deployable ---
    const checkpoint = getCheckpoint(stateDir, checkpointId);
    if (!checkpoint) {
      throw new Error(
        `bindCheckpointToWorkerProfile failed: checkpoint "${checkpointId}" not found ` +
          `in training registry. Ensure the checkpoint has been registered via ` +
          `registerCheckpoint() in model-training-registry.ts first.`
      );
    }

    if (!isCheckpointDeployable(stateDir, checkpointId)) {
      throw new Error(
        `bindCheckpointToWorkerProfile failed: checkpoint "${checkpointId}" is not deployable. ` +
          `Only checkpoints that have passed evaluation may be bound to a worker profile. ` +
          `Use markCheckpointDeployable() in model-training-registry.ts after a successful eval.`
      );
    }

    // --- Phase 7: Validate promotion gate has passed ---
    assertPromotionGatePassed(stateDir, checkpointId);

    // --- Validate profile-family constraint ---
    validateProfileFamilyConstraint(workerProfile, checkpoint.targetModelFamily);

    // --- Find existing deployment for this profile (if any) ---
    const existingIdx = registry.deployments.findIndex(
      (d) => d.workerProfile === workerProfile
    );

    const deploymentId = existingIdx >= 0
      ? registry.deployments[existingIdx].deploymentId
      : crypto.randomUUID();

    const previousCheckpointId = existingIdx >= 0
      ? registry.deployments[existingIdx].activeCheckpointId ?? null
      : null;

    const newDeployment: Deployment = {
      deploymentId,
      workerProfile,
      targetModelFamily: checkpoint.targetModelFamily,
      activeCheckpointId: checkpointId,
      // When re-binding (updating checkpoint), the old active becomes previous
      previousCheckpointId,
      // routingEnabled starts false — must be explicitly enabled
      routingEnabled: false,
      deployedAt: existingIdx >= 0
        ? registry.deployments[existingIdx].deployedAt
        : now,
      updatedAt: now,
      note: note ?? (existingIdx >= 0 ? registry.deployments[existingIdx].note : undefined),
    };

    if (existingIdx >= 0) {
      registry.deployments[existingIdx] = newDeployment;
    } else {
      registry.deployments.push(newDeployment);
    }

    writeRegistry(stateDir, registry);
    return newDeployment;
  });
}

/**
 * Retrieve the deployment record for a worker profile.
 *
 * @returns Deployment if found, null otherwise
 */
export function getDeployment(
  stateDir: string,
  workerProfile: WorkerProfile
): Deployment | null {
  assertSupportedProfile(workerProfile);
  const registry = readRegistry(stateDir);
  return registry.deployments.find((d) => d.workerProfile === workerProfile) ?? null;
}

/**
 * List all deployments, optionally filtered.
 *
 * @param stateDir - Workspace state directory
 * @param filter - Optional filter criteria
 */
export function listDeployments(
  stateDir: string,
  filter?: {
    workerProfile?: WorkerProfile;
    routingEnabled?: boolean;
  }
): Deployment[] {
  const registry = readRegistry(stateDir);
  let {deployments} = registry;

  if (filter?.workerProfile) {
    deployments = deployments.filter((d) => d.workerProfile === filter.workerProfile);
  }
  if (filter?.routingEnabled !== undefined) {
    deployments = deployments.filter((d) => d.routingEnabled === filter.routingEnabled);
  }

  return deployments.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

/**
 * Enable routing for a worker profile.
 *
 * PRECONDITIONS (fail-closed):
 *   1. A deployment record must exist for this profile
 *   2. activeCheckpointId must not be null
 *
 * @throws Error if no deployment exists
 * @throws Error if activeCheckpointId is null (nothing to route to)
 */
export function enableRoutingForProfile(
  stateDir: string,
  workerProfile: WorkerProfile
): Deployment {
  assertSupportedProfile(workerProfile);

  return withDeploymentRegistryLock(stateDir, (registry) => {
    const idx = registry.deployments.findIndex(
      (d) => d.workerProfile === workerProfile
    );

    if (idx === -1) {
      throw new Error(
        `enableRoutingForProfile failed: no deployment found for profile "${workerProfile}". ` +
          `Bind a checkpoint first using bindCheckpointToWorkerProfile().`
      );
    }

    const deployment = registry.deployments[idx];

    if (!deployment.activeCheckpointId) {
      throw new Error(
        `enableRoutingForProfile failed: deployment for "${workerProfile}" has no ` +
          `active checkpoint (activeCheckpointId is null). ` +
          `Bind a checkpoint before enabling routing.`
      );
    }

    // Double-check the active checkpoint is still deployable
    if (!isCheckpointDeployable(stateDir, deployment.activeCheckpointId)) {
      throw new Error(
        `enableRoutingForProfile failed: active checkpoint "${deployment.activeCheckpointId}" ` +
          `for profile "${workerProfile}" is no longer marked deployable. ` +
          `Revoke deployment or bind a new checkpoint before enabling routing.`
      );
    }

    registry.deployments[idx] = {
      ...deployment,
      routingEnabled: true,
      updatedAt: new Date().toISOString(),
    };

    writeRegistry(stateDir, registry);
    return registry.deployments[idx];
  });
}

/**
 * Disable routing for a worker profile.
 * This is always safe — it does not unbind the checkpoint.
 *
 * @throws Error if no deployment exists for the profile
 */
export function disableRoutingForProfile(
  stateDir: string,
  workerProfile: WorkerProfile
): Deployment {
  assertSupportedProfile(workerProfile);

  return withDeploymentRegistryLock(stateDir, (registry) => {
    const idx = registry.deployments.findIndex(
      (d) => d.workerProfile === workerProfile
    );

    if (idx === -1) {
      throw new Error(
        `disableRoutingForProfile failed: no deployment found for profile "${workerProfile}".`
      );
    }

    registry.deployments[idx] = {
      ...registry.deployments[idx],
      routingEnabled: false,
      updatedAt: new Date().toISOString(),
    };

    writeRegistry(stateDir, registry);
    return registry.deployments[idx];
  });
}

/**
 * Roll back the deployment for a worker profile to its previous checkpoint.
 *
 * ROLLBACK RULE:
 *   - Can only roll back if previousCheckpointId is not null
 *   - Sets activeCheckpointId = previousCheckpointId
 *   - The old activeCheckpointId becomes the new previousCheckpointId
 *   - routingEnabled is set to false (must be re-enabled explicitly)
 *
 * @throws Error if no deployment exists
 * @throws Error if no previous checkpoint is available
 */
export function rollbackDeployment(
  stateDir: string,
  workerProfile: WorkerProfile,
  note?: string
): Deployment {
  assertSupportedProfile(workerProfile);

  return withDeploymentRegistryLock(stateDir, (registry) => {
    const idx = registry.deployments.findIndex(
      (d) => d.workerProfile === workerProfile
    );

    if (idx === -1) {
      throw new Error(
        `rollbackDeployment failed: no deployment found for profile "${workerProfile}".`
      );
    }

    const deployment = registry.deployments[idx];

    if (!deployment.previousCheckpointId) {
      throw new Error(
        `rollbackDeployment failed: no previous checkpoint available for profile ` +
          `"${workerProfile}". The current deployment has no rollback target. ` +
          `(activeCheckpointId="${deployment.activeCheckpointId}", ` +
          `previousCheckpointId=null)`
      );
    }

    // Verify the rollback target checkpoint still exists and is deployable
    const rollbackTarget = getCheckpoint(stateDir, deployment.previousCheckpointId);
    if (!rollbackTarget) {
      throw new Error(
        `rollbackDeployment failed: previous checkpoint "${deployment.previousCheckpointId}" ` +
          `no longer exists in the training registry. Cannot roll back to a deleted checkpoint.`
      );
    }
    if (!isCheckpointDeployable(stateDir, deployment.previousCheckpointId)) {
      throw new Error(
        `rollbackDeployment failed: previous checkpoint "${deployment.previousCheckpointId}" ` +
          `is no longer deployable. Roll back to a passing checkpoint or re-bind a new one.`
      );
    }

    const now = new Date().toISOString();

    // Chain the rollback: the old active becomes the new previous
    const newPreviousCheckpointId = deployment.activeCheckpointId;

    const rolledBack: Deployment = {
      ...deployment,
      activeCheckpointId: deployment.previousCheckpointId,
      previousCheckpointId: newPreviousCheckpointId,
      routingEnabled: false, // Always disable routing after rollback — must re-enable
      updatedAt: now,
      note: note ?? `Rollback to ${deployment.previousCheckpointId}`,
    };

    registry.deployments[idx] = rolledBack;
    writeRegistry(stateDir, registry);
    return rolledBack;
  });
}

// ---------------------------------------------------------------------------
// Read-Only Query Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a worker profile currently has an enabled deployment
 * with an active checkpoint that is still deployable.
 *
 * GOVERNANCE: Even if routing was previously enabled, a checkpoint that
 * has been revoked (marked non-deployable via markCheckpointDeployable(false))
 * must not be used for routing. This prevents routing traffic to a
 * checkpoint that has been superseded or failed re-evaluation.
 */
export function isRoutingEnabledForProfile(
  stateDir: string,
  workerProfile: WorkerProfile
): boolean {
  const deployment = getDeployment(stateDir, workerProfile);
  if (!deployment?.routingEnabled) return false;
  if (!deployment.activeCheckpointId) return false;
  // Re-check deployability on every routing decision — checkpoint may have been revoked
  return isCheckpointDeployable(stateDir, deployment.activeCheckpointId);
}

/**
 * Get the active checkpoint ID for a worker profile.
 * Returns null if no deployment or no active checkpoint.
 */
export function getActiveCheckpointForProfile(
  stateDir: string,
  workerProfile: WorkerProfile
): string | null {
  const deployment = getDeployment(stateDir, workerProfile);
  return deployment?.activeCheckpointId ?? null;
}

/**
 * Get the full deployment record with lineage context.
 * Returns null if no deployment exists.
 *
 * Lineage includes: deployment record, active checkpoint, parent training run, eval summary.
 */
export function getDeploymentLineage(
  stateDir: string,
  workerProfile: WorkerProfile
): {
  deployment: Deployment;
  activeCheckpoint: Checkpoint | null;
} | null {
  const deployment = getDeployment(stateDir, workerProfile);
  if (!deployment) return null;

  const activeCheckpoint = deployment.activeCheckpointId
    ? getCheckpoint(stateDir, deployment.activeCheckpointId)
    : null;

  return { deployment, activeCheckpoint };
}

/**
 * Get the complete deployment registry (for debugging/admin purposes).
 */
export function getFullDeploymentRegistry(stateDir: string): ModelDeploymentRegistry {
  return readRegistry(stateDir);
}

/**
 * Compute stats for the deployment registry.
 */
export function getDeploymentRegistryStats(
  stateDir: string
): {
  totalDeployments: number;
  activeDeployments: number; // deployments with routingEnabled === true
  profilesWithBindings: number;
  profilesWithRoutingEnabled: number;
} {
  const registry = readRegistry(stateDir);
  const {deployments} = registry;

  return {
    totalDeployments: deployments.length,
    activeDeployments: deployments.filter((d) => d.routingEnabled).length,
    profilesWithBindings: new Set(deployments.map((d) => d.workerProfile)).size,
    profilesWithRoutingEnabled: deployments.filter((d) => d.routingEnabled).length,
  };
}
