import fs from 'node:fs';
import {
  PROMPT_BUDGET_MAX_CHARS,
  PROMPT_BUDGET_MIN_CHARS,
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  classifySingleItemBudgetTier,
  computeFeatureFlagsFromConfig,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  type PromptBudgetCapacitySource,
  type PromptBudgetCapacityStatus,
  type PromptBudgetFallbackReason,
  type PromptBudgetResolution,
  type PromptBudgetTierFit,
} from '@principles/core/runtime';
import { loadPdConfigForPlugin } from './pd-config.js';
import { computePromptSingleItemFit } from './prompt-activation-deliverability.js';
import { readPromptActivationAuthority } from './prompt-activation-authority.js';
import {
  PROMPT_INJECTION_TARGET_HOSTS,
  buildLivePromptInjectionProjection,
  resolvePromptInjectionRouteDecision,
  type PromptInjectionBudgetScope,
  type PromptInjectionRouteDecision,
  type PromptInjectionRouteName,
  type PromptInjectionTargetHost,
} from './prompt-injection-projection.js';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';

/**
 * SPEC PD_PROMPT_CAPACITY_V1 R-A3: per-live-activation injection status for
 * the activations surface. Every row carries POSITIVE single-item evidence
 * computed with the production serializer for the bound route — "oversized"
 * means this row's own serialized entry exceeds the budget, "window_excluded"
 * means it fits but the current window is full (AC-06: a row is never deemed
 * healthy merely because it is absent from a bounded diagnostic list), and
 * `route_unconfirmed` surfaces AC-01's honest unknown instead of a guess.
 * No compliance/遵守 counts are produced here — absence of injection logs is
 * NOT reported as "zero compliance" (AC-12 boundary).
 *
 * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001: "oversized" now means the entry
 * exceeds the MAXIMUM supported budget (never injectable on any supported
 * model); a row that misses the CURRENT projection budget but fits within
 * the supported [min, max] range is `model_dependent` — whether it injects
 * depends on the runtime model's context window, which this surface cannot
 * see. Budget figures come from the projection's resolution (legacy
 * fallback when no runtime capacity is confirmed), never a bare constant.
 */

export type PromptActivationInjectionStatusKind =
  | 'injectable'
  | 'oversized'
  | 'model_dependent'
  | 'window_excluded'
  | 'resolution_failed'
  | 'route_unconfirmed';

export interface PromptActivationInjectionStatus {
  activationId: string;
  principleId?: string;
  status: PromptActivationInjectionStatusKind;
  /**
   * Present for injectable/window_excluded/oversized/model_dependent under a
   * confirmed route. For model_dependent rows it keeps the POSITIVE window
   * fact: true = the entry fits THIS surface's (usually fallback) projection
   * window, but still exceeds the measured floor — a smaller-context runtime
   * model would exclude it.
   */
  inCurrentWindow?: boolean;
  /** Present when the single-item cost was computable. */
  costChars?: number;
  budget?: number;
  budgetScope?: PromptInjectionBudgetScope;
  route?: PromptInjectionRouteName;
  /** Present for resolution_failed / route_unconfirmed / model_dependent (structured reason). */
  reason?: string;
  /** Present for route_unconfirmed: per-host single-item tier fit facts. */
  perHostFits?: readonly { hostKind: PromptInjectionTargetHost; tierFit: PromptBudgetTierFit }[];
}

/**
 * PRI-1017: provenance of the budget the rows were measured against, copied
 * from the SAME resolution the projection ran under. Optional on every field
 * so a caller can degrade without inventing a capacity fact.
 */
export interface PromptActivationBudgetProvenance {
  capacitySource?: PromptBudgetCapacitySource;
  capacityStatus?: PromptBudgetCapacityStatus;
  contextWindowTokens?: number;
  policyVersion?: string;
  fallbackReason?: PromptBudgetFallbackReason;
}

export interface PromptActivationInjectionStatusReport {
  route: PromptInjectionRouteDecision;
  /** Empty when injection is globally unavailable (prompt flag off / state.db missing) — see `globalReason`. */
  statuses: PromptActivationInjectionStatus[];
  warnings: string[];
  /** Present when no status could be computed at all (fail-loud degradation, rc-9). */
  globalReason?: string;
  /** Present for a confirmed route: the budget basis every row was measured under. */
  budgetProvenance?: PromptActivationBudgetProvenance;
}

