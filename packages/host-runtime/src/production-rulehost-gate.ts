import fs from 'node:fs';
import path from 'node:path';
import {
  buildRuleHostAction,
  buildToolSemanticRegistry,
  deriveToolHintsFromCanonicalKind,
  estimateLineChanges,
  mergeDecisions,
  SqliteConnection,
  UNAVAILABLE_RULE_CONTEXT,
  validateRuleContextV2,
  validateRuleHostResult,
  verifyPiArtifactRowDigest,
  type LoadedImplementation,
  type RuleContextV2,
  type RuleHostEvaluatedEventData,
  type RuleHostInput,
  type RuleHostMeta,
  type RuleHostResult,
  type ToolSemanticRegistry,
} from '@principles/core/runtime-v2';
import { scanRetiredContractSymbols } from './legacy-rule-contract-symbols.js';
import { recordDegradedEnforcement } from './degraded-enforcement-marker.js';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import {
  createNodeRuleImplementationRuntime,
  MAX_ACTIVE_RULES,
  RULE_BATCH_SOURCE_BYTES,
  RULE_SOURCE_BYTES,
  type RuleImplementationRuntime,
} from './rule-implementation-runtime.js';

const WARNING_LIMIT = 500;
const MAX_WARNINGS = 16;
const GATE_DEADLINE_MS = 3_000;
const ARTIFACT_CONTENT_BYTES = 512 * 1024;

function boundedWarning(reason: string, nextAction: string): string {
  return `${reason}; nextAction=${nextAction}`.replace(/\s+/g, ' ').slice(0, WARNING_LIMIT);
}

function addWarning(warnings: string[], reason: string, nextAction: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(boundedWarning(reason, nextAction));
}

function remainingGateMs(startedAt: number): number {
  return GATE_DEADLINE_MS - (Date.now() - startedAt);
}

function createDeadlinePromise<T>(remaining: number): { promise: Promise<T>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('gate_deadline_exceeded')), remaining);
    timer.unref?.();
  });
  return { promise, clear: () => { if (timer !== undefined) clearTimeout(timer); } };
}

async function withinGateDeadline<T>(value: T | Promise<T>, startedAt: number): Promise<T> {
  const remaining = remainingGateMs(startedAt);
  if (remaining <= 0) throw new Error('gate_deadline_exceeded');
  const deadline = createDeadlinePromise<T>(remaining);
  try {
    return await Promise.race([Promise.resolve(value), deadline.promise]);
  } finally {
    deadline.clear();
  }
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
  epTier: number;
  bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown';
}
export type RuleInputEnrichmentProvider = (request: ProductionRuleContextRequest) => unknown | Promise<unknown>;

export interface ProductionRuleHostGateOptions {
  ruleContextProvider?: RuleContextProvider;
  ruleInputEnrichmentProvider?: RuleInputEnrichmentProvider;
  implementationRuntime?: RuleImplementationRuntime;
  /**
   * PRI-634-F: host-declared ToolSemanticRegistry. Extraction hints and
   * action.canonicalKind derive from this registry (defaults to the
   * core-baseline registry when the constructing host has not declared its
   * tool semantics). Replaces the previous inline bash/write name sets,
   * which silently disagreed with the OpenClaw host vocabulary
   * (shell/cmd/insert/patch/delete_file/move_file were never hinted).
   */
  toolSemantics?: ToolSemanticRegistry;
}

const baselineToolSemanticsResult = buildToolSemanticRegistry();
// Static baseline input — always builds; throwing here is a programming error.
if (!baselineToolSemanticsResult.ok) {
  throw new Error(`baseline tool semantic registry failed to build: ${baselineToolSemanticsResult.errors.join('; ')}`);
}
const BASELINE_TOOL_SEMANTICS: ToolSemanticRegistry = baselineToolSemanticsResult.registry;

