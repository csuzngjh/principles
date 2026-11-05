import {
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  computeFeatureFlagsFromConfig,
  filterPromptActivations,
  renderPrinciplesToDirectives,
  resolvePrincipleFromArtifact,
  resolvePromptBudget,
  type ActivatedPrinciple,
  type PromptBudgetResolution,
  type PromptSelectionPolicy,
} from '@principles/core/runtime-v2';
import fs from 'node:fs';
import path from 'node:path';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import { readPromptActivationAuthority } from './prompt-activation-authority.js';
import { revalidateAdaptivePrinciple } from './adaptive-principle-revalidation.js';

/** PRI-904 SPEC §10: bounded diagnostic id lists (mirrors the core selector's cap of 16). */
export const MAX_SHARED_DIAGNOSTIC_IDS = 16;

export interface ActivePrinciplePromptResult {
  additionalContext: string;
  principleIds: string[];
  activationIds: string[];
  artifactIds: string[];
  warnings: string[];
  budget: number;
  truncated: boolean;
  /** PRI-904: budget-packing policy that produced this selection. */
  selectionPolicy?: PromptSelectionPolicy;
  /** PRI-904: candidates that reached the budget selector. */
  eligibleCount?: number;
  /** PRI-904: circular scan start; present only under fair_rotation_v1. */
  rotationStartIndex?: number;
  /** PRI-904 (bounded, max 16): activation ids dropped for insufficient remaining budget. */
  droppedActivationIds?: string[];
  /** PRI-904 (bounded, max 16): activation ids that cannot fit even in an empty payload. */
  oversizedActivationIds?: string[];
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: provenance of the `budget` this
   * selection ran under (capacity source/status + the resolved context
   * window). Present on every result; `legacy_fallback` + `unknown` means
   * no model capacity could be confirmed and the fixed budget was used.
   */
  budgetCapacitySource?: PromptBudgetResolution['capacitySource'];
  budgetCapacityStatus?: PromptBudgetResolution['capacityStatus'];
  budgetContextWindowTokens?: number | null;
  budgetPolicyVersion?: PromptBudgetResolution['policyVersion'];
  /** SPEC §7 v0.2: bounded fallback reason code; present only on legacy_fallback. */
  budgetFallbackReason?: PromptBudgetResolution['fallbackReason'];
  /** Non-sensitive log context (provider/model ids); never emitted to events. */
  budgetFallbackDetail?: string;
  /** Assembly-only status; it does not assert that the host delivered the prompt. */
  adaptivePacking?: AdaptivePackingReport;
}

export interface AdaptivePackingReport {
  status: 'target_present' | 'prioritized' | 'unavailable';
  reason?: string;
  targetActivationId: string;
  displacedActivationIds: string[];
  /** Internal return-boundary checks; these snapshots are not delivery evidence. */
  targetSnapshot?: ActivatedPrinciple;
  targetBody?: string;
  nativeBaseline?: ActivePrinciplePromptResult;
  deadlineAt?: number;
}

export interface PromptActivationCandidates {
  principles: ActivatedPrinciple[];
  warnings: string[];
  /** true = prompt flag off or state.db missing — candidates are necessarily empty */
  aborted: boolean;
  selfReportEnabled: boolean;
  abstractionLayerEnabled: boolean;
}

/**
 * PR #1844 follow-up: the activation READ half of buildActivePrinciplePromptContext,
 * exported so the console budget projection can share the exact same input
 * selection (FIFO activations → artifact resolve) without duplicating logic.
 */
