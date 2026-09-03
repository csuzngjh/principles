/**
 * ArtificerRunner — Implementation plan generator for the Internalization Engine (PRI-111).
 *
 * Migrated to extend BasePeerRunner (PRI-302). The shared lease → buildContext →
 * invoke → poll → fetch → validate → succeed/fail pipeline is now in the base
 * class. This file only contains Artificer-specific logic.
 *
 * Key constraints (ADR-0003):
 *   - Uses PDRuntimeAdapter for all LLM execution (no direct SDK calls)
 *   - Does NOT directly invoke Evaluator/RolloutReviewer (host layer enqueues)
 *   - No plugin-layer imports (core is infrastructure-agnostic)
 *   - Uses RuntimeStateManager for all state operations
 *
 * Trust boundary (Artificer is activation-capable, higher risk than upstream runners):
 *   - LLM output enters as `unknown`; only after validateOutput + lineage check
 *     can it be treated as ArtificerRuleOutput
 *   - sourceScribeArtifactId lineage consistency enforced in succeedTask (ERR-004)
 *   - Invalid activation/action/channel cannot succeed commit
 *   - Artifact write failure → retryOrFail, never silent
 *
 * Pipeline:
 *   1. acquireLease — isolated try/catch, lease_conflict is non-mutating
 *   2. resolve Scribe dependency from dependencyTaskIds
 *   3. fetch Scribe artifact via PIArtifactStore
 *   4. startRun with outputSchemaRef: 'artificer-rule-output-v2'
 *   5. pollUntilTerminal (inherited)
 *   6. fetchOutput → validate as unknown → cast to ArtificerRuleOutput
 *   7. checkLineageIntegrity (sourceScribeArtifactId consistency, ERR-008)
 *   8. updateRunOutput → persist serialized output
 *   9. write PIArtifact → markTaskSucceeded with artificer:// resultRef
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 * @see BasePeerRunner in runner/base-peer-runner.ts
 */
import type { RunHandle } from '../runtime-protocol.js';
import type { ArtificerRuleOutput, ArtificerValidator } from './artificer-output.js';
import type { BehaviorExamplePack } from './behavior-example-pack.js';
import type { TaskRecord } from '../task-status.js';
import { PDRuntimeError, type PDErrorCategory, isPDErrorCategory } from '../error-categories.js';
import { computeFeatureFlagsFromConfig, isFeatureEnabled } from '../config/pd-config-feature-flags.js';
import { hydratePITaskRecord, type RepairPayload } from './pitask-metadata.js';
import { ArtificerPromptBuilder, type ArtificerDreamerContext } from './artificer-prompt-builder.js';
import { ARTIFICER_MANIFEST, ARTIFICER_REPAIR_MANIFEST } from './context-manifests.js';
import { reconcileLineageEcho } from './peer-runner-contracts.js';
import type { PIArtifactStore } from './pi-artifact.js';
import {
  resolveRepairReplayContext,
  type RepairReplayContext,
} from './repair-replay-resolver.js';
import type { RelatedContextSource } from './context-resolution.js';
import { BasePeerRunner } from '../runner/base-peer-runner.js';
import type {
  PeerRunnerOptions,
  PeerRunnerDeps,
  PeerRunnerResult,
  PeerRunnerValidationResult,
} from '../runner/peer-runner-types.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { LoadedPredecessorArtifact } from './attach-summary-envelope.js';

// ── Artificer-specific context ──────────────────────────────────────────────

/** Context built by ArtificerRunner.buildContext() and consumed by invokeRuntime(). */
interface ArtificerContext {
  readonly contextHash: string;
  readonly scribeArtifact: string | null;
  readonly sourceScribeArtifactId: string | null;
  /**
   * Prior adversarial replay failures (PRI-428). Non-null only on Round-2+
   * retries inside runAdversarialLoop, read from the task's
   * PITaskMetadata.adversarialFeedback. Forwarded to the prompt builder so the
   * LLM can make targeted corrections.
   */
  readonly adversarialFeedback: string | null;
  /**
   * P1-1: Rollout-reviewer revision feedback. Non-null when this task was
   * reopened by rollout needs_revision routing (code_tool_hook channel).
   * Raw validated text from PITaskMetadata.revisionFeedback; appended to the
   * prompt so the artificer addresses each requiredChange.
   */
  readonly revisionFeedback?: string | null;
  /**
   * Dreamer candidate 5-dim context (PRI-508). Undefined when:
   * - scribe artifact lacks sourceTrace.dreamerArtifactId (pre-PRI-508 flows)
   * - dreamer artifact cannot be resolved (best-effort, non-blocking)
   * - dreamer artifact contentJson fails runtime validation
   * Lineage: scribe.sourceTrace.dreamerArtifactId → dreamer artifact → candidates[0] (rc-6).
   */
  readonly dreamerContext?: ArtificerDreamerContext;
  /**
   * Evaluator repair feedback (PRI-509). Non-null only on artificer repair
   * tasks seeded by evaluator needs_revision. Constructed by buildContext from
   * the task's PITaskMetadata.repairPayload (already validated by
   * isValidRepairPayload in pitask-metadata.ts). Forwarded to the prompt
   * builder so the LLM addresses each requiredChange instead of regenerating
   * blind. Null on Round-1 artificer tasks (backward compatible).
   *
   * Loop state freshness (rc-7, EP-05): repairPayload.repairIteration is
   * written at task creation time, never inferred at read. Each repair round
   * reads the current evaluator's feedback — never a cached value.
   *
   * PR B: this is the NO-REPLAY base string (concerns + required changes).
   * The deterministic replay evidence is carried separately by `replayContext`
   * so the Shared Information Plane can choose its channel (design §26/§35):
   *   - manifest focused  → `replay.*` fields carry it, base string is used;
   *   - flag off/fallback → the PR-A evidence block is appended here, because
   *     the replay evidence MUST survive the flag-off production path.
   */
  readonly repairFeedback: string | null;
  /**
   * The current task's validated RepairPayload (PR B). Ephemeral — it is the
   * already-durable task metadata, re-read here only so invokeRuntime can
   * re-render the feedback string with the channel-appropriate replay block.
   * It is never re-persisted and never gains `failedCases` (design §21).
   */
  readonly repairPayload?: RepairPayload;
  /**
   * PR-A resolved deterministic replay evidence (PR B). Present only when this
   * repair round's source replay ran and FAILED. Ephemeral: exists for this
   * buildContext/invokeRuntime pair, never persisted, never a second fact store
   * — the durable authority remains the source Evaluator artifact.
   */
  readonly replayContext?: RepairReplayContext;
}

