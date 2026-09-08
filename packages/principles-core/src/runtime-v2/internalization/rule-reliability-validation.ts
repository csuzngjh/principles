/**
 * Rule Reliability Validation & Failure Attribution — PRI-634-F Phase 3
 *
 * PURPOSE: answer "哪里错 / 为什么 / 谁负责" for rule reliability failures
 * (SPEC §8) instead of free-text "replay failed". Two pure capabilities:
 *
 *   1. validateRuleReliability — deterministic pre-gate check (SPEC §7/§9 V1):
 *      every declared tool (affectedTools + goldenTraceCases toolName) must be
 *      known to the ToolSemanticRegistry, otherwise adapter/tool_alias_unknown.
 *
 *   2. classifyReplayFailure — map a RefinerRuleHostGate outcome to ONE
 *      FailureLayer with a stable reasonCode, bounded evidence and a next
 *      action. Routing only — no repair (SPEC §10).
 *
 * Layer semantics (SPEC §8):
 *   rule    — the generated RuleCode itself is defective
 *   test    — the golden trace material is deficient
 *   adapter — the tool mapping/host adapter surface is wrong
 *   runtime — the evaluation infrastructure/environment failed
 *   unknown — cannot be determined
 *
 * Pure logic — zero I/O. No new subsystem, no repair loop.
 */

import type { RefinerRuleHostGateDecision, } from './refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from './refiner-sandbox-wrapper.js';
import type { ToolSemanticRegistry } from './tool-semantic-registry.js';

export type FailureLayer = 'rule' | 'test' | 'adapter' | 'runtime' | 'principle' | 'evaluation' | 'unknown';

export interface RuleReliabilityFailure {
  readonly layer: FailureLayer;
  readonly reasonCode: string;
  /** Bounded human-readable evidence (rc-8: never assume stringify of arbitrary values). */
  readonly evidence: string;
  readonly nextAction: string;
}

/**
 * PRI-705 / PRI-703 Phase 2 (Owner decision 2026-09-07): pipeline-stage
 * failure attribution — "哪里失败 / 为什么 / 下一步改哪里" at the level an
 * operator or repair loop routes on. This EXTENDS FailureLayer (same
 * vocabulary, one enum — no parallel taxonomy): each stage-failure answer
 * maps onto a layer so the existing propagation paths
 * (evaluator artifact failure.{layer,reasonCode}, CLI rulecode output)
 * keep working.
 *
 * Stage answers:
 *   FAILED_PRINCIPLE → layer 'principle' — the principle (or its intent
 *     contract) is incomplete/wrong; repairing the rule cannot fix it.
 *   FAILED_RULE      → layer 'rule' — the rule implementation is defective.
 *   FAILED_EVALUATION→ layer 'evaluation' — the evaluation/judging itself was
 *     wrong (gate correct rejections are NOT this — a correct rejection is
 *     the system working; this value is for evaluation-side defects).
 *   FAILED_TEST      → layer 'test' — the adversarial/golden material is
 *     deficient or OUT OF SCOPE for this principle's intent contract
 *     (deterministic v2-context cases judging a v1 action-only rule are the
 *     canonical instance — Episode 001 / PRI-700 factor A).
 *   INFRA_BLOCKED    → layer 'runtime' — infrastructure blocked the attempt.
 *   OWNER_BLOCKED    → not a failure layer: represented by task status
 *     needs_human_review + HumanReviewReasonCode (owner-review.ts). Listed
 *     here for the operator-facing taxonomy completeness; classify never
 *     returns it (task state owns it).
 *   UNKNOWN          → layer 'unknown'.
 */
export type FailureAttribution =
  | 'FAILED_PRINCIPLE'
  | 'FAILED_RULE'
  | 'FAILED_EVALUATION'
  | 'FAILED_TEST'
  | 'INFRA_BLOCKED'
  | 'OWNER_BLOCKED'
  | 'UNKNOWN';

/** Map a FailureLayer to the operator-facing attribution stage answer. */
export function attributionFromLayer(layer: FailureLayer): FailureAttribution {
  switch (layer) {
    case 'principle': return 'FAILED_PRINCIPLE';
    case 'rule': return 'FAILED_RULE';
    case 'evaluation': return 'FAILED_EVALUATION';
    case 'test': return 'FAILED_TEST';
    case 'runtime': return 'INFRA_BLOCKED';
    default: return 'UNKNOWN';
  }
}

