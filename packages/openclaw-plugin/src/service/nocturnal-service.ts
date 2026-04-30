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
import type { RecentPainContext } from './subagent-workflow/types.js';
import type { PluginLogger } from '../openclaw-sdk.js';
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
  type TrinityTelemetry,
  type TrinityResult,
  type TrinityDraftArtifact,
  type TrinityRuntimeAdapter,
  type ArtificerRuleContext,
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
  runArtificerAsync,
  shouldRunArtificer,
  type ArtificerInput,
  type ArtificerLineageMetadata,
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
  getPrincipleSubtree,
  type LedgerRule,
} from '../core/principle-tree-ledger.js';
import {
  checkPreflight,
  recordRunStart,
  recordRunEnd,
  type IdleCheckResult,
  type PreflightCheckResult,
} from './nocturnal-runtime.js';
import { loadNocturnalConfig } from './nocturnal-config.js';
import { atomicWriteFileSync } from '../utils/io.js';
import { NocturnalPathResolver } from '../core/nocturnal-paths.js';
import { registerSample } from '../core/nocturnal-dataset.js';
import { getPrincipleState, setPrincipleState } from '../core/principle-training-state.js';
import type { Implementation } from '../types/principle-tree-schema.js';
import { validateNocturnalSnapshotIngress } from '../core/nocturnal-snapshot-contract.js';
import { EventLogService } from '../core/event-log.js';


// ---------------------------------------------------------------------------
// #251: Sync trainingStore sample counts after registration
// ---------------------------------------------------------------------------

