import fs from 'node:fs';
import path from 'node:path';
import {
  buildRuleHostAction,
  buildToolSemanticRegistry,
  deriveToolHintsFromCanonicalKind,
  estimateLineChanges,
  mergeDecisions,
  normalizeRuleHostResult,
  SqliteConnection,
  UNAVAILABLE_RULE_CONTEXT,
  validateRuleContextV2,
  verifyPiArtifactRowDigest,
  RECOVERY_CONTROL_SURFACES,
  type LoadedImplementation,
  type RuleContextV2,
  type RuleHostEvaluatedEventData,
  type RuleHostInput,
  type RuleHostMeta,
  type RuleHostResult,
  type ToolSemanticRegistry,
  type GovernanceHostKind,
} from '@principles/core/runtime';
import { buildRuleHostInput, isRuleHostEvaluableKind } from '@principles/core/runtime/internalization/rule-host-input-builder';
import { classifyBashRisk } from '@principles/core/runtime/internalization/bash-risk';
import { scanRetiredContractSymbols } from './legacy-rule-contract-symbols.js';
import { recordDegradedEnforcement } from './degraded-enforcement-marker.js';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import {
  createNodeRuleImplementationRuntime,
  MAX_ACTIVE_RULES,
  RULE_BATCH_SOURCE_BYTES,
  RULE_SOURCE_BYTES,
  type RuleImplementationRuntime,
  type RuleBatchEvaluation,
} from './rule-implementation-runtime.js';

const WARNING_LIMIT = 500;
const MAX_WARNINGS = 16;
const GATE_DEADLINE_MS = 3_000;
const ARTIFACT_CONTENT_BYTES = 512 * 1024;

/**
 * Production RuleHost gate — the shared decision path for every supported host.
 *
 * PRI-1187 (Owner decision 2026-11-12): rules are NEVER filtered by
 * `affectedTools`. Over-blocking (a write-only rule also observing exec) is
 * accepted noise; under-blocking is not. `affectedTools` is the DECLARED
 * SCOPE used by activation (`validateRuleReliability`: golden-trace tool
 * families must be a subset of the declared families) and by approval/audit
 * surfaces — it is NOT an execution bound.
 *
 * DO NOT re-add a runtime filter here. Three review rounds each found a way to
 * skip a call the rule was validated to block: the reserved `host-liveness:`
 * prefix, a narrow declaration with a broad implementation, and a guard that
 * only inspected the golden trace. The decision and the follow-up ticket live
 * in docs/proposals/PRI-1187-write-only-rule-exec-false-positive.md.
 *
 * The only affectedTools runtime code allowed in this file is the
 * observation-only mismatch signal below: it logs, it never changes the
 * evaluation set or the verdict.
 */
const AFFECTED_TOOLS_OBSERVABILITY_ENV = 'PD_AFFECTED_TOOLS_OBSERVABILITY';

// Check the actual imported builder, not an installed-package version string:
// a mixed host-runtime/core deployment must not claim input-v2 support.
const RECOVERY_INPUT_V2_AVAILABLE = RECOVERY_CONTROL_SURFACES
  .filter(surface => surface.channel === 'cli')
  .every(surface => typeof surface.cliCommand === 'string'
    && buildRuleHostAction('recovery-contract-probe', { command: surface.cliCommand }, '/', { canonicalKind: 'execute' })
      .recoveryControl === surface.capabilityId);

function boundedWarning(reason: string, nextAction: string): string {
  return `${reason}; nextAction=${nextAction}`.replace(/\s+/g, ' ').slice(0, WARNING_LIMIT);
}

function addWarning(warnings: string[], reason: string, nextAction: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(boundedWarning(reason, nextAction));
}

/**
 * PRI-1208 Stage 3: structured, bounded evaluation faults.
 *
 * Warnings are human text for the host logger. The legacy `RuleHost` also
 * persisted two kinds of evidence that the shared gate did not carry:
 * `rulehost_unhealthy` (a rule defect) and `rulehost_skipped` (a governance /
 * configuration skip). Deleting the legacy path would silently drop that
 * evidence. These facts are host-neutral: the gate returns them; the OpenClaw
 * adapter maps them onto its existing EventLog schema. Other hosts are free to
 * ignore them — this file never writes host state.
 */
export interface RuleHostEvaluationFault {
  kind: 'unhealthy' | 'skipped';
  activationId: string;
  artifactId: string;
  ruleId: string;
  mode?: 'live' | 'shadow';
  reason: string;
  nextAction: string;
}

interface FaultSource {
  activationId: string;
  artifactId: string;
  ruleId: string;
  mode?: 'live' | 'shadow';
}

// eslint-disable-next-line @typescript-eslint/max-params -- internal accumulator; positional args keep every call site one line
function addFault(
  faults: RuleHostEvaluationFault[],
  kind: RuleHostEvaluationFault['kind'],
  source: FaultSource,
  reason: string,
  nextAction: string,
): void {
  if (faults.length >= MAX_WARNINGS) return;
  faults.push({ kind, ...source, reason: reason.slice(0, 300), nextAction: nextAction.slice(0, 300) });
}