/**
 * Layer 0 (design §6.1): artificer's edge predecessor is `scribe`, whose
 * artifact `buildContext` already loaded. Reusing that string keeps the writer
 * path at zero extra store reads (F3). Returns null when no scribe artifact
 * was resolved (buildContext's `empty-context` short-circuit, or a missing
 * sourceTrace) — the writer then emits `artifact_summary_predecessor_absent`
 * and writes only the self `summary` (rc-9).
 */
function toScribePredecessor(context: ArtificerContext): LoadedPredecessorArtifact | null {
  if (!context.scribeArtifact || !context.sourceScribeArtifactId) return null;
  let contentJson: unknown;
  try {
    contentJson = JSON.parse(context.scribeArtifact);
  } catch {
    contentJson = context.scribeArtifact;
  }
  return {
    artifactId: context.sourceScribeArtifactId,
    runnerKind: 'scribe',
    contentJson,
  };
}

// ── Result Types (backward-compatible exports) ───────────────────────────────

export type ArtificerRunnerResultStatus = 'succeeded' | 'failed' | 'retried';

export interface ArtificerRunnerResult {
  readonly status: ArtificerRunnerResultStatus;
  readonly taskId: string;
  readonly runId?: string;
  readonly artifactId?: string;
  readonly resultRef?: string;
  readonly contextHash?: string;
  readonly output?: ArtificerRuleOutput;
  readonly errorCategory?: PDErrorCategory;
  readonly failureReason?: string;
  readonly attemptCount: number;
}

// ── Constructor Options (backward-compatible exports) ────────────────────────

export interface ArtificerRunnerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly defaultMaxAttempts?: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId?: string;
}

export interface ResolvedArtificerRunnerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly owner: string;
  readonly runtimeKind: string;
  readonly agentId: string;
}

const DEFAULT_ARTIFICER_RUNNER_OPTIONS: Readonly<Omit<ResolvedArtificerRunnerOptions, 'owner' | 'runtimeKind'>> = {
  pollIntervalMs: 5_000,
  timeoutMs: 300_000,
  defaultMaxAttempts: 3,
  agentId: 'artificer',
} as const;

export function resolveArtificerRunnerOptions(options: ArtificerRunnerOptions): ResolvedArtificerRunnerOptions {
  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.pollIntervalMs,
    timeoutMs: options.timeoutMs ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.timeoutMs,
    defaultMaxAttempts: options.defaultMaxAttempts ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.defaultMaxAttempts,
    owner: options.owner,
    runtimeKind: options.runtimeKind,
    agentId: options.agentId ?? DEFAULT_ARTIFICER_RUNNER_OPTIONS.agentId,
  };
}

// ── Dependencies (backward-compatible; extends PeerRunnerDeps) ───────────────