function incrementGeneratedSampleCount(stateDir: string, principleId: string): void {
  try {
    const state = getPrincipleState(stateDir, principleId);
    state.generatedSampleCount += 1;
    setPrincipleState(stateDir, state);
  } catch (err) {
     
    console.warn(`[nocturnal-service] Failed to sync generatedSampleCount for ${principleId}:`, err instanceof Error ? err.stack : err);
  }
}

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

  /**
   * Logger for diagnostic output.
   * When provided, warnings are logged via logger.warn instead of console.warn.
   */
  logger?: PluginLogger;
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

  // #256: Build artifact from actual event content, not just stats counts.
  // Previously the stub only checked stats.failureCount/painEvents/gateBlocks > 0
  // and emitted the same template artifact regardless of what actually happened.
  // Now we examine the actual event data to generate targeted reflections.

  const hasGateBlocks = (snapshot.stats.totalGateBlocks ?? 0) > 0;
  const hasPain = snapshot.stats.totalPainEvents > 0;
  const hasFailures = (snapshot.stats.failureCount ?? 0) > 0;

   
  let badDecision: string;
   
  let betterDecision: string;
   
  let rationale: string;

  if (hasGateBlocks && snapshot.gateBlocks.length > 0) {
    // Use actual gate block content
     
    const block = snapshot.gateBlocks[0];
    const tool = block.toolName ?? 'a tool';
    const file = block.filePath ? ` on ${block.filePath}` : '';
    badDecision = `Attempted to invoke ${tool}${file} without satisfying the gate requirements`;
    betterDecision = `Review the gate block reason "${block.reason ?? 'unspecified'}" and resolve the blocking condition before retrying`;
    rationale = `Gate blocks exist for a reason — bypassing them without understanding the underlying constraint risks unintended consequences. The block on ${tool}${file} indicates the operation exceeded allowed thresholds for the current evolution tier.`;
  } else if (hasPain && snapshot.painEvents.length > 0) {
    // Use actual pain event content
     
    const pain = snapshot.painEvents[0];
    const painSource = pain.source ?? 'unknown';
    const painReason = pain.reason ? `: ${pain.reason}` : '';
    badDecision = `Continued operating despite ${painSource} pain signal (score ${pain.score ?? 'unknown'})${painReason}`;
    betterDecision = `Pause and analyze the ${painSource} signal — the pain indicates accumulated friction that should be diagnosed before proceeding`;
    rationale = `Pain signals from ${painSource} are early warnings of systemic issues. Score ${pain.score ?? 'N/A'} indicates ${((pain.score ?? 0) >= 70) ? 'severe' : ((pain.score ?? 0) >= 40) ? 'moderate' : 'mild'} friction that should be addressed before continuing operations.`;
  } else if (hasFailures && snapshot.toolCalls.length > 0) {
    // Use actual tool failure content
    const failedCall = snapshot.toolCalls.find(tc => tc.outcome === 'failure');
    if (failedCall) {
      const tool = failedCall.toolName ?? 'a tool';
      const file = failedCall.filePath ? ` on ${failedCall.filePath}` : '';
      const error = failedCall.errorMessage ? ` — ${failedCall.errorMessage}` : '';
      badDecision = `Retried ${tool}${file} after failure without first diagnosing the root cause${error}`;
      betterDecision = `Examine the error details (${failedCall.errorType ?? 'unknown type'}${error ? error : ''}) and verify preconditions before attempting ${tool} again`;
      rationale = `Tool failures are opportunities for learning. The ${tool} failure${file} with error type ${failedCall.errorType ?? 'unknown'} suggests a gap in precondition checking or error handling that should be addressed to prevent recurrence.`;
    } else {
      badDecision = `Retried a failing operation without diagnosing the root cause of the failure`;
      betterDecision = `Based on the evidence from the error logs, let me first check the actual source code to understand the precondition before retrying`;
      rationale = `Diagnosing failures before retry prevents repeated failures and respects the cost of each action attempt`;
    }
  } else {
    // Fallback — no specific signal content available
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

  atomicWriteFileSync(artifactPath, JSON.stringify(sampleRecord, null, 2));
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
    try {
      refreshPrincipleLifecycle(workspaceDir, stateDir);
    } catch (err) {
      console.warn('[nocturnal-service] Lifecycle refresh failed after code candidate persistence:', err instanceof Error ? err.stack : err);
    }
    // PD-FUNNEL-2.3: Emit nocturnal_code_candidate_created event
    try {
      const eventLog = EventLogService.get(stateDir, undefined);
      eventLog.recordNocturnalCodeCandidateCreated({
        implementationId,
        artifactId,
        ruleId: parsedArtificer.ruleId,
        persistedPath: assetRoot,
      });
    } catch (evErr) {
      console.warn(`[nocturnal-service] Failed to record nocturnal_code_candidate_created: ${String(evErr)}`);
    }
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

function processArtificerOutput(
  parsedArtificer: ArtificerOutput | null,
  ruleResolution: ArtificerTargetRuleResolution,
  validationFailures: string[],
  stateDir: string,
  workspaceDir: string,
  artifact: NocturnalArtifact,
  selectedPrincipleId: string,
  selectedSessionId: string,
  isStub: boolean
): NocturnalArtificerDiagnostics {
  void stateDir;
  void isStub;

  // Callers guarantee status === 'selected' (skip early-returns are handled
  // before calling this function), but TS doesn't narrow across function
  // boundaries. The cast is safe by construction.
  const ruleId = (ruleResolution as Extract<typeof ruleResolution, { status: 'selected' }>).ruleId;

  if (!parsedArtificer) {
    return {
      status: 'validation_failed',
      reason: 'parse_failed',
      ruleResolution,
      validationFailures: ['Artificer output could not be parsed.'],
      ruleId,
    };
  }

  if (parsedArtificer.ruleId !== ruleId) {
    return {
      status: 'validation_failed',
      reason: 'rule_mismatch',
      ruleResolution,
      validationFailures: [
        `Resolved rule ${ruleId} did not match candidate rule ${parsedArtificer.ruleId}.`,
      ],
      ruleId,
    };
  }

  const validation = validateRuleImplementationCandidate(parsedArtificer.candidateSource);
  if (!validation.passed) {
    return {
      status: 'validation_failed',
      reason: 'validator_rejected',
      ruleResolution,
      validationFailures: validation.failures.map((failure) => failure.message),
      ruleId: (ruleResolution as Extract<typeof ruleResolution, { status: 'selected' }>).ruleId,
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

async function maybePersistArtificerCandidateAsync(
  workspaceDir: string,
  stateDir: string,
  selectedPrincipleId: string,
  selectedSessionId: string,
  snapshot: NocturnalSessionSnapshot,
  artifact: NocturnalArtifact,
  options: NocturnalServiceOptions
): Promise<NocturnalArtificerDiagnostics> {
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

  if (options.runtimeAdapter) {
    const lineage: ArtificerLineageMetadata = {
      artifactKind: 'rule-implementation-candidate',
      sourceSnapshotRef: artifact.sourceSnapshotRef,
      sourcePainIds,
      sourceGateBlockIds,
    };
    const artificerInput: ArtificerInput = {
      principleId: selectedPrincipleId,
      ruleId: ruleResolution.ruleId,
      snapshot,
      scribeArtifact: {
        sessionId: selectedSessionId,
        badDecision: artifact.badDecision,
        betterDecision: artifact.betterDecision,
        rationale: artifact.rationale,
        sourceSnapshotRef: artifact.sourceSnapshotRef,
      },
      lineage,
    };

    const subtree = getPrincipleSubtree(stateDir, selectedPrincipleId);
    const targetRule: LedgerRule | undefined = subtree?.rules.find(
      (entry) => entry.rule.id === ruleResolution.ruleId
    )?.rule;
    const ruleContext: ArtificerRuleContext = {
      ruleName: targetRule?.name ?? ruleResolution.ruleId,
      ruleDescription: targetRule?.description ?? '',
      triggerCondition: targetRule?.triggerCondition ?? '',
      action: targetRule?.action ?? '',
    };

    const trinityConfig: TrinityConfig = {
      useTrinity: true,
      maxCandidates: 3,
      useStubs: false,
      ...options.trinityConfig,
    };
    const telemetry: TrinityTelemetry = {
      chainMode: 'trinity',
      dreamerPassed: true,
      philosopherPassed: true,
      scribePassed: true,
      candidateCount: 1,
      selectedCandidateIndex: 0,
      stageFailures: [],
      usedStubs: false,
    };

    const artificerOutput = await runArtificerAsync(
      artificerInput,
      ruleContext,
      options.runtimeAdapter,
      telemetry,
      trinityConfig
    );

    if (!artificerOutput) {
      const fallbackParsed = buildDefaultArtificerOutput(
        ruleResolution.ruleId,
        artifact,
        artifact.sourceSnapshotRef,
        sourcePainIds,
        sourceGateBlockIds
      );
      return processArtificerOutput(
        fallbackParsed,
        ruleResolution,
        validationFailures,
        stateDir,
        workspaceDir,
        artifact,
        selectedPrincipleId,
        selectedSessionId,
        true
      );
    }

    return processArtificerOutput(
      artificerOutput,
      ruleResolution,
      validationFailures,
      stateDir,
      workspaceDir,
      artifact,
      selectedPrincipleId,
      selectedSessionId,
      false
    );
  }

  if (options.artificerOutputOverride !== undefined) {
    const overrideParsed = parseArtificerOutput(options.artificerOutputOverride);
    return processArtificerOutput(
      overrideParsed,
      ruleResolution,
      validationFailures,
      stateDir,
      workspaceDir,
      artifact,
      selectedPrincipleId,
      selectedSessionId,
      false
    );
  }

  const stubParsed = buildDefaultArtificerOutput(
    ruleResolution.ruleId,
    artifact,
    artifact.sourceSnapshotRef,
    sourcePainIds,
    sourceGateBlockIds
  );
  return processArtificerOutput(
    stubParsed,
    ruleResolution,
    validationFailures,
    stateDir,
    workspaceDir,
    artifact,
    selectedPrincipleId,
    selectedSessionId,
    true
  );
}

  
  
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

  return processArtificerOutput(
    parsedArtificer,
    ruleResolution,
    validationFailures,
    stateDir,
    workspaceDir,
    artifact,
    selectedPrincipleId,
    selectedSessionId,
    true
  );
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
  // Use provided logger or fallback to console
  const logger = options.logger;
   
  const warn = logger?.warn?.bind(logger) ?? console.warn.bind(console);

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
    options.idleCheckOverride,
    !!options.idleCheckOverride // skip cooldown/quota gates for manual/test triggers
  );
  diagnostics.preflight = preflight;

  if (!preflight.canRun) {
    return {
      success: false,
      noTargetSelected: true,
      skipReason: 'preflight_blocked',
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
  const config = loadNocturnalConfig(stateDir);
  void recordRunStart(stateDir, selectedPrincipleId, config.cooldown_ms).catch((err) => {
    warn(`[nocturnal-service] Failed to record run start: ${String(err)}`);
  });

  // -------------------------------------------------------------------------
  // Step 5: Artifact generation (Trinity or single-reflector)
  // -------------------------------------------------------------------------
   
   
  let trinityArtifact: TrinityDraftArtifact | null = null;
  let trinityResult: TrinityResult | null = null;
   
   
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
        warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
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
          warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
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

      if (trinityResult.success) {
        // Validate Trinity draft
        const draftValidation = validateTrinityDraft(trinityResult.artifact);
        if (!draftValidation.valid) {
          // Trinity draft invalid — fail closed
          const {failures} = draftValidation;
          void recordRunEnd(stateDir, 'failed', { reason: `Trinity draft invalid: ${failures.join('; ')}` }).catch((err) => {
            warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
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
          warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
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
  // #256: Use 0 for thinkingModelDeltaMin — Trinity chain (Dreamer→Philosopher→Scribe)
  // already ensures quality. A delta of 0 is valid when both bad and better decisions
  // show equally well-reasoned thinking (the Scribe's job is to contrast decisions,
  // not to make one sound more "cognitive" than the other).
  const arbiterResult = parseAndValidateArtifact(rawJson, {
    expectedPrincipleId: selectedPrincipleId,
    expectedSessionId: selectedSessionId,
    qualityThresholds: {
      thinkingModelDeltaMin: 0,
      planningRatioGainMin: -0.5,
    },
  });
  diagnostics.arbiterResult = arbiterResult;

  if (!arbiterResult.passed || !arbiterResult.artifact) {
    const failures = arbiterResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      warn(`[nocturnal-service] Failed to record run end (arbiter failed): ${String(err)}`);
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
      warn(`[nocturnal-service] Failed to record run end (executability failed): ${String(err)}`);
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
    // PD-FUNNEL-2.3: Emit nocturnal_artifact_persisted event
    try {
      const eventLog = EventLogService.get(stateDir, undefined);
      eventLog.recordNocturnalArtifactPersisted({
        artifactId: artifactWithBoundedAction.artifactId,
        principleId: artifactWithBoundedAction.principleId,
        persistedPath,
      });
    } catch (evErr) {
      console.warn(`[nocturnal-service] Failed to record nocturnal_artifact_persisted: ${String(evErr)}`);
    }
  } catch (err) {
    void recordRunEnd(stateDir, 'failed', { reason: `persistence error: ${String(err)}` }).catch((e) => {
      warn(`[nocturnal-service] Failed to record run end (persistence failed): ${String(e)}`);
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
    const regResult = registerSample(workspaceDir, arbiterResult.artifact, persistedPath, null);
    if (regResult.isNew) {
      incrementGeneratedSampleCount(stateDir, arbiterResult.artifact.principleId);
    }
  } catch (err) {
    // Non-fatal: artifact is persisted, registry is secondary.
    // Log but don't fail the run.
    warn(`[nocturnal-service] Failed to register sample in dataset registry: ${String(err)}`);
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
    warn(`[nocturnal-service] Failed to append behavioral artifact lineage: ${String(err)}`);
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
    warn(`[nocturnal-service] Failed to record run end (success): ${String(err)}`);
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
  // Use provided logger or fallback to console
  const logger = options.logger;
   
  const warn = logger?.warn?.bind(logger) ?? console.warn.bind(console);

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
    options.idleCheckOverride,
    !!options.idleCheckOverride // skip cooldown/quota gates for manual/test triggers
  );
  diagnostics.preflight = preflight;

  if (!preflight.canRun) {
    return { 
      success: false, 
      noTargetSelected: true, 
      skipReason: 'preflight_blocked',
      validationFailed: false, 
      validationFailures: [], 
      diagnostics 
    };
  }

  // Step 2: Target selection (or use override to skip)
   
   
  let selectedPrincipleId: string | undefined;
   
   
  let selectedSessionId: string | undefined;
   
   
  let snapshot: NocturnalSessionSnapshot | null = null;

  if (options.principleIdOverride && options.snapshotOverride) {
    const snapshotValidation = validateNocturnalSnapshotIngress(options.snapshotOverride);
    if (snapshotValidation.status !== 'valid' || !snapshotValidation.snapshot) {
      return {
        success: false,
        skipReason: 'insufficient_snapshot_data',
        noTargetSelected: true,
        validationFailed: true,
        validationFailures: snapshotValidation.reasons.length > 0
          ? snapshotValidation.reasons
          : ['invalid snapshot override'],
        snapshot: undefined,
        diagnostics,
        trinityTelemetry: undefined,
      };
    }

    // Skip Selector: use provided principleId and snapshot directly
    selectedPrincipleId = options.principleIdOverride;
    selectedSessionId = snapshotValidation.snapshot.sessionId;
     
    snapshot = snapshotValidation.snapshot;
    // Calculate violation density from snapshot stats for meaningful diagnostics
    const snapStats = snapshotValidation.snapshot.stats;
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
    diagnostics.idle = {
      isIdle: true,
      mostRecentActivityAt: 0,
      idleForMs: 0,
      userActiveSessions: 0,
      abandonedSessionIds: [],
      trajectoryGuardrailConfirmsIdle: true,
      reason: 'selector skipped (override provided)',
    };
  } else {
    // Normal Selector path
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

     
     
    selectedPrincipleId = selection.selectedPrincipleId;
     
     
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
  const config = loadNocturnalConfig(stateDir);
  void recordRunStart(stateDir, selectedPrincipleId, config.cooldown_ms).catch((err) => {
    warn(`[nocturnal-service] Failed to record run start: ${String(err)}`);
  });

  // Step 4: Trinity execution via adapter (async)
   
   
  let trinityArtifact: TrinityDraftArtifact | null = null;
  let trinityResult: TrinityResult | null = null;
   
   
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
        warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
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

      if (trinityResult.success) {
        const draftValidation = validateTrinityDraft(trinityResult.artifact);
        if (!draftValidation.valid) {
          const {failures} = draftValidation;
          void recordRunEnd(stateDir, 'failed', { reason: `Trinity draft invalid: ${failures.join('; ')}` }).catch((err) => {
            warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
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
          warn(`[nocturnal-service] Failed to record run end: ${String(err)}`);
        });
        adjustThresholdsFromSignals(stateDir, { malformedRate: 1.0, arbiterRejectRate: 0.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
        return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: [`Trinity chain failed: ${failures.join('; ')}`], snapshot, diagnostics };
      }
    } else {
      rawJson = invokeStubReflector(snapshot, selectedPrincipleId);
    }
  }

  // Step 5: Arbiter validation
  // #256: Use 0 for thinkingModelDeltaMin — Trinity chain already ensures quality
  const arbiterResult = parseAndValidateArtifact(rawJson, {
    expectedPrincipleId: selectedPrincipleId,
    expectedSessionId: selectedSessionId,
    qualityThresholds: {
      thinkingModelDeltaMin: 0,
      planningRatioGainMin: -0.5,
    },
  });
  diagnostics.arbiterResult = arbiterResult;

  if (!arbiterResult.passed || !arbiterResult.artifact) {
    const failures = arbiterResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      warn(`[nocturnal-service] Failed to record run end (arbiter failed): ${String(err)}`);
    });
    adjustThresholdsFromSignals(stateDir, { malformedRate: 0.0, arbiterRejectRate: 1.0, executabilityRejectRate: 0.0, qualityDelta: 0.0 });
    return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: failures, diagnostics };
  }

  // Step 6: Executability check
  const execResult = validateExecutability(arbiterResult.artifact);
  if (!execResult.executable) {
    const failures = execResult.failures.map((f) => f.reason);
    void recordRunEnd(stateDir, 'failed', { reason: failures.join('; ') }).catch((err) => {
      warn(`[nocturnal-service] Failed to record run end (executability failed): ${String(err)}`);
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
      warn(`[nocturnal-service] Failed to record run end (persistence failed): ${String(e)}`);
    });
    return { success: false, noTargetSelected: false, validationFailed: true, validationFailures: [`Failed to persist artifact: ${String(err)}`], snapshot, diagnostics };
  }

  // Step 8: Register in dataset lineage
  try {
    const regResult = registerSample(workspaceDir, arbiterResult.artifact, persistedPath, null);
    if (regResult.isNew) {
      incrementGeneratedSampleCount(stateDir, arbiterResult.artifact.principleId);
    }
  } catch (err) {
    warn(`[nocturnal-service] Failed to register sample in dataset registry: ${String(err)}`);
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
    warn(`[nocturnal-service] Failed to append behavioral artifact lineage: ${String(err)}`);
  }

  diagnostics.artificer = await maybePersistArtificerCandidateAsync(
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
    warn(`[nocturnal-service] Failed to record run end (success): ${String(err)}`);
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
