import {
  RUNTIME_V2_PRINCIPLE_BUDGET,
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  computeFeatureFlagsFromConfig,
  filterPromptActivations,
  renderPrinciplesToDirectives,
  resolvePrincipleFromArtifact,
  type ActivatedPrinciple,
} from '@principles/core/runtime-v2';
import fs from 'node:fs';
import path from 'node:path';
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
  excludedPrincipleIds: string[];
  excludedCount: number;
  exclusionReason?: 'host_principle_overlap';
  allValidatedPrinciplesExcluded: boolean;
}

export interface PromptActivationCandidates {
  principles: ActivatedPrinciple[];
  excludedPrincipleIds: string[];
  warnings: string[];
  /** true = prompt flag off or state.db missing — candidates are necessarily empty */
  aborted: boolean;
  selfReportEnabled: boolean;
  abstractionLayerEnabled: boolean;
}

/**
 * PR #1844 follow-up: the activation READ half of buildActivePrinciplePromptContext,
 * exported so the console budget projection can share the exact same input
 * selection (FIFO activations → artifact resolve → exclude partition) without
 * duplicating logic.
 */
export async function readPromptActivationCandidates(input: {
  workspaceDir: string;
  excludePrincipleIds?: ReadonlySet<string>;
}): Promise<PromptActivationCandidates> {
  const warnings: string[] = [];
  const principles: ActivatedPrinciple[] = [];
  const excludedPrincipleIds: string[] = [];
  const config = loadPdConfigForPlugin(input.workspaceDir);
  if (!config.ok) {
    warnings.push(...config.errors.map((error) => `config_invalid: ${error.reason}; nextAction=${error.nextAction}`));
  }
  const { flags } = computeFeatureFlagsFromConfig(config.effective);
  const { prompt: promptFlag } = flags;
  const abstractionLayerEnabled = flags.abstraction_layer_v1?.enabled === true;
  if (!promptFlag?.enabled) {
    warnings.push('prompt_feature_disabled; nextAction=set features.prompt.enabled=true in .pd/config.yaml');
    return { principles, excludedPrincipleIds, warnings, aborted: true, selfReportEnabled: false, abstractionLayerEnabled };
  }
  // PRI-532: agent self-report instruction rides the directive template when
  // the flag is on (flag-off keeps the template byte-identical).
  const selfReportEnabled = flags.principle_receipt_self_report?.enabled === true;

  let connection: SqliteConnection | undefined;
  const stateDbPath = path.join(input.workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(stateDbPath)) {
    warnings.push('activation_db_not_found; nextAction=initialize_workspace_runtime_state');
    return { principles, excludedPrincipleIds, warnings, aborted: true, selfReportEnabled, abstractionLayerEnabled };
  }
  try {
    connection = new SqliteConnection({ workspaceDir: input.workspaceDir, readonly: true, bootstrapIfMissing: false });
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
      if (input.excludePrincipleIds?.has(resolved.principle.principleId)) {
        excludedPrincipleIds.push(resolved.principle.principleId);
      } else {
        principles.push(resolved.principle);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`activation_db_unreadable: ${message}; nextAction=check_workspace_pd_state_db`);
  } finally {
    connection?.close();
  }
  return { principles, excludedPrincipleIds, warnings, aborted: false, selfReportEnabled, abstractionLayerEnabled };
}

export async function buildActivePrinciplePromptContext(input: {
  workspaceDir: string;
  excludePrincipleIds?: ReadonlySet<string>;
}): Promise<ActivePrinciplePromptResult> {
  const { principles, excludedPrincipleIds, warnings, aborted, selfReportEnabled } =
    await readPromptActivationCandidates(input);
  if (aborted) {
    return {
      additionalContext: '', principleIds: [], activationIds: [], artifactIds: [], warnings,
      budget: RUNTIME_V2_PRINCIPLE_BUDGET, truncated: false, excludedPrincipleIds,
      excludedCount: excludedPrincipleIds.length, allValidatedPrinciplesExcluded: false,
    };
  }

  const included: ActivatedPrinciple[] = [];
  let additionalContext = '';
  let truncated = false;
  for (const principle of principles) {
    const candidate = [...included, principle];
    const candidateContext = renderPrinciplesToDirectives(
      candidate,
      new Set(candidate.map((entry) => entry.principleId)),
      { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled },
    );
    if (candidateContext.length > RUNTIME_V2_PRINCIPLE_BUDGET) {
      truncated = true;
      break;
    }
    included.push(principle);
    additionalContext = candidateContext;
  }
  if (truncated) {
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
    truncated,
    excludedPrincipleIds,
    excludedCount: excludedPrincipleIds.length,
    allValidatedPrinciplesExcluded: excludedPrincipleIds.length > 0 && principles.length === 0,
    ...(excludedPrincipleIds.length > 0 ? { exclusionReason: 'host_principle_overlap' as const } : {}),
  };
}
