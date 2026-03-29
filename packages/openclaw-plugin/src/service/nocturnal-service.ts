/**
 * Nocturnal Service — Trinity Reflection Pipeline Orchestrator
 * ============================================================
 *
 * PURPOSE: Orchestrate the complete nocturnal reflection pipeline:
 *   1. Workspace idle check
 *   2. Target selection (principle + session)
 *   3. Trajectory snapshot extraction
 *   4. Trinity artifact generation (Dreamer -> Philosopher -> Scribe)
 *      OR single-reflector fallback (if Trinity disabled or fails)
 *   5. Arbiter validation
 *   6. Executability check
 *   7. Artifact persistence
 *   8. Cooldown recording
 *
 * DESIGN CONSTRAINTS (Phase 6):
 * - Trinity is configurable (useTrinity flag)
 * - Single-reflector fallback preserved if Trinity fails
 * - All stage I/O is structured JSON contracts
 * - Any malformed stage output fails the entire chain closed
 * - Final artifact still passes arbiter + executability validation
 * - Telemetry records chain mode, stage outcomes, candidate counts
 * - No real training export (Phase 3+ only)
 * - No auto-deployment
 * - Approved artifacts go to .state/nocturnal/samples/{artifactId}.json
 * - Cooldown recorded via nocturnal-runtime.ts
 *
 * THIS IS THE MAIN ORCHESTRATOR — all other nocturnal modules are called from here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  NocturnalTrajectoryExtractor,
  createNocturnalTrajectoryExtractor,
  type NocturnalSessionSnapshot,
} from '../core/nocturnal-trajectory-extractor.js';
import {
  NocturnalTargetSelector,
  selectNocturnalTarget,
  type NocturnalSelectionResult,
  type SkipReason,
} from './nocturnal-target-selector.js';
import {
  validateArtifact,
  parseAndValidateArtifact,
  validateTrinityDraft,
  type NocturnalArtifact,
  type ArbiterResult,
} from '../core/nocturnal-arbiter.js';
import {
  draftToArtifact,
  runTrinity,
  runTrinityAsync,
  DEFAULT_TRINITY_CONFIG,
  type TrinityConfig,
  type TrinityResult,
  type TrinityDraftArtifact,
  type TrinityRuntimeAdapter,
} from '../core/nocturnal-trinity.js';
import {
  validateExecutability,
  type BoundedAction,
} from '../core/nocturnal-executability.js';
import {
  adjustThresholdsFromSignals,
  type ThresholdSignals,
} from '../core/adaptive-thresholds.js';
import {
  checkWorkspaceIdle,
  checkPreflight,
  recordRunStart,
  recordRunEnd,
  type IdleCheckResult,
  type PreflightCheckResult,
} from './nocturnal-runtime.js';
import { NocturnalPathResolver } from '../core/nocturnal-paths.js';
import { registerSample } from '../core/nocturnal-dataset.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a complete nocturnal reflection run.
 */
export interface NocturnalRunResult {
  /** Whether the run produced an approved artifact */
  success: boolean;
  /** The approved artifact (if success === true) */
  artifact?: NocturnalArtifact & { boundedAction?: BoundedAction };
  /** Skip reason (if success === false because nothing to do) */
  skipReason?: SkipReason;
  /** Whether the selector found no target */
  noTargetSelected: boolean;
  /** Whether the reflector rejected or artifact failed validation */
  validationFailed: boolean;
  /** Validation failure reasons */
  validationFailures: string[];
  /** Snapshot used for reflection */
  snapshot?: NocturnalSessionSnapshot;
  /** Diagnostics from each pipeline stage */
  diagnostics: NocturnalRunDiagnostics;
  /** Trinity telemetry (if Trinity was used) */
  trinityTelemetry?: TrinityResult['telemetry'];
}

/**
 * Diagnostics from each pipeline stage.
 */
export interface NocturnalRunDiagnostics {
  /** Pre-flight check result */
  preflight: PreflightCheckResult | null;
  /** Selection result */
  selection: NocturnalSelectionResult | null;
  /** Idle check result */
  idle: IdleCheckResult | null;
  /** Whether Trinity chain was attempted */
  trinityAttempted: boolean;
  /** Trinity result (if trinityAttempted === true) */
  trinityResult: TrinityResult | null;
  /** Which chain mode was used */
  chainModeUsed: 'trinity' | 'single-reflector' | null;
  /** Arbiter validation result */
  arbiterResult: ArbiterResult | null;
  /** Executability validation result (if arbiter passed) */
  executabilityResult: { executable: boolean; failures: string[] } | null;
  /** Whether artifact was persisted */
  persisted: boolean;
  /** Persistence path (if persisted) */
  persistedPath?: string;
}