export interface ArtificerRunnerDeps extends PeerRunnerDeps {
  readonly validator: ArtificerValidator;
  readonly contextMode?: 'v1' | 'v2';
  readonly behaviorExamplePack?: BehaviorExamplePack;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── PRI-508: Dreamer context extraction ─────────────────────────────────────

/**
 * Resolve the dreamer candidate 5-dim context from the dreamer artifact
 * referenced by `scribe.sourceTrace.dreamerArtifactId`.
 *
 * Trust boundary (rc-1, rc-2): scribe contentJson and dreamer contentJson are
 * untrusted. All field access uses Object.hasOwn (rc-5) and typeof / Array.isArray
 * guards (rc-4) — no `as` casts that bypass validation.
 *
 * Lineage consistency (rc-6): dreamerContext comes from the exact artifact
 * referenced by the scribe's sourceTrace.dreamerArtifactId — never inferred.
 *
 * Fail-loud / no silent fallback (rc-3, rc-9): when dreamerArtifactId is present
 * but the dreamer artifact cannot be resolved or fails validation, emits a
 * `dreamer_artifact_missing` / `dreamer_context_invalid` event so the gap is
 * observable. Returns undefined (best-effort, non-blocking) so the artificer
 * can still proceed with the scribe principle alone.
 */
async function resolveDreamerContext(params: {
  scribeContentJson: string;
  artifactStore: Pick<PIArtifactStore, 'getArtifactById'>;
  taskId: string;
  emitEvent: (eventName: string, taskId: string, payload: Record<string, unknown>) => void;
}): Promise<ArtificerDreamerContext | undefined> {
  const { scribeContentJson, taskId, emitEvent } = params;

  // Parse scribe contentJson as unknown — never trust the shape (rc-1).
  let scribeParsed: unknown;
  try {
    scribeParsed = JSON.parse(scribeContentJson);
  } catch {
    // Scribe contentJson malformed — cannot resolve dreamer lineage.
    emitEvent('dreamer_context_skipped', taskId, { reason: 'scribe_contentJson_unparseable' });
    return undefined;
  }
  if (!isRecord(scribeParsed)) return undefined;

  // rc-5: use Object.hasOwn, not `in`.
  if (!Object.hasOwn(scribeParsed, 'sourceTrace') || !isRecord(scribeParsed.sourceTrace)) {
    // scribe has no sourceTrace.dreamerArtifactId — pre-PRI-508 flow, backward compatible.
    return undefined;
  }
  const { sourceTrace } = scribeParsed;
  if (!Object.hasOwn(sourceTrace, 'dreamerArtifactId') || sourceTrace.dreamerArtifactId === undefined) {
    return undefined;
  }
  const { dreamerArtifactId } = sourceTrace;
  if (typeof dreamerArtifactId !== 'string' || dreamerArtifactId.trim() === '') {
    emitEvent('dreamer_context_skipped', taskId, { reason: 'dreamerArtifactId_not_string', dreamerArtifactId });
    return undefined;
  }

  // Fetch the dreamer artifact via the canonical source (rc-6 lineage).
  const dreamerArtifact = await params.artifactStore.getArtifactById(dreamerArtifactId);
  if (!dreamerArtifact) {
    // rc-9: observable event — do NOT silently swallow.
    emitEvent('dreamer_artifact_missing', taskId, { dreamerArtifactId });
    return undefined;
  }

  let dreamerParsed: unknown;
  try {
    dreamerParsed = JSON.parse(dreamerArtifact.contentJson);
  } catch {
    emitEvent('dreamer_context_invalid', taskId, { dreamerArtifactId, reason: 'contentJson_unparseable' });
    return undefined;
  }
  if (!isRecord(dreamerParsed)) {
    emitEvent('dreamer_context_invalid', taskId, { dreamerArtifactId, reason: 'content_not_record' });
    return undefined;
  }

  // rc-4: validate candidates is a non-empty array, then element[0] shape.
  // rc-2: avoid `as` cast — let `Array.isArray` type-guard narrow the local var.
  if (!Object.hasOwn(dreamerParsed, 'candidates')) {
    emitEvent('dreamer_context_invalid', taskId, { dreamerArtifactId, reason: 'candidates_not_array' });
    return undefined;
  }
  const candidatesField: unknown = dreamerParsed.candidates;
  if (!Array.isArray(candidatesField)) {
    emitEvent('dreamer_context_invalid', taskId, { dreamerArtifactId, reason: 'candidates_not_array' });
    return undefined;
  }
  if (candidatesField.length === 0) {
    emitEvent('dreamer_context_invalid', taskId, { dreamerArtifactId, reason: 'candidates_empty' });
    return undefined;
  }
  const [firstCandidate] = candidatesField;
  if (!isRecord(firstCandidate)) {
    emitEvent('dreamer_context_invalid', taskId, { dreamerArtifactId, reason: 'candidate0_not_record' });
    return undefined;
  }

  // Validate the 5-dim fields. badDecision/betterDecision/rationale are required strings.
  // riskLevel/strategicPerspective are optional but must be string when present.
  const requiredString = (key: string): string | undefined => {
    if (!Object.hasOwn(firstCandidate, key)) return undefined;
    const value = firstCandidate[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  const badDecision = requiredString('badDecision');
  const betterDecision = requiredString('betterDecision');
  const rationale = requiredString('rationale');
  if (badDecision === undefined || betterDecision === undefined || rationale === undefined) {
    emitEvent('dreamer_context_invalid', taskId, {
      dreamerArtifactId,
      reason: 'missing_required_5dim_fields',
      hasBadDecision: badDecision !== undefined,
      hasBetterDecision: betterDecision !== undefined,
      hasRationale: rationale !== undefined,
    });
    return undefined;
  }

  const riskLevel = requiredString('riskLevel');
  const strategicPerspective = requiredString('strategicPerspective');

  const dreamerContext: ArtificerDreamerContext = {
    badDecision,
    betterDecision,
    rationale,
    ...(riskLevel !== undefined ? { riskLevel } : {}),
    ...(strategicPerspective !== undefined ? { strategicPerspective } : {}),
  };
  return dreamerContext;
}

// ── PRI-509: Evaluator repair feedback formatting ───────────────────────────

/**
 * PRI-634 PR-A: render the resolved deterministic replay evidence for the
 * repair prompt. Each entry names the concrete caseId, the expected decision,
 * the actual decision (only when the rule really produced one), the sandbox
 * errorType, and a bounded safe message — never a bare "N failed" label.
 */
function formatReplayEvidenceBlock(context: RepairReplayContext): string {
  const lines: string[] = [
    `Deterministic Replay Evidence (resolved by reference from evaluator artifact ${context.sourceEvaluatorArtifactId}; total failed cases: ${context.failedCaseCount}):`,
  ];
  for (const violation of context.globalViolations) {
    lines.push(`- Global violation | ${violation}`);
  }
  if (context.globalViolationCount > context.globalViolations.length) {
    lines.push(`- (global violations truncated: ${context.globalViolationCount} durable, showing ${context.globalViolations.length})`);
  }
  for (const failure of [...context.systemFailures, ...context.traceFailures]) {
    const parts: string[] = [`Case: ${failure.caseId}`];
    if (failure.expectedDecision !== undefined) parts.push(`Expected: ${failure.expectedDecision}`);
    if (failure.actualDecision !== undefined) parts.push(`Actual: ${failure.actualDecision}`);
    parts.push(`Error: ${failure.errorType}`);
    if (failure.message !== undefined) parts.push(`Message: ${failure.message}`);
    lines.push(`- ${parts.join(' | ')}`);
  }
  if (context.truncated) {
    const shown = context.systemFailures.length + context.traceFailures.length + context.globalViolations.length;
    // `failedCaseCount` is the pre-selection durable total and ALREADY includes
    // the forbidden-pattern entries that were partitioned into
    // `globalViolations` — adding `globalViolationCount` would double-count
    // them (P2 review finding, carried into PR B).
    lines.push(`- (evidence truncated: ${context.failedCaseCount} durable entries, showing ${shown} stratified representatives)`);
  }
  return lines.join('\n');
}

/**
 * PR B: expose the RepairPayload and the PR-A replay evidence as RELATED
 * context sources (design §33). They are causal references — NOT ancestry — so
 * nothing here reaches into `lineageArtifactIds`.
 *
 * The replay values come straight from the already-bounded
 * `RepairReplayContext`: the information plane therefore inherits PR A's ≤16
 * selection (`MAX_REPLAY_FAILURES_IN_REPAIR`) and never re-expands the durable
 * `failedCases` array (design §43).
 */
function buildRepairRelatedSources(context: ArtificerContext): readonly RelatedContextSource[] {
  const sources: RelatedContextSource[] = [];
  const { replayContext, repairPayload } = context;

  if (repairPayload !== undefined) {
    sources.push({
      namespace: 'repair',
      summary: {
        requiredChanges: repairPayload.requiredChanges,
        concerns: repairPayload.concerns,
      },
    });
  }

  if (replayContext !== undefined) {
    const failureTypes = new Set<string>();
    for (const failure of [...replayContext.systemFailures, ...replayContext.traceFailures]) {
      failureTypes.add(failure.errorType);
    }
    sources.push({
      namespace: 'replay',
      summary: {
        passed: replayContext.passed,
        failedCaseCount: replayContext.failedCaseCount,
        // Deterministic: sorted, so the same context always renders identically.
        failureTypes: [...failureTypes].sort(),
      },
      raw: {
        traceFailures: replayContext.traceFailures,
        systemFailures: replayContext.systemFailures,
        globalViolations: replayContext.globalViolations,
      },
    });
  }

  return sources;
}

/**
 * Format a validated RepairPayload into a repairFeedback string for the
 * artificer prompt. The format is PoC-validated (Campaign 1 R2):
 *
 *   Previous attempt scored <previousScore> (needs_revision).
 *   Evaluator concerns:
 *   1. <concern1>
 *   2. <concern2>
 *   Required changes:
 *   1. <change1>
 *   2. <change2>
 *   Fix ALL the above.
 *
 * Trust boundary (rc-1, rc-2): the RepairPayload was already validated by
 * isValidRepairPayload in pitask-metadata.ts (called inside hydratePITaskRecord).
 * By the time we receive it here, requiredChanges is a non-empty readonly
 * string array and concerns is a readonly string array (possibly empty).
 * No further `as` casts or shape checks are needed — we treat the validated
 * payload as typed text input for the prompt.
 *
 * Loop state freshness (rc-7, EP-05): the caller passes the CURRENT task's
 * repairPayload — never a cached or stale value. repairIteration tells the
 * artificer which round it's in (1 = first repair, 2 = second repair).
 *
 * PRI-634 PR-A: when the caller resolved concrete replay evidence (read-only
 * from the source Evaluator artifact), the evidence block REPLACES the old
 * "(failed cases: N)" summary line — failure must increase information.
 */
function formatRepairFeedback(payload: RepairPayload, replayEvidence?: string): string {
  const concernsLines = payload.concerns.length > 0
    ? payload.concerns.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none)';
  const changesLines = payload.requiredChanges.map((c, i) => `${i + 1}. ${c}`).join('\n');
  // PRI-634 R4 (P1-2): surface the diagnostic replay evidence from the
  // rejecting evaluator round. Replay passing ≠ semantically correct (the
  // verdict stays needs_revision), but tells the Artificer what the
  // deterministic gate did observe — failed cases are actionable signals.
  const replayLines = payload.diagnosticReplay
    ? replayEvidence !== undefined
      ? [replayEvidence]
      : [
          `Deterministic adversarial replay: ${payload.diagnosticReplay.ran ? (payload.diagnosticReplay.passed ? 'PASSED' : 'FAILED') : 'not run'} (failed cases: ${payload.diagnosticReplay.failedCaseCount}). This is diagnostic evidence only — the evaluator verdict remains needs_revision.`,
        ]
    : [];
  return [
    `Previous attempt scored ${payload.previousScore} (needs_revision).`,
    ...replayLines,
    `Evaluator concerns:`,
    concernsLines,
    `Required changes:`,
    changesLines,
    `Fix ALL the above.`,
  ].join('\n');
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepJsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepJsonEqual(left[key], right[key]));
}

function validateContextModeOutput(
  output: unknown,
  contextMode: 'v1' | 'v2',
  pack: BehaviorExamplePack | undefined,
): string[] {
  if (!isRecord(output)) return [];
  if (contextMode === 'v1') {
    return Object.hasOwn(output, 'requiresContextVersion')
      ? ['v1 Artificer output must not declare requiresContextVersion']
      : [];
  }
  const errors: string[] = [];
  if (output.requiresContextVersion !== 2) errors.push('v2 Artificer output must declare requiresContextVersion: 2');
  if (!pack) {
    errors.push('v2 Artificer output cannot be validated without BehaviorExamplePack');
    return errors;
  }
  if (!Array.isArray(output.goldenTraceCases)) {
    errors.push('v2 Artificer output must contain goldenTraceCases');
    return errors;
  }
  const expectedCases = [pack.sourceNegativeCase, ...pack.positiveCounterexamples];
  const protectedFields = ['kind', 'toolName', 'params', 'expectedDecision', 'ruleContext'] as const;
  for (const expected of expectedCases) {
    const actual = output.goldenTraceCases.find((entry: unknown) => isRecord(entry) && entry.caseId === expected.caseId);
    if (!isRecord(actual)) {
      errors.push(`Owner-labelled example ${expected.caseId} was omitted`);
      continue;
    }
    for (const field of protectedFields) {
      if (!deepJsonEqual(actual[field], expected[field])) {
        errors.push(`Owner-labelled example ${expected.caseId}.${field} was rewritten`);
      }
    }
  }
  // PRI-490: v2 output evidenceRefs must match pack evidenceRefs exactly.
  // LLM must copy evidenceRefs verbatim — no omission, reordering, or rewriting.
  const outputEvidenceRefs = output.evidenceRefs;
  if (!Array.isArray(outputEvidenceRefs)) {
    errors.push('v2 Artificer output must include evidenceRefs array');
  } else {
    const packRefs = [...pack.evidenceRefs];
    if (outputEvidenceRefs.length !== packRefs.length
      || !outputEvidenceRefs.every((ref: unknown, i: number) => typeof ref === 'string' && ref === packRefs[i])) {
      errors.push('v2 Artificer output evidenceRefs must exactly match behaviorExamplePack.evidenceRefs');
    }
  }
  return errors;
}

// ── ArtificerRunner ──────────────────────────────────────────────────────────

/** Options for the ArtificerRunner. Adds effectiveConfig for feature flag
 * resolution (Issue 2: `artificer_output_retry`), mirroring the diagnostician
 * runners' pattern (diag-rootcause/diag-distiller). */
export interface ArtificerRunnerOptions extends PeerRunnerOptions {
  /** Effective PD config for feature flag resolution (ADR-0019). */
  readonly effectiveConfig?: EffectivePdConfig;
}

export class ArtificerRunner extends BasePeerRunner<ArtificerContext, ArtificerRuleOutput> {
  private readonly validator: ArtificerValidator;
  private readonly contextMode: 'v1' | 'v2';
  private readonly behaviorExamplePack: BehaviorExamplePack | undefined;

