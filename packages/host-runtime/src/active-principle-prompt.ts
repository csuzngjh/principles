import {
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  computeFeatureFlagsFromConfig,
  filterPromptActivations,
  renderPrinciplesToDirectives,
  // PRI-1137 final review P1-2: exact additive measurement of the shared
  // directive render — the packer decides by arithmetic, renders once.
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
  resolvePrincipleFromArtifact,
  resolvePromptBudget,
  type ActivatedPrinciple,
  type PromptBudgetResolution,
  type PromptSelectionPolicy,
} from '@principles/core/runtime';
import fs from 'node:fs';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import { readPromptActivationAuthority } from './prompt-activation-authority.js';
import { ADAPTIVE_DECISION_MAX_CANDIDATE_CHARS } from './adaptive-decision-protocol.js';
import { revalidateAdaptivePrinciple } from './adaptive-principle-revalidation.js';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';

/** PRI-904 SPEC §10: bounded diagnostic id lists (mirrors the core selector's cap of 16). */
export const MAX_SHARED_DIAGNOSTIC_IDS = 16;

/** PRI-1150: bounded per-assembly presence-expectation entries (design v2 §2.1). */
export const MAX_SHARED_PRESENCE_EXPECTATIONS = 64;

/** PRI-1150: one frozen per-principle expectation for prompt presence forensics. */
export interface SharedInjectedExpectation {
  activationId: string;
  /**
   * The EXACT escaped `<directive>` slice this assembly embedded (renderer
   * contract — already escaped once; consumers must not re-escape).
   */
  bodyText: string;
  bodyChars: number;
  /** False when the assembly truncated this directive (never yields a full_hit). */
  bodyComplete: boolean;
}

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
  /**
   * PRI-1137: the trusted round key this fair rotation actually advanced on.
   * Present only under fair_rotation_v1 — the injection event mirrors it as
   * `selectionRoundOrdinal`, so the recorded round can never disagree with
   * the selection that produced the payload.
   */
  selectionRoundOrdinal?: number;
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
  /**
   * PRI-1150: per-principle frozen expectation set, rendered SAME-SOURCE with
   * `additionalContext` (one render pass, no second read). Revision is not
   * available at this layer and is deliberately absent — consumers record
   * unknown rather than inventing one. Memory-only forensics; PD-internal
   * contract, never sent to the OpenClaw host.
   */
  injectedExpectations?: SharedInjectedExpectation[];
  /** PRI-1150: injected directives dropped by the frozen-set cap (visibility fact). */
  injectedExpectationsOverflow?: number;
}

export interface AdaptivePackingReport {
  source?: 'native_gap';
  status: 'target_present' | 'prioritized' | 'unavailable';
  reason?: string;
  targetActivationId: string;
  targetArtifactId?: string;
  hookInvocationId?: string;
  displacedActivationIds: string[];
  /** Internal return-boundary checks; these snapshots are not delivery evidence. */
  targetSnapshot?: ActivatedPrinciple;
  displacedSnapshot?: ActivatedPrinciple;
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
  /**
   * PRI-1137: the `abstraction_layer_v1` route context is retired — every host
   * now reads the same candidate set. Field removed rather than pinned false,
   * so no consumer can branch on a dead route marker.
   */
}

/**
 * PR #1844 follow-up: the activation READ half of buildActivePrinciplePromptContext,
 * exported so the console budget projection can share the exact same input
 * selection (FIFO activations → artifact resolve) without duplicating logic.
 */