/**
 * The ONLY v2 adversarial template caseIds the evaluator generates
 * (v2-adversarial-cases.ts). An allowlist — NOT a prefix match: the merged
 * case set can carry LLM-supplied adversarialCases whose caseId merely needs
 * to be a non-empty string, so a custom `v2-business-boundary` id would be
 * misattributed as out-of-scope by a prefix rule (评审 P1: prefix 匹配会把
 * LLM 自定义 v2-* id 误判为 test 出界，跳过真实需要的 Rule 修复).
 *
 * Equivalence with the generator is locked by contract test
 * (evolution-alignment-contract.test.ts) — adding a template without
 * updating this list silently re-opens the v2×v1 repair death loop.
 */
export const V2_TEMPLATE_CASE_IDS: ReadonlySet<string> = new Set([
  'v2-unavailable',
  'v2-truncated',
  'v2-alias',
  'v2-path-boundary',
  'v2-combination',
]);

/**
 * Round-2 R1（Owner 口径 b，2026-09-08）：出界判据不按模板名单断言，按
 * **模板定义的期望决策（oracle）** 判定。三个 context-only 模板
 * （unavailable/truncated/alias）期望 allow 且该期望 v1 action-only 规则
 * 结构上无法表达（context 不可用→必须 allow 是 context 语义）。另两个
 * 模板（path-boundary/combination）期望 **block**——风险路径写门，v1 完全
 * 可以实现，因此永远 in-scope（R1 复现：禁写 /etc/passwd 的规则正是被
 * 名单判据错误豁免）。
 *
 * TRUST BOUNDARY（Oracle-only expectedDecision）：这里的映射是编译期
 * 事实（generateV2ContextAdversarialCases 的模板定义），不是从运行时
 * 工件读取的 expectedDecision——后者对 LLM-supplied adversarialCases
 * 混入了不可信来源。出界判定只用本常量 + 沙箱回带值的**一致性比对**
 * （防 caseId 冒名），绝不信任工件里的期望值本身。
 */
export const V2_CONTEXT_ONLY_TEMPLATE_EXPECTED_ALLOW: ReadonlyMap<string, 'allow'> = new Map([
  ['v2-unavailable', 'allow'],
  ['v2-truncated', 'allow'],
  ['v2-alias', 'allow'],
]);

/** The oracle expected decision for a known v2 template caseId (compile-time fact), or null for unknown ids. */
export function v2TemplateOracleExpectedDecision(caseId: string): 'allow' | 'block' | null {
  if (V2_CONTEXT_ONLY_TEMPLATE_EXPECTED_ALLOW.has(caseId)) return 'allow';
  if (caseId === 'v2-path-boundary' || caseId === 'v2-combination') return 'block';
  return null;
}

/**
 * PRI-703 Phase 2 — deterministic v2-case scope classification (Episode 001
 * PRI-700 factor A, Owner decision: evaluation cases must fall INSIDE the
 * principle's intent contract before they may judge it).
 *
 * The v2 adversarial templates (v2-unavailable/truncated/alias/path-boundary/
 * combination) demand context-aware decisions ("allow when context
 * unavailable"). A v1 action-only rule structurally CANNOT express them
 * (V1_CONTEXT_INSTRUCTION forbids reading input.context), so their failure is
 * a property of the CASE × CHANNEL pairing, not of the rule. Pure string-shape
 * logic against the known template-id allowlist (V2_TEMPLATE_CASE_IDS) —
 * deterministic, no LLM involved; LLM-supplied custom `v2-*` ids are NOT
 * matched (they introduce new behavioral requirements and stay in-scope).
 *
 * Pure function — zero I/O.
 */
export function isV2ContextCase(caseId: string): boolean {
  return V2_TEMPLATE_CASE_IDS.has(caseId);
}