  constructor(deps: ArtificerRunnerDeps, options: ArtificerRunnerOptions) {
    super(deps, options, {
      runnerName: 'artificer',
      expectedTaskKind: 'artificer',
      defaultAgentId: 'artificer',
      resultRefPrefix: 'artificer',
      // ADR-0019: pass effectiveConfig so isArtificerOutputRetryEnabled() can
      // read the `artificer_output_retry` feature flag (Issue 2).
      effectiveConfig: options.effectiveConfig,
    });
    this.validator = deps.validator;
    this.contextMode = deps.contextMode ?? 'v1';
    this.behaviorExamplePack = deps.behaviorExamplePack;
  }

  // ── Abstract implementations ───────────────────────────────────────────────

  /**
   * Permanent error categories for the artificer runner.
   *
   * Issue 2 (Codex E2E): `output_invalid` (malformed LLM output, e.g. the LLM
   * never calls submit_rulecode) was unconditionally permanent → the
   * internalization pipeline dead-ends with no retry/fallback. When the
   * `artificer_output_retry` flag is ON, `output_invalid` is excluded so the
   * base runner's retry policy (bounded by task.maxAttempts) retries it.
   * Flag-off / no effectiveConfig = legacy behavior (permanent failure).
   */
  get permanentErrorCategories(): ReadonlySet<PDErrorCategory> {
    const base = new Set<PDErrorCategory>([
      'storage_unavailable',
      'workspace_invalid',
      'capability_missing',
      'cancelled',
      'input_invalid',
    ]);
    if (!this.isArtificerOutputRetryEnabled()) {
      base.add('output_invalid');
    }
    return base;
  }