export async function readPromptActivationCandidates(input: {
  workspaceDir: string;
  /** Opt in for revalidation; default route keeps its historical prompt bytes. */
  includeAuthority?: boolean;
}): Promise<PromptActivationCandidates> {
  const warnings: string[] = [];
  const principles: ActivatedPrinciple[] = [];
  const config = loadPdConfigForPlugin(input.workspaceDir);
  if (!config.ok) {
    warnings.push(...config.errors.map((error) => `config_invalid: ${error.reason}; nextAction=${error.nextAction}`));
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  const { prompt: promptFlag } = flags;
  const abstractionLayerEnabled = flags.abstraction_layer_v1?.enabled === true;
  if (!promptFlag?.enabled) {
    warnings.push('prompt_feature_disabled; nextAction=set features.prompt.enabled=true in .pd/config.yaml');
    return { principles, warnings, aborted: true, selfReportEnabled: false, abstractionLayerEnabled };
  }
  // PRI-532: agent self-report instruction rides the directive template when
  // the flag is on (flag-off keeps the template byte-identical).
  const selfReportEnabled = flags.principle_receipt_self_report?.enabled === true;

  let connection: SqliteConnection | undefined;
  const stateDbPath = path.join(input.workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(stateDbPath)) {
    warnings.push('activation_db_not_found; nextAction=initialize_workspace_runtime_state');
    return { principles, warnings, aborted: true, selfReportEnabled, abstractionLayerEnabled };
  }
  try {
    connection = new SqliteConnection({ workspaceDir: input.workspaceDir, readonly: true, bootstrapIfMissing: false,
      // Additional adaptive reads must not hold the host behind SQLite's synchronous busy wait.
      ...(input.includeAuthority === true ? { busyTimeoutMs: 0 } : {}),
    });
    const activations = filterPromptActivations(await new SqliteActivationStateStore(connection).listPromptActivations());
    const artifactStore = new SqlitePIArtifactStore(connection);
    for (const activation of activations) {
      let artifact;
      try {
        artifact = await artifactStore.getArtifactById(activation.artifactId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`artifact_query_failed: artifactId=${activation.artifactId} reason=${message}; nextAction=check_pi_artifacts_table`);
        continue;
      }
      if (artifact === null) {
        warnings.push(`artifact_not_found: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table_or_remove_stale_activation`);
        continue;
      }
      const resolved = resolvePrincipleFromArtifact({
        artifact_id: artifact.artifactId,
        artifact_kind: artifact.artifactKind,
        content_json: artifact.contentJson,
        validation_status: artifact.validationStatus,
      }, activation);
      if (!resolved.ok) {
        warnings.push(resolved.warning);
        continue;
      }
      if (input.includeAuthority === true) {
        try {
          const authority = readPromptActivationAuthority(connection, artifact.artifactId, 'prompt');
          if (authority.authority) resolved.principle.authority = authority.authority;
          if (authority.approvedBy) resolved.principle.approvedBy = authority.approvedBy;
        } catch {
          // Approval lookup failure is unknown, never inferred as owner or policy.
          warnings.push(`prompt_activation_authority_unavailable: artifactId=${artifact.artifactId}`);
        }
      }
      principles.push(resolved.principle);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`activation_db_unreadable: ${message}; nextAction=check_workspace_pd_state_db`);
  } finally {
    connection?.close();
  }
  return { principles, warnings, aborted: false, selfReportEnabled, abstractionLayerEnabled };
}

export async function buildActivePrinciplePromptContext(input: {
  workspaceDir: string;
  /**
   * PRI-904 fair-rotation round key (derive via roundKeyFromRunIdentity from
   * the host run/turn id). Absent → legacy FIFO prefix policy (rollback /
   * characterization baseline).
   */
  roundKey?: number;
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1: the budget resolution for
   * THIS request, resolved once by the entry point that holds the model
   * facts. Absent → the resolver's no-facts default (legacy fixed 2000,
   * capacityStatus unknown) — the historical behavior, used by callers with
   * no model context (console projections, WorkBuddy without model facts).
   */
  promptBudget?: PromptBudgetResolution;
  /** Optional single already-qualified activation to place first in this pack pass. */
  adaptivePriority?: { artifactId: string; activationId: string };
  /** Principles in the native pack that adaptive packing must preserve. */
  mandatoryPrincipleIds?: string[];
  /** Request cancellation forwarded to the final read-only target revalidation. */
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ActivePrinciplePromptResult> {
  // One resolution per request (SPEC §6.1): the caller's pre-resolved budget
  // or the fixed-fallback default — never a per-line constant read.
  const promptBudget = input.promptBudget ?? resolvePromptBudget();
  const { budgetChars } = promptBudget;
  const { principles, warnings, aborted, selfReportEnabled } =
    await readPromptActivationCandidates(input);
  if (aborted) {
    return {
      additionalContext: '', principleIds: [], activationIds: [], artifactIds: [], warnings,
      budget: budgetChars, truncated: false,
      selectionPolicy: 'legacy_fifo_prefix_v1', eligibleCount: 0,
      budgetCapacitySource: promptBudget.capacitySource,
      budgetCapacityStatus: promptBudget.capacityStatus,
      budgetContextWindowTokens: promptBudget.contextWindowTokens,
      budgetPolicyVersion: promptBudget.policyVersion,
      ...(promptBudget.fallbackReason !== undefined ? { budgetFallbackReason: promptBudget.fallbackReason } : {}),
      ...(promptBudget.fallbackDetail !== undefined ? { budgetFallbackDetail: promptBudget.fallbackDetail } : {}),
    };
  }

  // PRI-904: same fair-rotation semantics as the plugin route's trimToBudget —
  // deterministic rotating start over the base (ASC) candidate order, circular
  // scan, continue-on-non-fit. Costs are measured with the REAL serializer
  // (renderPrinciplesToDirectives) so budget accounting stays exact here too.
  const { roundKey } = input;
  const selectionPolicy: PromptSelectionPolicy =
    roundKey === undefined || principles.length === 0 ? 'legacy_fifo_prefix_v1' : 'fair_rotation_v1';
  const n = principles.length;
  // Guard on the policy, not just the key: an empty candidate list has n === 0
  // and must not emit a NaN start (core trimToBudget omits the field for empty
  // input — parity requires the same here).
  const rotationStartIndex = selectionPolicy === 'fair_rotation_v1' && roundKey !== undefined
    ? ((roundKey % n) + n) % n
    : undefined;
  const nativeScanOrder: ActivatedPrinciple[] = rotationStartIndex === undefined
    ? principles
    : principles.slice(rotationStartIndex).concat(principles.slice(0, rotationStartIndex));

  const pack = (scanOrder: ActivatedPrinciple[]) => {
    const included: ActivatedPrinciple[] = [];
    let additionalContext = '';
    let truncated = false;
    const dropped: string[] = [];
    const oversized: string[] = [];
    const standaloneFits = (principle: ActivatedPrinciple): boolean =>
      renderPrinciplesToDirectives([principle], new Set([principle.principleId]), { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled }).length
      <= budgetChars;

    for (const principle of scanOrder) {
      const candidate = [...included, principle];
      const candidateContext = renderPrinciplesToDirectives(
        candidate,
        new Set(candidate.map((entry) => entry.principleId)),
        { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled },
      );
      if (candidateContext.length > budgetChars) {
        if (standaloneFits(principle)) {
          truncated = true;
          if (dropped.length < MAX_SHARED_DIAGNOSTIC_IDS) dropped.push(principle.activationId);
        } else if (oversized.length < MAX_SHARED_DIAGNOSTIC_IDS) {
          oversized.push(principle.activationId);
        }
        if (selectionPolicy === 'legacy_fifo_prefix_v1') break;
        continue;
      }
      included.push(principle);
      additionalContext = candidateContext;
    }
    return { included, additionalContext, truncated, dropped, oversized };
  };

  const makeResult = (
    packing: ReturnType<typeof pack>,
    eligiblePrinciples: ActivatedPrinciple[],
    adaptivePacking?: AdaptivePackingReport,
  ): ActivePrinciplePromptResult => {
    const resultWarnings = [...warnings];
    if (packing.truncated) {
      resultWarnings.push('prompt_context_truncated: production_prompt_cap; nextAction=reduce_active_prompt_principles');
    }
    const injectedIds = new Set(packing.included.map((principle) => principle.principleId));
    return {
      additionalContext: packing.additionalContext,
      principleIds: [...injectedIds],
      activationIds: packing.included.map((principle) => principle.activationId),
      artifactIds: packing.included.map((principle) => principle.artifactId),
      warnings: resultWarnings,
      budget: budgetChars,
      truncated: packing.truncated,
      selectionPolicy,
      eligibleCount: eligiblePrinciples.length,
      ...(rotationStartIndex !== undefined ? { rotationStartIndex } : {}),
      ...(packing.dropped.length > 0 ? { droppedActivationIds: packing.dropped } : {}),
      ...(packing.oversized.length > 0 ? { oversizedActivationIds: packing.oversized } : {}),
      budgetCapacitySource: promptBudget.capacitySource,
      budgetCapacityStatus: promptBudget.capacityStatus,
      budgetContextWindowTokens: promptBudget.contextWindowTokens,
      budgetPolicyVersion: promptBudget.policyVersion,
      ...(promptBudget.fallbackReason !== undefined ? { budgetFallbackReason: promptBudget.fallbackReason } : {}),
      ...(promptBudget.fallbackDetail !== undefined ? { budgetFallbackDetail: promptBudget.fallbackDetail } : {}),
      ...(adaptivePacking ? { adaptivePacking } : {}),
    };
  };

  const nativePacking = pack(nativeScanOrder);
  const nativeResult = makeResult(nativePacking, principles);
  const priority = input.adaptivePriority;
  if (priority === undefined) return nativeResult;

  const report = (status: AdaptivePackingReport['status'], reason?: string, displacedActivationIds: string[] = []): AdaptivePackingReport => ({
    status,
    ...(reason ? { reason } : {}),
    targetActivationId: typeof priority.activationId === 'string' ? priority.activationId : '',
    displacedActivationIds,
  });
  const nativeTargetMatches = principles.filter((principle) =>
    principle.artifactId === priority.artifactId && principle.activationId === priority.activationId,
  );
  const [nativeTarget] = nativeTargetMatches;
  const baselineHasTarget = nativePacking.included.some((principle) =>
    principle.artifactId === priority.artifactId && principle.activationId === priority.activationId,
  );
  const withoutTarget = (reason: string): ActivePrinciplePromptResult => {
    if (nativeTargetMatches.length !== 1 || !nativeTarget) return { ...nativeResult, adaptivePacking: report('unavailable', reason) };
    const targetPrincipleId = nativeTarget.principleId;
    const safePrinciples = principles.filter((principle) => principle.principleId !== targetPrincipleId);
    const safeScanOrder = nativeScanOrder.filter((principle) => principle.principleId !== targetPrincipleId);
    const safePacking = pack(safeScanOrder);
    return makeResult(
      safePacking,
      safePrinciples,
      report('unavailable', reason, baselineHasTarget ? [nativeTarget.activationId] : []),
    );
  };

  if (typeof priority.artifactId !== 'string' || !priority.artifactId.trim()
    || typeof priority.activationId !== 'string' || !priority.activationId.trim()) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'invalid_target') };
  }
  if (nativeTargetMatches.length === 0) return { ...nativeResult, adaptivePacking: report('unavailable', 'target_unavailable') };
  if (nativeTargetMatches.length !== 1) return { ...nativeResult, adaptivePacking: report('unavailable', 'target_ambiguous') };
  if (!nativeTarget) return { ...nativeResult, adaptivePacking: report('unavailable', 'target_unavailable') };
  if (principles.filter((principle) => principle.principleId === nativeTarget.principleId).length !== 1) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'target_ambiguous') };
  }

  const authorityRead = await readPromptActivationCandidates({ workspaceDir: input.workspaceDir, includeAuthority: true });
  const authorizedMatches = authorityRead.principles.filter((principle) =>
    principle.artifactId === priority.artifactId && principle.activationId === priority.activationId,
  );
  const [authorizedTarget] = authorizedMatches;
  if (authorityRead.aborted || authorityRead.warnings.length > 0 || authorizedMatches.length !== 1 || !authorizedTarget
    || authorityRead.principles.filter((principle) => principle.principleId === authorizedTarget.principleId).length !== 1) {
    return withoutTarget('authority_unavailable');
  }
  if (!authorizedTarget.authority
    || authorizedTarget.principleId !== nativeTarget.principleId
    || authorizedTarget.text !== nativeTarget.text
    || authorizedTarget.artifactContentSha256 !== nativeTarget.artifactContentSha256) {
    return withoutTarget('target_changed');
  }

  const signal = input.signal ?? new AbortController().signal;
  const targetRendered = renderPrinciplesToDirectives([nativeTarget], new Set([nativeTarget.principleId]), { escapeFn: escapeXml });
  const targetBody = targetRendered.slice(targetRendered.indexOf('<directive '), targetRendered.indexOf('</directive>') + '</directive>'.length);
  const prepared = (status: 'target_present' | 'prioritized', displaced: string[] = []): AdaptivePackingReport => ({
    ...report(status, undefined, displaced), targetSnapshot: authorizedTarget, targetBody,
    nativeBaseline: nativeResult, ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  });
  if (baselineHasTarget) {
    const stillValid = await revalidateAdaptivePrinciple(input.workspaceDir, authorizedTarget, signal);
    if (!stillValid) return withoutTarget('target_changed');
    return { ...nativeResult, adaptivePacking: prepared('target_present') };
  }

  const targetIndex = nativeScanOrder.indexOf(nativeTarget);
  const targetFirstScan = [nativeTarget, ...nativeScanOrder.filter((principle, index) =>
    index !== targetIndex && principle.principleId !== nativeTarget.principleId,
  )];
  const prioritizedPacking = pack(targetFirstScan);
  if (!prioritizedPacking.included.some((principle) => principle.principleId === nativeTarget.principleId)) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'target_does_not_fit') };
  }
  const mandatoryIds = input.mandatoryPrincipleIds ?? [];
  if (!Array.isArray(mandatoryIds) || mandatoryIds.some((id) => typeof id !== 'string')
    || mandatoryIds.some((id) => !prioritizedPacking.included.some((principle) => principle.principleId === id))) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'mandatory_constraint_displaced') };
  }

  const stillValid = await revalidateAdaptivePrinciple(input.workspaceDir, authorizedTarget, signal);
  if (!stillValid) return { ...nativeResult, adaptivePacking: report('unavailable', 'target_changed') };
  const prioritizedActivationIds = new Set(prioritizedPacking.included.map((principle) => principle.activationId));
  const displacedActivationIds = nativePacking.included
    .filter((principle) => !prioritizedActivationIds.has(principle.activationId))
    .map((principle) => principle.activationId);
  const result = makeResult(prioritizedPacking, principles, prepared('prioritized', displacedActivationIds));
  // Adaptive assembly is deliberately limited to the existing renderer's Native budget cap.
  return result;
}
