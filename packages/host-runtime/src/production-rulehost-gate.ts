import fs from 'node:fs';
import path from 'node:path';
import {
  buildRuleHostAction,
  estimateLineChanges,
  mergeDecisions,
  SqliteConnection,
  UNAVAILABLE_RULE_CONTEXT,
  validateRuleContextV2,
  validateRuleHostResult,
  type LoadedImplementation,
  type RuleContextV2,
  type RuleHostInput,
  type RuleHostMeta,
  type RuleHostResult,
} from '@principles/core/runtime-v2';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import { createNodeRuleImplementationRuntime, type RuleImplementationRuntime } from './rule-implementation-runtime.js';

const WARNING_LIMIT = 500;

function boundedWarning(reason: string, nextAction: string): string {
  return `${reason}; nextAction=${nextAction}`.slice(0, WARNING_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ToolInput { toolName: string; params: Record<string, unknown> }

function readToolInput(rawPayload: unknown): ToolInput | null {
  if (!isRecord(rawPayload) || !Object.hasOwn(rawPayload, 'toolInput')) return null;
  const input = rawPayload.toolInput;
  if (!isRecord(input) || typeof input.toolName !== 'string' || input.toolName.trim().length === 0) return null;
  const {params} = input;
  if (!isRecord(params)) return null;
  return { toolName: input.toolName, params };
}

function isRuleMeta(value: unknown): value is RuleHostMeta {
  return isRecord(value) && typeof value.name === 'string' && typeof value.version === 'string'
    && typeof value.ruleId === 'string' && typeof value.coversCondition === 'string';
}

function isRuleContext(value: unknown): value is RuleContextV2 {
  return validateRuleContextV2(value).valid;
}

function isRuleResult(value: unknown): value is RuleHostResult {
  return validateRuleHostResult(value).valid;
}

export interface ProductionRuleContextRequest {
  workspaceDir: string;
  sessionId: string;
  targetPath: string;
  toolName: string;
  rawPayload: unknown;
}

export type RuleContextProvider = (request: ProductionRuleContextRequest) => unknown | Promise<unknown>;
export interface RuleInputEnrichment {
  currentGfi: number;
  recentThinking: boolean;
  epTier: number;
  bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown';
}
export type RuleInputEnrichmentProvider = (request: ProductionRuleContextRequest) => unknown | Promise<unknown>;

export interface ProductionRuleHostGateOptions {
  ruleContextProvider?: RuleContextProvider;
  ruleInputEnrichmentProvider?: RuleInputEnrichmentProvider;
  implementationRuntime?: RuleImplementationRuntime;
}

export function createProductionRuleHostGate(options: ProductionRuleHostGateOptions = {}) {
  const implementationRuntime = options.implementationRuntime ?? createNodeRuleImplementationRuntime();
  return async (event: HostEvent): Promise<HostEventResult> => {
    const warnings: string[] = [];
    const input = readToolInput(event.rawPayload);
    if (!input || input.toolName !== event.context.toolName) {
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('tool_input_invalid', 'decode and validate toolName and params before dispatch')] };
    }

    const isBash = new Set(['bash', 'exec', 'execute', 'run_shell_command']).has(input.toolName);
    const isWrite = new Set(['write', 'write_file', 'edit', 'edit_file', 'replace', 'apply_patch']).has(input.toolName);
    const action = buildRuleHostAction(input.toolName, input.params, event.context.workspaceDir, { isBashTool: isBash, isWriteTool: isWrite });
    if (action.normalizedPath === null) return { decision: 'allow', source: event.source, metadata: { evaluatedLiveRules: 0 } };

    let context: RuleContextV2 | undefined;
    let enrichment: RuleInputEnrichment = { currentGfi: 0, recentThinking: false, epTier: 0, bashRisk: 'unknown' };
    const request: ProductionRuleContextRequest = {
      workspaceDir: event.context.workspaceDir, sessionId: event.context.sessionId,
      targetPath: action.normalizedPath, toolName: input.toolName, rawPayload: event.rawPayload,
    };
    if (options.ruleInputEnrichmentProvider) {
      try {
        const candidate: unknown = await options.ruleInputEnrichmentProvider(request);
        if (isRecord(candidate) && typeof candidate.currentGfi === 'number' && Number.isFinite(candidate.currentGfi)
          && typeof candidate.recentThinking === 'boolean' && typeof candidate.epTier === 'number' && Number.isFinite(candidate.epTier)
          && (candidate.bashRisk === 'safe' || candidate.bashRisk === 'normal' || candidate.bashRisk === 'dangerous' || candidate.bashRisk === 'unknown')) {
          enrichment = { currentGfi: candidate.currentGfi, recentThinking: candidate.recentThinking, epTier: candidate.epTier, bashRisk: candidate.bashRisk };
        } else warnings.push(boundedWarning('rule_input_enrichment_invalid', 'repair the host enrichment provider'));
      } catch (error: unknown) {
        warnings.push(boundedWarning(`rule_input_enrichment_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect the host enrichment provider'));
      }
    }
    if (options.ruleContextProvider) {
      try {
        const candidate: unknown = await options.ruleContextProvider(request);
        if (candidate === undefined) {
          context = undefined;
        } else {
        const validation = validateRuleContextV2(candidate);
        if (isRuleContext(candidate)) context = candidate;
        else {
          context = UNAVAILABLE_RULE_CONTEXT;
          warnings.push(boundedWarning(`rule_context_invalid: ${validation.errors.join('; ')}`, 'repair the host context provider'));
        }
        }
      } catch (error: unknown) {
        context = UNAVAILABLE_RULE_CONTEXT;
        warnings.push(boundedWarning(`rule_context_provider_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect the host context provider and retry'));
      }
    }

    const dbPath = path.join(event.context.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(dbPath)) {
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('activation_db_not_found', 'initialize_workspace_runtime_state')] };
    }

    const connection = new SqliteConnection({ workspaceDir: event.context.workspaceDir, readonly: true, bootstrapIfMissing: false });
    const implementations: LoadedImplementation[] = [];
    try {
      const rows: unknown = connection.getDb().prepare(`
        SELECT a.activation_id, a.artifact_id, a.target_ref, a.action,
               p.content_json, p.source_rule_id, p.source_principle_id
        FROM activations a JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
        ORDER BY a.activated_at ASC
      `).all();
      if (!Array.isArray(rows)) {
        warnings.push(boundedWarning('activation_query_invalid', 'inspect state.db schema and integrity'));
      } else {
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          if (!isRecord(row) || typeof row.target_ref !== 'string' || row.target_ref.length === 0) {
            warnings.push(boundedWarning('activation_row_invalid', 'deactivate and recreate the malformed activation'));
            continue;
          }
          const group = groups.get(row.target_ref) ?? [];
          group.push(row);
          groups.set(row.target_ref, group);
        }
        for (const [targetRef, group] of groups) {
          if (group.length !== 1) {
            warnings.push(boundedWarning(`duplicate_active_activation: ${targetRef}`, 'deactivate all but one activation for this target_ref'));
            continue;
          }
          const [row] = group;
          if (!row || row.action !== 'code_tool_hook_live_activate') continue;
          const activationId = row.activation_id;
          const artifactId = row.artifact_id;
          const contentJson = row.content_json;
          if (typeof activationId !== 'string' || typeof artifactId !== 'string' || typeof contentJson !== 'string') {
            warnings.push(boundedWarning('activation_required_fields_invalid', 'deactivate and recreate the activation'));
            continue;
          }
          try {
            const content: unknown = JSON.parse(contentJson);
            if (!isRecord(content) || typeof content.implementationCode !== 'string' || content.implementationCode.length === 0) {
              warnings.push(boundedWarning(`activation_artifact_invalid: ${activationId}`, 'regenerate the rule artifact with implementationCode'));
              continue;
            }
            if (Object.hasOwn(content, 'requiresContextVersion')) {
              if (content.requiresContextVersion !== 2) {
                warnings.push(boundedWarning(`unsupported_context_version: ${String(content.requiresContextVersion)}`, 'regenerate the rule artifact for context version 2'));
                continue;
              }
              if (!context) {
                warnings.push(boundedWarning('rule_context_v2_unavailable', 'enable and wire the host rule context provider'));
                continue;
              }
            }
            const ruleId = typeof content.ruleId === 'string' ? content.ruleId : typeof row.source_rule_id === 'string' ? row.source_rule_id : artifactId;
            const principleId = typeof content.principleId === 'string' ? content.principleId : typeof row.source_principle_id === 'string' ? row.source_principle_id : ruleId;
            const evaluateUnknown = implementationRuntime.compile(content.implementationCode, `activation-${activationId}`);
            const fallbackMeta: RuleHostMeta = { name: activationId, version: '1', ruleId, coversCondition: 'all' };
            implementations.push({
              implId: activationId, ruleId, meta: isRuleMeta(content.meta) ? content.meta : fallbackMeta,
              evaluate(ruleInput: RuleHostInput): RuleHostResult {
                const raw: unknown = evaluateUnknown(ruleInput);
                const validation = validateRuleHostResult(raw);
                if (!isRuleResult(raw)) throw new Error(`invalid RuleHostResult: ${validation.errors.join('; ')}`);
                if (raw.matched) return { ...raw, ruleId, principleId };
                return raw;
              },
            });
          } catch (error: unknown) {
            warnings.push(boundedWarning(`implementation_unhealthy: ${error instanceof Error ? error.message : String(error)}`, 'fix the RuleCode and reactivate the rule'));
          }
        }
      }

      const hostInput: RuleHostInput = {
        action,
        workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
        session: { sessionId: event.context.sessionId, currentGfi: enrichment.currentGfi, recentThinking: enrichment.recentThinking },
        evolution: { epTier: enrichment.epTier },
        derived: { estimatedLineChanges: estimateLineChanges({ toolName: input.toolName, params: input.params }), bashRisk: enrichment.bashRisk },
        ...(context ? { context } : {}),
      };
      const result = mergeDecisions(implementations, hostInput, {
        warn(message) { warnings.push(boundedWarning(message, 'inspect the unhealthy activation and RuleCode output')); },
      });
      if (result?.decision === 'block') {
        if (result.reason.trim().length === 0) {
          warnings.push(boundedWarning('deny_reason_missing', 'fix the RuleCode to return a non-empty block reason'));
          return { decision: 'allow', source: event.source, warnings, metadata: { evaluatedLiveRules: implementations.length } };
        }
        return { decision: 'deny', reason: result.reason, source: event.source, ...(warnings.length ? { warnings } : {}), metadata: { evaluatedLiveRules: implementations.length, ruleId: result.ruleId, principleId: result.principleId } };
      }
      return { decision: 'allow', source: event.source, ...(warnings.length ? { warnings } : {}), metadata: { evaluatedLiveRules: implementations.length, ruleDecision: result?.decision ?? 'allow' } };
    } catch (error: unknown) {
      warnings.push(boundedWarning(`activation_read_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect state.db schema and integrity'));
      return { decision: 'allow', source: event.source, warnings, metadata: { evaluatedLiveRules: 0 } };
    } finally {
      connection.close();
    }
  };
}