export async function readPromptActivationInjectionStatuses(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
  /**
   * SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 / PRI-1017: budget resolution
   * the status projection must run under — console callers pass the
   * resolution rebuilt from the workspace's most recent runtime budget
   * observation. Absent → the honest fixed-fallback default.
   */
  promptBudget?: PromptBudgetResolution;
  /**
   * PRI-1017: per-host observations for a route confirmed by WORKSPACE FACTS
   * (no request-level targetHost). The projection uses only the resolved
   * host's own budget; an unidentified shared route stays on the fallback.
   */
  perHostPromptBudget?: Partial<Record<PromptInjectionTargetHost, PromptBudgetResolution>>;
}): Promise<PromptActivationInjectionStatusReport> {
  const config = loadPdConfigForPlugin(input.workspaceDir);
  const warnings: string[] = [];
  if (!config.ok) {
    warnings.push(...config.errors.map((error) => `config_invalid: ${error.reason}; nextAction=${error.nextAction}`));
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  const selfReportEnabled = flags.principle_receipt_self_report?.enabled === true;
  const route = resolvePromptInjectionRouteDecision(input);

  if (!flags.prompt?.enabled) {
    return {
      route,
      statuses: [],
      warnings,
      globalReason: 'prompt_feature_disabled: the prompt injection surface is off, so no activation can be injected; nextAction=set features.prompt.enabled=true in .pd/config.yaml',
    };
  }
  const stateDbPath = resolveStateDbPath(input.workspaceDir);
  if (!fs.existsSync(stateDbPath)) {
    return {
      route,
      statuses: [],
      warnings,
      globalReason: 'activation_db_not_found: .pd/state.db is missing, live activations cannot be read; nextAction=initialize_workspace_runtime_state',
    };
  }

  type Row =
    | { activationId: string; principleId: string; text: string; authority?: 'owner' | 'system_policy' }
    | { activationId: string; failure: string };
  const rows: Row[] = [];
  let connection: SqliteConnection | undefined;
  try {
    connection = new SqliteConnection({ workspaceDir: input.workspaceDir, readonly: true, bootstrapIfMissing: false });
    const activations = filterPromptActivations(
      await new SqliteActivationStateStore(connection).listPromptActivations(),
    );
    const artifactStore = new SqlitePIArtifactStore(connection);
    for (const activation of activations) {
      let artifact;
      try {
        artifact = await artifactStore.getArtifactById(activation.artifactId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rows.push({ activationId: activation.activationId, failure: `artifact_query_failed: ${message}` });
        continue;
      }
      if (artifact === null) {
        rows.push({ activationId: activation.activationId, failure: `artifact_not_found: artifactId=${activation.artifactId}` });
        continue;
      }
      const resolved = resolvePrincipleFromArtifact(
        {
          artifact_id: artifact.artifactId,
          artifact_kind: artifact.artifactKind,
          content_json: artifact.contentJson,
          validation_status: artifact.validationStatus,
          source_principle_id: artifact.sourcePrincipleId,
        },
        activation,
      );
      if (!resolved.ok) {
        rows.push({ activationId: activation.activationId, failure: resolved.warning });
        continue;
      }
      // PRI-1137: cost is measured exactly as the ONE shared prompt renders it,
      // so an approval row must contribute its `authority` attribute here too.
      // Unknown authority stays unannotated (never inferred).
      let authority: 'owner' | 'system_policy' | undefined;
      try {
        ({ authority } = readPromptActivationAuthority(connection, artifact.artifactId, 'prompt'));
      } catch {
        authority = undefined;
      }
      rows.push({
        activationId: activation.activationId,
        principleId: resolved.principle.principleId,
        text: resolved.principle.text,
        ...(authority !== undefined ? { authority } : {}),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      route,
      statuses: [],
      warnings,
      globalReason: `activation_db_unreadable: ${message}; nextAction=check_workspace_pd_state_db`,
    };
  } finally {
    connection?.close();
  }

  if (route.status === 'unconfirmed') {
    const statuses: PromptActivationInjectionStatus[] = rows.map((row) => {
      if ('failure' in row) {
        return { activationId: row.activationId, status: 'resolution_failed', reason: row.failure };
      }
      const perHostFits = PROMPT_INJECTION_TARGET_HOSTS.map((hostKind) => {
        const { costChars } = computePromptSingleItemFit({
          principle: { principleId: row.principleId, text: row.text, artifactId: '', activationId: row.activationId, ...(row.authority !== undefined ? { authority: row.authority } : {}) },
          selfReportEnabled,
        });
        return { hostKind, tierFit: classifySingleItemBudgetTier(costChars) };
      });
      return {
        activationId: row.activationId,
        principleId: row.principleId,
        status: 'route_unconfirmed',
        reason: route.unconfirmedReason ?? 'effective injection route cannot be confirmed',
        perHostFits,
      };
    });
    return { route, statuses, warnings };
  }

  const decidedBudget = input.promptBudget
    ?? (route.hostKind !== undefined ? input.perHostPromptBudget?.[route.hostKind] : undefined);
  const projection = await buildLivePromptInjectionProjection({
    workspaceDir: input.workspaceDir,
    targetHost: route.hostKind,
    ...(decidedBudget !== undefined ? { promptBudget: decidedBudget } : {}),
  });
  warnings.push(...projection.warnings);
  const statuses: PromptActivationInjectionStatus[] = rows.map((row) => {
    if ('failure' in row) {
      return { activationId: row.activationId, status: 'resolution_failed', reason: row.failure };
    }
    const { fits, costChars } = computePromptSingleItemFit({
      principle: { principleId: row.principleId, text: row.text, artifactId: '', activationId: row.activationId, ...(row.authority !== undefined ? { authority: row.authority } : {}) },
      selfReportEnabled,
      budget: projection.budget,
    });
    const inCurrentWindow = projection.injectedActivationIds.includes(row.activationId);
    const budgetScope: PromptInjectionBudgetScope = projection.budgetScope;
    const serialization = 'full directive render';
    // Tier verdict FIRST (SPEC §6.3): the projection budget on this surface
    // is the fixed fallback (2000) unless the caller passed a runtime budget
    // OBSERVATION (PRI-1017) — and even then an entry in (MIN, fallback]
    // exceeds the measured floor, so on a 32K/64K model (budget = floor) it
    // would NOT inject. Reporting it as an unconditional `injectable` would
    // contradict the approval-time `model_dependent` verdict for the very
    // same artifact.
    const tierFit = classifySingleItemBudgetTier(costChars);
    if (tierFit === 'exceeds_max_tier') {
      return {
        activationId: row.activationId,
        principleId: row.principleId,
        status: 'oversized',
        inCurrentWindow: false,
        costChars,
        budget: projection.budget,
        budgetScope,
        route: projection.route,
        reason: `single_item_exceeds_budget: this principle's own entry is ${costChars} chars > the ${PROMPT_BUDGET_MAX_CHARS}-char maximum supported budget under the ${serialization} serialization`,
      };
    }
    if (tierFit === 'model_dependent') {
      return {
        activationId: row.activationId,
        principleId: row.principleId,
        status: 'model_dependent',
        inCurrentWindow,
        costChars,
        budget: projection.budget,
        budgetScope,
        route: projection.route,
        reason: `model_dependent_capacity: this principle's own entry is ${costChars} chars — above the ${PROMPT_BUDGET_MIN_CHARS}-char measured floor, so smaller-context models exclude it${fits ? ' even though it fits this surface\'s fallback-budget estimate' : ''}; injection depends on the runtime model`,
      };
    }
    return {
      activationId: row.activationId,
      principleId: row.principleId,
      status: inCurrentWindow ? 'injectable' : 'window_excluded',
      inCurrentWindow,
      costChars,
      budget: projection.budget,
      budgetScope,
      route: projection.route,
    };
  });
  return {
    route,
    statuses,
    warnings,
    budgetProvenance: {
      ...(projection.budgetCapacitySource !== undefined ? { capacitySource: projection.budgetCapacitySource } : {}),
      ...(projection.budgetCapacityStatus !== undefined ? { capacityStatus: projection.budgetCapacityStatus } : {}),
      ...(typeof projection.budgetContextWindowTokens === 'number' ? { contextWindowTokens: projection.budgetContextWindowTokens } : {}),
      ...(projection.budgetPolicyVersion !== undefined ? { policyVersion: projection.budgetPolicyVersion } : {}),
      ...(projection.budgetFallbackReason !== undefined ? { fallbackReason: projection.budgetFallbackReason } : {}),
    },
  };
}
