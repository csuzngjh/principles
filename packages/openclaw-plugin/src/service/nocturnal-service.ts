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
import type { RecentPainContext } from './evolution-worker.js';
import {
  createNocturnalTrajectoryExtractor,
  computeThinkingModelDelta,
  type NocturnalSessionSnapshot,
} from '../core/nocturnal-trajectory-extractor.js';
import {
  NocturnalTargetSelector,
  type NocturnalSelectionResult,
  type SkipReason,
} from './nocturnal-target-selector.js';
import {
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
  parseArtificerOutput,
  resolveArtificerTargetRule,
  shouldRunArtificer,
  type ArtificerOutput,
  type ArtificerTargetRuleResolution,
} from '../core/nocturnal-artificer.js';
import { validateRuleImplementationCandidate } from '../core/nocturnal-rule-implementation-validator.js';
import { refreshPrincipleLifecycle } from '../core/principle-internalization/lifecycle-refresh.js';
import {
  createImplementationAssetDir,
  deleteImplementationAssetDir,
  getImplementationAssetRoot,
  type CodeImplementationLineageMetadata,
} from '../core/code-implementation-storage.js';
import {
  appendCandidateArtifactLineageRecord,
  appendArtifactLineageRecord,
} from '../core/nocturnal-artifact-lineage.js';
import {
  createImplementation,
  deleteImplementation,
} from '../core/principle-tree-ledger.js';
import {
  checkPreflight,
  recordRunStart,
  recordRunEnd,
  type IdleCheckResult,
  type PreflightCheckResult,
} from './nocturnal-runtime.js';
import { NocturnalPathResolver } from '../core/nocturnal-paths.js';
import { registerSample } from '../core/nocturnal-dataset.js';
import type { Implementation } from '../types/principle-tree-schema.js';

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
  /** Code-candidate sidecar diagnostics */
  artificer: NocturnalArtificerDiagnostics;
}

export interface NocturnalArtificerDiagnostics {
  status: 'skipped' | 'validation_failed' | 'persisted_candidate';
  reason?:
    | 'behavioral_artifact_unavailable'
    | 'no_deterministic_rule'
    | 'insufficient_signal_density'
    | 'missing_scribe_input'
    | 'parse_failed'
    | 'rule_mismatch'
    | 'validator_rejected'
    | 'persistence_failed';
  ruleResolution: ArtificerTargetRuleResolution | null;
  validationFailures: string[];
  implementationId?: string;
  artifactId?: string;
  ruleId?: string;
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

  /**
   * Recent pain context from the evolution queue.
   * When provided, the target selector uses it for ranking bias and diagnostics enrichment.
   * This threads recent pain signals into sleep_reflection targeting without merging task kinds.
   */
  painContext?: RecentPainContext;

  /**
   * Override the principleId (skip Selector stage).
   * When provided with snapshotOverride, the Selector stage is skipped and the provided
   * principleId and snapshot are used directly for Trinity execution.
   * This unifies NocturnalWorkflowManager with executeNocturnalReflectionAsync.
   */
  principleIdOverride?: string;

  /**
   * Override the snapshot (skip Selector stage).
   * Must be provided together with principleIdOverride to skip Selector.
   */
  snapshotOverride?: NocturnalSessionSnapshot;

  /**
   * Override the Artificer JSON output (for testing).
   * When omitted, a deterministic local candidate is synthesized.
   */
  artificerOutputOverride?: string;
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
  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in all if/else branches
  let badDecision: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in all if/else branches
  let betterDecision: string;
  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in all if/else branches
  let rationale: string;