export async function readPromptActivationCandidates(input: {
  workspaceDir: string;
  /**
   * PRI-1137: annotate each candidate with its authority. The shared runtime is
   * now the ONLY prompt route, so this must stay on for the production read —
   * the retired OpenClaw list route rendered `authority="owner"`/`"system_policy"`
   * per directive, and dropping it would silently weaken the P0-G INV-05
   * guarantee that a low-risk auto-activation is never represented as Owner-approved.
   */
  includeAuthority?: boolean;
  /**
   * Additional adaptive reads must not hold the host behind SQLite's synchronous
   * busy wait. Only the adaptive revalidation read opts in.
   */
  noBusyWait?: boolean;
}): Promise<PromptActivationCandidates> {
  const warnings: string[] = [];
  const principles: ActivatedPrinciple[] = [];
  const config = loadPdConfigForPlugin(input.workspaceDir);
  if (!config.ok) {
    warnings.push(...config.errors.map((error) => `config_invalid: ${error.reason}; nextAction=${error.nextAction}`));
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  const { prompt: promptFlag } = flags;
  if (!promptFlag?.enabled) {
    warnings.push('prompt_feature_disabled; nextAction=set features.prompt.enabled=true in .pd/config.yaml');
    return { principles, warnings, aborted: true, selfReportEnabled: false };
  }
  // PRI-532: agent self-report instruction rides the directive template when
  // the flag is on (flag-off keeps the template byte-identical).
  const selfReportEnabled = flags.principle_receipt_self_report?.enabled === true;

  let connection: SqliteConnection | undefined;
  const stateDbPath = resolveStateDbPath(input.workspaceDir);
  if (!fs.existsSync(stateDbPath)) {
    warnings.push('activation_db_not_found; nextAction=initialize_workspace_runtime_state');
    return { principles, warnings, aborted: true, selfReportEnabled };
  }
  try {
    connection = new SqliteConnection({ workspaceDir: input.workspaceDir, readonly: true, bootstrapIfMissing: false,
      // Additional adaptive reads must not hold the host behind SQLite's synchronous busy wait.
      ...(input.noBusyWait === true ? { busyTimeoutMs: 0 } : {}),
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
        source_principle_id: artifact.sourcePrincipleId,
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
  return { principles, warnings, aborted: false, selfReportEnabled };
}

export interface SharedDirectivePacking {
  included: ActivatedPrinciple[];
  additionalContext: string;
  truncated: boolean;
  dropped: string[];
  oversized: string[];
}

/**
 * PRI-1140: resolve a configured principle identity to the AT MOST ONE
 * currently-authorized prompt activation of that principle, so a delivery
 * mapping survives Owner revisions (the prompt-replacement flow deactivates
 * the pinned activation) without editing plugin config per revision. Read-only
 * over the SAME candidates reader the shared assembly uses — selection never
 * creates authorization, and the downstream guards in
 * `buildActivePrinciplePromptContext` re-verify authority/content before any
 * injection. Errors fail closed to Native: the caller gets a structured
 * reason, never a guess.
 */
export type ResolveCurrentAuthorizedActivationResult =
  | { ok: true; principleId: string; artifactId: string; activationId: string; warnings: string[] }
  | {
    ok: false;
    reason: 'principle_not_currently_authorized' | 'ambiguous_current_activations' | 'candidates_unavailable';
    warnings: string[];
  };

export async function resolveCurrentAuthorizedActivationByPrincipleId(input: {
  workspaceDir: string;
  principleId: string;
}): Promise<ResolveCurrentAuthorizedActivationResult> {
  const principleId = typeof input.principleId === 'string' ? input.principleId.trim() : '';
  if (!principleId) {
    return { ok: false, reason: 'principle_not_currently_authorized', warnings: [] };
  }
  // Mirrors the adaptive authority re-read (noBusyWait): an optional
  // enhancement must not hold the host behind the synchronous busy wait; a
  // read warning means the candidate set itself is not trustworthy, so the
  // resolution fails closed instead of selecting from a degraded list.
  const candidates = await readPromptActivationCandidates({
    workspaceDir: input.workspaceDir,
    includeAuthority: true,
    noBusyWait: true,
  });
  if (candidates.aborted || candidates.warnings.length > 0) {
    return { ok: false, reason: 'candidates_unavailable', warnings: candidates.warnings };
  }
  const matches = candidates.principles.filter((principle) => principle.principleId === principleId);
  if (matches.length === 0) {
    return { ok: false, reason: 'principle_not_currently_authorized', warnings: candidates.warnings };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous_current_activations', warnings: candidates.warnings };
  }
  const [resolved] = matches;
  if (!resolved) {
    return { ok: false, reason: 'principle_not_currently_authorized', warnings: candidates.warnings };
  }
  return {
    ok: true,
    principleId: resolved.principleId,
    artifactId: resolved.artifactId,
    activationId: resolved.activationId,
    warnings: candidates.warnings,
  };
}

/**
 * PRI-1137 final review P1-5: did the AUTHORIZATION FACTS of the adaptive
 * priority target change between the native snapshot (first read) and the
 * authorized snapshot (second read)? The packed directive is annotated from
 * the facts as of packing time, so a drift in `authority` (e.g. owner →
 * system_policy after an approval-state change) or `approvedBy` means the
 * first snapshot's annotation would be a stale authorization claim — the
 * caller must exclude the target rather than inject it. Content drift
 * (text/sha) is checked separately (`target_changed`).
 */
export function adaptiveTargetAuthorizationChanged(
  native: { authority?: 'owner' | 'system_policy'; approvedBy?: string },
  authorized: { authority?: 'owner' | 'system_policy'; approvedBy?: string },
): boolean {
  return native.authority !== authorized.authority || native.approvedBy !== authorized.approvedBy;
}

/**
 * PRI-1137 final review P1-2: the packing DECISION without the final render —
 * the rotation reachability replay runs this once per round key over the SAME
 * precomputed block costs (via `blockCharsByActivationId`), so N rounds cost
 * O(N²) integer adds instead of O(N³) string work. The decision mirrors the
 * render exactly because both derive from the same additive measurement
 * (`baseChars + Σ blockChars === render(set).length` for any non-empty set).
 * Declared before `packSharedDirectives` (no-use-before-define).
 */
export function planSharedDirectivePacking(input: {
  scanOrder: ActivatedPrinciple[];
  budgetChars: number;
  selfReportEnabled: boolean;
  continueOnNonFit: boolean;
  /**
   * Precomputed exact marginal chars per activationId (P1-2 fast path). When
   * absent each candidate is measured once here — still one render per
   * PRINCIPLE, never per prefix.
   */
  blockCharsByActivationId?: ReadonlyMap<string, number>;
}): Omit<SharedDirectivePacking, 'additionalContext'> {
  const { scanOrder, budgetChars, selfReportEnabled, continueOnNonFit } = input;
  const blockChars = input.blockCharsByActivationId
    ?? new Map(scanOrder.map((principle) => [
      principle.activationId,
      measureSharedDirectiveBlockChars(principle, { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled }),
    ] as const));
  // Chars any non-empty render carries (header + footer + note). An empty
  // included set renders '' (the renderer's own empty contract).
  const baseChars = sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: selfReportEnabled });
  const included: ActivatedPrinciple[] = [];
  let runningChars = baseChars;
  let truncated = false;
  const dropped: string[] = [];
  const oversized: string[] = [];
  for (const principle of scanOrder) {
    const marginal = blockChars.get(principle.activationId);
    if (marginal === undefined) {
      // Unknown cost must never silently pass as zero (rc-3): treat as
      // oversized-for-planning and record it.
      if (oversized.length < MAX_SHARED_DIAGNOSTIC_IDS) oversized.push(principle.activationId);
      if (!continueOnNonFit) break;
      continue;
    }
    if (runningChars + marginal > budgetChars) {
      // Standalone fit = base + own block within budget — the same fact the
      // single-principle render expresses, derived additively.
      if (baseChars + marginal <= budgetChars) {
        truncated = true;
        if (dropped.length < MAX_SHARED_DIAGNOSTIC_IDS) dropped.push(principle.activationId);
      } else if (oversized.length < MAX_SHARED_DIAGNOSTIC_IDS) {
        oversized.push(principle.activationId);
      }
      if (!continueOnNonFit) break;
      continue;
    }
    included.push(principle);
    runningChars += marginal;
  }
  return { included, truncated, dropped, oversized };
}

/**
 * PRI-1137: THE shared directive packer. `buildActivePrinciplePromptContext`
 * selects through it, and the console projection reuses it to answer "which
 * activations this route reaches across rounds". One policy implementation —
 * the retired list-route `trimToBudget` arithmetic must not survive as a
 * second forecast authority.
 *
 * PRI-1137 final review P1-2 (CodeRabbit Major): the previous loop re-rendered
 * the ENTIRE growing prefix per candidate — O(N²) render work per pack, and
 * the rotation reachability replay called it once per round key. The render is
 * strictly additive over per-principle directive blocks (see
 * `measureSharedDirectiveBlockChars`), so inclusion is decided by integer
 * arithmetic over per-block costs measured ONCE, and the string is rendered a
 * single time at the end. Output is byte-identical to the retired loop
 * (locked by characterization tests); only the work profile changed.
 */
export function packSharedDirectives(input: {
  scanOrder: ActivatedPrinciple[];
  budgetChars: number;
  selfReportEnabled: boolean;
  /** Fair rotation continues past a non-fit; legacy FIFO stops at the first one. */
  continueOnNonFit: boolean;
}): SharedDirectivePacking {
  const plan = planSharedDirectivePacking(input);
  const additionalContext = renderPrinciplesToDirectives(
    plan.included,
    new Set(plan.included.map((entry) => entry.principleId)),
    { escapeFn: escapeXml, selfReportInstruction: input.selfReportEnabled },
  );
  return { ...plan, additionalContext };
}


export interface AdaptiveGapOptions {
  readonly excludedByBudget: boolean;
  readonly replacementByActivationId: ReadonlyMap<string, ActivatedPrinciple>;
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
  /** Select only from omitted principles with a feasible plan in the current budget. */
  selectNativeGap?: (
    candidates: readonly ActivatedPrinciple[],
    options: AdaptiveGapOptions,
  ) => Promise<{
    artifactId: string; activationId: string; signal?: AbortSignal; deadlineAt?: number;
  } | undefined>;
  /**
   * PRI-1140 (Owner supplementary condition): additive-only adaptive packing.
   * Only meaningful together with `adaptivePriority`. When true, the
   * prioritized repack is accepted ONLY if it keeps every activation the
   * native baseline already assembled (a pure superset — the target may be
   * placed first, but nothing native-included may be squeezed out); otherwise
   * the native baseline is kept and the would-be displacement is recorded via
   * `adaptivePacking.reason='would_displace_native_assembly'` +
   * `displacedActivationIds`. The legacy pinned-identity path is unaffected
   * (its budget-driven displacement semantics are preserved verbatim).
   */
  additiveOnly?: boolean;
  /** Principles in the native pack that adaptive packing must preserve. */
  mandatoryPrincipleIds?: string[];
  /** Request cancellation forwarded to the final read-only target revalidation. */
  signal?: AbortSignal;
  deadlineAt?: number;
  hookInvocationId?: string;
}): Promise<ActivePrinciplePromptResult> {
  // One resolution per request (SPEC §6.1): the caller's pre-resolved budget
  // or the fixed-fallback default — never a per-line constant read.
  const promptBudget = input.promptBudget ?? resolvePromptBudget();
  const { budgetChars } = promptBudget;
  // PRI-1137 final review P2 (deliberate): this FIRST read keeps the default
  // busy_timeout (≈5s) instead of noBusyWait. It is the source of the WHOLE
  // injection — failing it on a transient SQLite lock would abort every
  // principle (aborted ⇒ empty context), which is a far worse degradation
  // than the bounded wait. Only the adaptive REVALIDATION read opts into
  // noBusyWait (line ~459): that one is an optional enhancement whose
  // fast-fail falls back to the native baseline, so waiting there would risk
  // the hook timeout for no injection benefit.
  const { principles, warnings, aborted, selfReportEnabled } =
    await readPromptActivationCandidates({ workspaceDir: input.workspaceDir, includeAuthority: true });
  if (aborted) {
    return {
      additionalContext: '', principleIds: [], activationIds: [], artifactIds: [], warnings,
      budget: budgetChars, truncated: false,
      selectionPolicy: 'legacy_fifo_prefix_v1', eligibleCount: 0,
      ...(input.adaptivePriority ? { adaptivePacking: {
        status: 'unavailable' as const, reason: 'reader_aborted',
        targetActivationId: input.adaptivePriority.activationId, targetArtifactId: input.adaptivePriority.artifactId,
        displacedActivationIds: [], ...(input.hookInvocationId ? { hookInvocationId: input.hookInvocationId } : {}),
      } } : {}),
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

  const pack = (scanOrder: ActivatedPrinciple[]) =>
    packSharedDirectives({ scanOrder, budgetChars, selfReportEnabled, continueOnNonFit: selectionPolicy === 'fair_rotation_v1' });

  const makeResult = (
    packing: ReturnType<typeof pack>,
    eligiblePrinciples: ActivatedPrinciple[],
    adaptivePacking?: AdaptivePackingReport,
  ): ActivePrinciplePromptResult => {
    const resultWarnings = [...warnings];
    if (packing.truncated) {
      resultWarnings.push('prompt_context_truncated: production_prompt_cap; nextAction=reduce_active_prompt_principles');
    }
    // Evidence arrays are positional tuples (principle, activation, artifact).
    // A principle can have multiple activated artifacts, so deduplicate the
    // candidate objects once and derive every identity array from that same
    // first-selected entry; independently deduplicating only principleIds
    // would shift later activation/artifact associations.
    const seenPrincipleIds = new Set<string>();
    const injectedPrinciples = packing.included.filter((principle) => {
      if (seenPrincipleIds.has(principle.principleId)) return false;
      seenPrincipleIds.add(principle.principleId);
      return true;
    });
    // PRI-1150: freeze per-principle presence expectations SAME-SOURCE with the
    // additionalContext above — one render pass over the already-included
    // principles, no second read. Each entry is the exact escaped `<directive>`
    // slice this assembly embedded; `bodyComplete` is containment against the
    // assembly, so a truncated directive can never yield a full_hit downstream.
    // Bounded at MAX_SHARED_PRESENCE_EXPECTATIONS with an overflow fact.
    const injectedExpectations: SharedInjectedExpectation[] = [];
    let injectedExpectationsOverflow = 0;
    for (const principle of injectedPrinciples) {
      if (injectedExpectations.length >= MAX_SHARED_PRESENCE_EXPECTATIONS) {
        injectedExpectationsOverflow += 1;
        continue;
      }
      const rendered = renderPrinciplesToDirectives(
        [principle],
        new Set([principle.principleId]),
        { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled },
      );
      const start = rendered.indexOf('<directive ');
      const end = rendered.indexOf('</directive>');
      if (start === -1 || end === -1) continue;
      const bodyText = rendered.slice(start, end + '</directive>'.length);
      if (!bodyText) continue;
      injectedExpectations.push({
        activationId: principle.activationId,
        bodyText,
        bodyChars: bodyText.length,
        bodyComplete: packing.additionalContext.includes(bodyText),
      });
    }
    return {
      additionalContext: packing.additionalContext,
      principleIds: injectedPrinciples.map((principle) => principle.principleId),
      activationIds: injectedPrinciples.map((principle) => principle.activationId),
      artifactIds: injectedPrinciples.map((principle) => principle.artifactId),
      warnings: resultWarnings,
      budget: budgetChars,
      truncated: packing.truncated,
      selectionPolicy,
      eligibleCount: eligiblePrinciples.length,
      ...(injectedExpectations.length > 0 || injectedExpectationsOverflow > 0
        ? {
            injectedExpectations,
            ...(injectedExpectationsOverflow > 0 ? { injectedExpectationsOverflow } : {}),
          }
        : {}),
      ...(rotationStartIndex !== undefined ? { rotationStartIndex } : {}),
      ...(selectionPolicy === 'fair_rotation_v1' && roundKey !== undefined ? { selectionRoundOrdinal: roundKey } : {}),
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
  let gapPriority: Awaited<ReturnType<NonNullable<typeof input.selectNativeGap>>>;
  const mandatoryIds = input.mandatoryPrincipleIds ?? [];
  let feasible: ActivatedPrinciple[] = [];
  const replacements = new Map<string, ActivatedPrinciple>();
  if (input.adaptivePriority === undefined && input.selectNativeGap && warnings.length === 0) {
    const omitted = principles.filter((principle) => !nativeResult.principleIds.includes(principle.principleId));
    const renderOptions = { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled };
    const nativeChars = nativePacking.additionalContext.length || sharedDirectiveBaseChars(renderOptions);
    const remaining = budgetChars - nativeChars;
    const config = loadPdConfigForPlugin(input.workspaceDir);
    const replaceableIds = new Set(config.ok ? config.effective.config.adaptiveActivation?.replaceableActivationIds : undefined);
    // Prefer the last explicitly replaceable Native directive that can cover
    // the shortfall. Each question scores one concrete plan, never a free-form removal.
    const replaceable = nativePacking.included.slice().reverse()
      .filter((p) => replaceableIds.has(p.activationId) && p.authority === 'owner'
        && p.artifactContentSha256 && Array.isArray(mandatoryIds) && !mandatoryIds.includes(p.principleId)
        && principles.filter((candidate) => candidate.principleId === p.principleId).length === 1)
      .map((principle) => ({ principle, chars: measureSharedDirectiveBlockChars(principle, renderOptions) }));
    feasible = omitted.filter((principle) => {
      const shortfall = measureSharedDirectiveBlockChars(principle, renderOptions) - remaining;
      if (shortfall <= 0) return true;
      // Compare complete directives. A truncated excerpt cannot establish
      // that removing a constraint is appropriate for this task.
      if (principle.authority !== 'owner' || !principle.artifactContentSha256
        || principle.text.trim().length > ADAPTIVE_DECISION_MAX_CANDIDATE_CHARS) return false;
      const outgoing = replaceable.find(({ principle: p, chars }) =>
        chars >= shortfall && p.text.trim().length <= ADAPTIVE_DECISION_MAX_CANDIDATE_CHARS);
      if (!outgoing) return false;
      replacements.set(principle.activationId, outgoing.principle);
      return true;
    });
    gapPriority = await input.selectNativeGap(feasible, {
      excludedByBudget: feasible.length < omitted.length,
      replacementByActivationId: replacements,
    });
  }
  const priority = input.adaptivePriority ?? gapPriority;
  if (priority === undefined) return nativeResult;
  const signal = gapPriority?.signal ?? input.signal ?? new AbortController().signal;
  const deadlineAt = gapPriority?.deadlineAt ?? input.deadlineAt;
  const outgoing = gapPriority ? replacements.get(priority.activationId) : undefined;
  const additiveOnly = (gapPriority !== undefined && outgoing === undefined) || input.additiveOnly === true;
  const report = (status: AdaptivePackingReport['status'], reason?: string, displacedActivationIds: string[] = []): AdaptivePackingReport => ({
    status,
    ...(gapPriority ? { source: 'native_gap' as const } : {}),
    ...(reason ? { reason } : {}),
    targetActivationId: typeof priority.activationId === 'string' ? priority.activationId : '',
    targetArtifactId: typeof priority.artifactId === 'string' ? priority.artifactId : '',
    ...(input.hookInvocationId ? { hookInvocationId: input.hookInvocationId } : {}),
    displacedActivationIds,
  });
  if (gapPriority && (signal.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt))) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'deadline') };
  }
  const nativeTargetMatches = principles.filter((principle) =>
    principle.artifactId === priority.artifactId && principle.activationId === priority.activationId,
  );
  const [nativeTarget] = nativeTargetMatches;
  const baselineHasTarget = nativePacking.included.some((principle) =>
    principle.artifactId === priority.artifactId && principle.activationId === priority.activationId,
  );
  const withoutTarget = (reason: string): ActivePrinciplePromptResult => {
    if (gapPriority || nativeTargetMatches.length !== 1 || !nativeTarget) return { ...nativeResult, adaptivePacking: report('unavailable', reason) };
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

  if (gapPriority && !feasible.includes(nativeTarget)) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'target_not_in_feasible_gap') };
  }

  const authorityRead = await readPromptActivationCandidates({ workspaceDir: input.workspaceDir, includeAuthority: true, noBusyWait: true });
  const authorizedMatches = authorityRead.principles.filter((principle) =>
    principle.artifactId === priority.artifactId && principle.activationId === priority.activationId,
  );
  const [authorizedTarget] = authorizedMatches;
  if (authorityRead.aborted || authorityRead.warnings.length > 0 || authorizedMatches.length !== 1 || !authorizedTarget
    || authorityRead.principles.filter((principle) => principle.principleId === authorizedTarget.principleId).length !== 1) {
    return withoutTarget('authority_unavailable');
  }
  // PRI-1137 final review P1-5: the second read must prove the AUTHORIZATION
  // FACTS unchanged, not merely present. The packed directive carries the
  // first snapshot's authority annotation, so an approval-state change
  // between the two reads (owner → system_policy, or a different approver)
  // must exclude the priority target instead of injecting stale authorization.
  if (adaptiveTargetAuthorizationChanged(nativeTarget, authorizedTarget)) {
    return withoutTarget('target_authority_changed');
  }
  if (!authorizedTarget.authority
    || authorizedTarget.principleId !== nativeTarget.principleId
    || authorizedTarget.text !== nativeTarget.text
    || authorizedTarget.artifactContentSha256 !== nativeTarget.artifactContentSha256) {
    return withoutTarget('target_changed');
  }

  const targetRendered = renderPrinciplesToDirectives([nativeTarget], new Set([nativeTarget.principleId]), { escapeFn: escapeXml });
  const targetBody = targetRendered.slice(targetRendered.indexOf('<directive '), targetRendered.indexOf('</directive>') + '</directive>'.length);
  const prepared = (status: 'target_present' | 'prioritized', displaced: string[] = []): AdaptivePackingReport => ({
    ...report(status, undefined, displaced), targetSnapshot: authorizedTarget, targetBody,
    ...(outgoing ? { displacedSnapshot: outgoing } : {}),
    nativeBaseline: nativeResult, ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  });
  if (baselineHasTarget) {
    const stillValid = await revalidateAdaptivePrinciple(input.workspaceDir, authorizedTarget, signal);
    if (!stillValid) return withoutTarget('target_changed');
    return { ...nativeResult, adaptivePacking: prepared('target_present') };
  }

  // Apply only the scored plan to the exact Native selection.
  const prioritizedPacking = gapPriority
    ? {
        ...pack([...nativePacking.included.filter((p) => p !== outgoing), nativeTarget]),
        truncated: nativePacking.truncated,
        dropped: [
          ...(outgoing ? [outgoing.activationId] : []),
          ...nativePacking.dropped.filter((id) => id !== nativeTarget.activationId),
        ].slice(0, MAX_SHARED_DIAGNOSTIC_IDS),
        oversized: nativePacking.oversized,
      }
    : pack([nativeTarget, ...nativeScanOrder.filter((principle) => principle.principleId !== nativeTarget.principleId)]);
  if (!prioritizedPacking.included.some((principle) => principle.principleId === nativeTarget.principleId)) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'target_does_not_fit') };
  }
  if (!Array.isArray(mandatoryIds) || mandatoryIds.some((id) => typeof id !== 'string')
    || mandatoryIds.some((id) => !prioritizedPacking.included.some((principle) => principle.principleId === id))) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'mandatory_constraint_displaced') };
  }
  const prioritizedActivationIds = new Set(prioritizedPacking.included.map((principle) => principle.activationId));
  const displacedActivationIds = nativePacking.included
    .filter((principle) => !prioritizedActivationIds.has(principle.activationId))
    .map((principle) => principle.activationId);
  if (outgoing && (displacedActivationIds.length !== 1 || displacedActivationIds[0] !== outgoing.activationId)) {
    return withoutTarget('unexpected_replacement');
  }
  // PRI-1140: an additive-only target may never squeeze out content the
  // native baseline already assembled. Decided BEFORE the revalidation read so
  // a refused placement costs no further I/O; the would-be displacement is the
  // recorded reason (bounded like the other diagnostic id lists).
  if (additiveOnly && displacedActivationIds.length > 0) {
    return {
      ...nativeResult,
      adaptivePacking: report(
        'unavailable',
        'would_displace_native_assembly',
        displacedActivationIds.slice(0, MAX_SHARED_DIAGNOSTIC_IDS),
      ),
    };
  }

  const [stillValid, outgoingValid] = await Promise.all([
    revalidateAdaptivePrinciple(input.workspaceDir, authorizedTarget, signal),
    outgoing ? revalidateAdaptivePrinciple(input.workspaceDir, outgoing, signal) : true,
  ]);
  if (gapPriority && (signal.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt))) {
    return { ...nativeResult, adaptivePacking: report('unavailable', 'deadline') };
  }
  if (!stillValid) return { ...nativeResult, adaptivePacking: report('unavailable', 'target_changed') };
  if (!outgoingValid) return withoutTarget('replacement_changed');
  if (outgoing) {
    const config = loadPdConfigForPlugin(input.workspaceDir);
    if (!config.ok || !config.effective.config.adaptiveActivation?.replaceableActivationIds?.includes(outgoing.activationId)) {
      return withoutTarget('replacement_permission_changed');
    }
    if (signal.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt)) return withoutTarget('deadline');
  }
  const result = makeResult(prioritizedPacking, principles, prepared('prioritized', displacedActivationIds));
  // Adaptive assembly is deliberately limited to the existing renderer's Native budget cap.
  return result;
}