/**
 * PRI-703 Phase 2（评审 P1 修正）: resolve a rule artifact's context-channel
 * declaration from its contentJson for scope classification. Three-way
 * result — the distinction is load-bearing wiring:
 *   2        → resolved v2 rule (context-aware; every v2 case is in scope);
 *   undefined → resolved v1 rule (key absent on a PARSED artifact — the
 *              artificer schema only ever writes literal 2, so key-absent is
 *              deterministically v1; the partition MUST run for it);
 *   null     → unresolvable (artifact missing/unparseable/not an object/
 *              malformed value) — callers fail open and skip the partition.
 *
 * 评审 P1 回归背景：此前 runner 把 key-absent（=v1，出界路由的全部目标
 * 人群）也折叠成 null，导致 partition 在生产中永远不运行——单测直接传
 * undefined 掩盖了接线断点。纯函数提取以使该判定可测。
 */
export function resolveRequiresContextVersionFromArtifact(
  contentJson: string | null | undefined,
): number | undefined | null {
  if (contentJson === null || contentJson === undefined || contentJson.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, 'requiresContextVersion')) return undefined;
  const value = record.requiresContextVersion;
  return typeof value === 'number' ? value : null;
}

/**
 * Partition failed replay cases into in-scope (real rule defects — feed the
 * repair loop) vs out-of-scope (test-material problem — must NOT enter the
 * repair loop as a rule defect; it is surfaced as a channel-limitation signal
 * instead). Out-of-scope = every failed case is a v2-context template AND the
 * rule is v1 (no requiresContextVersion: 2): the v1 channel cannot express
 * context semantics, so requiring it is a test-scope error.
 */
/**
 * PRI-703 Phase 2 — deterministic v2-case scope classification (Episode 001
 * PRI-700 factor A, Owner decision: evaluation cases must fall INSIDE the
 * principle's intent contract before they may judge it).
 *
 * Round-2 R1 (Owner 口径 b): out-of-scope is granted ONLY per-case, and only
 * when BOTH hold:
 *   1. the caseId belongs to a context-only template (unavailable/truncated/
 *      alias) whose ORACLE expected decision is 'allow' — the v1 channel
 *      structurally cannot express "must allow when context is unavailable";
 *   2. the sandbox-reported expectedDecision for that case MATCHES the
 *      oracle (anti-spoofing: a case re-using a template id with a different
 *      expectation is not the template case).
 * Everything else — including v2-path-boundary / v2-combination (expected
 * block; risk-path gating a v1 rule CAN implement), LLM-invented v2-* ids,
 * and any case whose reported expectation is missing or disagrees — stays
 * IN SCOPE (fail-closed: a missing/malformed expectation never exempts the
 * rule from repair). R1 regression: a rule that fails an explicit block
 * requirement must always reach the repair loop.
 *
 * Pure function — zero I/O. The expectedDecision input is the value carried
 * on the durable evaluator artifact's failedCases (sandbox-authoritative for
 * template-generated traces); it is only used as a consistency CHECK against
 * the compile-time oracle — never as the classification source of truth.
 */
export interface OutOfScopeFailedCase {
  readonly caseId: string;
  /** Sandbox-carried expectation for the case; undefined when absent. */
  readonly expectedDecision?: string;
}

export function partitionV2OutOfScopeFailures(input: {
  readonly requiresContextVersion: number | undefined;
  readonly failedCases: readonly OutOfScopeFailedCase[];
}): { readonly outOfScope: readonly string[]; readonly inScope: readonly string[]; readonly isPureOutOfScope: boolean } {
  const { requiresContextVersion, failedCases } = input;
  if (requiresContextVersion === 2) {
    // v2 rules CAN express context semantics — every v2 case is in scope.
    return { outOfScope: [], inScope: failedCases.map((c) => c.caseId), isPureOutOfScope: false };
  }
  const outOfScope: string[] = [];
  const inScope: string[] = [];
  for (const failed of failedCases) {
    const oracle = v2TemplateOracleExpectedDecision(failed.caseId);
    // Only a context-only template with oracle-expected allow, corroborated
    // by the sandbox-carried expectation, can be structurally unexpressible
    // for a v1 rule. block-expecting templates, unknown ids, and missing/
    // mismatched expectations all remain rule-defect signals.
    const isVerifiedOutOfScope = oracle === 'allow' && failed.expectedDecision === 'allow';
    if (isVerifiedOutOfScope) {
      outOfScope.push(failed.caseId);
    } else {
      inScope.push(failed.caseId);
    }
  }
  return {
    outOfScope,
    inScope,
    // Pure = every failure is the v2×v1 structural mismatch → the repair loop
    // would have nothing real to fix; route to owner review instead.
    isPureOutOfScope: outOfScope.length > 0 && inScope.length === 0,
  };
}