  if (hasGateBlocks) {
    badDecision = `Proceeded with a tool call despite receiving a gate block, bypassing the safety check`;
    betterDecision = `Read the blocked operation documentation and obtained proper authorization before retrying the operation`;
    rationale = `Respecting gate blocks prevents unintended system modifications and ensures alignment with operational constraints`;
  } else if (hasPain) {
    badDecision = `Continued executing operations without pausing to address accumulated pain signals`;
    betterDecision = `Let me stop and reconsider when pain signals accumulate — the error tells us something needs fixing first`;
    rationale = `Pain signals indicate accumulated friction or error conditions that should be addressed before continuing`;
  } else if (hasFailures) {
    badDecision = `Retried a failing operation without diagnosing the root cause of the failure`;
    betterDecision = `Based on the evidence from the error logs, let me first check the actual source code to understand the precondition before retrying`;
    rationale = `Diagnosing failures before retry prevents repeated failures and respects the cost of each action attempt`;
  } else {
    badDecision = `Proceeded with an operation without verifying preconditions or checking for conflicting changes`;
    betterDecision = `Let me first understand the current state of the codebase by reading the relevant files before making any changes`;
    rationale = `Verifying preconditions and current state prevents errors and ensures actions are appropriate for the actual situation`;
  }

  // Compute design-alignment reflection quality metrics
  const thinkingModelDelta = computeThinkingModelDelta(badDecision, betterDecision);
  // Stub reflectors don't have an improved snapshot, so planningRatioGain is 0
  const planningRatioGain = 0;