/**
 * Configuration for the nocturnal service.
 */
export interface NocturnalServiceOptions {
  /**
   * Whether to skip the reflector (for testing arbiter/executability in isolation).
   * Default: false (reflector runs normally).
   */
  skipReflector?: boolean;

  /**
   * Override the reflector output (for testing).
   * If provided, this JSON string is used instead of calling the stub reflector.
   */
  reflectorOutputOverride?: string;

  /**
   * Override idle check (for testing).
   * If provided, this result is used instead of calling checkWorkspaceIdle.
   */
  idleCheckOverride?: IdleCheckResult;

  /**
   * Trinity chain configuration.
   * Default: { useTrinity: true, maxCandidates: 3, useStubs: false }
   */
  trinityConfig?: Partial<TrinityConfig>;

  /**
   * Runtime adapter for real subagent execution.
   * When provided, Trinity stages are invoked via the adapter's async methods.
   * Ignored when trinityConfig.useStubs is true.
   */
  runtimeAdapter?: TrinityRuntimeAdapter;

  /**
   * Override the Trinity result (for testing).
   * If provided, this result is used instead of running the Trinity chain.
   */
  trinityResultOverride?: TrinityResult;
}

// ---------------------------------------------------------------------------
// Stub Reflector (Phase 2 — no real subagent calls)
// ---------------------------------------------------------------------------

/**
 * STUB REFLECTOR — Phase 2 MVP only.
 *
 * This does NOT call a real subagent. Instead, it generates a plausible
 * artifact for testing purposes. The artifact structure is correct and
 * passes arbiter validation, but the content is synthetic.
 *
 * In Phase 3, this will be replaced with real subagent invocation.
 */
function invokeStubReflector(
  snapshot: NocturnalSessionSnapshot,
  principleId: string
): string {
  const artifactId = randomUUID();
  const now = new Date().toISOString();

  // Build a plausible bad/better decision pair based on available snapshot data.
  // This is synthetic — real reflection would come from subagent analysis.
  const hasFailures = snapshot.stats.failureCount > 0;
  const hasPain = snapshot.stats.totalPainEvents > 0;
  const hasGateBlocks = snapshot.stats.totalGateBlocks > 0;

  // Detect what kind of signal is available and craft appropriate artifact
  let badDecision: string;
  let betterDecision: string;
  let rationale: string;

  if (hasGateBlocks) {
    badDecision = `Proceeded with a tool call despite receiving a gate block, bypassing the safety check`;
    betterDecision = `Read the blocked operation documentation and obtained proper authorization before retrying the operation`;
    rationale = `Respecting gate blocks prevents unintended system modifications and ensures alignment with operational constraints`;
  } else if (hasPain) {
    badDecision = `Continued executing operations without pausing to address accumulated pain signals`;
    betterDecision = `Check the pain signals and identify the root cause before proceeding with the next operation`;
    rationale = `Pain signals indicate accumulated friction or error conditions that should be addressed before continuing`;
  } else if (hasFailures) {
    badDecision = `Retried a failing operation without diagnosing the root cause of the failure`;
    betterDecision = `Check the error message and verify preconditions before retrying a failed bash command`;
    rationale = `Diagnosing failures before retry prevents repeated failures and respects the cost of each action attempt`;
  } else {
    badDecision = `Proceeded with an operation without verifying preconditions or checking for conflicting changes`;
    betterDecision = `Read the relevant file and verify the current state before making changes to avoid conflicts`;
    rationale = `Verifying preconditions and current state prevents errors and ensures actions are appropriate for the actual situation`;
  }

  const artifact = {
    artifactId,
    sessionId: snapshot.sessionId,
    principleId,
    sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
    badDecision,
    betterDecision,
    rationale,
    createdAt: now,
  };

  return JSON.stringify(artifact);
}

// ---------------------------------------------------------------------------
// Artifact Persistence
// ---------------------------------------------------------------------------

/**
 * Persist an approved artifact to the samples directory.
 * Returns the absolute path where the artifact was saved.
 */
