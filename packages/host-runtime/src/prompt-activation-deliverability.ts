import fs from 'node:fs';
import path from 'node:path';
import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteConnection,
  SqlitePIArtifactStore,
  computeFeatureFlagsFromConfig,
  listEntryLine,
  renderPrinciplesToDirectives,
  resolvePrincipleFromArtifact,
  trimToBudget,
  type ActivatedPrinciple,
  type ActivationStatusRecord,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';
import {
  PROMPT_INJECTION_UNIT,
  promptRouteForHost,
  resolvePromptInjectionRouteDecision,
  type PromptInjectionBudgetScope,
  type PromptInjectionRouteDecision,
  type PromptInjectionRouteName,
  type PromptInjectionTargetHost,
} from './prompt-injection-projection.js';

/**
 * SPEC PD_PROMPT_CAPACITY_V1 R-B2: ONE route-aware single-artifact capacity
 * precheck, shared by every real prompt-activation write entry (Console
 * approve, CLI approve) and by the pre-approval candidate fit (R-A2). The
 * cost is measured with the SAME production serializer/selector the bound
 * route uses — list route bills the selected-lines entry (header + entry),
 * shared route bills the full single-principle directive render including
 * the self-report footer when that flag is on. The principle identity is
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
}

export type PromptArtifactDeliverability =
  | {
    status: 'deliverable';
    route: PromptInjectionRouteName;
    hostKind?: PromptInjectionTargetHost;
    basis?: PromptInjectionRouteDecision['basis'];
    budget: number;
    /** Single-item cost in UTF-16 code units under the bound route's serializer. */
    costChars: number;
    budgetScope: PromptInjectionBudgetScope;
    unit: typeof PROMPT_INJECTION_UNIT;
  }
  | {
    status: 'undeliverable';
    reason: 'single_item_exceeds_budget';
    route: PromptInjectionRouteName;
    hostKind?: PromptInjectionTargetHost;
    basis?: PromptInjectionRouteDecision['basis'];
    budget: number;
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
    /** Route-unconfirmed case: per-host single-item fit so the UI can show both. */
    perHost?: readonly { hostKind: PromptInjectionTargetHost; fits: boolean; costChars: number }[];
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
 * Positive single-item evidence under a given route, using the production
 * selector itself (AC-06: a row is "fits" because its own serialized entry
 * fits — never because it is absent from a bounded diagnostic list).
 *
 * `costChars` is what the single-entry selection would consume, measured the
 * same way the route's projection reports `usedChars` (the joined selected
 * lines). For an entry that does NOT fit, trimToBudget returns only the
 * header line, so the would-be cost is reconstructed from the header line it
 * DID return plus the real entry line (same format authority, listEntryLine).
 */
export function computePromptSingleItemFit(input: {
  principle: ActivatedPrinciple;
  route: PromptInjectionRouteName;
  selfReportEnabled: boolean;
}): { fits: boolean; costChars: number } {
  if (input.route === 'shared_render') {
    const render = renderPrinciplesToDirectives(
      [input.principle],
      new Set([input.principle.principleId]),
      { escapeFn: escapeXml, selfReportInstruction: input.selfReportEnabled },
    );
    return { fits: render.length <= RUNTIME_V2_PRINCIPLE_BUDGET, costChars: render.length };
  }
  const trimmed = trimToBudget([input.principle], RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);
  const fits = trimmed.injectedIds.has(input.principle.principleId);
  const costChars = trimmed.lines.length > 1
    ? trimmed.lines.join('\n').length
    : (trimmed.lines[0]?.length ?? 0) + 1 + listEntryLine(input.principle, escapeXml).length;
  return { fits, costChars };
}

const UNDELIVERABLE_NEXT_ACTION =
  'shorten the principle statement and resubmit, or use the activations page "modify to injectable version" entry to create a replacement artifact (the approval facts are preserved)';

/**
 * Precheck one artifact against the workspace's effective injection route.
 * Pure read — no state mutation, safe to call before any governance write.
 */
export async function checkPromptArtifactDeliverability(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
  artifact: PromptDeliverabilityCandidateArtifact | null | undefined;
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
  const decision = resolvePromptInjectionRouteDecision({
    workspaceDir: input.workspaceDir,
    targetHost: input.targetHost,
  });

  if (decision.status === 'confirmed' && decision.route !== undefined) {
    const { fits, costChars } = computePromptSingleItemFit({
      principle: resolved.principle,
      route: decision.route,
      selfReportEnabled,
    });
    const budgetScope: PromptInjectionBudgetScope = decision.route === 'shared_render'
      ? 'full_directive_context'
      : 'selected_lines';
    if (fits) {
      return {
        status: 'deliverable',
        route: decision.route,
        ...(decision.hostKind !== undefined ? { hostKind: decision.hostKind } : {}),
        ...(decision.basis !== undefined ? { basis: decision.basis } : {}),
        budget: RUNTIME_V2_PRINCIPLE_BUDGET,
        costChars,
        budgetScope,
        unit: PROMPT_INJECTION_UNIT,
      };
    }
    return {
      status: 'undeliverable',
      reason: 'single_item_exceeds_budget',
      route: decision.route,
      ...(decision.hostKind !== undefined ? { hostKind: decision.hostKind } : {}),
      ...(decision.basis !== undefined ? { basis: decision.basis } : {}),
      budget: RUNTIME_V2_PRINCIPLE_BUDGET,
      costChars,
      overByChars: costChars - RUNTIME_V2_PRINCIPLE_BUDGET,
      budgetScope,
      unit: PROMPT_INJECTION_UNIT,
      nextAction: UNDELIVERABLE_NEXT_ACTION,
    };
  }

  // Route unconfirmed: report per-host fit for every standard host instead of
  // guessing (R-A1) — the write gate refuses, the UI can show both facts.
  const hosts: PromptInjectionTargetHost[] = ['openclaw', 'codex'];
  const perHost = hosts.map((hostKind) => {
    const route = promptRouteForHost(hostKind, decision.flagEnabled);
    const { fits, costChars } = computePromptSingleItemFit({
      principle: resolved.principle,
      route,
      selfReportEnabled,
    });
    return { hostKind, fits, costChars };
  });
  return {
    status: 'unconfirmed',
    reason: `route_unconfirmed: ${decision.unconfirmedReason ?? 'effective injection route cannot be confirmed'}`,
    nextAction: decision.nextAction ?? 'pass an explicit target host (openclaw|codex)',
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
  const stateDbPath = path.join(workspaceDir, '.pd', 'state.db');
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
}): Promise<PromptArtifactDeliverability> {
  const loaded = await loadPromptArtifactById(input.workspaceDir, input.artifactId);
  if (!loaded.ok) {
    return {
      status: 'unconfirmed',
      reason: loaded.reason,
      nextAction: 'fix the artifact store readability, then retry the approval',
    };
  }
  return checkPromptArtifactDeliverability({ ...input, artifact: loaded.artifact });
}