  /**
   * Issue 2: whether the `artificer_output_retry` feature flag is on.
   * Reads from effectiveConfig; returns false when absent (legacy behavior —
   * output_invalid stays permanent). Mirrors isDegradationEnabled (ADR-0019).
   */
  private isArtificerOutputRetryEnabled(): boolean {
    const { effectiveConfig } = this.config;
    if (!effectiveConfig) return false;
    const flags = computeFeatureFlagsFromConfig(effectiveConfig);
    return isFeatureEnabled(flags, 'artificer_output_retry');
  }

  async buildContext(taskId: string): Promise<ArtificerContext> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      throw new PDRuntimeError('input_invalid', `Task ${taskId} not found`);
    }

    const piTask = hydratePITaskRecord(task);
    const deps = piTask?.dependencyTaskIds ?? [];

    // PRI-428: carry prior adversarial replay failures into the prompt when
    // this is a Round-2+ retry. Validated as non-empty string by the metadata
    // parser; null when absent (Round 1 / non-loop invocations).
    const adversarialFeedback = typeof piTask?.adversarialFeedback === 'string'
      && piTask.adversarialFeedback.trim() !== ''
      ? piTask.adversarialFeedback
      : null;

    // PRI-509: carry evaluator repair feedback into the prompt when this is
    // an artificer repair task seeded by evaluator needs_revision. The
    // repairPayload was already validated by isValidRepairPayload in
    // pitask-metadata.ts (called inside hydratePITaskRecord); we treat the
    // hydrated value as typed text input and format it for the prompt.
    // rc-7 (loop state freshness): repairPayload comes from the CURRENT task's
    // diagnosticJson — never a cached or inferred value. repairIteration tells
    // the artificer which round it's in.
    //
    // PRI-634 PR-A: when the diagnostic replay ran and FAILED, the concrete
    // evidence is resolved BY REFERENCE from the source Evaluator artifact
    // (read-only; no facts are copied into RepairPayload). If the durable
    // evidence cannot be resolved, the repair round fails loud
    // (repair_replay_evidence_unavailable) instead of consuming a blind LLM
    // retry — failure must increase information (SPEC §27).
    let repairFeedback: string | null = null;
    let repairPayload: RepairPayload | undefined;
    let replayContext: RepairReplayContext | undefined;
    if (piTask?.repairPayload) {
      const payload = piTask.repairPayload;
      repairPayload = payload;
      if (payload.diagnosticReplay?.ran === true && payload.diagnosticReplay.passed === false) {
        const resolution = await resolveRepairReplayContext({
          sourceEvaluatorTaskId: payload.sourceEvaluatorTaskId,
          deps: {
            artifactStore: this.artifactStore,
            getTask: (tid: string) => this.stateManager.getTask(tid),
          },
        });
        if (resolution.ok) {
          // PR B: keep the resolved evidence object ephemeral on the context.
          // The prompt channel is chosen in invokeRuntime (design §26).
          replayContext = resolution.context;
          this.emitEvent('repair_replay_evidence_resolved', taskId, {
            sourceEvaluatorTaskId: payload.sourceEvaluatorTaskId,
            sourceEvaluatorArtifactId: resolution.context.sourceEvaluatorArtifactId,
            failedCaseCount: resolution.context.failedCaseCount,
            truncated: resolution.context.truncated,
          });
        } else {
          this.emitEvent('repair_replay_evidence_unavailable', taskId, {
            sourceEvaluatorTaskId: payload.sourceEvaluatorTaskId,
            reason: resolution.reason,
            detail: resolution.detail,
            nextAction: 'verify_source_evaluator_artifact_durability_before_repair_retry',
          });
          throw new PDRuntimeError(
            'input_invalid',
            `repair_replay_evidence_unavailable: diagnosticReplay reported FAILED (failed cases: ${payload.diagnosticReplay.failedCaseCount}) but the replay evidence could not be resolved from evaluator task ${payload.sourceEvaluatorTaskId} (${resolution.reason}: ${resolution.detail}). Refusing to consume a blind repair LLM round.`,
          );
        }
      }
      // Base string carries concerns + required changes only; the replay
      // evidence is appended in invokeRuntime according to the chosen channel.
      repairFeedback = formatRepairFeedback(payload);
    }