const EVIDENCE_MAX_CHARS = 300;

function boundEvidence(text: string): string {
  return text.length > EVIDENCE_MAX_CHARS ? `${text.slice(0, EVIDENCE_MAX_CHARS)}…` : text;
}

// ---------------------------------------------------------------------------
// 1. Rule Reliability Validation (SPEC §7 / §9 — Tool存在性)
// ---------------------------------------------------------------------------

export interface RuleReliabilityValidationInput {
  /** ArtificerRuleOutput.affectedTools (declared scope of the rule). */
  readonly affectedTools: readonly string[];
  /** Tool names used by the rule's goldenTraceCases. */
  readonly goldenTraceCaseToolNames: readonly string[];
  /** The registry the production gate resolves tool semantics with. */
  readonly toolSemantics: ToolSemanticRegistry;
}

export interface RuleReliabilityValidationResult {
  readonly valid: boolean;
  readonly failure?: RuleReliabilityFailure;
}

/**
 * V1 validation (SPEC §9, revised in R2 per review): every tool name the rule
 * declares or tests against must be HOST-DISPATCHABLE — resolvable is not
 * enough. Three verdicts:
 *
 *   tool_alias_unknown          — resolves nowhere (not even baseline);
 *   tool_not_host_dispatchable  — semantically classifiable (baseline generic
 *                                 vocabulary like `execute_command`, or a
 *                                 read/search family the host gate never
 *                                 routes) but NOT declared by the host layer.
 *                                 A rule matching this name passes replay
 *                                 against fictional inputs and never fires
 *                                 in production — reject (SC1).
 *   tool_registry_host_layer_missing — the registry carries no host
 *                                 declaration at all; existence cannot be
 *                                 verified. Configuration defect, fail loud
 *                                 rather than silently skipping the check.
 */