function persistArtifact(
  workspaceDir: string,
  artifact: NocturnalArtifact & { boundedAction?: BoundedAction }
): string {
  const artifactPath = NocturnalPathResolver.samplePath(workspaceDir, artifact.artifactId);

  const sampleRecord = {
    ...artifact,
    status: 'approved' as const,
    boundedAction: artifact.boundedAction,
    persistedAt: new Date().toISOString(),
  };

  // Ensure directory exists
  const dir = path.dirname(artifactPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(artifactPath, JSON.stringify(sampleRecord, null, 2), 'utf-8');
  return artifactPath;
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute a complete nocturnal reflection run.
 *
 * Pipeline:
 *  1. Pre-flight check (idle + cooldown + quota)
 *  2. Target selection (principle + violating session)
 *  3. Trajectory snapshot extraction
 *  4. Reflector (stub) → JSON artifact
 *  5. Arbiter validation
 *  6. Executability check
 *  7. Artifact persistence
 *  8. Cooldown recording
 *
 * @param workspaceDir - Workspace directory
 * @param stateDir - State directory
 * @param options - Service configuration options
 * @returns NocturnalRunResult
 */
export function executeNocturnalReflection(
  workspaceDir: string,
  stateDir: string,
  options: NocturnalServiceOptions = {}
): NocturnalRunResult {
  const diagnostics: NocturnalRunDiagnostics = {
    preflight: null,
    selection: null,
    idle: null,
    trinityAttempted: false,
    trinityResult: null,
    chainModeUsed: null,
    arbiterResult: null,
    executabilityResult: null,
    persisted: false,
  };

  // -------------------------------------------------------------------------
  // Step 1: Pre-flight check
  // -------------------------------------------------------------------------
  const preflight = checkPreflight(
    workspaceDir,
    stateDir,
    undefined, // principleId
    undefined, // trajectoryLastActivityAt
    options.idleCheckOverride
  );
  diagnostics.preflight = preflight;

  if (!preflight.canRun) {
    return {
      success: false,
      noTargetSelected: false,
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Target selection
  // -------------------------------------------------------------------------
  const extractor = createNocturnalTrajectoryExtractor(workspaceDir, stateDir);
  const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor, {
    idleCheckOverride: options.idleCheckOverride,
  });

  const selection = selector.select();
  diagnostics.selection = selection;

  if (selection.decision === 'skip') {
    return {
      success: false,
      noTargetSelected: true,
      skipReason: selection.skipReason,
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }

  const { selectedPrincipleId, selectedSessionId } = selection;

  // -------------------------------------------------------------------------
  // Step 3: Trajectory snapshot extraction
  // -------------------------------------------------------------------------
  if (!selectedPrincipleId || !selectedSessionId) {
    return {
      success: false,
      noTargetSelected: true,
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }

  const snapshot = extractor.getNocturnalSessionSnapshot(selectedSessionId);
  if (!snapshot) {
    return {
      success: false,
      noTargetSelected: true,
      skipReason: 'insufficient_snapshot_data',
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }
  diagnostics.idle = { isIdle: true, mostRecentActivityAt: 0, idleForMs: 0, activeSessionCount: 0, abandonedSessionIds: [], trajectoryGuardrailConfirmsIdle: true, reason: 'preflight passed' };

  // -------------------------------------------------------------------------
  // Step 4: Record run start (begin cooldown window)
  // -------------------------------------------------------------------------
  // Note: We use a sync approximation here since this is called from sync context
  // The async version would be used in real worker integration
  void recordRunStart(stateDir, selectedPrincipleId).catch((err) => {
    console.warn(`[nocturnal-service] Failed to record run start: ${String(err)}`);
  });

  // -------------------------------------------------------------------------
  // Step 5: Artifact generation (Trinity or single-reflector)
  // -------------------------------------------------------------------------
  let trinityArtifact: TrinityDraftArtifact | null = null;
  let trinityResult: TrinityResult | null = null;
  let rawJson: string;
  let chainModeUsed: 'trinity' | 'single-reflector' = 'single-reflector';

  if (options.skipReflector) {
    // Caller provided explicit artifact — used for testing arbiter/executability
    if (!options.reflectorOutputOverride) {
      return {
        success: false,
        noTargetSelected: false,
        validationFailed: true,
        validationFailures: ['skipReflector is true but no reflectorOutputOverride provided'],
        diagnostics,
      };
    }
    rawJson = options.reflectorOutputOverride;
  } else if (options.trinityResultOverride) {
    // Testing override — use provided Trinity result
    trinityResult = options.trinityResultOverride;
    diagnostics.trinityAttempted = true;
    diagnostics.trinityResult = trinityResult;
    diagnostics.chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';
    chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';

    if (!trinityResult.success) {
      // Trinity failed — fail closed (same semantics as production)
      const failures = trinityResult.failures.map((f) => `${f.stage}: ${f.reason}`);
      void recordRunEnd(stateDir, 'failed', { reason: `Trinity override failed: ${failures.join('; ')}` }).catch((err) => {
        console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
      });
      // Emit threshold signals: malformed Trinity override is a strong signal
      adjustThresholdsFromSignals(stateDir, {
        malformedRate: 1.0,
        arbiterRejectRate: 0.0,
        executabilityRejectRate: 0.0,
        qualityDelta: 0.0,
      });
      return {
        success: false,
        noTargetSelected: false,
        validationFailed: true,
        validationFailures: [`Trinity override failed: ${failures.join('; ')}`],
        snapshot,
        diagnostics,
      };
    } else {
      // Validate Trinity draft
      const draftValidation = validateTrinityDraft(trinityResult.artifact);
      if (!draftValidation.valid) {
        const failures = draftValidation.failures;
        void recordRunEnd(stateDir, 'failed', { reason: `Trinity draft invalid: ${failures.join('; ')}` }).catch((err) => {
          console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
        });
        // Emit threshold signals: malformed draft content is a strong signal
        adjustThresholdsFromSignals(stateDir, {
          malformedRate: 1.0,
          arbiterRejectRate: 0.0,
          executabilityRejectRate: 0.0,
          qualityDelta: 0.0,
        });
        return {
          success: false,
          noTargetSelected: false,
          validationFailed: true,
          validationFailures: failures,
          snapshot,
          diagnostics,
        };
      }
      trinityArtifact = trinityResult.artifact!;
      // Convert Trinity draft to arbiter-compatible artifact
      const artifactData = draftToArtifact(trinityArtifact);
      rawJson = JSON.stringify(artifactData);
    }
  } else {
    // Normal execution: try Trinity first, fall back to single-reflector
    const trinityConfig: TrinityConfig = {
      ...DEFAULT_TRINITY_CONFIG,
      ...options.trinityConfig,
      stateDir, // Enable threshold loading/persistence
    };

    // If useStubs=false but no runtimeAdapter provided in sync context,
    // fall back to stub behavior (graceful degradation).
    // For real async execution, use executeNocturnalReflectionAsync with a runtimeAdapter.
    const effectiveConfig: TrinityConfig = trinityConfig.useTrinity && !trinityConfig.useStubs && !options.runtimeAdapter
      ? { ...trinityConfig, useStubs: true }
      : trinityConfig;

    if (effectiveConfig.useTrinity) {
      diagnostics.trinityAttempted = true;
      trinityResult = runTrinity({ snapshot, principleId: selectedPrincipleId, config: effectiveConfig });
      diagnostics.trinityResult = trinityResult;
      diagnostics.chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';
      chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';

      if (trinityResult.success) {
        // Validate Trinity draft
        const draftValidation = validateTrinityDraft(trinityResult.artifact);
        if (!draftValidation.valid) {
          // Trinity draft invalid — fail closed
          const failures = draftValidation.failures;
          void recordRunEnd(stateDir, 'failed', { reason: `Trinity draft invalid: ${failures.join('; ')}` }).catch((err) => {
            console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
          });
          // Emit threshold signals: malformed draft content is a strong signal
          adjustThresholdsFromSignals(stateDir, {
            malformedRate: 1.0,
            arbiterRejectRate: 0.0,
            executabilityRejectRate: 0.0,
            qualityDelta: 0.0,
          });
          return {
            success: false,
            noTargetSelected: false,
            validationFailed: true,
            validationFailures: failures,
            snapshot,
            diagnostics,
          };
        }
        trinityArtifact = trinityResult.artifact!;
        // Convert Trinity draft to arbiter-compatible artifact
        const artifactData = draftToArtifact(trinityArtifact);
        rawJson = JSON.stringify(artifactData);
      } else {
        // Trinity failed — fail closed (do NOT fall back to single-reflector)
        // Phase 6 requirement: malformed Trinity stage output fails closed
        const failures = trinityResult.failures.map((f) => `${f.stage}: ${f.reason}`);
        void recordRunEnd(stateDir, 'failed', { reason: `Trinity chain failed: ${failures.join('; ')}` }).catch((err) => {
          console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
        });
        // Emit threshold signals: malformed Trinity is the strongest signal for tightening schema threshold
        adjustThresholdsFromSignals(stateDir, {
          malformedRate: 1.0,
          arbiterRejectRate: 0.0,
          executabilityRejectRate: 0.0,
          qualityDelta: 0.0,
        });
        return {
          success: false,
          noTargetSelected: false,
          validationFailed: true,
          validationFailures: [`Trinity chain failed: ${failures.join('; ')}`],
          snapshot,
          diagnostics,
        };
      }
    } else {
      // Trinity disabled — use single-reflector directly
      rawJson = invokeStubReflector(snapshot, selectedPrincipleId);
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Arbiter validation
  // -------------------------------------------------------------------------
  const arbiterResult = parseAndValidateArtifact(rawJson, {
    expectedPrincipleId: selectedPrincipleId,
    expectedSessionId: selectedSessionId,
  });
  diagnostics.arbiterResult = arbiterResult;

  if (!arbiterResult.passed || !arbiterResult.artifact) {
    const failures = arbiterResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      console.warn(`[nocturnal-service] Failed to record run end (arbiter failed): ${String(err)}`);
    });
    // Emit threshold signals: arbiter rejection indicates principle alignment issues
    adjustThresholdsFromSignals(stateDir, {
      malformedRate: 0.0,
      arbiterRejectRate: 1.0,
      executabilityRejectRate: 0.0,
      qualityDelta: 0.0,
    });
    return {
      success: false,
      noTargetSelected: false,
      validationFailed: true,
      validationFailures: failures,
      diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // Step 7: Executability check
  // -------------------------------------------------------------------------
  const execResult = validateExecutability(arbiterResult.artifact);

  if (!execResult.executable) {
    const failures = execResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      console.warn(`[nocturnal-service] Failed to record run end (executability failed): ${String(err)}`);
    });
    // Emit threshold signals: executability rejection indicates action quality issues
    adjustThresholdsFromSignals(stateDir, {
      malformedRate: 0.0,
      arbiterRejectRate: 0.0,
      executabilityRejectRate: 1.0,
      qualityDelta: 0.0,
    });
    return {
      success: false,
      noTargetSelected: false,
      validationFailed: true,
      validationFailures: failures,
      diagnostics,
    };
  }
  diagnostics.executabilityResult = { executable: true, failures: [] };

  // -------------------------------------------------------------------------
  // Step 8: Persist artifact
  // -------------------------------------------------------------------------
  const artifactWithBoundedAction = {
    ...arbiterResult.artifact,
    boundedAction: execResult.boundedAction,
  };

  let persistedPath: string;
  try {
    persistedPath = persistArtifact(workspaceDir, artifactWithBoundedAction);
    diagnostics.persisted = true;
    diagnostics.persistedPath = persistedPath;
  } catch (err) {
    void recordRunEnd(stateDir, 'failed', { reason: `persistence error: ${String(err)}` }).catch((e) => {
      console.warn(`[nocturnal-service] Failed to record run end (persistence failed): ${String(e)}`);
    });
    return {
      success: false,
      noTargetSelected: false,
      validationFailed: true,
      validationFailures: [`Failed to persist artifact: ${String(err)}`],
      snapshot,
      diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // Step 8b: Register in dataset lineage store (Phase 3 review gate)
  // -------------------------------------------------------------------------
  // Approved artifacts must enter the dataset registry so they can be reviewed
  // before export. Without this, new samples never appear in the review queue.
  try {
    registerSample(workspaceDir, arbiterResult.artifact, persistedPath, null);
  } catch (err) {
    // Non-fatal: artifact is persisted, registry is secondary.
    // Log but don't fail the run.
    console.warn(`[nocturnal-service] Failed to register sample in dataset registry: ${String(err)}`);
  }

  // -------------------------------------------------------------------------
  // Step 9: Record run success
  // -------------------------------------------------------------------------
  void recordRunEnd(stateDir, 'success', { sampleCount: 1 }).catch((err) => {
    console.warn(`[nocturnal-service] Failed to record run end (success): ${String(err)}`);
  });

  // -------------------------------------------------------------------------
  // Step 10: Adaptive threshold adjustment based on run signals
  // -------------------------------------------------------------------------
  // Compute signals from this run's outcomes and adjust thresholds if needed
  const malformedRate = trinityResult && !trinityResult.success ? 1.0 : 0.0;
  const arbiterRejectRate = !arbiterResult.passed ? 1.0 : 0.0;
  const executabilityRejectRate = !execResult.executable ? 1.0 : 0.0;
  // qualityDelta requires reviewed-subset comparison infrastructure (Phase 7+)
  const qualityDelta = 0.0;

  const signals: ThresholdSignals = {
    malformedRate,
    arbiterRejectRate,
    executabilityRejectRate,
    qualityDelta,
  };

  // Apply threshold adjustments based on run signals (fire-and-forget, non-blocking)
  // Note: adjustThresholdsFromSignals is synchronous, so no .catch() needed
  adjustThresholdsFromSignals(stateDir, signals);

  return {
    success: true,
    artifact: artifactWithBoundedAction,
    noTargetSelected: false,
    validationFailed: false,
    validationFailures: [],
    snapshot,
    diagnostics,
    trinityTelemetry: trinityResult?.telemetry,
  };
}

// ---------------------------------------------------------------------------
// Convenience function for async contexts (e.g., worker integration)
// ---------------------------------------------------------------------------

/**
 * Async wrapper for executeNocturnalReflection.
 * When runtimeAdapter is provided in options, uses runTrinityAsync for real subagent execution.
 * Otherwise falls back to synchronous executeNocturnalReflection.
 */
export async function executeNocturnalReflectionAsync(
  workspaceDir: string,
  stateDir: string,
  options: NocturnalServiceOptions = {}
): Promise<NocturnalRunResult> {
  // If no runtime adapter and no trinityConfig.override, use sync path
  if (!options.runtimeAdapter && !options.trinityConfig?.useStubs) {
    // Sync path with default config (useStubs=false but no adapter = fail)
    // Fall through to sync wrapper
    return Promise.resolve(executeNocturnalReflection(workspaceDir, stateDir, options));
  }

  // If runtime adapter is provided, use async Trinity path
  if (options.runtimeAdapter) {
    return executeNocturnalReflectionWithAdapter(workspaceDir, stateDir, options);
  }

  // Sync path (useStubs=true or other sync options)
  return Promise.resolve(executeNocturnalReflection(workspaceDir, stateDir, options));
}

/**
 * Execute nocturnal reflection with real Trinity runtime adapter (async).
 * This handles the full pipeline with async Trinity stage execution.
 */
async function executeNocturnalReflectionWithAdapter(
  workspaceDir: string,
  stateDir: string,
  options: NocturnalServiceOptions
): Promise<NocturnalRunResult> {
  const diagnostics: NocturnalRunDiagnostics = {
    preflight: null,
    selection: null,
    idle: null,
    trinityAttempted: false,
    trinityResult: null,
    chainModeUsed: null,
    arbiterResult: null,
    executabilityResult: null,
    persisted: false,
  };

  // Step 1: Pre-flight check
  const preflight = checkPreflight(
    workspaceDir,
    stateDir,
    undefined,
    undefined,
    options.idleCheckOverride
  );
  diagnostics.preflight = preflight;

  if (!preflight.canRun) {
    return { success: false, noTargetSelected: false, validationFailed: false, validationFailures: [], diagnostics };
  }

  // Step 2: Target selection
  const extractor = createNocturnalTrajectoryExtractor(workspaceDir, stateDir);
  const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor, {
    idleCheckOverride: options.idleCheckOverride,
  });

  const selection = selector.select();
  diagnostics.selection = selection;

  if (selection.decision === 'skip') {
    return {
      success: false,
      noTargetSelected: true,
      skipReason: selection.skipReason,
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }

  const { selectedPrincipleId, selectedSessionId } = selection;

  if (!selectedPrincipleId || !selectedSessionId) {
    return {
      success: false,
      noTargetSelected: true,
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }

  const snapshot = extractor.getNocturnalSessionSnapshot(selectedSessionId);
  if (!snapshot) {
    return {
      success: false,
      noTargetSelected: true,
      skipReason: 'insufficient_snapshot_data',
      validationFailed: false,
      validationFailures: [],
      diagnostics,
    };
  }
  diagnostics.idle = { isIdle: true, mostRecentActivityAt: 0, idleForMs: 0, activeSessionCount: 0, abandonedSessionIds: [], trajectoryGuardrailConfirmsIdle: true, reason: 'preflight passed' };

  // Step 3: Record run start
  void recordRunStart(stateDir, selectedPrincipleId).catch((err) => {
    console.warn(`[nocturnal-service] Failed to record run start: ${String(err)}`);
  });

  // Step 4: Trinity execution via adapter (async)
  let trinityArtifact: TrinityDraftArtifact | null = null;
  let trinityResult: TrinityResult | null = null;
  let rawJson: string;
  let chainModeUsed: 'trinity' | 'single-reflector' = 'single-reflector';

  if (options.skipReflector) {
    if (!options.reflectorOutputOverride) {
      return {
        success: false,
        noTargetSelected: false,
        validationFailed: true,
        validationFailures: ['skipReflector is true but no reflectorOutputOverride provided'],
        diagnostics,
      };
    }
    rawJson = options.reflectorOutputOverride;
  } else if (options.trinityResultOverride) {
    trinityResult = options.trinityResultOverride;
    diagnostics.trinityAttempted = true;
    diagnostics.trinityResult = trinityResult;
    diagnostics.chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';
    chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';

    if (!trinityResult.success) {
      const failures = trinityResult.failures.map((f) => `${f.stage}: ${f.reason}`);
      void recordRunEnd(stateDir, 'failed', { reason: `Trinity override failed: ${failures.join('; ')}` }).catch((err) => {
        console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
      });
      adjustThresholdsFromSignals(stateDir, { malformedRate: 1.0, arbiterRejectRate: 0.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
      return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: [`Trinity override failed: ${failures.join('; ')}`], snapshot, diagnostics };
    }
    trinityArtifact = trinityResult.artifact!;
    const artifactData = draftToArtifact(trinityArtifact);
    rawJson = JSON.stringify(artifactData);
  } else {
    const trinityConfig: TrinityConfig = {
      ...DEFAULT_TRINITY_CONFIG,
      ...options.trinityConfig,
      runtimeAdapter: options.runtimeAdapter,
      stateDir,
    };

    if (trinityConfig.useTrinity) {
      diagnostics.trinityAttempted = true;
      trinityResult = await runTrinityAsync({ snapshot, principleId: selectedPrincipleId, config: trinityConfig });
      diagnostics.trinityResult = trinityResult;
      diagnostics.chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';
      chainModeUsed = trinityResult.success ? 'trinity' : 'single-reflector';

      if (trinityResult.success) {
        const draftValidation = validateTrinityDraft(trinityResult.artifact);
        if (!draftValidation.valid) {
          const failures = draftValidation.failures;
          void recordRunEnd(stateDir, 'failed', { reason: `Trinity draft invalid: ${failures.join('; ')}` }).catch((err) => {
            console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
          });
          adjustThresholdsFromSignals(stateDir, { malformedRate: 1.0, arbiterRejectRate: 0.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
          return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: failures, snapshot, diagnostics };
        }
        trinityArtifact = trinityResult.artifact!;
        const artifactData = draftToArtifact(trinityArtifact);
        rawJson = JSON.stringify(artifactData);
      } else {
        const failures = trinityResult.failures.map((f) => `${f.stage}: ${f.reason}`);
        void recordRunEnd(stateDir, 'failed', { reason: `Trinity chain failed: ${failures.join('; ')}` }).catch((err) => {
          console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
        });
        adjustThresholdsFromSignals(stateDir, { malformedRate: 1.0, arbiterRejectRate: 0.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
        return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: [`Trinity chain failed: ${failures.join('; ')}`], snapshot, diagnostics };
      }
    } else {
      rawJson = invokeStubReflector(snapshot, selectedPrincipleId);
    }
  }

  // Step 5: Arbiter validation
  const arbiterResult = parseAndValidateArtifact(rawJson, {
    expectedPrincipleId: selectedPrincipleId,
    expectedSessionId: selectedSessionId,
  });
  diagnostics.arbiterResult = arbiterResult;

  if (!arbiterResult.passed || !arbiterResult.artifact) {
    const failures = arbiterResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      console.warn(`[nocturnal-service] Failed to record run end (arbiter failed): ${String(err)}`);
    });
    adjustThresholdsFromSignals(stateDir, { malformedRate: 0.0, arbiterRejectRate: 1.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
    return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: failures, diagnostics };
  }

  // Step 6: Executability check
  const execResult = validateExecutability(arbiterResult.artifact);
  if (!execResult.executable) {
    const failures = execResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      console.warn(`[nocturnal-service] Failed to record run end (executability failed): ${String(err)}`);
    });
    adjustThresholdsFromSignals(stateDir, { malformedRate: 0.0, arbiterRejectRate: 0.0, executabilityRejectRate: 1.0, qualityDelta: 0.0 });
    return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: failures, diagnostics };
  }
  diagnostics.executabilityResult = { executable: true, failures: [] };

  // Step 7: Persist artifact
  const artifactWithBoundedAction = { ...arbiterResult.artifact, boundedAction: execResult.boundedAction };
  let persistedPath: string;
  try {
    persistedPath = persistArtifact(workspaceDir, artifactWithBoundedAction);
    diagnostics.persisted = true;
    diagnostics.persistedPath = persistedPath;
  } catch (err) {
    void recordRunEnd(stateDir, 'failed', { reason: `persistence error: ${String(err)}` }).catch((e) => {
      console.warn(`[nocturnal-service] Failed to record run end (persistence failed): ${String(e)}`);
    });
    return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: [`Failed to persist artifact: ${String(err)}`], snapshot, diagnostics };
  }

  // Step 8: Register in dataset lineage
  try {
    registerSample(workspaceDir, arbiterResult.artifact, persistedPath, null);
  } catch (err) {
    console.warn(`[nocturnal-service] Failed to register sample in dataset registry: ${String(err)}`);
  }

  // Step 9: Record run success
  void recordRunEnd(stateDir, 'success', { sampleCount: 1 }).catch((err) => {
    console.warn(`[nocturnal-service] Failed to record run end (success): ${String(err)}`);
  });

  // Step 10: Adaptive threshold adjustment
  const malformedRate = trinityResult && !trinityResult.success ? 1.0 : 0.0;
  const arbiterRejectRate = !arbiterResult.passed ? 1.0 : 0.0;
  const executabilityRejectRate = !execResult.executable ? 1.0 : 0.0;
  const qualityDelta = 0.0;
  adjustThresholdsFromSignals(stateDir, { malformedRate, arbiterRejectRate, executabilityRejectRate, qualityDelta });

  return {
    success: true,
    artifact: artifactWithBoundedAction,
    noTargetSelected: false,
    validationFailed: false,
    validationFailures: [],
    snapshot,
    diagnostics,
    trinityTelemetry: trinityResult?.telemetry,
  };
}

// ---------------------------------------------------------------------------
// Query: List approved artifacts
// ---------------------------------------------------------------------------

/**
 * List all approved nocturnal artifacts for a workspace.
 * Returns artifacts sorted by createdAt (newest first).
 */
export function listApprovedNocturnalArtifacts(
  workspaceDir: string
): Array<NocturnalArtifact & { persistedAt: string; boundedAction?: BoundedAction }> {
  const samplePaths = NocturnalPathResolver.listApprovedSamples(workspaceDir);
  const artifacts: Array<NocturnalArtifact & { persistedAt: string; boundedAction?: BoundedAction }> = [];

  for (const samplePath of samplePaths) {
    try {
      const content = fs.readFileSync(samplePath, 'utf-8');
      const sample = JSON.parse(content);
      if (sample.status === 'approved' && sample.artifactId) {
        artifacts.push({
          artifactId: sample.artifactId,
          sessionId: sample.sessionId,
          principleId: sample.principleId,
          sourceSnapshotRef: sample.sourceSnapshotRef || '',
          badDecision: sample.badDecision,
          betterDecision: sample.betterDecision,
          rationale: sample.rationale,
          createdAt: sample.createdAt,
          persistedAt: sample.persistedAt || new Date().toISOString(),
          boundedAction: sample.boundedAction,
        });
      }
    } catch {
      // Skip malformed files
    }
  }

  // Sort by createdAt descending
  artifacts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return artifacts;
}
