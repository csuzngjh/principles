import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  computeFeatureFlagsFromConfig,
  filterPromptActivations,
  renderPrinciplesToDirectives,
  resolvePrincipleFromArtifact,
  trimToBudget,
  type ActivatedPrinciple,
} from '@principles/core/runtime-v2';
import { escapeXml } from '@principles/core/prompt-builder';
import { loadPdConfigForPlugin } from './pd-config.js';

export interface ActivePrinciplePromptResult {
  additionalContext: string;
  principleIds: string[];
  activationIds: string[];
  artifactIds: string[];
  warnings: string[];
  budget: number;
  truncated: boolean;
}

export async function buildActivePrinciplePromptContext(input: {
  workspaceDir: string;
  excludePrincipleIds?: ReadonlySet<string>;
}): Promise<ActivePrinciplePromptResult> {
  const warnings: string[] = [];
  const principles: ActivatedPrinciple[] = [];
  const config = loadPdConfigForPlugin(input.workspaceDir);
  if (!config.ok) {
    warnings.push(...config.errors.map((error) => `config_invalid: ${error.reason}; nextAction=${error.nextAction}`));
  }
  const promptFlag = computeFeatureFlagsFromConfig(config.effective).flags.prompt;
  if (!promptFlag?.enabled) {
    warnings.push('prompt_feature_disabled; nextAction=set features.prompt.enabled=true in .pd/config.yaml');
    return { additionalContext: '', principleIds: [], activationIds: [], artifactIds: [], warnings, budget: RUNTIME_V2_PRINCIPLE_BUDGET, truncated: false };
  }

  let connection: SqliteConnection | undefined;
  try {
    connection = new SqliteConnection(input.workspaceDir);
    const activations = filterPromptActivations(await new SqliteActivationStateStore(connection).listPromptActivations());
    for (const activation of activations) {
      let row: unknown | null;
      try {
        row = connection.getDb().prepare(`
          SELECT artifact_id, artifact_kind, content_json, validation_status
          FROM pi_artifacts WHERE artifact_id = ?
        `).get(activation.artifactId) ?? null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`artifact_query_failed: artifactId=${activation.artifactId} reason=${message}; nextAction=check_pi_artifacts_table`);
        continue;
      }
      if (row === null) {
        warnings.push(`artifact_not_found: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table_or_remove_stale_activation`);
        continue;
      }
      const resolved = resolvePrincipleFromArtifact(row, activation);
      if (!resolved.ok) {
        warnings.push(resolved.warning);
        continue;
      }
      if (!input.excludePrincipleIds?.has(resolved.principle.principleId)) principles.push(resolved.principle);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`activation_db_unreadable: ${message}; nextAction=check_workspace_pd_state_db`);
  } finally {
    connection?.close();
  }

  const selected = trimToBudget(principles, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);
  const included = principles.filter((principle) => selected.injectedIds.has(principle.principleId));
  let additionalContext = renderPrinciplesToDirectives(included, new Set(included.map((principle) => principle.principleId)), escapeXml);
  let bounded = false;
  while (additionalContext.length > 9_000 && included.length > 0) {
    included.pop();
    bounded = true;
    additionalContext = renderPrinciplesToDirectives(included, new Set(included.map((principle) => principle.principleId)), escapeXml);
  }
  if (bounded) {
    warnings.push('prompt_context_truncated: production_prompt_cap; nextAction=reduce_active_prompt_principles');
  }
  const injectedIds = new Set(included.map((principle) => principle.principleId));
  return {
    additionalContext,
    principleIds: [...injectedIds],
    activationIds: included.map((principle) => principle.activationId),
    artifactIds: included.map((principle) => principle.artifactId),
    warnings,
    budget: RUNTIME_V2_PRINCIPLE_BUDGET,
    truncated: selected.truncated || bounded,
  };
}