function withFaults(
  metadata: Record<string, unknown>,
  faults: readonly RuleHostEvaluationFault[],
): Record<string, unknown> {
  return faults.length > 0 ? { ...metadata, evaluationFaults: faults } : metadata;
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

function requiresDesignGateFact(value: unknown): boolean {
  if (!isRecord(value) || !Object.hasOwn(value, 'requiredFactKinds')) return false;
  return Array.isArray(value.requiredFactKinds)
    && value.requiredFactKinds.every((kind: unknown) => typeof kind === 'string')
    && value.requiredFactKinds.includes('design_approval');
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

export interface ProductionRuleContextRequest {
  workspaceDir: string;
  sessionId: string;
  targetPath: string;
  toolName: string;
  rawPayload: unknown;
}

export type RuleContextProvider = (request: ProductionRuleContextRequest) => unknown | Promise<unknown>;
export interface RuleInputEnrichment {
  epTier: number;
  bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown';
}
export type RuleInputEnrichmentProvider = (request: ProductionRuleContextRequest) => unknown | Promise<unknown>;

export interface ProductionRuleHostGateOptions {
  projectDir?: string;
  hostKind?: GovernanceHostKind;
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
  /**
   * PRI-1187: observation-only signal for the accepted "over-block" tradeoff.
   *
   * When a rule declares `affectedTools` and the current action family is NOT
   * in that declaration, the rule is still evaluated (never skipped). This
   * sink records one structured event per such evaluation so we can measure
   * how much over-blocking exists and which rules cause it.
   *
   * Defaults ON. Silence it with `{ enabled: false }` or the environment
   * variable `PD_AFFECTED_TOOLS_OBSERVABILITY=0`. The sink is called inside a
   * try/catch and can never alter the decision.
   */
  affectedToolsObservability?: AffectedToolsObservabilityOptions;
}

/** One observation-only "declared scope does not cover the action" record. */
export interface AffectedToolsMismatchEvent {
  ruleId: string;
  activationId: string;
  activationMode: 'live' | 'shadow';
  toolName: string;
  /** Action family resolved by the ToolSemanticRegistry (write/execute/agent…). */
  actionFamily: string;
  /** Raw declaration, verbatim from the artifact. */
  declaredTools: string[];
  /** Resolved families of `declaredTools` (never empty when emitted). */
  declaredFamilies: string[];
  /** The rule's own decision for this call (not the merged verdict). */
  decision: RuleHostResult['decision'];
  hostKind?: GovernanceHostKind;
}

export interface AffectedToolsObservabilityOptions {
  /** Defaults to `PD_AFFECTED_TOOLS_OBSERVABILITY !== '0' | 'false' | 'off'`. */
  enabled?: boolean;
  /** Defaults to one structured JSON line on `console.warn`. */
  sink?: (event: AffectedToolsMismatchEvent) => void;
}

const baselineToolSemanticsResult = buildToolSemanticRegistry();
// Static baseline input — always builds; throwing here is a programming error.
if (!baselineToolSemanticsResult.ok) {
  throw new Error(`baseline tool semantic registry failed to build: ${baselineToolSemanticsResult.errors.join('; ')}`);
}
const BASELINE_TOOL_SEMANTICS: ToolSemanticRegistry = baselineToolSemanticsResult.registry;

/**
 * Resolve a rule's declared scope for OBSERVATION ONLY.
 *
 * Returns `null` when the declaration cannot prove a mismatch (absent, not an
 * array, empty, malformed entry, or a name the registry cannot classify). A
 * `null` declaration therefore emits nothing — the signal must never guess,
 * because a false positive would misdirect the follow-up work that decides
 * whether the no-filter tradeoff stays.
 */
function resolveDeclaredFamilies(
  affectedTools: unknown,
  toolSemantics: ToolSemanticRegistry,
): { tools: string[]; families: string[] } | null {
  if (!Array.isArray(affectedTools) || affectedTools.length === 0) return null;
  const tools: string[] = [];
  const families = new Set<string>();
  for (const declared of affectedTools) {
    if (typeof declared !== 'string' || declared.trim().length === 0) return null;
    const kind = toolSemantics.lookup(declared);
    if (kind === null) return null;
    tools.push(declared);
    families.add(kind);
  }
  return families.size === 0 ? null : { tools, families: [...families] };
}

function affectedToolsObservabilityDisabledByEnv(): boolean {
  const raw = process.env[AFFECTED_TOOLS_OBSERVABILITY_ENV]?.trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off';
}

function defaultAffectedToolsSink(event: AffectedToolsMismatchEvent): void {
  console.warn(`[PD:RuleHost] affected_tools_mismatch ${JSON.stringify(event)}`);
}

export function createProductionRuleHostGate(options: ProductionRuleHostGateOptions = {}) {
  const implementationRuntime = options.implementationRuntime ?? createNodeRuleImplementationRuntime();
  const toolSemantics = options.toolSemantics ?? BASELINE_TOOL_SEMANTICS;
  const observabilityEnabled = options.affectedToolsObservability?.enabled
    ?? !affectedToolsObservabilityDisabledByEnv();
  const observabilitySink = options.affectedToolsObservability?.sink ?? defaultAffectedToolsSink;

  /**
   * PRI-1187 observation-only: record that a declared scope did not cover the
   * action while the rule was still evaluated. MUST NOT skip, reorder, or
   * mutate anything. Sink failures are swallowed for the same reason.
   */
  const emitAffectedToolsMismatch = (
    candidate: {
      ruleId: string;
      implId: string;
      activationMode: 'live' | 'shadow';
      declaredTools: string[] | null;
      declaredFamilies: string[] | null;
    },
    observation: { decision: RuleHostResult['decision']; actionFamily: string; toolName: string },
  ): void => {
    if (!observabilityEnabled) return;
    if (candidate.declaredTools === null || candidate.declaredFamilies === null) return;
    if (candidate.declaredFamilies.includes(observation.actionFamily)) return;
    try {
      observabilitySink({
        ruleId: candidate.ruleId,
        activationId: candidate.implId,
        activationMode: candidate.activationMode,
        toolName: observation.toolName,
        actionFamily: observation.actionFamily,
        declaredTools: candidate.declaredTools,
        declaredFamilies: candidate.declaredFamilies,
        decision: observation.decision,
        ...(options.hostKind !== undefined ? { hostKind: options.hostKind } : {}),
      });
    } catch {
      // Observation must never affect enforcement.
    }
  };

  return async (event: HostEvent): Promise<HostEventResult> => {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const evaluationFaults: RuleHostEvaluationFault[] = [];
    const input = readToolInput(event.rawPayload);
    if (!input || input.toolName !== event.context.toolName) {
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('tool_input_invalid', 'decode and validate toolName and params before dispatch')] };
    }

    const canonicalKind = toolSemantics.resolve(input.toolName);
    // PRI-1184 / F3': restore the RuleHost routing contract. Only the write,
    // execute and agent families enter rule evaluation; read/search and every
    // other canonical kind are allowed without touching the RuleCode engine.
    // The kind comes from the same ToolSemanticRegistry that supplies the
    // extraction hints below — never a tool-name allowlist.
    if (!isRuleHostEvaluableKind(canonicalKind)) {
      return { decision: 'allow', source: event.source, metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
    }
    const { isBashTool: isBash, isWriteTool: isWrite } = deriveToolHintsFromCanonicalKind(canonicalKind);
    const action = buildRuleHostAction(input.toolName, input.params, options.projectDir ?? event.context.workspaceDir, { isBashTool: isBash, isWriteTool: isWrite, canonicalKind });
    // F3': normalizePathPure returns '' when no path could be extracted, so the
    // old `=== null` guard never fired. Both null and '' mean "no action
    // target": a pathless tool is not evaluated rather than treating an empty
    // string as a path.
    if (action.normalizedPath === null || action.normalizedPath === '') return { decision: 'allow', source: event.source, metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };

    let context: RuleContextV2 | undefined;
    /**
     * SPEC-RULECODE-QUALITY-001 A3 (Q10): the precise reason a v2 rule is
     * suspended — carried into the skip warning so each fault kind (absent /
     * undefined / invalid / failed / unavailable) is distinguishable in host
     * telemetry instead of merging into one opaque 'unavailable'.
     */
    let contextFault: 'provider_absent' | 'provider_returned_undefined' | 'provider_invalid' | 'provider_failed' | undefined;
    // PRI-1047 Owner review R6 #1: the default bashRisk is the deterministic
    // shared classifier (NOT 'unknown') — hosts that wire no enrichment
    // provider (the Codex path) previously fed every rule bashRisk='unknown',
    // so no approval-gate rule could ever exempt read-only investigation.
    // A wired provider remains the host truth and overrides the default.
    let enrichment: RuleInputEnrichment = {
      epTier: 0,
      bashRisk: classifyBashRisk(canonicalKind === 'execute', input.params),
    };
    const request: ProductionRuleContextRequest = {
      workspaceDir: event.context.workspaceDir, sessionId: event.context.sessionId,
      targetPath: action.normalizedPath, toolName: input.toolName, rawPayload: event.rawPayload,
    };
    if (options.ruleInputEnrichmentProvider) {
      try {
        const candidate: unknown = await withinGateDeadline(options.ruleInputEnrichmentProvider(request), startedAt);
        if (isRecord(candidate)
          && typeof candidate.epTier === 'number' && Number.isFinite(candidate.epTier)
          && (candidate.bashRisk === 'safe' || candidate.bashRisk === 'normal' || candidate.bashRisk === 'dangerous' || candidate.bashRisk === 'unknown')) {
          enrichment = { epTier: candidate.epTier, bashRisk: candidate.bashRisk };
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
          contextFault = 'provider_returned_undefined';
        } else {
        const validation = validateRuleContextV2(candidate);
        if (isRuleContext(candidate)) context = candidate;
        else {
          context = UNAVAILABLE_RULE_CONTEXT;
          contextFault = 'provider_invalid';
          addWarning(warnings, `rule_context_invalid: ${validation.errors.join('; ')}`, 'repair the host context provider');
        }
        }
      } catch (error: unknown) {
        context = UNAVAILABLE_RULE_CONTEXT;
        contextFault = 'provider_failed';
        addWarning(warnings, `rule_context_provider_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect the host context provider and retry');
      }
    } else {
      contextFault = 'provider_absent';
    }

    const dbPath = path.join(event.context.workspaceDir, '.pd', 'state.db');
    if (remainingGateMs(startedAt) <= 0) {
      // SPEC-RULECODE-QUALITY-001 Q24: a deadline-exhausted allow must be
      // observable as "no rule executed" (evaluatedLiveRules=0), never read
      // as successful governance — isolated probe finding (the early return
      // previously carried no evaluation facts at all).
      return { decision: 'allow', source: event.source, warnings: [boundedWarning('gate_deadline_exceeded', 'inspect host context providers and active RuleCode resource use')], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
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
    const candidates: { implId: string; artifactId: string; ruleId: string; principleId: string; meta: RuleHostMeta; source: string; activationMode: 'live' | 'shadow'; declaredTools: string[] | null; declaredFamilies: string[] | null }[] = [];
    try {
      const globalPause: unknown = connection.getDb().prepare(`
        SELECT pause_id FROM global_rulecode_pauses WHERE status = 'paused' LIMIT 1
      `).get();
      if (globalPause !== undefined) {
        return {
          decision: 'allow',
          source: event.source,
          warnings: [boundedWarning('global_rulecode_pause_active', 'review the incident in the Owner Console before releasing the global pause')],
          metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults),
        };
      }
      // PRI-1044 step 3-1: an ACTIVE activation whose pi_artifacts row is gone
      // is invisible to the candidate query below (INNER JOIN), so the gate
      // reported `no_rules_armed` and enforced nothing with no trace at all
      // (observed: 8+ hours of silent non-enforcement). Detect the dangling
      // reference explicitly: the fail-open availability posture is unchanged,
      // but the gap becomes Owner-visible (rc-9) through a structured warning
      // that names the activation AND the durable out-of-workspace marker, so
      // it survives the host's per-call log buffer.
      const danglingArtifacts: unknown = connection.getDb().prepare(`
        SELECT a.activation_id, a.artifact_id
        FROM activations a
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM pi_artifacts p WHERE p.artifact_id = a.artifact_id)
        ORDER BY a.activated_at ASC
      `).all();
      if (!Array.isArray(danglingArtifacts)) {
        addWarning(warnings, 'activation_artifact_reference_query_invalid', 'inspect state.db schema and integrity');
      } else {
        const missingArtifacts: string[] = [];
        for (const dangling of danglingArtifacts) {
          if (!isRecord(dangling) || typeof dangling.activation_id !== 'string') {
            addWarning(warnings, 'activation_artifact_reference_invalid', 'inspect state.db activation rows and integrity');
            continue;
          }
          const artifactLabel = typeof dangling.artifact_id === 'string' ? dangling.artifact_id : 'unknown';
          missingArtifacts.push(`${dangling.activation_id}->${artifactLabel}`);
          addWarning(
            warnings,
            `activation_artifact_missing: activation=${dangling.activation_id} artifact=${artifactLabel}`,
            'restore the referenced pi_artifacts row or deactivate the stale activation; the rule did not run',
          );
        }
        if (missingArtifacts.length > 0) {
          recordDegradedEnforcement(
            event.context.workspaceDir,
            `activation_artifact_missing: ${missingArtifacts.join(', ')}`.slice(0, 300),
          );
        }
      }
      const rows: unknown = connection.getDb().prepare(`
        SELECT a.activation_id, a.artifact_id, a.target_ref, a.action,
               c.enforcement, c.isolation_decision_id,
               p.source_rule_id, p.source_principle_id,
               EXISTS (SELECT 1 FROM approvals ap WHERE ap.artifact_id = a.artifact_id
                 AND ap.channel = 'code_tool_hook' AND ap.status = 'approved') AS owner_approved,
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
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`active_rule_limit_exceeded: maximum ${MAX_ACTIVE_RULES}`, 'deactivate excess active RuleHost rules and retry')], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
      } else {
        for (const row of rows) {
          if (!isRecord(row) || typeof row.content_bytes !== 'number' || !Number.isSafeInteger(row.content_bytes) || row.content_bytes < 0) {
            return { decision: 'allow', source: event.source, warnings: [boundedWarning('artifact_content_size_invalid', 'inspect state.db artifact content integrity')], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
          }
          if (row.content_bytes > ARTIFACT_CONTENT_BYTES) {
            const activation = typeof row.activation_id === 'string' ? row.activation_id : 'unknown';
            return { decision: 'allow', source: event.source, warnings: [boundedWarning(`artifact_content_budget_exceeded: activation=${activation} bytes=${row.content_bytes} maximum=${ARTIFACT_CONTENT_BYTES}`, 'reduce the active artifact envelope and reactivate the rule')], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
          }
        }
        const groups = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
          if (!isRecord(row) || typeof row.target_ref !== 'string' || row.target_ref.length === 0) {
            addWarning(warnings, 'activation_row_invalid', 'deactivate and recreate the malformed activation');
            continue;
          }
          const activationId = typeof row.activation_id === 'string' ? row.activation_id : 'unknown';
          const controlFaultSource: FaultSource = {
            activationId,
            artifactId: typeof row.artifact_id === 'string' ? row.artifact_id : 'unknown',
            // Same identity rule everywhere: the rule's own id, else its
            // artifact. Never activationId / targetRef — consumers group by
            // ruleId and a fallback would invent a fake rule.
            ruleId: typeof row.source_rule_id === 'string' && row.source_rule_id.length > 0
              ? row.source_rule_id
              : (typeof row.artifact_id === 'string' && row.artifact_id.length > 0 ? row.artifact_id : activationId),
          };
          if (row.enforcement === 'safety_isolated') {
            addWarning(warnings, `activation_safety_isolated: ${activationId}`, 'recover the activation to shadow after reviewing safety evidence');
            addFault(evaluationFaults, 'skipped', controlFaultSource, `activation_safety_isolated: ${activationId}`, 'recover the activation to shadow after reviewing safety evidence');
            continue;
          }
          if (row.enforcement !== 'eligible') {
            addWarning(warnings, `activation_control_state_invalid: ${activationId}`, 'repair the activation control state before RuleCode enforcement');
            addFault(evaluationFaults, 'skipped', controlFaultSource, `activation_control_state_invalid: ${activationId}`, 'repair the activation control state before RuleCode enforcement');
            continue;
          }
          const group = groups.get(row.target_ref) ?? [];
          group.push(row);
          groups.set(row.target_ref, group);
        }
        for (const [targetRef, group] of groups) {
          if (group.length !== 1) {
            addWarning(warnings, `duplicate_active_activation: ${targetRef}`, 'deactivate all but one activation for this target_ref');
            for (const duplicate of group) {
              addFault(
                evaluationFaults,
                'unhealthy',
                {
                  activationId: typeof duplicate.activation_id === 'string' ? duplicate.activation_id : 'unknown',
                  artifactId: typeof duplicate.artifact_id === 'string' ? duplicate.artifact_id : 'unknown',
                  ruleId: typeof duplicate.source_rule_id === 'string' && duplicate.source_rule_id.length > 0
                    ? duplicate.source_rule_id
                    : (typeof duplicate.artifact_id === 'string' ? duplicate.artifact_id : 'unknown'),
                },
                `duplicate active activation for target_ref ${targetRef}`,
                'Deactivate all but one activation for this target_ref',
              );
            }
            continue;
          }
          const [row] = group;
          if (!row) continue;
          // PRI-813: shadow activations are no longer skipped here — they run
          // through the SAME budget/content/context validation and
          // evaluateBatch pipeline as live rows, but their results are
          // collected as observations only and never join mergeDecisions
          // (shadow observes, never enforces). The v2 qualification and context
          // checks below remain ahead of evaluation for both activation modes.
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
          const faultSource: FaultSource = {
            activationId,
            artifactId,
            ruleId: typeof row.source_rule_id === 'string' && row.source_rule_id.length > 0 ? row.source_rule_id : artifactId,
            mode: activationMode,
          };
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
            addFault(evaluationFaults, 'skipped', faultSource, `activation_artifact_invalid: ${activationId}`, 'inspect state.db artifact content integrity');
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
              addFault(evaluationFaults, 'skipped', faultSource, `artifact_content_budget_exceeded: activation=${activationId}`, 'reduce the active shadow artifact envelope and reactivate the rule');
              continue;
            }
            return { decision: 'allow', source: event.source, warnings: [boundedWarning(`artifact_content_budget_exceeded: activation=${activationId} bytes=${Math.max(contentRow.content_bytes, returnedContentBytes)} maximum=${ARTIFACT_CONTENT_BYTES}`, 'reduce the active artifact envelope and reactivate the rule')], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
          }
          if (contentRow.content_bytes !== expectedContentBytes || returnedContentBytes !== contentRow.content_bytes) {
            if (activationMode === 'shadow') {
              addWarning(warnings, `artifact_content_size_changed: activation=${activationId}`, 'retry after the active shadow artifact update completes; live enforcement is unaffected');
              addFault(evaluationFaults, 'skipped', faultSource, `artifact_content_size_changed: activation=${activationId}`, 'retry after the active shadow artifact update completes');
              continue;
            }
            return { decision: 'allow', source: event.source, warnings: [boundedWarning(`artifact_content_size_changed: activation=${activationId}`, 'retry after the active artifact update completes')], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
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
            addFault(evaluationFaults, 'skipped', faultSource, `activation_artifact_invalid: ${activationId}`, 'inspect state.db artifact row integrity');
            continue;
          }
          if (digestCheck.outcome === 'tampered') {
            const digestNextAction = 'the artifact content no longer matches the Owner-approved digest — deactivate and re-approve the rule; execution was skipped';
            if (activationMode === 'shadow') {
              addWarning(warnings, `artifact_digest_mismatch (shadow): activation=${activationId}`, `${digestNextAction}; live enforcement is unaffected`);
              addFault(evaluationFaults, 'skipped', faultSource, `artifact_digest_mismatch (shadow): activation=${activationId}`, digestNextAction);
              continue;
            }
            addWarning(warnings, `artifact_content_tampered: activation=${activationId} approved=${approvedArtifactDigest} actual=${digestCheck.actualDigest}`, digestNextAction);
            addFault(evaluationFaults, 'skipped', faultSource, `artifact_content_tampered: activation=${activationId}`, digestNextAction);
            continue;
          }
          try {
            const content: unknown = JSON.parse(contentJson);
            if (!isRecord(content) || typeof content.implementationCode !== 'string' || content.implementationCode.length === 0) {
              addWarning(warnings, `activation_artifact_invalid: ${activationId}`, 'regenerate the rule artifact with implementationCode');
              addFault(evaluationFaults, 'skipped', faultSource, `activation_artifact_invalid: ${activationId}`, 'regenerate the rule artifact with implementationCode');
              continue;
            }
            const sourceBytes = Buffer.byteLength(content.implementationCode, 'utf8');
            if (sourceBytes > RULE_SOURCE_BYTES) {
              if (activationMode === 'shadow') {
                addWarning(warnings, `rule_source_budget_exceeded: activation=${activationId} bytes=${sourceBytes}`, `reduce the shadow RuleCode source below ${RULE_SOURCE_BYTES} bytes; live enforcement is unaffected`);
                addFault(evaluationFaults, 'skipped', faultSource, `rule_source_budget_exceeded: activation=${activationId}`, `reduce the shadow RuleCode source below ${RULE_SOURCE_BYTES} bytes`);
                continue;
              }
              return { decision: 'allow', source: event.source, warnings: [boundedWarning(`rule_source_budget_exceeded: activation=${activationId} bytes=${sourceBytes}`, `reduce each RuleCode source below ${RULE_SOURCE_BYTES} bytes`)], metadata: withFaults({ evaluatedLiveRules: 0 }, evaluationFaults) };
            }
            if (Object.hasOwn(content, 'requiresContextVersion')) {
              if (content.requiresContextVersion !== 2) {
                addWarning(warnings, `unsupported_context_version: ${String(content.requiresContextVersion)}`, 'regenerate the rule artifact for context version 2');
                addFault(evaluationFaults, 'skipped', faultSource, `unsupported_context_version: ${String(content.requiresContextVersion)}`, 'regenerate the rule artifact for context version 2');
                continue;
              }
              // Codex V2 is opt-in per regenerated, Owner-approved artifact.
              // This system-stamped contract is emitted only after current
              // evaluator replay; merely wiring history must not revive old
              // activations. Live execution additionally needs the existing
              // promotion decision's binding to this exact artifact snapshot.
              // SPEC-RULECODE-HOST-PROMOTION-001 §11.3: the SAME qualification
              // gates every host with a V2 context path — WorkBuddy must not
              // auto-execute historical V2 artifacts stamped for another host
              // (the hostKinds binding below rejects them by the exact same
              // includes() check Codex uses).
              if (options.hostKind === 'codex' || options.hostKind === 'workbuddy') {
                const contract = content.ruleHostInputContract;
                const hosts = isRecord(contract) ? contract.hostKinds : undefined;
                let contentBindingVerified = digestCheck.outcome === 'verified';
                if (activationMode === 'shadow' && row.owner_approved === 1) {
                  // Old databases remain readable without writing a migration
                  // from this enforcement reader. A legacy approval without a
                  // content digest cannot grant V2 execution eligibility.
                  const approvalColumns: unknown[] = connection.getDb().prepare('PRAGMA table_info(approvals)').all();
                  if (approvalColumns.some((column) => isRecord(column) && column.name === 'artifact_digest')) {
                    const approval: unknown = connection.getDb().prepare(`
                      SELECT artifact_digest FROM approvals
                      WHERE artifact_id = ? AND channel = 'code_tool_hook' AND status = 'approved'
                      ORDER BY decided_at DESC LIMIT 1
                      `).get(artifactId);
                    const approvalDigest = isRecord(approval) && typeof approval.artifact_digest === 'string'
                      ? approval.artifact_digest : null;
                    contentBindingVerified = verifyPiArtifactRowDigest(contentRow, contentJson, approvalDigest).outcome === 'verified';
                  } else {
                    contentBindingVerified = false;
                  }
                }
                if (!isRecord(contract)
                  || (contract.version !== 1 && !(contract.version === 2 && RECOVERY_INPUT_V2_AVAILABLE))
                  || contract.contextVersion !== 2
                  || !Array.isArray(hosts) || !hosts.every((host: unknown) => typeof host === 'string')
                  || !hosts.includes(options.hostKind) || row.owner_approved !== 1
                  || !contentBindingVerified) {
                  addWarning(warnings, `${options.hostKind}_rule_context_v2_unqualified: activation=${activationId}`,
                    `regenerate and replay this artifact for ${options.hostKind}, approve it for shadow observation, and use the existing Owner promotion flow for live execution`);
                  addFault(evaluationFaults, 'skipped', faultSource, `${options.hostKind}_rule_context_v2_unqualified: activation=${activationId}`,
                    `regenerate and replay this artifact for ${options.hostKind}, approve it for shadow observation, and use the existing Owner promotion flow for live execution`);
                  continue;
                }
              }
              // SPEC-RULECODE-QUALITY-001 A3 / §7.1 (Q10): MANDATORY runtime
              // suspension of context-dependent rules. A v2 rule may only
              // execute when the provider resolved a schema-valid context
              // whose history.status is 'available'. The old check (`!context`)
              // let the truthy UNAVAILABLE_RULE_CONTEXT sentinel (provider
              // invalid/thrown) and schema-valid unavailable contexts through,
              // so a v2 rule without its own self-protection still executed on
              // untrusted input. Skipping happens per-call, per-rule — healthy
              // sibling rules (v1 or well-fed v2) keep evaluating, and no
              // governance state changes. Intentional behavior change vs the
              // pre-fix "legal unavailable still executed" path.
              //
              // PRI-1019 exception: a rule whose ONLY declared dependence is
              // the design_approval fact stays eligible on an actionable fact
              // (resolution !== 'unknown') even when history is unavailable.
              // SPEC-RULECODE-CODEX-LOCAL-CLOSURE-001 §6 requires a managed
              // action with an authoritative not_approved to be blocked
              // regardless of history, and the Artificer prompt contract
              // (V2_CONTEXT_INSTRUCTION) requires history-dependent behavior
              // to allow while the independently supplied fact stays
              // enforceable. Without this exception the first managed action
              // of a new session (no prior history) would never evaluate the
              // rule, and an authoritative not_approved could not block.
              const designGateFact = context?.facts.designGate;
              const designGateActionable = designGateFact !== undefined && designGateFact.resolution !== 'unknown'
                ? designGateFact
                : undefined;
              if ((context === undefined || context.history.status !== 'available')
                && !(requiresDesignGateFact(content.ruleHostInputContract) && designGateActionable !== undefined)) {
                // Reference identity against the frozen sentinel distinguishes
                // "the provider faulted" from "the provider legitimately
                // declared history unavailable" (same wire shape, different
                // fault class — Q10 asserts them separately).
                const fault = context === undefined
                  ? (contextFault ?? 'provider_absent')
                  : context === UNAVAILABLE_RULE_CONTEXT
                    ? (contextFault ?? 'provider_invalid')
                    : 'history_unavailable';
                // SPEC-RULECODE-HOST-PROMOTION-001 R2: a schema-valid
                // unavailable context carries the provider's precise reason
                // (e.g. workbuddy_history_attribution_conflict) — surface it
                // in the warning instead of collapsing every legit
                // unavailability into one opaque class (rc-9).
                const preciseReason = context !== undefined
                  && context !== UNAVAILABLE_RULE_CONTEXT
                  && typeof context.history.unavailableReason === 'string'
                  && context.history.unavailableReason.length > 0
                  ? `:${context.history.unavailableReason}`
                  : '';
                addWarning(
                  warnings,
                  `rule_context_v2_unavailable: ${fault}${preciseReason} (activation=${activationId})`,
                  'enable and wire the host rule context provider, or regenerate the rule without context dependence',
                );
                addFault(
                  evaluationFaults,
                  'skipped',
                  faultSource,
                  `rule_context_v2_unavailable: ${fault}${preciseReason} (activation=${activationId})`,
                  'enable and wire the host rule context provider, or regenerate the rule without context dependence',
                );
                continue;
              }
              const inputContract = content.ruleHostInputContract;
              if (isRecord(inputContract) && Object.hasOwn(inputContract, 'requiredFactKinds')) {
                if (!Array.isArray(inputContract.requiredFactKinds)
                  || !inputContract.requiredFactKinds.every((kind: unknown) => typeof kind === 'string')) {
                  addWarning(warnings, `rule_required_fact_contract_invalid: activation=${activationId}`,
                    'regenerate the rule artifact from validated Scribe execution conditions');
                  addFault(evaluationFaults, 'skipped', faultSource, `rule_required_fact_contract_invalid: activation=${activationId}`,
                    'regenerate the rule artifact from validated Scribe execution conditions');
                  continue;
                }
                if (requiresDesignGateFact(inputContract) && designGateActionable === undefined) {
                  addWarning(warnings, `rule_required_fact_unavailable: design_approval (activation=${activationId})`,
                    'verify the current Owner design declaration and scope before retrying');
                  addFault(evaluationFaults, 'skipped', faultSource, `rule_required_fact_unavailable: design_approval (activation=${activationId})`,
                    'verify the current Owner design declaration and scope before retrying');
                  continue;
                }
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
              addFault(evaluationFaults, 'skipped', { ...faultSource, ruleId }, `legacy_rule_contract_dependency: ${retiredSymbols.join(', ')} (activation=${activationId})`, nextAction);
              continue;
            }
            const fallbackMeta: RuleHostMeta = { name: activationId, version: '1', ruleId, coversCondition: 'all' };
            // PRI-1187: resolved for the observation-only mismatch signal; it
            // is attached to the candidate but never filters the batch.
            const declaredScope = resolveDeclaredFamilies(content.affectedTools, toolSemantics);
            candidates.push({ implId: activationId, artifactId, ruleId, principleId, meta: isRuleMeta(content.meta) ? content.meta : fallbackMeta, source: content.implementationCode, activationMode, declaredTools: declaredScope?.tools ?? null, declaredFamilies: declaredScope?.families ?? null });
          } catch (error: unknown) {
            const reason = `implementation_unhealthy: ${error instanceof Error ? error.message : String(error)}`;
            addWarning(warnings, reason, 'fix the RuleCode and reactivate the rule');
            addFault(evaluationFaults, 'unhealthy', faultSource, reason, 'fix the RuleCode and reactivate the rule');
          }
        }
      }

      // PRI-1208 Stage 2: the single input-assembly contract shared with
      // Golden Trace replay. `isRiskPath` is derived there, never re-derived
      // (or hard-coded) by a host.
      const hostInput: RuleHostInput = buildRuleHostInput({
        action,
        sessionId: event.context.sessionId,
        epTier: enrichment.epTier,
        bashRisk: enrichment.bashRisk,
        estimatedLineChanges: estimateLineChanges({ toolName: input.toolName, params: input.params }, toolSemantics),
        ...(context !== undefined ? { context } : {}),
      });
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
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`rule_source_budget_exceeded: batchBytes=${liveBatchBytes}`, `reduce total active RuleCode below ${RULE_BATCH_SOURCE_BYTES} bytes`)], metadata: withFaults({ evaluatedLiveRules: 0, evaluationStatus: 'failed' }, evaluationFaults) };
      }
      let remaining = remainingGateMs(startedAt);
      if (remaining <= 0) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning('gate_deadline_exceeded', 'reduce active RuleCode count or source size and retry')], metadata: withFaults({ evaluatedLiveRules: 0, evaluationStatus: 'failed' }, evaluationFaults) };
      }
      const liveBatch: RuleBatchEvaluation = liveCandidates.length === 0
        ? { ok: true, results: [] }
        : implementationRuntime.evaluateBatch(
        liveCandidates.map((candidate) => ({ source: candidate.source, filename: `activation-${candidate.implId}` })),
        hostInput,
        remaining,
      );
      if (!liveBatch.ok || !liveBatch.results) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`${liveBatch.reason ?? 'rule_batch_failed'}: ${liveBatch.detail ?? 'unknown failure'}`, 'inspect active RuleCode resource use and repair or deactivate the unhealthy rule')], metadata: withFaults({ evaluatedLiveRules: 0, evaluationStatus: 'failed' }, evaluationFaults) };
      }
      const timedOutChild = liveBatch.results.find((candidate) => !candidate.ok && candidate.error?.includes('timed out'));
      if (timedOutChild) {
        return { decision: 'allow', source: event.source, warnings: [boundedWarning(`rule_batch_timeout: ${timedOutChild.error ?? 'unknown child timeout'}`, 'fix or deactivate the unhealthy RuleCode and retry')], metadata: withFaults({ evaluatedLiveRules: 0, evaluationStatus: 'failed' }, evaluationFaults) };
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
                const reason = `implementation_unhealthy: ${batchResult && !batchResult.ok ? batchResult.error ?? 'unknown child error' : 'rule_batch_result_missing'}`;
                addWarning(warnings, reason, 'fix the shadow RuleCode and reactivate the rule; live enforcement is unaffected');
                if (candidate) {
                  addFault(evaluationFaults, 'unhealthy', {
                    activationId: candidate.implId, artifactId: candidate.artifactId, ruleId: candidate.ruleId, mode: 'shadow',
                  }, reason, 'fix the shadow RuleCode and reactivate the rule');
                }
                continue;
              }
              const normalized = normalizeRuleHostResult(batchResult.result);
              if (normalized.degraded !== undefined) {
                const reason = `invalid RuleHostResult: ${normalized.degraded.notes ?? 'unknown invalid result'}`;
                addWarning(warnings, reason, 'fix the shadow RuleCode result and reactivate the rule; live enforcement is unaffected');
                addFault(evaluationFaults, 'unhealthy', {
                  activationId: candidate.implId, artifactId: candidate.artifactId, ruleId: candidate.ruleId, mode: 'shadow',
                }, reason, 'fix the shadow RuleCode result and reactivate the rule');
                continue;
              }
              const shadowResult = normalized.matched
                ? { ...normalized, ruleId: candidate.ruleId, principleId: candidate.principleId }
                : normalized;
              emitAffectedToolsMismatch(candidate, { decision: shadowResult.decision, actionFamily: canonicalKind, toolName: input.toolName });
              shadowEvaluations.push({
                toolName: input.toolName,
                filePath: action.normalizedPath,
                matched: shadowResult.matched,
                decision: shadowResult.decision,
                ruleId: candidate.ruleId,
                activationId: candidate.implId,
                activationMode: 'shadow',
                ...(options.hostKind !== undefined ? { hostKind: options.hostKind } : {}),
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
          const reason = `implementation_unhealthy: ${batchResult.error ?? 'unknown child error'}`;
          addWarning(warnings, reason, 'fix the RuleCode and reactivate the rule');
          addFault(evaluationFaults, 'unhealthy', {
            activationId: candidate.implId, artifactId: candidate.artifactId, ruleId: candidate.ruleId, mode: 'live',
          }, reason, 'fix the RuleCode and reactivate the rule');
          continue;
        }
        // B1: one reading of unusable output. Previously this branch warned and
        // `continue`d, so the rule silently stopped participating and another
        // rule's allow could win the merge. Normalization keeps it in the merge
        // as a contract-level fail-closed requireApproval marked `degraded`.
        const normalized = normalizeRuleHostResult(batchResult.result);
        if (normalized.degraded !== undefined) {
          const reason = `invalid RuleHostResult: ${normalized.degraded.notes ?? 'unknown invalid result'}`;
          const nextAction = 'fix the RuleCode result and reactivate the rule; invalid output is normalized to requireApproval (fail-closed in the contract, not enforced as a block by this gate)';
          addWarning(warnings, reason, nextAction);
          addFault(evaluationFaults, 'unhealthy', {
            activationId: candidate.implId, artifactId: candidate.artifactId, ruleId: candidate.ruleId, mode: 'live',
          }, reason, nextAction);
        }
        const validatedResult = normalized.matched
          ? { ...normalized, ruleId: candidate.ruleId, principleId: candidate.principleId }
          : normalized;
        implementations.push({ ...candidate, evaluate: () => validatedResult });
        liveEvaluatedResults.push(validatedResult);
        emitAffectedToolsMismatch(candidate, { decision: validatedResult.decision, actionFamily: canonicalKind, toolName: input.toolName });
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
          ...(options.hostKind !== undefined ? { hostKind: options.hostKind } : {}),
        },
        ...shadowEvaluations,
      ];
      if (result?.decision === 'block') {
        if (result.reason.trim().length === 0) {
          addWarning(warnings, 'deny_reason_missing', 'fix the RuleCode to return a non-empty block reason');
          return { decision: 'allow', source: event.source, warnings, metadata: withFaults({ evaluatedLiveRules: implementations.length, evaluations }, evaluationFaults) };
        }
        return { decision: 'deny', reason: result.reason, source: event.source, ...(warnings.length ? { warnings } : {}), metadata: withFaults({ evaluatedLiveRules: implementations.length, ruleId: result.ruleId, principleId: result.principleId, evaluations }, evaluationFaults) };
      }
      // Task 1 (legacy fallback convergence): a non-block verdict now carries
      // the facts the OpenClaw adapter needs to record/apply it WITHOUT a
      // second evaluation: winner identity, matched flag, rule reason and the
      // already-merged (validated) correction proposal. `metadata` is
      // host-neutral; adapters that do not consume these keys ignore them and
      // never forward them into a host schema.
      return {
        decision: 'allow',
        source: event.source,
        ...(warnings.length ? { warnings } : {}),
        metadata: withFaults({
          evaluatedLiveRules: implementations.length,
          ruleDecision: result?.decision ?? 'allow',
          matched: result?.matched ?? false,
          ...(result?.ruleId !== undefined ? { ruleId: result.ruleId } : {}),
          ...(result?.principleId !== undefined ? { principleId: result.principleId } : {}),
          ...(result?.reason !== undefined ? { ruleReason: result.reason } : {}),
          ...(result !== undefined && result.correctionProposal !== undefined ? { correctionProposal: result.correctionProposal } : {}),
          evaluations,
        }, evaluationFaults),
      };
    } catch (error: unknown) {
      addWarning(warnings, `activation_read_failed: ${error instanceof Error ? error.message : String(error)}`, 'inspect state.db schema and integrity');
      // Same durable-marker contract as the missing-DB branch: a corrupt or
      // unreadable governance store degrades enforcement to allow, so the
      // degradation must leave a durable, Owner-visible trace outside the
      // agent-writable workspace. Best-effort; never replaces the decision.
      try {
        recordDegradedEnforcement(event.context.workspaceDir, `activation_read_failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      } catch { /* observability only */ }
      return { decision: 'allow', source: event.source, warnings, metadata: withFaults({ evaluatedLiveRules: 0, evaluationStatus: 'failed' }, evaluationFaults) };
    } finally {
      connection.close();
    }
  };
}
