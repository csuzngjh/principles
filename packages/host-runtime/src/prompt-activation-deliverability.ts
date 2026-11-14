import fs from 'node:fs';
import {
  PROMPT_BUDGET_FALLBACK_CHARS,
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  SqliteConnection,
  SqlitePIArtifactStore,
  classifySingleItemBudgetTier,
  computeFeatureFlagsFromConfig,
  renderPrinciplesToDirectives,
  resolvePrincipleFromArtifact,
  type ActivatedPrinciple,
  type ActivationStatusRecord,
  type PromptBudgetTierFit,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import { readPromptActivationAuthority } from './prompt-activation-authority.js';
import {
  PROMPT_INJECTION_TARGET_HOSTS,
  PROMPT_INJECTION_UNIT,
  resolvePromptInjectionRouteDecision,
  type PromptInjectionBudgetScope,
  type PromptInjectionRouteDecision,
  type PromptInjectionRouteName,
  type PromptInjectionTargetHost,
} from './prompt-injection-projection.js';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';

/**
 * SPEC PD_PROMPT_CAPACITY_V1 R-B2: ONE route-aware single-artifact capacity
 * precheck, shared by every real prompt-activation write entry (Console
 * approve, CLI approve) and by the pre-approval candidate fit (R-A2).
 * PRI-1137: the cost is measured with the ONE live production serializer —
 * the full single-principle directive render (including the self-report
 * footer when that flag is on). The retired list-route selected-lines
 * arithmetic is gone. The principle identity is
 * the REAL resolved id (content `principleId` or draft title) — never a
 * fixed-length UUID allowance (a title-derived id can only be longer).
 *
 * This module deliberately does NOT read host configs from core: it lives
 * in host-runtime and consumes the workspace config + host facts here.
 */

export interface PromptDeliverabilityCandidateArtifact {
  artifactId: string;
  artifactKind: string;
  contentJson: string;
  validationStatus: string;
  /** Formal ledger identity column; identity never comes from content titles. */
  sourcePrincipleId?: string;
  /**
   * Ledger identity resolved through the artifact's candidate lineage (the same
   * authority the activation dispatcher uses). Legacy artifacts were written
   * before the identity column was stamped; the precheck must measure them
   * under the identity they will actually activate as, not refuse them as if
   * they had none.
   */
  resolvedPrincipleId?: string;
}

export type PromptArtifactDeliverability =
  | {
    status: 'deliverable';
    route: PromptInjectionRouteName;
    hostKind?: PromptInjectionTargetHost;
    basis?: PromptInjectionRouteDecision['basis'];
    /**
     * The budget this judgment is binding against: the MINIMUM supported
     * tier — a deliverable here fits under EVERY supported budget
     * (SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.3), so the strictest tier is
     * the honest evidence.
     */
    budget: number;
    budgetMinChars: number;
    budgetMaxChars: number;
    /** Single-item cost in UTF-16 code units under the bound route's serializer. */
    costChars: number;
    budgetScope: PromptInjectionBudgetScope;
    unit: typeof PROMPT_INJECTION_UNIT;
  }
  | {
    /**
     * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.3: the artifact fits under
     * SOME supported budgets but not all — whether it injects depends on the
     * runtime model's context window. NOT a promise of injection and NOT a
     * permanent refusal; approval flow proceeds unchanged.
     */
    status: 'model_dependent';
    route: PromptInjectionRouteName;
    hostKind?: PromptInjectionTargetHost;
    basis?: PromptInjectionRouteDecision['basis'];
    budgetMinChars: number;
    budgetMaxChars: number;
    costChars: number;
    budgetScope: PromptInjectionBudgetScope;
    unit: typeof PROMPT_INJECTION_UNIT;
    nextAction: string;
  }
  | {
    status: 'undeliverable';
    reason: 'single_item_exceeds_budget';
    route: PromptInjectionRouteName;
    hostKind?: PromptInjectionTargetHost;
    basis?: PromptInjectionRouteDecision['basis'];
    /** The budget this judgment is binding against: the MAXIMUM supported tier. */
    budget: number;
    budgetMinChars: number;
    budgetMaxChars: number;
    costChars: number;
    overByChars: number;
    budgetScope: PromptInjectionBudgetScope;
    unit: typeof PROMPT_INJECTION_UNIT;
    nextAction: string;
  }
  | {
    status: 'unconfirmed';
    /** Stable machine-readable reason (route facts or artifact content unresolvable). */
    reason: string;
    nextAction: string;
    /** Route-unconfirmed case: per-host single-item tier fit so the UI can show both. */
    perHost?: readonly { hostKind: PromptInjectionTargetHost; tierFit: PromptBudgetTierFit; costChars: number }[];
  };

function syntheticPendingActivation(artifactId: string): ActivationStatusRecord {
  return {
    activationId: `pending:${artifactId}`,
    idempotencyKey: `pending:${artifactId}::prompt`,
    artifactId,
    channel: 'prompt',
    action: 'prompt_activate',
    targetRef: `pending://${artifactId}`,
    activatedAt: new Date(0).toISOString(),
    deactivatedAt: null,
  };
}

/** Resolve the REAL principle identity + text from the artifact content. */
export function resolvePromptCandidatePrinciple(
  artifact: PromptDeliverabilityCandidateArtifact,
): { ok: true; principle: ActivatedPrinciple } | { ok: false; warning: string } {
  return resolvePrincipleFromArtifact(
    {
      artifact_id: artifact.artifactId,
      artifact_kind: artifact.artifactKind,
      content_json: artifact.contentJson,
      validation_status: artifact.validationStatus,
      source_principle_id: artifact.resolvedPrincipleId ?? artifact.sourcePrincipleId,
    },
    syntheticPendingActivation(artifact.artifactId),
  );
}

function selfReportEnabledFor(workspaceDir: string): boolean {
  return computeFeatureFlagsFromConfig(
    loadPdConfigForPlugin(workspaceDir).effective,
  ).flags.principle_receipt_self_report?.enabled === true;
}

/**
 * Positive single-item evidence under the live route, using the production
 * serializer itself (AC-06: a row is "fits" because its own serialized
 * directive fits — never because it is absent from a bounded diagnostic list).
 *
 * `costChars` is what the single-entry selection consumes, measured exactly as
 * the shared projection reports `usedChars`. PRI-1137: there is one live route,
 * so there is no route parameter and no list-route `trimToBudget` arithmetic to
 * keep in sync — a forecast may not measure a deleted path.
 *
 * The budget parameter defaults to the fixed fallback budget: approval-time
 * callers hold no runtime model facts, and SPEC §6.3 requires the fixed
 * fallback — never an invented capacity — when none can be confirmed.
 */
export function computePromptSingleItemFit(input: {
  principle: ActivatedPrinciple;
  selfReportEnabled: boolean;
  budget?: number;
}): { fits: boolean; costChars: number } {
  const budget = input.budget ?? PROMPT_BUDGET_FALLBACK_CHARS;
  const render = renderPrinciplesToDirectives(
    [input.principle],
    new Set([input.principle.principleId]),
    { escapeFn: escapeXml, selfReportInstruction: input.selfReportEnabled },
  );
  return { fits: render.length <= budget, costChars: render.length };
}

const UNDELIVERABLE_NEXT_ACTION =
  'shorten the principle statement and resubmit, or use the activations page "modify to injectable version" entry to create a replacement artifact (the approval facts are preserved)';

const MODEL_DEPENDENT_NEXT_ACTION =
  'this principle fits the injection budget only on models with a larger context window; it may be excluded at runtime on smaller-context models — the approval itself is unaffected';

/**
 * PRI-1137: the production prompt annotates each directive with its authority,
 * so an approval-time cost that omitted the attribute would understate the real
 * bytes. Unknown/unreadable stays unannotated — never inferred.
 *
 * PRI-1137 final review P2: a BROKEN authority read is distinguished from
 * "no annotation" — the caller refuses as unconfirmed instead of silently
 * billing an unannotated (cheaper) entry (rc-3/rc-9).
 */
function readAuthorityForArtifact(
  workspaceDir: string,
  artifactId: string,
): { ok: true; authority: 'owner' | 'system_policy' | undefined } | { ok: false; reason: string } {
  const stateDbPath = resolveStateDbPath(workspaceDir);
  if (!fs.existsSync(stateDbPath)) return { ok: true, authority: undefined };
  let connection: SqliteConnection | undefined;
  try {
    connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false, busyTimeoutMs: 0 });
    return { ok: true, authority: readPromptActivationAuthority(connection, artifactId, 'prompt').authority };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `authority_read_failed: ${message.slice(0, 160)}` };
  } finally {
    connection?.close();
  }
}