    // PR B: ephemeral repair/replay evidence for the Shared Information Plane.
    // Both are read-only views of already-durable facts; neither is persisted
    // here and neither widens RepairPayload (design §21/§28).
    const repairEvidenceExtras = {
      ...(repairPayload !== undefined ? { repairPayload } : {}),
      ...(replayContext !== undefined ? { replayContext } : {}),
    };

    // P1-1 (外部复核): rollout needs_revision 路由到 artificer (code 渠道) 时,
    // revisionFeedback 携带 reviewer requiredChanges — 与 repairPayload 同等
    // 注入 prompt,避免"路由到 artificer 但反馈丢失"。rc-7: 从当前任务元数据读取。
    const revisionFeedback = typeof piTask?.revisionFeedback === 'string' && piTask.revisionFeedback.trim() !== ''
      ? piTask.revisionFeedback
      : null;

    if (deps.length === 0) {
      this.emitEvent('no_dependencies', taskId, {});
      return { contextHash: 'empty', scribeArtifact: null, sourceScribeArtifactId: null, adversarialFeedback, repairFeedback, revisionFeedback, ...repairEvidenceExtras };
    }

    for (const depId of deps) {
      const depTask = await this.stateManager.getTask(depId);
      if (!depTask) continue;
      if (depTask.taskKind !== 'scribe') continue;
      if (depTask.status !== 'succeeded') {
        this.emitEvent('dependency_not_succeeded', taskId, {
          depTaskId: depId,
          depStatus: depTask.status,
        });
        continue;
      }

      const artifacts = await this.artifactStore.listBySourceTaskId(depId);
      if (artifacts.length > 0) {
        const [firstArtifact] = artifacts;
        if (!firstArtifact) continue;
        const artifactRef = firstArtifact.artifactId;
        this.emitEvent('scribe_dep_selected', taskId, {
          depTaskId: depId,
          artifactId: firstArtifact.artifactId,
        });

        // PRI-508: resolve dreamer candidate 5-dim context from the dreamer
        // artifact referenced by scribe.sourceTrace.dreamerArtifactId.
        // Best-effort: undefined when absent or invalid (backward compatible).
        // rc-9: emits observable events on resolution failure — no silent fallback.
        const dreamerContext = await resolveDreamerContext({
          scribeContentJson: firstArtifact.contentJson,
          artifactStore: this.artifactStore,
          taskId,
          emitEvent: (eventName, tId, payload) => this.emitEvent(eventName, tId, payload),
        });

        return {
          contextHash: BasePeerRunner.hashContextRefs([artifactRef]),
          scribeArtifact: firstArtifact.contentJson,
          sourceScribeArtifactId: firstArtifact.artifactId,
          adversarialFeedback,
          repairFeedback,
          revisionFeedback,
          ...repairEvidenceExtras,
          ...(dreamerContext !== undefined ? { dreamerContext } : {}),
        };
      }
    }

