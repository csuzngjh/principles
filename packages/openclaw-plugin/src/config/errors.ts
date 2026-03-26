/**
 * Domain-Specific Errors for Principles Disciple
 * 
 * These errors provide semantic meaning to failure modes,
 * making it easier to distinguish between:
 * - Lock contention (resource busy)
 * - Parse/validation failures
 * - Derived state mismatches
 * - Configuration issues
 */

/**
 * Base class for all Principles Disciple errors
 */
export class PdError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'PdError';
  }
}

/**
 * Thrown when a resource lock cannot be acquired
 * (e.g., queue, trajectory, evolution file)
 */
export class LockUnavailableError extends PdError {
  constructor(
    resource: string,
    scope: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Lock] ${scope}: queue lock unavailable for ${resource}`,
      'LOCK_UNAVAILABLE',
      options
    );
    this.name = 'LockUnavailableError';
  }
}

/**
 * Thrown when a path key cannot be resolved
 */
export class PathResolutionError extends PdError {
  constructor(
    key: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Path] Unknown path key: ${key}`,
      'PATH_RESOLUTION_ERROR',
      options
    );
    this.name = 'PathResolutionError';
  }
}

/**
 * Thrown when a workspace cannot be found
 */
export class WorkspaceNotFoundError extends PdError {
  constructor(
    workspace: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Workspace] Workspace not found: ${workspace}`,
      'WORKSPACE_NOT_FOUND',
      options
    );
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Thrown when a required sample cannot be found
 */
export class SampleNotFoundError extends PdError {
  constructor(
    sampleId: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Sample] Correction sample not found: ${sampleId}`,
      'SAMPLE_NOT_FOUND',
      options
    );
    this.name = 'SampleNotFoundError';
  }
}

/**
 * Thrown when configuration is invalid or missing required fields
 */
export class ConfigurationError extends PdError {
  constructor(
    message: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Config] ${message}`,
      'CONFIGURATION_ERROR',
      options
    );
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown when prompt/logger dependencies are unavailable
 */
export class DependencyError extends PdError {
  constructor(
    component: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:${component}] ${message}`,
      'DEPENDENCY_ERROR',
      options
    );
    this.name = 'DependencyError';
  }
}

/**
 * Thrown when evolution worker encounters a processing error
 */
export class EvolutionProcessingError extends PdError {
  constructor(
    message: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Evolution] ${message}`,
      'EVOLUTION_PROCESSING_ERROR',
      options
    );
    this.name = 'EvolutionProcessingError';
  }
}

/**
 * Thrown when trajectory operations fail
 */
export class TrajectoryError extends PdError {
  constructor(
    message: string,
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Trajectory] ${message}`,
      'TRAJECTORY_ERROR',
      options
    );
    this.name = 'TrajectoryError';
  }
}