/**
 * Precheck one artifact against the workspace's effective injection route.
 * Pure read — no state mutation, safe to call before any governance write.
 */
export async function checkPromptArtifactDeliverability(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
  artifact: PromptDeliverabilityCandidateArtifact | null | undefined;
  /**
   * PRI-1137 final review P2: the authority the DECISION under measurement
   * will stamp on this artifact. Approve-time callers pass `'owner'` (the
   * console/CLI approval IS an owner decision — the post-approval directive
   * bills `authority="owner"`, and billing the pre-approval default
   * `system_policy` overstated the entry by the attribute delta and could
   * refuse a borderline-fitting entry). Absent → the current DB fact (the
   * honest pre-decision view for candidate-fit surfaces).
   */
  authority?: 'owner' | 'system_policy';
}): Promise<PromptArtifactDeliverability> {
  if (!input.artifact) {
    return {
      status: 'unconfirmed',
      reason: 'artifact_unavailable: artifact could not be read from the store',
      nextAction: 'check pi_artifacts for the approval artifact, then retry',
    };
  }
  const resolved = resolvePromptCandidatePrinciple(input.artifact);
  if (!resolved.ok) {
    return {
      status: 'unconfirmed',
      reason: `artifact_content_unresolved: ${resolved.warning}`,
      nextAction: 'fix the artifact content (kind/validation/principleId/statement), then retry',
    };
  }
  const selfReportEnabled = selfReportEnabledFor(input.workspaceDir);
  const authorityRead = readAuthorityForArtifact(input.workspaceDir, input.artifact.artifactId);
  if (!authorityRead.ok) {
    // A broken authority read must not be billed as "unannotated" — the cost
    // evidence would be fabricated-cheap (final review P2, rc-3).
    return {
      status: 'unconfirmed',
      reason: `${authorityRead.reason}; the single-entry cost cannot be measured with the authority annotation this route bills`,
      nextAction: 'repair the workspace state.db readability (the authority join read failed), then retry',
    };
  }
  const authority = input.authority ?? authorityRead.authority;
  const principle: ActivatedPrinciple = authority === undefined
    ? resolved.principle
    : { ...resolved.principle, authority };
  const decision = resolvePromptInjectionRouteDecision({
    workspaceDir: input.workspaceDir,
    targetHost: input.targetHost,
  });

  if (decision.status === 'confirmed' && decision.route !== undefined) {
    const { costChars } = computePromptSingleItemFit({
      principle,
      selfReportEnabled,
    });
    const budgetScope: PromptInjectionBudgetScope = 'full_directive_context';
    const shared = {
      route: decision.route,
      ...(decision.hostKind !== undefined ? { hostKind: decision.hostKind } : {}),
      ...(decision.basis !== undefined ? { basis: decision.basis } : {}),
      budgetMinChars: PROMPT_BUDGET_MIN_CHARS,
      budgetMaxChars: PROMPT_BUDGET_MAX_CHARS,
      costChars,
      budgetScope,
      unit: PROMPT_INJECTION_UNIT,
    };
    // SPEC §6.3: approval time holds no runtime model identity — classify
    // against the SUPPORTED budget range instead of pretending to know the
    // executing model's window.
    const tierFit = classifySingleItemBudgetTier(costChars);
    if (tierFit === 'fits_all_tiers') {
      return {
        status: 'deliverable',
        ...shared,
        budget: PROMPT_BUDGET_MIN_CHARS,
      };
    }
    if (tierFit === 'model_dependent') {
      return {
        status: 'model_dependent',
        ...shared,
        nextAction: MODEL_DEPENDENT_NEXT_ACTION,
      };
    }
    return {
      status: 'undeliverable',
      ...shared,
      reason: 'single_item_exceeds_budget',
      budget: PROMPT_BUDGET_MAX_CHARS,
      overByChars: costChars - PROMPT_BUDGET_MAX_CHARS,
      nextAction: UNDELIVERABLE_NEXT_ACTION,
    };
  }

  // Route unconfirmed: report per-host tier fit for every standard host
  // instead of guessing (R-A1) — the write gate refuses, the UI can show
  // both facts. Roster derives from the single SSoT list (review P3-1: a
  // hand-typed two-host array dropped WorkBuddy from unconfirmed
  // deliverability reports).
  const perHost = PROMPT_INJECTION_TARGET_HOSTS.map((hostKind) => {
    const { costChars } = computePromptSingleItemFit({
      principle,
      selfReportEnabled,
    });
    return { hostKind, tierFit: classifySingleItemBudgetTier(costChars), costChars };
  });
  return {
    status: 'unconfirmed',
    reason: `route_unconfirmed: ${decision.unconfirmedReason ?? 'effective injection route cannot be confirmed'}`,
    nextAction: decision.nextAction ?? 'pass an explicit target host (openclaw|codex|workbuddy)',
    perHost,
  };
}

