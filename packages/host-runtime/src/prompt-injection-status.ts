import fs from 'node:fs';
import path from 'node:path';
import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  computeFeatureFlagsFromConfig,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
} from '@principles/core/runtime-v2';
import { loadPdConfigForPlugin } from './pd-config.js';
import { computePromptSingleItemFit } from './prompt-activation-deliverability.js';
import {
  PROMPT_INJECTION_TARGET_HOSTS,
  buildLivePromptInjectionProjection,
  promptRouteForHost,
  resolvePromptInjectionRouteDecision,
  type PromptInjectionBudgetScope,
  type PromptInjectionRouteDecision,
  type PromptInjectionRouteName,
  type PromptInjectionTargetHost,
} from './prompt-injection-projection.js';

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
 */

export type PromptActivationInjectionStatusKind =
  | 'injectable'
  | 'oversized'
  | 'window_excluded'
  | 'resolution_failed'
  | 'route_unconfirmed';

export interface PromptActivationInjectionStatus {
  activationId: string;
  principleId?: string;
  status: PromptActivationInjectionStatusKind;
  /** Present for injectable/window_excluded/oversized under a confirmed route. */
  inCurrentWindow?: boolean;
  /** Present when the single-item cost was computable. */
  costChars?: number;
  budget?: number;
  budgetScope?: PromptInjectionBudgetScope;
  route?: PromptInjectionRouteName;
  /** Present for resolution_failed / route_unconfirmed (structured reason). */
  reason?: string;
  /** Present for route_unconfirmed: per-host single-item fit facts. */
  perHostFits?: readonly { hostKind: PromptInjectionTargetHost; fits: boolean }[];
}

export interface PromptActivationInjectionStatusReport {
  route: PromptInjectionRouteDecision;
  /** Empty when injection is globally unavailable (prompt flag off / state.db missing) — see `globalReason`. */
  statuses: PromptActivationInjectionStatus[];
  warnings: string[];
  /** Present when no status could be computed at all (fail-loud degradation, rc-9). */
  globalReason?: string;
}

export async function readPromptActivationInjectionStatuses(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
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
  const stateDbPath = path.join(input.workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(stateDbPath)) {
    return {
      route,
      statuses: [],
      warnings,
      globalReason: 'activation_db_not_found: .pd/state.db is missing, live activations cannot be read; nextAction=initialize_workspace_runtime_state',
    };
  }

  type Row =
    | { activationId: string; principleId: string; text: string }
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
        },
        activation,
      );
      if (!resolved.ok) {
        rows.push({ activationId: activation.activationId, failure: resolved.warning });
        continue;
      }
      rows.push({
        activationId: activation.activationId,
        principleId: resolved.principle.principleId,
        text: resolved.principle.text,
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
        const hostRoute = promptRouteForHost(hostKind, route.flagEnabled);
        const { fits } = computePromptSingleItemFit({
          principle: { principleId: row.principleId, text: row.text, artifactId: '', activationId: row.activationId },
          route: hostRoute,
          selfReportEnabled,
        });
        return { hostKind, fits };
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

  const projection = await buildLivePromptInjectionProjection({
    workspaceDir: input.workspaceDir,
    targetHost: route.hostKind,
  });
  warnings.push(...projection.warnings);
  const statuses: PromptActivationInjectionStatus[] = rows.map((row) => {
    if ('failure' in row) {
      return { activationId: row.activationId, status: 'resolution_failed', reason: row.failure };
    }
    const { fits, costChars } = computePromptSingleItemFit({
      principle: { principleId: row.principleId, text: row.text, artifactId: '', activationId: row.activationId },
      route: projection.route,
      selfReportEnabled,
    });
    const inCurrentWindow = projection.injectedActivationIds.includes(row.activationId);
    const budgetScope: PromptInjectionBudgetScope = projection.budgetScope;
    if (!fits) {
      return {
        activationId: row.activationId,
        principleId: row.principleId,
        status: 'oversized',
        inCurrentWindow: false,
        costChars,
        budget: RUNTIME_V2_PRINCIPLE_BUDGET,
        budgetScope,
        route: projection.route,
        reason: `single_item_exceeds_budget: this principle's own entry is ${costChars} chars > ${RUNTIME_V2_PRINCIPLE_BUDGET} under the ${projection.route === 'shared_render' ? 'full directive render' : 'list entry'} serialization`,
      };
    }
    return {
      activationId: row.activationId,
      principleId: row.principleId,
      status: inCurrentWindow ? 'injectable' : 'window_excluded',
      inCurrentWindow,
      costChars,
      budget: RUNTIME_V2_PRINCIPLE_BUDGET,
      budgetScope,
      route: projection.route,
    };
  });
  return { route, statuses, warnings };
}