export function validateRuleReliability(
  input: RuleReliabilityValidationInput,
): RuleReliabilityValidationResult {
  if (!input.toolSemantics.hasHostLayer) {
    return {
      valid: false,
      failure: {
        layer: 'adapter',
        reasonCode: 'tool_registry_host_layer_missing',
        evidence: 'ToolSemanticRegistry has no host-declared layer — tool existence cannot be verified against the production host',
        nextAction: 'supply a host-declared registry (host mappings), or run the host once so its declaration is persisted for the workspace',
      },
    };
  }

  const classify = (tool: string): 'ok' | 'unknown' | 'not_dispatchable' => {
    if (input.toolSemantics.hasHostTool(tool)) return 'ok';
    return input.toolSemantics.lookup(tool) === null ? 'unknown' : 'not_dispatchable';
  };

  const unknownAffected = input.affectedTools.filter((tool) => classify(tool) === 'unknown');
  const notDispatchableAffected = input.affectedTools.filter((tool) => classify(tool) === 'not_dispatchable');
  if (unknownAffected.length > 0) {
    return {
      valid: false,
      failure: {
        layer: 'adapter',
        reasonCode: 'tool_alias_unknown',
        evidence: boundEvidence(`affectedTools unknown to any tool vocabulary: ${unknownAffected.join(', ')}`),
        nextAction: 'regenerate the rule using real host tool names (see the host tool semantic declaration)',
      },
    };
  }
  if (notDispatchableAffected.length > 0) {
    return {
      valid: false,
      failure: {
        layer: 'adapter',
        reasonCode: 'tool_not_host_dispatchable',
        evidence: boundEvidence(
          `affectedTools semantically classifiable but NOT dispatched by this host (never reach the RuleHost gate): ${notDispatchableAffected.join(', ')}`,
        ),
        nextAction: 'regenerate the rule against host-declared tool names — generic LLM vocabulary and read/search-family names cannot trigger rules in production',
      },
    };
  }

  const unknownCaseTools = input.goldenTraceCaseToolNames.filter((tool) => classify(tool) === 'unknown');
  const notDispatchableCaseTools = input.goldenTraceCaseToolNames.filter((tool) => classify(tool) === 'not_dispatchable');
  if (unknownCaseTools.length > 0 || notDispatchableCaseTools.length > 0) {
    const parts: string[] = [];
    if (unknownCaseTools.length > 0) parts.push(`unknown: ${unknownCaseTools.join(', ')}`);
    if (notDispatchableCaseTools.length > 0) parts.push(`not host-dispatchable: ${notDispatchableCaseTools.join(', ')}`);
    return {
      valid: false,
      failure: {
        layer: 'adapter',
        reasonCode: unknownCaseTools.length > 0 ? 'tool_alias_unknown' : 'tool_not_host_dispatchable',
        evidence: boundEvidence(`goldenTraceCases toolName ${parts.join('; ')}`),
        nextAction: 'regenerate golden trace cases against host-declared tool names so replay exercises inputs production can actually produce',
      },
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 2. Replay Failure Classification (SPEC §8 / §10 — routing only)
// ---------------------------------------------------------------------------

/** Sentinel caseIds produced by infrastructure, never by a trace case. */
const INFRA_CASE_IDS: ReadonlySet<string> = new Set(['__sandbox__', '__no_evaluator__', '__compile__', '__return_shape__', '__matched_false_decision__']);

export function classifyReplayFailure(
  decision: Exclude<RefinerRuleHostGateDecision, 'accepted_shadow'>,
  sandboxResult: RefinerSandboxResult,
): RuleReliabilityFailure {
  switch (decision) {
    case 'rejected_no_cases':
      return {
        layer: 'test',
        reasonCode: 'golden_trace_empty',
        evidence: 'goldenTrace.cases is empty — no test material to validate against',
        nextAction: 'regenerate the artifact with at least one positive and one negative golden trace case',
      };
    case 'rejected_forbidden_pattern':
      return {
        layer: 'rule',
        reasonCode: 'forbidden_pattern',
        evidence: boundEvidence(`forbidden patterns: ${sandboxResult.forbiddenPatternViolations.join(', ')}`),
        nextAction: 'regenerate RuleCode without forbidden APIs (no fs/process/require/eval/network)',
      };
    case 'rejected_timeout':
      return {
        layer: 'rule',
        reasonCode: 'evaluation_timeout',
        evidence: boundEvidence(
          sandboxResult.failedCases.map((c) => `${c.caseId}: ${c.message}`).join('; '),
        ),
        nextAction: 'regenerate RuleCode with bounded logic (no unbounded loops)',
      };
    case 'rejected_validation_failed': {
      // Sentinels here are static-shape defects of the RULE CODE itself
      // (return shape, matched=false pairing) — still rule-layer.
      const detail = sandboxResult.failedCases
        .filter((c) => c.errorType === 'validation_failed')
        .map((c) => `${c.caseId}: ${c.message}`)
        .join('; ');
      return {
        layer: 'rule',
        reasonCode: 'replay_decision_mismatch',
        evidence: boundEvidence(detail || 'validation failed with no case detail'),
        nextAction: 'fix the RuleCode decision logic to satisfy the golden trace expectations',
      };
    }
    case 'rejected_runtime_error': {
      // Distinguish rule-code defects (case-level syntax/runtime errors) from
      // infrastructure failures (sandbox adapter throw, opaque sandbox state).
      const infraCases = sandboxResult.failedCases.filter((c) => INFRA_CASE_IDS.has(c.caseId));
      if (infraCases.length > 0) {
        return {
          layer: 'runtime',
          reasonCode: 'sandbox_infrastructure_failure',
          evidence: boundEvidence(infraCases.map((c) => `${c.caseId}: ${c.message}`).join('; ')),
          nextAction: 'inspect the sandbox/gate adapter wiring, then re-run the gate',
        };
      }
      const ruleCases = sandboxResult.failedCases.map((c) => `${c.caseId}: ${c.errorType} — ${c.message}`);
      return {
        layer: 'rule',
        reasonCode: 'rule_code_execution_error',
        evidence: boundEvidence(ruleCases.join('; ')),
        nextAction: 'fix the RuleCode so evaluate() handles every input shape without throwing',
      };
    }
    default:
      return {
        layer: 'unknown',
        reasonCode: 'unclassified',
        evidence: boundEvidence(`gate decision ${String(decision)}`),
        nextAction: 'inspect the full gate result manually',
      };
  }
}