    this.emitEvent('no_scribe_artifact', taskId, {});
    return { contextHash: 'empty', scribeArtifact: null, sourceScribeArtifactId: null, adversarialFeedback, repairFeedback, ...repairEvidenceExtras };
  }

  async invokeRuntime(taskId: string, context: ArtificerContext): Promise<RunHandle> {
    if (!context.scribeArtifact || !context.sourceScribeArtifactId) {
      throw new PDRuntimeError('input_invalid', 'Scribe dependency artifact not resolved');
    }

    let scribeArtifactInput: unknown;
    try {
      scribeArtifactInput = JSON.parse(context.scribeArtifact);
    } catch {
      scribeArtifactInput = context.scribeArtifact;
    }

    // Layer 1 (design §6.2/§6.3, task 5.9) + PR B Shared Information Plane:
    // resolve the manifest against the scribe predecessor's summary envelope,
    // the durable CandidateLineage ancestry (tier2 raw), and — for repair
    // rounds — the related replay evidence. Focused → inject only the
    // allocated fields; fallback/disabled → legacy full scribeArtifact (F13).
    const scribePred = toScribePredecessor(context);
    let replayViaManifest = false;
    if (scribePred !== null) {
      const isRepair = context.replayContext !== undefined;
      const manifest = isRepair ? ARTIFICER_REPAIR_MANIFEST : ARTIFICER_MANIFEST;
      const relatedSources = isRepair ? buildRepairRelatedSources(context) : undefined;
      // Required-evidence gate (design §35/§43): on a repair round the replay
      // evidence MUST reach the prompt. If the manifest budget cannot carry it,
      // resolution falls back and the bounded PR-A string channel is used
      // instead of injecting a thinner prompt. Normal artificer tier2 stays
      // optional — `dreamerContext` (PRI-508, F2) is its safety net.
      const resolved = await this.resolveContextInjectionAsync({
        taskId,
        manifest,
        predecessorContentJson: scribePred.contentJson,
        startArtifactId: context.sourceScribeArtifactId ?? undefined,
        ...(relatedSources !== undefined ? { relatedSources } : {}),
        requiredPaths: isRepair ? [...ARTIFICER_REPAIR_MANIFEST.tier2] : [],
      });
      if (resolved.mode === 'focused') {
        scribeArtifactInput = resolved.fields;
        replayViaManifest = isRepair;
      }
    }

    // PR B (design §26): pick the replay-evidence channel. When the manifest
    // carried it, the base string keeps concerns + required changes only; when
    // the flag is off (or the budget could not carry the evidence) the PR-A
    // bounded evidence block is appended — exactly the pre-PR-B behavior, so
    // the replay evidence never depends on a quiet flag being on.
    let { repairFeedback } = context;
    const { replayContext, repairPayload } = context;
    if (replayContext !== undefined && repairPayload !== undefined && !replayViaManifest) {
      repairFeedback = formatRepairFeedback(repairPayload, formatReplayEvidenceBlock(replayContext));
    }

    const builder = new ArtificerPromptBuilder();
    const { message } = builder.buildPrompt({
      contextMode: this.contextMode,
      behaviorExamplePack: this.behaviorExamplePack,
      taskId,
      contextHash: context.contextHash,
      scribeArtifact: scribeArtifactInput,
      sourceScribeArtifactId: context.sourceScribeArtifactId,
      adversarialFeedback: context.adversarialFeedback ?? undefined,
      // PRI-508: forward dreamer 5-dim context to artificer prompt so artificer
      // can produce implementations aligned with dreamer's badDecision/betterDecision intent.
      dreamerContext: context.dreamerContext,
      // PRI-509: forward evaluator repair feedback so artificer addresses each
      // requiredChange instead of regenerating blind. Undefined when absent
      // (prompt builder treats undefined as backward-compatible no-op).
      // PR B: channel-resolved — see the block above.
      repairFeedback: repairFeedback ?? undefined,
    });
    // P1-1: rollout revision feedback 注入 (与 scribe 同模式; repairFeedback
    // 走 prompt builder 字段,revisionFeedback 是路由文本,直接附加)
    const finalMessage = context.revisionFeedback
      ? `${message}

<rollout_revision_feedback>
${context.revisionFeedback}
</rollout_revision_feedback>`
      : message;

    return this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.resolvedOptions.agentId, schemaVersion: 'v1' },
      taskRef: { taskId },
      inputPayload: finalMessage,
      contextItems: [],
      outputSchemaRef: 'artificer-rule-output-v2',
      timeoutMs: this.resolvedOptions.timeoutMs,
    });
  }

  async validateOutput(output: unknown, taskId: string, context: ArtificerContext): Promise<PeerRunnerValidationResult> {
    const result = await this.validator.validate(output, taskId, context.sourceScribeArtifactId ?? undefined);
    const modeErrors = validateContextModeOutput(output, this.contextMode, this.behaviorExamplePack);

    // Trust-boundary: validator returns `string | undefined` for errorCategory.
    // Must not `as`-cast; validate at runtime (ERR-001, ERR-005).
    const rawCategory = result.errorCategory;
    let errorCategory: PDErrorCategory | undefined;
    if (rawCategory == null) {
      errorCategory = undefined;
    } else if (isPDErrorCategory(rawCategory)) {
      errorCategory = rawCategory;
    } else {
      // Invalid errorCategory from validator — fail loud, do not pass through
      return {
        valid: false,
        errors: [...result.errors, `invalid errorCategory: ${rawCategory}`],
        errorCategory: 'output_invalid',
      };
    }

    return {
      errors: [...result.errors, ...modeErrors],
      valid: result.valid && modeErrors.length === 0,
      // CodeRabbit PR2 outside-diff comment: when the base validator passes but
      // v1/v2 mode validation fails, errorCategory is still undefined. Since
      // modeErrors are structural contract violations (permanent, not retriable),
      // classify them as 'output_invalid' to match permanentErrorCategories.
      errorCategory: errorCategory ?? (modeErrors.length > 0 ? 'output_invalid' : undefined),
    };
  }

  // eslint-disable-next-line @typescript-eslint/max-params
  async succeedTask(
    taskId: string,
    runId: string,
    output: ArtificerRuleOutput,
    task: TaskRecord,
    contextHash: string,
    context: ArtificerContext,
  ): Promise<PeerRunnerResult<ArtificerRuleOutput>> {
    // Lineage consistency: sourceScribeArtifactId must match buildContext result (ERR-004, ERR-008).
    if (!context.sourceScribeArtifactId || output.sourceScribeArtifactId !== context.sourceScribeArtifactId) {
      throw new PDRuntimeError(
        'output_invalid',
        `sourceScribeArtifactId mismatch: expected ${context.sourceScribeArtifactId ?? '(none)'}, got ${output.sourceScribeArtifactId}`,
      );
    }

    // Store output before marking succeeded
    try {
      await this.stateManager.updateRunOutput(runId, JSON.stringify(output));
    } catch (updateErr) {
      this.emitEvent('update_output_failed', taskId, {
        runId,
        errorMessage: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      throw updateErr;
    }

    // Resolve lineage artifact IDs
    let lineageArtifactIds: string[] = [];
    let lineageHasRejected = false;
    try {
      const lineageResult = await this.resolveLineageArtifactIds(taskId);
      lineageArtifactIds = lineageResult.ids;
      lineageHasRejected = lineageResult.hasRejected;
    } catch (lineageErr) {
      this.emitEvent('lineage_resolve_failed', taskId, {
        runId,
        errorMessage: lineageErr instanceof Error ? lineageErr.message : String(lineageErr),
      });
    }

    if (lineageHasRejected) {
      this.emitEvent('lineage_partial', taskId, {
        runId,
        resolvedCount: lineageArtifactIds.length,
        warning: 'Some dependency artifact queries were rejected; lineage may be incomplete',
      });
    }

    // Write PIArtifact via artifactStore (idempotent upsert)
    const artifactId = `pi-art-${taskId}-${runId}`;
    const now = new Date().toISOString();
    try {
      await this.artifactStore.upsertArtifact({
        artifactId,
        artifactKind: 'principle',
        sourceTaskId: taskId,
        lineageArtifactIds,
        validationStatus: 'pending',
        // Layer 0 (design §6.1, task 3.11): artificer's edge predecessor is
        // scribe. The dreamer 5-dim context still flows through the separate
        // PRI-508 `resolveDreamerContext` path (F2) — it does NOT enter
        // `predecessorSummary` (which holds exactly one edge predecessor).
        contentJson: this.buildArtifactContentJson(taskId, 'artificer', output, toScribePredecessor(context)),
        createdAt: now,
        updatedAt: now,
      });
    } catch (artifactErr) {
      this.emitEvent('artifact_write_failed', taskId, {
        runId,
        errorMessage: artifactErr instanceof Error ? artifactErr.message : String(artifactErr),
      });
      return this.retryOrFail({
        taskId,
        task,
        errorCategory: 'artifact_commit_failed',
        failureReason: `PIArtifact write failed: ${artifactErr instanceof Error ? artifactErr.message : String(artifactErr)}`,
      });
    }

    // Mark task succeeded
    const resultRef = `${this.config.resultRefPrefix}://${runId}`;
    try {
      await this.stateManager.markTaskSucceeded(taskId, resultRef);
    } catch (stateErr) {
      this.emitEvent('mark_succeeded_failed', taskId, {
        taskId,
        runId,
        errorMessage: stateErr instanceof Error ? stateErr.message : String(stateErr),
      });
      throw stateErr;
    }

    this.emitEvent('task_succeeded', taskId, {
      attemptCount: task.attemptCount,
      resultRef,
      implementationSummary: output.implementationSummary,
    });

    return {
      status: 'succeeded',
      taskId,
      runId,
      artifactId,
      resultRef,
      contextHash,
      output,
      attemptCount: task.attemptCount,
    };
  }

  // ── Optional hooks ─────────────────────────────────────────────────────────

  /**
   * Re-inject taskId if stripped by stripLineageFields (PRI-272 / ERR-008).
   * Only fill when absent via Object.hasOwn — present-but-falsy values
   * must reach validation and fail loud (Runtime Contract Rule 3).
   *
   * generatedAt override is handled by the base class — subclasses must call
   * super.postFetchTransform() to inherit it.
   */
  protected override postFetchTransform(taskId: string, untrustedOutput: unknown, _context: ArtificerContext): void {
    super.postFetchTransform(taskId, untrustedOutput, _context);
    // Shared lineage echo gate (PRI-541). sourceScribeArtifactId is nullable
    // (rule-plan candidates with no scribe predecessor): when null there is
    // no authoritative value to reconcile, so only taskId is enforced.
    const topFields = [{ field: 'taskId', authoritativeValue: taskId }];
    const traceFields = [] as { field: string; authoritativeValue: string }[];
    if (_context.sourceScribeArtifactId !== null) {
      topFields.push({ field: 'sourceScribeArtifactId', authoritativeValue: _context.sourceScribeArtifactId });
      traceFields.push({ field: 'scribeArtifactId', authoritativeValue: _context.sourceScribeArtifactId });
    }
    const correctedFields = reconcileLineageEcho(untrustedOutput, {
      topFields,
      ...(traceFields.length > 0 ? { trace: { traceField: 'sourceTrace', fields: traceFields } } : {}),
    });
    if (correctedFields.length > 0) {
      this.emitEvent('lineage_echo_corrected', taskId, { correctedFields });
    }
  }

  protected override emitSuccessTelemetry(taskId: string, output: ArtificerRuleOutput): void {
    this.emitEvent('implementation_plan_generated', taskId, {
      implementationSummary: output.implementationSummary,
      affectedTools: output.affectedTools,
      goldenTraceCaseCount: output.goldenTraceCases.length,
    });
  }
}

export { DEFAULT_ARTIFICER_RUNNER_OPTIONS };