  const artifact = {
    artifactId,
    sessionId: snapshot.sessionId,
    principleId,
    sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
    badDecision,
    betterDecision,
    rationale,
    createdAt: now,
    thinkingModelDelta,
    planningRatioGain,
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

function buildPainRefs(snapshot: NocturnalSessionSnapshot): string[] {
  return snapshot.painEvents.map(
    (painEvent) =>
      `pain:${painEvent.source}:${painEvent.createdAt}:${(painEvent.reason ?? '').trim()}`
  );
}

function buildGateBlockRefs(snapshot: NocturnalSessionSnapshot): string[] {
  return snapshot.gateBlocks.map(
    (gateBlock) =>
      `gate:${gateBlock.toolName}:${gateBlock.createdAt}:${gateBlock.reason.trim()}`
  );
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function signature requires all parameters for type-safe artifact construction */
function buildDefaultArtificerOutput(
  ruleId: string,
  artifact: NocturnalArtifact,
  sourceSnapshotRef: string,
  sourcePainIds: string[],
  sourceGateBlockIds: string[]
): ArtificerOutput {
  return {
    ruleId,
    implementationType: 'code',
    candidateSource: [
      'export const meta = {',
      `  name: ${JSON.stringify(`nocturnal-${ruleId.toLowerCase()}`)},`,
      '  version: "1.0.0",',
      `  ruleId: ${JSON.stringify(ruleId)},`,
      `  coversCondition: ${JSON.stringify(artifact.betterDecision)},`,
      '};',
      '',
      'export function evaluate(input, helpers) {',
      '  const riskPath = helpers.isRiskPath();',
      '  const toolName = helpers.getToolName();',
      '  const planStatus = helpers.getPlanStatus();',
      "  if (riskPath && toolName === 'write' && planStatus !== 'READY') {",
      '    return {',
      "      decision: 'requireApproval',",
      '      matched: true,',
      `      reason: ${JSON.stringify(artifact.rationale)},`,
      '    };',
      '  }',
      '  return {',
      "    decision: 'allow',",
      '    matched: false,',
      "    reason: 'not-applicable',",
      '  };',
      '}',
    ].join('\n'),
    helperUsage: ['isRiskPath', 'getToolName', 'getPlanStatus'],
    expectedDecision: 'requireApproval',
    rationale: artifact.rationale,
    lineage: {
      artifactKind: 'rule-implementation-candidate',
      sourceSnapshotRef,
      sourcePainIds,
      sourceGateBlockIds,
    },
  };
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function signature requires all parameters for type-safe candidate persistence */
function persistCodeCandidate(
  workspaceDir: string,
  stateDir: string,
  artifact: NocturnalArtifact,
  selectedPrincipleId: string,
  selectedSessionId: string,
  parsedArtificer: ArtificerOutput
): NocturnalArtificerDiagnostics {
  const implementationId = `IMPL-${randomUUID()}`;
  const artifactId = `artifact-${randomUUID()}`;
  const now = new Date().toISOString();
  const assetRoot = getImplementationAssetRoot(stateDir, implementationId);
  const entryPath = path.join(assetRoot, 'entry.js');
  const lineage: CodeImplementationLineageMetadata = {
    principleId: selectedPrincipleId,
    ruleId: parsedArtificer.ruleId,
    sourceSnapshotRef: artifact.sourceSnapshotRef,
    sourcePainIds: [...parsedArtificer.lineage.sourcePainIds],
    sourceGateBlockIds: [...parsedArtificer.lineage.sourceGateBlockIds],
    sourceSessionId: selectedSessionId,
    artificerArtifactId: artifactId,
  };

  const implementation: Implementation = {
    id: implementationId,
    ruleId: parsedArtificer.ruleId,
    type: 'code',
    path: entryPath,
    version: now,
    coversCondition: parsedArtificer.rationale,
    coveragePercentage: 0,
    lifecycleState: 'candidate',
    createdAt: now,
    updatedAt: now,
  };

  try {
    createImplementation(stateDir, implementation);
    createImplementationAssetDir(stateDir, implementationId, now, {
      entrySource: parsedArtificer.candidateSource,
      lineage,
    });
    appendCandidateArtifactLineageRecord(workspaceDir, {
      artifactId,
      principleId: selectedPrincipleId,
      ruleId: parsedArtificer.ruleId,
      sessionId: selectedSessionId,
      sourceSnapshotRef: artifact.sourceSnapshotRef,
      sourcePainIds: lineage.sourcePainIds,
      sourceGateBlockIds: lineage.sourceGateBlockIds,
      storagePath: assetRoot,
      implementationId,
      createdAt: now,
    });
    refreshPrincipleLifecycle(workspaceDir, stateDir);
    return {
      status: 'persisted_candidate',
      ruleResolution: {
        status: 'selected',
        ruleId: parsedArtificer.ruleId,
        reason: 'evidence-winner',
        scores: [],
      },
      validationFailures: [],
      implementationId,
      artifactId,
      ruleId: parsedArtificer.ruleId,
      persistedPath: assetRoot,
    };
  } catch (error: unknown) {
    deleteImplementationAssetDir(stateDir, implementationId);
    try {
      deleteImplementation(stateDir, implementationId);
    } catch {
      // Best effort cleanup to avoid leaving a half-created candidate discoverable.
    }
    return {
      status: 'validation_failed',
      reason: 'persistence_failed',
      ruleResolution: {
        status: 'selected',
        ruleId: parsedArtificer.ruleId,
        reason: 'evidence-winner',
        scores: [],
      },
      validationFailures: [String(error)],
      ruleId: parsedArtificer.ruleId,
    };
  }
}

/* eslint-disable @typescript-eslint/max-params -- Reason: Function signature requires all parameters for type-safe candidate persistence */
function maybePersistArtificerCandidate(
  workspaceDir: string,
  stateDir: string,
  selectedPrincipleId: string,
  selectedSessionId: string,
  snapshot: NocturnalSessionSnapshot,
  artifact: NocturnalArtifact,
  options: NocturnalServiceOptions
): NocturnalArtificerDiagnostics {
  const ruleResolution = resolveArtificerTargetRule(
    stateDir,
    selectedPrincipleId,
    snapshot
  );

  if (ruleResolution.status !== 'selected') {
    return {
      status: 'skipped',
      reason: 'no_deterministic_rule',
      ruleResolution,
      validationFailures: [],
    };
  }

  // #219: Detect fallback data source and warn about potential signal inaccuracy
  const validationFailures: string[] = [];
  if (snapshot._dataSource === 'pain_context_fallback') {
    validationFailures.push('fallback_snapshot: stats derived from pain context only (trajectory extractor failed) - signal counts may be undercounted');
  }

  if (!shouldRunArtificer(snapshot, ruleResolution)) {
    return {
      status: 'skipped',
      reason: 'insufficient_signal_density',
      ruleResolution,
      validationFailures,
      ruleId: ruleResolution.ruleId,
    };
  }

  if (!artifact.betterDecision || !artifact.rationale) {
    return {
      status: 'skipped',
      reason: 'missing_scribe_input',
      ruleResolution,
      validationFailures: [],
      ruleId: ruleResolution.ruleId,
    };
  }

  const sourcePainIds = buildPainRefs(snapshot);
  const sourceGateBlockIds = buildGateBlockRefs(snapshot);
  const parsedArtificer =
    options.artificerOutputOverride !== undefined
      ? parseArtificerOutput(options.artificerOutputOverride)
      : buildDefaultArtificerOutput(
          ruleResolution.ruleId,
          artifact,
          artifact.sourceSnapshotRef,
          sourcePainIds,
          sourceGateBlockIds
        );

  if (!parsedArtificer) {
    return {
      status: 'validation_failed',
      reason: 'parse_failed',
      ruleResolution,
      validationFailures: ['Artificer output could not be parsed.'],
      ruleId: ruleResolution.ruleId,
    };
  }

  if (parsedArtificer.ruleId !== ruleResolution.ruleId) {
    return {
      status: 'validation_failed',
      reason: 'rule_mismatch',
      ruleResolution,
      validationFailures: [
        `Resolved rule ${ruleResolution.ruleId} did not match candidate rule ${parsedArtificer.ruleId}.`,
      ],
      ruleId: ruleResolution.ruleId,
    };
  }

  const validation = validateRuleImplementationCandidate(parsedArtificer.candidateSource);
  if (!validation.passed) {
    return {
      status: 'validation_failed',
      reason: 'validator_rejected',
      ruleResolution,
      validationFailures: validation.failures.map((failure) => failure.message),
      ruleId: ruleResolution.ruleId,
    };
  }

  const persisted = persistCodeCandidate(
    workspaceDir,
    stateDir,
    artifact,
    selectedPrincipleId,
    selectedSessionId,
    parsedArtificer
  );
  return {
    ...persisted,
    ruleResolution,
  };
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
    artificer: {
      status: 'skipped',
      ruleResolution: null,
      validationFailures: [],
    },
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
    recentPainContext: options.painContext,
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
  diagnostics.idle = { isIdle: true, mostRecentActivityAt: 0, idleForMs: 0, userActiveSessions: 0, abandonedSessionIds: [], trajectoryGuardrailConfirmsIdle: true, reason: 'preflight passed' };

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
  // eslint-disable-next-line no-useless-assignment -- Reason: initial value unused due to immediate reassignment in all branches
  let trinityArtifact: TrinityDraftArtifact | null = null;
  let trinityResult: TrinityResult | null = null;
  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in all branches before use at line 884
  let rawJson: string;

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
        const {failures} = draftValidation;
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
      trinityArtifact = trinityResult.artifact!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: artifact is validated by validateTrinityDraft which returns valid: true when artifact exists
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

      if (trinityResult.success) {
        // Validate Trinity draft
        const draftValidation = validateTrinityDraft(trinityResult.artifact);
        if (!draftValidation.valid) {
          // Trinity draft invalid — fail closed
          const {failures} = draftValidation;
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
        trinityArtifact = trinityResult.artifact!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: artifact is validated by validateTrinityDraft which returns valid: true when artifact exists
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
    qualityThresholds: {
      thinkingModelDeltaMin: 0.01,
      planningRatioGainMin: -0.5,
    },
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

  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try, catch has early return
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

  try {
    appendArtifactLineageRecord(workspaceDir, {
      artifactKind: 'behavioral-sample',
      artifactId: arbiterResult.artifact.artifactId,
      principleId: selectedPrincipleId,
      ruleId: null,
      sessionId: selectedSessionId,
      sourceSnapshotRef: arbiterResult.artifact.sourceSnapshotRef,
      sourcePainIds: buildPainRefs(snapshot),
      sourceGateBlockIds: buildGateBlockRefs(snapshot),
      storagePath: persistedPath,
      implementationId: null,
      createdAt: arbiterResult.artifact.createdAt,
    });
  } catch (err) {
    console.warn(`[nocturnal-service] Failed to append behavioral artifact lineage: ${String(err)}`);
  }

  diagnostics.artificer = maybePersistArtificerCandidate(
    workspaceDir,
    stateDir,
    selectedPrincipleId,
    selectedSessionId,
    snapshot,
    arbiterResult.artifact,
    options
  );

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
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Reason: mutual recursion between helper functions - reordering would break logical grouping
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
    artificer: {
      status: 'skipped',
      ruleResolution: null,
      validationFailures: [],
    },
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

  // Step 2: Target selection (or use override to skip)
  // eslint-disable-next-line @typescript-eslint/init-declarations -- Reason: assigned immediately in all branches before use
  let selectedPrincipleId: string | undefined;
  // eslint-disable-next-line @typescript-eslint/init-declarations -- Reason: assigned immediately in all branches before use
  let selectedSessionId: string | undefined;
  // eslint-disable-next-line no-useless-assignment -- Reason: initial value unused due to immediate reassignment in all branches
  let snapshot: NocturnalSessionSnapshot | null = null;

      if (options.principleIdOverride && options.snapshotOverride) {
        // Skip Selector: use provided principleId and snapshot directly
        selectedPrincipleId = options.principleIdOverride;
        selectedSessionId = options.snapshotOverride.sessionId;
        snapshot = options.snapshotOverride;
        console.log(`[nocturnal-service] Using override: principleId=${selectedPrincipleId}, sessionId=${selectedSessionId}`);
        // Calculate violation density from snapshot stats for meaningful diagnostics    const snapStats = options.snapshotOverride.stats;
    const totalToolCalls = snapStats?.totalToolCalls ?? 0;
    const failureCount = snapStats?.failureCount ?? 0;
    const violationDensity = totalToolCalls > 0 ? failureCount / totalToolCalls : 0;
    diagnostics.selection = {
      decision: 'selected',
      selectedPrincipleId,
      selectedSessionId,
      skipReason: undefined,
      diagnostics: {
        totalEvaluablePrinciples: 1,  // We provided one principle via override
        filteredByCooldown: 0,
        passedPrinciples: [selectedPrincipleId],
        violatingSessionCount: 1,  // The session we're using
        selectedSessionViolationDensity: violationDensity,
        selectedPrincipleScore: 100,  // Override means high priority
        scoringBreakdown: { override: 100 },
        idleCheckPassed: true,
        cooldownCheckPassed: true,
        quotaCheckPassed: true,
      },
    };
    diagnostics.idle = { isIdle: true, mostRecentActivityAt: 0, idleForMs: 0, userActiveSessions: 0, abandonedSessionIds: [], trajectoryGuardrailConfirmsIdle: true, reason: 'selector skipped (override provided)' };
  } else {
    // Normal Selector path
    console.log(`[nocturnal-service] Step 2/7: Target selection (normal path)`);
    const extractor = createNocturnalTrajectoryExtractor(workspaceDir, stateDir);
    const selector = new NocturnalTargetSelector(workspaceDir, stateDir, extractor, {
      idleCheckOverride: options.idleCheckOverride,
      recentPainContext: options.painContext,
    });

    const selection = selector.select();
    diagnostics.selection = selection;
    console.log(`[nocturnal-service] Selector result: decision=${selection.decision}, skipReason=${selection.skipReason ?? 'none'}`);

    if (selection.decision === 'skip') {
      console.warn(`[nocturnal-service] Target selection skipped: ${selection.skipReason}`);
      return {
        success: false,
        noTargetSelected: true,
        skipReason: selection.skipReason,
        validationFailed: false,
        validationFailures: [],
        diagnostics,
      };
    }

    // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- Reason: selectedPrincipleId/selectedSessionId are reassignable outer lets - destructuring would shadow
    selectedPrincipleId = selection.selectedPrincipleId;
    // eslint-disable-next-line @typescript-eslint/prefer-destructuring -- Reason: selectedPrincipleId/selectedSessionId are reassignable outer lets - destructuring would shadow
    selectedSessionId = selection.selectedSessionId;

    if (!selectedPrincipleId || !selectedSessionId) {
      return {
        success: false,
        noTargetSelected: true,
        validationFailed: false,
        validationFailures: [],
        diagnostics,
      };
    }

    snapshot = extractor.getNocturnalSessionSnapshot(selectedSessionId);
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
    diagnostics.idle = { isIdle: true, mostRecentActivityAt: 0, idleForMs: 0, userActiveSessions: 0, abandonedSessionIds: [], trajectoryGuardrailConfirmsIdle: true, reason: 'preflight passed' };
  }

  // Step 3: Record run start
  void recordRunStart(stateDir, selectedPrincipleId).catch((err) => {
    console.warn(`[nocturnal-service] Failed to record run start: ${String(err)}`);
  });

  // Step 4: Trinity execution via adapter (async)
  // eslint-disable-next-line no-useless-assignment -- Reason: initial value unused due to immediate reassignment in all branches
  let trinityArtifact: TrinityDraftArtifact | null = null;
  let trinityResult: TrinityResult | null = null;
  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in all branches before use
  let rawJson: string;

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

    if (!trinityResult.success) {
      const failures = trinityResult.failures.map((f) => `${f.stage}: ${f.reason}`);
      void recordRunEnd(stateDir, 'failed', { reason: `Trinity override failed: ${failures.join('; ')}` }).catch((err) => {
        console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
      });
      adjustThresholdsFromSignals(stateDir, { malformedRate: 1.0, arbiterRejectRate: 0.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
      return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: [`Trinity override failed: ${failures.join('; ')}`], snapshot, diagnostics };
    }
    trinityArtifact = trinityResult.artifact!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: artifact is validated by validateTrinityDraft which returns valid: true when artifact exists
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

      if (trinityResult.success) {
        const draftValidation = validateTrinityDraft(trinityResult.artifact);
        if (!draftValidation.valid) {
          const {failures} = draftValidation;
          void recordRunEnd(stateDir, 'failed', { reason: `Trinity draft invalid: ${failures.join('; ')}` }).catch((err) => {
            console.warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
          });
          adjustThresholdsFromSignals(stateDir, { malformedRate: 1.0, arbiterRejectRate: 0.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
          return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: failures, snapshot, diagnostics };
        }
        trinityArtifact = trinityResult.artifact!; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- Reason: artifact is validated by validateTrinityDraft which returns valid: true when artifact exists
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
    qualityThresholds: {
      thinkingModelDeltaMin: 0.01,
      planningRatioGainMin: -0.5,
    },
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
  // eslint-disable-next-line @typescript-eslint/init-declarations -- assigned in try, catch has early return
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

  try {
    appendArtifactLineageRecord(workspaceDir, {
      artifactKind: 'behavioral-sample',
      artifactId: arbiterResult.artifact.artifactId,
      principleId: selectedPrincipleId,
      ruleId: null,
      sessionId: selectedSessionId,
      sourceSnapshotRef: arbiterResult.artifact.sourceSnapshotRef,
      sourcePainIds: buildPainRefs(snapshot),
      sourceGateBlockIds: buildGateBlockRefs(snapshot),
      storagePath: persistedPath,
      implementationId: null,
      createdAt: arbiterResult.artifact.createdAt,
    });
  } catch (err) {
    console.warn(`[nocturnal-service] Failed to append behavioral artifact lineage: ${String(err)}`);
  }

  diagnostics.artificer = maybePersistArtificerCandidate(
    workspaceDir,
    stateDir,
    selectedPrincipleId,
    selectedSessionId,
    snapshot,
    arbiterResult.artifact,
    options
  );

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
): (NocturnalArtifact & { persistedAt: string; boundedAction?: BoundedAction })[] {
  const samplePaths = NocturnalPathResolver.listApprovedSamples(workspaceDir);
  const artifacts: (NocturnalArtifact & { persistedAt: string; boundedAction?: BoundedAction })[] = [];

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