export function createProductionRuleHostGate(options: ProductionRuleHostGateOptions = {}) {
  const implementationRuntime = options.implementationRuntime ?? createNodeRuleImplementationRuntime();
  const toolSemantics = options.toolSemantics ?? BASELINE_TOOL_SEMANTICS;
  return async (event: HostEvent): Promise<HostEventResult> => {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const input = readToolInput(event.rawPayload);
    if (!input || input.toolName !== event.context.toolName) {
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('tool_input_invalid', 'decode and validate toolName and params before dispatch')] };
    }

    const canonicalKind = toolSemantics.resolve(input.toolName);
    const { isBashTool: isBash, isWriteTool: isWrite } = deriveToolHintsFromCanonicalKind(canonicalKind);
    const action = buildRuleHostAction(input.toolName, input.params, event.context.workspaceDir, { isBashTool: isBash, isWriteTool: isWrite, canonicalKind });
    if (action.normalizedPath === null) return { decision: 'allow', source: event.source, metadata: { evaluatedLiveRules: 0 } };

    let context: RuleContextV2 | undefined;
    let enrichment: RuleInputEnrichment = { currentGfi: 0, epTier: 0, bashRisk: 'unknown' };
    const request: ProductionRuleContextRequest = {
      workspaceDir: event.context.workspaceDir, sessionId: event.context.sessionId,
      targetPath: action.normalizedPath, toolName: input.toolName, rawPayload: event.rawPayload,
    };
    if (options.ruleInputEnrichmentProvider) {
      try {
        const candidate: unknown = await withinGateDeadline(options.ruleInputEnrichmentProvider(request), startedAt);
        if (isRecord(candidate) && typeof candidate.currentGfi === 'number' && Number.isFinite(candidate.currentGfi)
          && typeof candidate.epTier === 'number' && Number.isFinite(candidate.epTier)
          && (candidate.bashRisk === 'safe' || candidate.bashRisk === 'normal' || candidate.bashRisk === 'dangerous' || candidate.bashRisk === 'unknown')) {
          enrichment = { currentGfi: candidate.currentGfi, epTier: candidate.epTier, bashRisk: candidate.bashRisk };
        } else addWarning(warnings, 'rule_input_enrichment_invalid', 'repair the host enrichment provider');
      } catch (error: unknown) {
        addWarning(warnings, `rule_input_enrichment_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect the host enrichment provider');
      }
    }
    if (options.ruleContextProvider) {
      try {
        const candidate: unknown = await withinGateDeadline(options.ruleContextProvider(request), startedAt);
        if (candidate === undefined) {
          context = undefined;
        } else {
        const validation = validateRuleContextV2(candidate);
        if (isRuleContext(candidate)) context = candidate;
        else {
          context = UNAVAILABLE_RULE_CONTEXT;
          addWarning(warnings, `rule_context_invalid: ${validation.errors.join('; ')}`, 'repair the host context provider');
        }
        }
      } catch (error: unknown) {
        context = UNAVAILABLE_RULE_CONTEXT;
        addWarning(warnings, `rule_context_provider_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect the host context provider and retry');
      }
    }

    const dbPath = path.join(event.context.workspaceDir, '.pd', 'state.db');
    if (remainingGateMs(startedAt) <= 0) {
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('gate_deadline_exceeded', 'inspect host context providers and active RuleCode resource use')] };
    }
    if (!fs.existsSync(dbPath)) {
      // Security audit run-1 (gate-failopen-allow-on-state-corruption):
      // fail-open stays the availability contract, but a missing governance
      // store is agent-choosable state — record a durable marker OUTSIDE the
      // agent-writable workspace so the degradation is Owner-visible and
      // distinguishable from a never-initialized workspace.
      recordDegradedEnforcement(event.context.workspaceDir, 'activation_db_not_found');
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('activation_db_not_found', 'initialize_workspace_runtime_state')] };
    }

    const connection = new SqliteConnection({ workspaceDir: event.context.workspaceDir, readonly: true, bootstrapIfMissing: false });
    const candidates: { implId: string; ruleId: string; principleId: string; meta: RuleHostMeta; source: string; activationMode: 'live' | 'shadow' }[] = [];
    try {
      const globalPause: unknown = connection.getDb().prepare(`
        SELECT pause_id FROM global_rulecode_pauses WHERE status = 'paused' LIMIT 1
      `).get();
      if (globalPause !== undefined) {
        return {
          decision: 'allow',
          source: event.source,
          warnings: [boundedWarning('global_rulecode_pause_active', 'review the incident in the Owner Console before releasing the global pause')],
          metadata: { evaluatedLiveRules: 0 },
        };
      }
      const rows: unknown = connection.getDb().prepare(`
        SELECT a.activation_id, a.artifact_id, a.target_ref, a.action,
               c.enforcement, c.isolation_decision_id,
               p.source_rule_id, p.source_principle_id,
               length(CAST(p.content_json AS BLOB)) AS content_bytes,
               (SELECT d.artifact_digest FROM activation_decisions d
                WHERE d.subject_kind = 'activation' AND d.activation_id = a.activation_id
                ORDER BY d.decided_at DESC, d.rowid DESC LIMIT 1) AS approved_artifact_digest
        FROM activations a
        JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        LEFT JOIN activation_control_states c ON a.activation_id = c.activation_id
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
        ORDER BY a.activated_at ASC
        LIMIT ?
      `).all(MAX_ACTIVE_RULES + 1);
      if (!Array.isArray(rows)) {
        addWarning(warnings, 'activation_query_invalid', 'inspect state.db schema and integrity');
      } else if (rows.length > MAX_ACTIVE_RULES) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`active_rule_limit_exceeded: maximum ${MAX_ACTIVE_RULES}`, 'deactivate excess active RuleHost rules and retry')], metadata: { evaluatedLiveRules: 0 } };
      } else {
        for (const row of rows) {
          if (!isRecord(row) || typeof row.content_bytes !== 'number' || !Number.isSafeInteger(row.content_bytes) || row.content_bytes < 0) {
            return { decision: 'allow', source: event.source, warnings: [boundedWarning('artifact_content_size_invalid', 'inspect state.db artifact content integrity')], metadata: { evaluatedLiveRules: 0 } };
          }
          if (row.content_bytes > ARTIFACT_CONTENT_BYTES) {
            const activation = typeof row.activation_id === 'string' ? row.activation_id : 'unknown';
            return { decision: 'allow', source: event.source, warnings: [boundedWarning(`artifact_content_budget_exceeded: activation=${activation} bytes=${row.content_bytes} maximum=${ARTIFACT_CONTENT_BYTES}`, 'reduce the active artifact envelope and reactivate the rule')], metadata: { evaluatedLiveRules: 0 } };
          }
        }
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          if (!isRecord(row) || typeof row.target_ref !== 'string' || row.target_ref.length === 0) {
            addWarning(warnings, 'activation_row_invalid', 'deactivate and recreate the malformed activation');
            continue;
          }
          const activationId = typeof row.activation_id === 'string' ? row.activation_id : 'unknown';
          if (row.enforcement === 'safety_isolated') {
            addWarning(warnings, `activation_safety_isolated: ${activationId}`, 'recover the activation to shadow after reviewing safety evidence');
            continue;
          }
          if (row.enforcement !== 'eligible') {
            addWarning(warnings, `activation_control_state_invalid: ${activationId}`, 'repair the activation control state before RuleCode enforcement');
            continue;
          }
          const group = groups.get(row.target_ref) ?? [];
          group.push(row);
          groups.set(row.target_ref, group);
        }
        for (const [targetRef, group] of groups) {
          if (group.length !== 1) {
            addWarning(warnings, `duplicate_active_activation: ${targetRef}`, 'deactivate all but one activation for this target_ref');
            continue;
          }
          const [row] = group;
          if (!row) continue;
          // PRI-813: shadow activations are no longer skipped here — they run
          // through the SAME budget/content/context validation and
          // evaluateBatch pipeline as live rows, but their results are
          // collected as observations only and never join mergeDecisions
          // (shadow observes, never enforces). The v2 gate below stays ahead
          // of any evaluation, so Codex v2 shadow remains suspended.
          const activationMode: 'live' | 'shadow' | null = row.action === 'code_tool_hook_live_activate'
            ? 'live'
            : row.action === 'code_tool_hook_shadow_activate' ? 'shadow' : null;
          if (activationMode === null) continue;
          const activationId = row.activation_id;
          const artifactId = row.artifact_id;
          const expectedContentBytes = row.content_bytes;
          if (typeof activationId !== 'string' || typeof artifactId !== 'string' || typeof expectedContentBytes !== 'number') {
            addWarning(warnings, 'activation_required_fields_invalid', 'deactivate and recreate the activation');
            continue;
          }
          const contentRow: unknown = connection.getDb().prepare(`
            SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
                   lineage_artifact_ids, validation_status, content_json,
                   created_at, updated_at,
                   length(CAST(content_json AS BLOB)) AS content_bytes
            FROM pi_artifacts WHERE artifact_id = ?
          `).get(artifactId);
          if (!isRecord(contentRow) || typeof contentRow.content_json !== 'string'
            || typeof contentRow.content_bytes !== 'number' || !Number.isSafeInteger(contentRow.content_bytes)) {
            addWarning(warnings, `activation_artifact_invalid: ${activationId}`, 'inspect state.db artifact content integrity');
            continue;
          }
          const contentJson = contentRow.content_json;
          const returnedContentBytes = Buffer.byteLength(contentJson, 'utf8');
          if (contentRow.content_bytes > ARTIFACT_CONTENT_BYTES || returnedContentBytes > ARTIFACT_CONTENT_BYTES) {
            // CodeRabbit CR-3: a shadow row's envelope overrun must only skip
            // the shadow observation — pre-PRI-813 this return was unreachable
            // for shadow rows, and letting it fire now would suppress live
            // enforcement (shadow may never influence the live outcome).
            if (activationMode === 'shadow') {
              addWarning(warnings, `artifact_content_budget_exceeded: activation=${activationId} bytes=${Math.max(contentRow.content_bytes, returnedContentBytes)} maximum=${ARTIFACT_CONTENT_BYTES}`, 'reduce the active shadow artifact envelope and reactivate the rule; live enforcement is unaffected');
              continue;
            }
            return { decision: 'allow', source: event.source, warnings: [boundedWarning(`artifact_content_budget_exceeded: activation=${activationId} bytes=${Math.max(contentRow.content_bytes, returnedContentBytes)} maximum=${ARTIFACT_CONTENT_BYTES}`, 'reduce the active artifact envelope and reactivate the rule')], metadata: { evaluatedLiveRules: 0 } };
          }
          if (contentRow.content_bytes !== expectedContentBytes || returnedContentBytes !== contentRow.content_bytes) {
            if (activationMode === 'shadow') {
              addWarning(warnings, `artifact_content_size_changed: activation=${activationId}`, 'retry after the active shadow artifact update completes; live enforcement is unaffected');
              continue;
            }
            return { decision: 'allow', source: event.source, warnings: [boundedWarning(`artifact_content_size_changed: activation=${activationId}`, 'retry after the active artifact update completes')], metadata: { evaluatedLiveRules: 0 } };
          }
          // Enforcement-time content binding (security audit run-1,
          // rulecode-approval-content-unbound): the Owner decision recorded
          // activation_decisions.artifact_digest over the promotion-time
          // artifact snapshot. Re-verify the CURRENT row against that digest
          // before compiling — a workspace-local writer can UPDATE
          // content_json, and executing content the Owner never approved
          // silently defeats enforcement. A digest mismatch is an integrity
          // failure, not an availability failure: skip this activation with a
          // structured warning instead of failing open. Rows without a
          // recorded activation-scoped decision (legacy activations from
          // before the owner-decision lifecycle) keep their prior behavior.
          // The check itself is core-owned (verifyPiArtifactRowDigest) so the
          // gate and the plugin RuleHost cannot drift.
          const approvedArtifactDigest = typeof row.approved_artifact_digest === 'string' ? row.approved_artifact_digest : null;
          const digestCheck = verifyPiArtifactRowDigest(contentRow, contentJson, approvedArtifactDigest);
          if (digestCheck.outcome === 'unverifiable') {
            addWarning(warnings, `activation_artifact_invalid: ${activationId} (${digestCheck.error})`, 'inspect state.db artifact row integrity; the approved digest could not be re-verified');
            continue;
          }
          if (digestCheck.outcome === 'tampered') {
            const digestNextAction = 'the artifact content no longer matches the Owner-approved digest — deactivate and re-approve the rule; execution was skipped';
            if (activationMode === 'shadow') {
              addWarning(warnings, `artifact_digest_mismatch (shadow): activation=${activationId}`, `${digestNextAction}; live enforcement is unaffected`);
              continue;
            }
            addWarning(warnings, `artifact_content_tampered: activation=${activationId} approved=${approvedArtifactDigest} actual=${digestCheck.actualDigest}`, digestNextAction);
            continue;
          }
          try {
            const content: unknown = JSON.parse(contentJson);
            if (!isRecord(content) || typeof content.implementationCode !== 'string' || content.implementationCode.length === 0) {
              addWarning(warnings, `activation_artifact_invalid: ${activationId}`, 'regenerate the rule artifact with implementationCode');
              continue;
            }
            const sourceBytes = Buffer.byteLength(content.implementationCode, 'utf8');
            if (sourceBytes > RULE_SOURCE_BYTES) {
              if (activationMode === 'shadow') {
                addWarning(warnings, `rule_source_budget_exceeded: activation=${activationId} bytes=${sourceBytes}`, `reduce the shadow RuleCode source below ${RULE_SOURCE_BYTES} bytes; live enforcement is unaffected`);
                continue;
              }
              return { decision: 'allow', source: event.source, warnings: [boundedWarning(`rule_source_budget_exceeded: activation=${activationId} bytes=${sourceBytes}`, `reduce each RuleCode source below ${RULE_SOURCE_BYTES} bytes`)], metadata: { evaluatedLiveRules: 0 } };
            }
            if (Object.hasOwn(content, 'requiresContextVersion')) {
              if (content.requiresContextVersion !== 2) {
                addWarning(warnings, `unsupported_context_version: ${String(content.requiresContextVersion)}`, 'regenerate the rule artifact for context version 2');
                continue;
              }
              if (!context) {
                addWarning(warnings, 'rule_context_v2_unavailable', 'enable and wire the host rule context provider');
                continue;
              }
            }
            const ruleId = typeof content.ruleId === 'string' ? content.ruleId : typeof row.source_rule_id === 'string' ? row.source_rule_id : artifactId;
            const principleId = typeof content.principleId === 'string' ? content.principleId : typeof row.source_principle_id === 'string' ? row.source_principle_id : ruleId;
            // Retired-contract backstop (2026-08-19; host-liveness correction
            // 2026-08-21):
            // persisted LIVE RuleCode that references removed RuleHost
            // contract symbols can never run safely against the new contract
            // — reads silently resolve to undefined and change owner-approved
            // behavior. The incompatible activation is therefore skipped and
            // surfaced with an actionable warning. It must not turn a runtime
            // compatibility defect into a host-wide deny; healthy sibling
            // rules continue to evaluate. The scan is a local copy (see
            // legacy-rule-contract-symbols.ts) so the published bundle keeps
            // working against the currently published core.
            const retiredSymbols = scanRetiredContractSymbols(content.implementationCode);
            if (retiredSymbols.length > 0) {
              const nextAction = 'migrate the RuleCode off the retired contract symbols or deactivate the activation, then re-approve a migrated rule';
              addWarning(warnings, `legacy_rule_contract_dependency: ${retiredSymbols.join(', ')} (activation=${activationId})`, nextAction);
              continue;
            }
            const fallbackMeta: RuleHostMeta = { name: activationId, version: '1', ruleId, coversCondition: 'all' };
            candidates.push({ implId: activationId, ruleId, principleId, meta: isRuleMeta(content.meta) ? content.meta : fallbackMeta, source: content.implementationCode, activationMode });
          } catch (error: unknown) {
            addWarning(warnings, `implementation_unhealthy: ${error instanceof Error ? error.message : String(error)}`, 'fix the RuleCode and reactivate the rule');
          }
        }
      }

      const hostInput: RuleHostInput = {
        action,
        workspace: { isRiskPath: false },
        session: { sessionId: event.context.sessionId, currentGfi: enrichment.currentGfi },
        evolution: { epTier: enrichment.epTier },
        derived: { estimatedLineChanges: estimateLineChanges({ toolName: input.toolName, params: input.params }), bashRisk: enrichment.bashRisk },
        ...(context ? { context } : {}),
      };
      // CodeRabbit CR-3: live and shadow evaluate in SEPARATE batches so a
      // shadow rule's timeout/budget failure can never suppress live
      // enforcement (shadow observes; it must not influence the live
      // outcome). Live keeps the exact pre-PRI-813 early-return semantics;
      // every shadow-batch failure degrades to a warning and skips the
      // shadow observation only.
      const liveCandidates = candidates.filter((candidate) => candidate.activationMode === 'live');
      const shadowCandidates = candidates.filter((candidate) => candidate.activationMode === 'shadow');
      const liveBatchBytes = liveCandidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.source, 'utf8'), 0);
      if (liveBatchBytes > RULE_BATCH_SOURCE_BYTES) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`rule_source_budget_exceeded: batchBytes=${liveBatchBytes}`, `reduce total active RuleCode below ${RULE_BATCH_SOURCE_BYTES} bytes`)], metadata: { evaluatedLiveRules: 0 } };
      }
      let remaining = remainingGateMs(startedAt);
      if (remaining <= 0) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning('gate_deadline_exceeded', 'reduce active RuleCode count or source size and retry')], metadata: { evaluatedLiveRules: 0 } };
      }
      const liveBatch = implementationRuntime.evaluateBatch(
        liveCandidates.map((candidate) => ({ source: candidate.source, filename: `activation-${candidate.implId}` })),
        hostInput,
        remaining,
      );
      if (!liveBatch.ok || !liveBatch.results) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`${liveBatch.reason ?? 'rule_batch_failed'}: ${liveBatch.detail ?? 'unknown failure'}`, 'inspect active RuleCode resource use and repair or deactivate the unhealthy rule')], metadata: { evaluatedLiveRules: 0 } };
      }
      const timedOutChild = liveBatch.results.find((candidate) => !candidate.ok && candidate.error?.includes('timed out'));
      if (timedOutChild) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`rule_batch_timeout: ${timedOutChild.error ?? 'unknown child timeout'}`, 'fix or deactivate the unhealthy RuleCode and retry')], metadata: { evaluatedLiveRules: 0 } };
      }

      // PRI-813: one canonical evaluation fact per shadow activation —
      // observations only. Shadow results never join mergeDecisions, never
      // block/modify/require approval: they record what a live rule WOULD
      // have decided (ACTIVATION_CHANNELS §3.4), mirroring the legacy
      // RuleHost report's shadowDecisions. Every failure mode below skips
      // shadow observation without touching the live decision.
      const shadowEvaluations: RuleHostEvaluatedEventData[] = [];
      if (shadowCandidates.length > 0) {
        const shadowBatchBytes = shadowCandidates.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.source, 'utf8'), 0);
        remaining = remainingGateMs(startedAt);
        if (shadowBatchBytes > RULE_BATCH_SOURCE_BYTES) {
          addWarning(warnings, `rule_source_budget_exceeded: shadowBatchBytes=${shadowBatchBytes}`, `reduce total shadow RuleCode below ${RULE_BATCH_SOURCE_BYTES} bytes; shadow observation was skipped, live enforcement is unaffected`);
        } else if (remaining <= 0) {
          addWarning(warnings, 'gate_deadline_exceeded', 'shadow observation was skipped after the live evaluation budget; live enforcement is unaffected');
        } else {
          const shadowBatch = implementationRuntime.evaluateBatch(
            shadowCandidates.map((candidate) => ({ source: candidate.source, filename: `activation-${candidate.implId}` })),
            hostInput,
            remaining,
          );
          const shadowTimedOut = shadowBatch.ok && shadowBatch.results
            ? shadowBatch.results.find((candidate) => !candidate.ok && candidate.error?.includes('timed out'))
            : undefined;
          if (!shadowBatch.ok || !shadowBatch.results) {
            addWarning(warnings, `${shadowBatch.ok ? 'rule_batch_failed' : shadowBatch.reason ?? 'rule_batch_failed'}: ${shadowBatch.ok ? 'unknown failure' : shadowBatch.detail ?? 'unknown failure'}`, 'inspect active shadow RuleCode; the shadow observation was skipped, live enforcement is unaffected');
          } else if (shadowTimedOut) {
            addWarning(warnings, `rule_batch_timeout: ${shadowTimedOut.error ?? 'unknown child timeout'}`, 'fix or deactivate the unhealthy shadow RuleCode; the shadow observation was skipped, live enforcement is unaffected');
          } else {
            for (let index = 0; index < shadowCandidates.length; index += 1) {
              const candidate = shadowCandidates[index];
              const batchResult = shadowBatch.results[index];
              if (!candidate || !batchResult || !batchResult.ok) {
                addWarning(warnings, `implementation_unhealthy: ${batchResult && !batchResult.ok ? batchResult.error ?? 'unknown child error' : 'rule_batch_result_missing'}`, 'fix the shadow RuleCode and reactivate the rule; live enforcement is unaffected');
                continue;
              }
              const validation = validateRuleHostResult(batchResult.result);
              if (!isRuleResult(batchResult.result)) {
                addWarning(warnings, `invalid RuleHostResult: ${validation.errors.join('; ')}`, 'fix the shadow RuleCode result and reactivate the rule; live enforcement is unaffected');
                continue;
              }
              const shadowResult = batchResult.result.matched
                ? { ...batchResult.result, ruleId: candidate.ruleId, principleId: candidate.principleId }
                : batchResult.result;
              shadowEvaluations.push({
                toolName: input.toolName,
                filePath: action.normalizedPath,
                matched: shadowResult.matched,
                decision: shadowResult.decision,
                ruleId: candidate.ruleId,
                activationId: candidate.implId,
                activationMode: 'shadow',
              });
            }
          }
        }
      }

      const implementations: LoadedImplementation[] = [];
      const liveEvaluatedResults: RuleHostResult[] = [];
      for (let index = 0; index < liveCandidates.length; index += 1) {
        const candidate = liveCandidates[index];
        const batchResult = liveBatch.results[index];
        if (!candidate || !batchResult) {
          addWarning(warnings, 'rule_batch_result_missing', 'inspect the RuleCode runtime result contract');
          continue;
        }
        if (!batchResult.ok) {
          addWarning(warnings, `implementation_unhealthy: ${batchResult.error ?? 'unknown child error'}`, 'fix the RuleCode and reactivate the rule');
          continue;
        }
        const validation = validateRuleHostResult(batchResult.result);
        if (!isRuleResult(batchResult.result)) {
          addWarning(warnings, `invalid RuleHostResult: ${validation.errors.join('; ')}`, 'fix the RuleCode result and reactivate the rule');
          continue;
        }
        const validatedResult = batchResult.result.matched
          ? { ...batchResult.result, ruleId: candidate.ruleId, principleId: candidate.principleId }
          : batchResult.result;
        implementations.push({ ...candidate, evaluate: () => validatedResult });
        liveEvaluatedResults.push(validatedResult);
      }
      const result = mergeDecisions(implementations, hostInput, {
        warn(message) { addWarning(warnings, message, 'inspect the unhealthy activation and RuleCode output'); },
      });
      // PRI-813 + CodeRabbit CR-4: attribute the winning live activation by
      // REFERENCE IDENTITY — mergeDecisions returns the winning candidate's
      // own result object for block/auto_correct, so indexOf is exact even
      // when two live activations share a ruleId (the previous ruleId
      // reverse-lookup could mis-attribute). Unattributable outcomes
      // (requireApproval aggregate, no winner) carry no activationId.
      const winnerIndex = result === undefined ? -1 : liveEvaluatedResults.indexOf(result);
      const liveActivationId = winnerIndex >= 0 ? implementations[winnerIndex]?.implId : undefined;
      // PRI-813: per-activation evaluation facts for host-side telemetry
      // writers. HostEventResult.metadata is the designed channel for
      // host-neutral evaluation facts; each entry maps losslessly onto the
      // canonical RuleHostEvaluatedEventData contract.
      const evaluations: RuleHostEvaluatedEventData[] = [
        {
          toolName: input.toolName,
          filePath: action.normalizedPath,
          matched: result?.matched ?? false,
          // CodeRabbit CR-5 / PRI-567: an EMPTY live set is 'no_rules_armed',
          // not a live 'allow' — enforcement statistics must not read as if a
          // live rule evaluated (the legacy writer already distinguishes
          // this; the shared path now aligns).
          decision: liveCandidates.length === 0 ? 'no_rules_armed' : result?.decision ?? 'allow',
          ...(result?.ruleId !== undefined ? { ruleId: result.ruleId } : {}),
          ...(liveActivationId !== undefined ? { activationId: liveActivationId } : {}),
          activationMode: 'live',
        },
        ...shadowEvaluations,
      ];
      if (result?.decision === 'block') {
        if (result.reason.trim().length === 0) {
          addWarning(warnings, 'deny_reason_missing', 'fix the RuleCode to return a non-empty block reason');
          return { decision: 'allow', source: event.source, warnings, metadata: { evaluatedLiveRules: implementations.length, evaluations } };
        }
        return { decision: 'deny', reason: result.reason, source: event.source, ...(warnings.length ? { warnings } : {}), metadata: { evaluatedLiveRules: implementations.length, ruleId: result.ruleId, principleId: result.principleId, evaluations } };
      }
      return { decision: 'allow', source: event.source, ...(warnings.length ? { warnings } : {}), metadata: { evaluatedLiveRules: implementations.length, ruleDecision: result?.decision ?? 'allow', evaluations } };
    } catch (error: unknown) {
      addWarning(warnings, `activation_read_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect state.db schema and integrity');
      // Same durable-marker contract as the missing-DB branch: a corrupt or
      // unreadable governance store degrades enforcement to allow, so the
      // degradation must leave a durable, Owner-visible trace outside the
      // agent-writable workspace. Best-effort; never replaces the decision.
      try {
        recordDegradedEnforcement(event.context.workspaceDir, `activation_read_failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      } catch { /* observability only */ }
      return { decision: 'allow', source: event.source, warnings, metadata: { evaluatedLiveRules: 0 } };
    } finally {
      connection.close();
    }
  };
}