/** Load one artifact read-only from `<workspace>/.pd/state.db`. Failures carry a reason (rc-9). */
export async function loadPromptArtifactById(
  workspaceDir: string,
  artifactId: string,
): Promise<
  | { ok: true; artifact: PromptDeliverabilityCandidateArtifact }
  | { ok: false; reason: string }
> {
  const stateDbPath = resolveStateDbPath(workspaceDir);
  if (!fs.existsSync(stateDbPath)) {
    return { ok: false, reason: `activation_db_not_found: ${stateDbPath}; nextAction=initialize_workspace_runtime_state` };
  }
  let connection: SqliteConnection | undefined;
  try {
    connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    const record = await new SqlitePIArtifactStore(connection).getArtifactById(artifactId);
    if (record) {
      return {
        ok: true,
        artifact: {
          artifactId: record.artifactId,
          artifactKind: record.artifactKind,
          contentJson: record.contentJson,
          validationStatus: record.validationStatus,
          sourcePrincipleId: record.sourcePrincipleId,
        },
      };
    }
    return { ok: false, reason: `artifact_not_found: artifactId=${artifactId}; nextAction=check_pi_artifacts_table` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `artifact_read_failed: ${message}; nextAction=check_workspace_pd_state_db` };
  } finally {
    connection?.close();
  }
}

/** Combined load + precheck for write gates that only hold an artifact id (CLI approve). */
export async function checkPromptArtifactDeliverabilityById(input: {
  workspaceDir: string;
  artifactId: string;
  targetHost?: PromptInjectionTargetHost;
  /** See `checkPromptArtifactDeliverability.authority` (approve-time = 'owner'). */
  authority?: 'owner' | 'system_policy';
  /** Ledger identity already resolved from the artifact's candidate lineage. */
  resolvedPrincipleId?: string;
}): Promise<PromptArtifactDeliverability> {
  const loaded = await loadPromptArtifactById(input.workspaceDir, input.artifactId);
  if (!loaded.ok) {
    return {
      status: 'unconfirmed',
      reason: loaded.reason,
      nextAction: 'fix the artifact store readability, then retry the approval',
    };
  }
  return checkPromptArtifactDeliverability({
    ...input,
    artifact: {
      ...loaded.artifact,
      ...(input.resolvedPrincipleId !== undefined ? { resolvedPrincipleId: input.resolvedPrincipleId } : {}),
    },
  });
}
