import type { PIArtifactSnapshot, CanActivateResult, ChannelWriter, WriterInput, WriterResult, ActivationRiskLevel, ApprovalEnqueueInput } from '../activation-types.js';
import type { RefinerRuleHostGateDeps, RefinerRuleHostGateResult } from '../../internalization/refiner-rulehost-gate.js';
import { evaluateRefinerRuleHostGate } from '../../internalization/refiner-rulehost-gate.js';
import type { ToolSemanticRegistry } from '../../internalization/tool-semantic-registry.js';
import { validateRuleReliability } from '../../internalization/rule-reliability-validation.js';
import type { GoldenTrace } from '../../golden-trace.js';
import { validateGoldenTrace } from '../../golden-trace.js';

const DESTRUCTIVE_TOOL_PREFIXES: readonly string[] = ['edit', 'write', 'delete', 'bash', 'exec', 'remove'];

export interface RuleHostWriterConfig {
  gateDeps: RefinerRuleHostGateDeps;
  /**
   * PRI-484 — feature flag probe used to gate v2 artifacts.
   *
   * Returns `true` if the named flag is enabled, `false` otherwise. When
   * omitted, all flags are treated as disabled (safe default for the
   * `quiet`-category `rulecode_context_v2` flag, which defaults to off per
   * PRI-239). The probe is injected (not imported) so this file stays pure
   * logic — no I/O, no YAML loader.
   */
  featureFlagProbe?: (flagId: string) => boolean;
  /**
   * PRI-634-F — ToolSemanticRegistry supplied by the constructing host.
   * When present: (1) canActivate runs the deterministic Rule Reliability
   * Validation (affectedTools + golden-trace toolNames must resolve —
   * SPEC §9 Tool存在性, adapter/tool_alias_unknown on failure); (2) the
   * activation gate replays with production-identical tool semantics.
   * Absent → legacy behavior (no reliability check, baseline replay inputs).
   */
  toolSemantics?: ToolSemanticRegistry;
  /**
   * PRI-634-F — replay path-normalization root (the workspace the gate
   * replays for). When present, golden-trace cases normalize exactly like
   * the production gate. Absent → legacy null normalizedPath replay.
   */
  projectDir?: string;
}

/** PRI-484 — the feature flag id that gates v2 rule artifacts. */
const RULECODE_CONTEXT_V2_FLAG_ID = 'rulecode_context_v2';

function parseContentJson(contentJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(contentJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractImplementationCode(parsed: Record<string, unknown>): string | null {
  const code = parsed.implementationCode;
  if (typeof code === 'string' && code.trim().length > 0) {
    return code;
  }
  return null;
}

type ExtractedGoldenTrace =
  | { ok: true; trace: GoldenTrace }
  | { ok: false; reason: string };

/**
 * Extract and validate the goldenTrace field from parsed artifact contentJson.
 *
 * ERR-001/ERR-005 (rc-1/rc-2): the previous implementation used
 * `as unknown as GoldenTrace` to cast the parsed object without calling
 * `validateGoldenTrace()`. This bypassed schema validation, allowing
 * artifacts with illegal `expectedDecision` values (e.g. "requireApproval",
 * which is a RuleHostDecision runtime enum, not a GoldenTraceDecision test
 * expectation) to pass canActivate and only fail later inside the sandbox
 * with an opaque `gate_decision_not_accepted_shadow:rejected_validation_failed`
 * error. The owner had no way to understand the real cause.
 *
 * Now we run the canonical `validateGoldenTrace()` validator and surface a
 * clear reason pointing at the offending field when validation fails.
 */
function extractGoldenTrace(parsed: Record<string, unknown>): ExtractedGoldenTrace {
  const trace = parsed.goldenTrace;
  if (typeof trace !== 'object' || trace === null || Array.isArray(trace)) {
    return { ok: false, reason: 'no_golden_trace' };
  }

  // Once we have an object, defer ALL field-level validation to the canonical
  // validator. The previous intermediate checks (cases non-empty, traceId
  // non-empty) masked schema errors as 'no_golden_trace', giving the owner
  // a less actionable reason than 'golden_trace_schema_invalid: <detail>'.
  const validation = validateGoldenTrace(trace);
  if (!validation.valid) {
    const detail = validation.errors.slice(0, 3).join('; ');
    return {
      ok: false,
      reason: `golden_trace_schema_invalid: ${detail}`,
    };
  }

  return { ok: true, trace: trace as GoldenTrace };
}

function extractRuleHostGateDecision(parsed: Record<string, unknown>): string | null {
  const decision = parsed.ruleHostGateDecision;
  if (typeof decision === 'string' && decision.trim().length > 0) {
    return decision;
  }
  return null;
}

function assessRiskLevel(parsed: Record<string, unknown>): ActivationRiskLevel {
  const { affectedTools } = parsed;
  if (!Array.isArray(affectedTools)) {
    return 'high';
  }
  const hasDestructive = affectedTools.some((tool: unknown) => {
    if (typeof tool !== 'string') return false;
    const toolLower = tool.toLowerCase();
    return DESTRUCTIVE_TOOL_PREFIXES.some((prefix) => toolLower.includes(prefix));
  });
  return hasDestructive ? 'critical' : 'high';
}

/**
 * PRI-490 — extract and validate the `evidenceRefs` field from parsed artifact
 * contentJson. Returns the validated `string[]` when present and well-formed,
 * or `null` when absent / malformed. Callers treat `null` as "no evidenceRefs".
 *
 * PRI-491 — exported for reuse by CLI/Console display paths that need to show
 * evidenceRefs without reimplementing the validation logic (DRY).
 *
 * ERR-001/ERR-005 (rc-1/rc-2/rc-4): the parsed value is `unknown`; we never
 * `as`-cast. Each element is type-narrowed via `typeof` before acceptance.
 */
export function extractEvidenceRefs(parsed: Record<string, unknown>): string[] | null {
  if (!Object.hasOwn(parsed, 'evidenceRefs')) return null;
  const refs = parsed.evidenceRefs;
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const valid: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.trim() === '') return null;
    valid.push(ref);
  }
  return valid;
}

/**
 * PRI-490 — validate v2 seed-rule content constraints BEFORE the sandbox runs.
 *
 * v2 seed rules (Owner-labelled evidence path) may only emit `allow` / `block`
 * decisions. `propose_correction` is forbidden because seed-user MVP does not
 * support auto-correct. v2 also requires `evidenceRefs` to be preserved from
 * the BehaviorExamplePack through the artifact chain.
 *
 * Returns `null` when the v2 content is valid, or a rejection reason string
 * describing the first violation. v1 artifacts skip this check entirely.
 *
 * ERR-009 (rc-3): missing required v2 fields fail loud with an actionable
 * reason rather than a silent skip.
 * ERR-089: we check BOTH the propose_correction ban AND the evidenceRefs
 * requirement; fixing one violation must not mask the other.
 */
function validateV2SeedRuleContent(
  parsed: Record<string, unknown>,
  goldenTrace: GoldenTrace,
): string | null {
  // 1. v2 seed rules forbid propose_correction in goldenTrace.cases.
  //    Only `allow` and `block` are permitted (seed-user MVP scope).
  for (const c of goldenTrace.cases) {
    if (c.expectedDecision === 'propose_correction') {
      return 'v2_seed_rule_forbidden_decision:propose_correction';
    }
  }

  // 2. v2 artifacts MUST carry evidenceRefs (non-empty array of non-empty
  //    strings) preserved verbatim from BehaviorExamplePack.
  const refs = extractEvidenceRefs(parsed);
  if (refs === null) {
    return Object.hasOwn(parsed, 'evidenceRefs')
      ? 'v2_seed_rule_invalid_evidence_refs'
      : 'v2_seed_rule_missing_evidence_refs';
  }

  return null;
}

export class RuleHostWriter implements ChannelWriter {
  readonly channel = 'code_tool_hook' as const;

  private readonly gateDeps: RefinerRuleHostGateDeps;
  private readonly featureFlagProbe?: (flagId: string) => boolean;
  private readonly toolSemantics?: ToolSemanticRegistry;
  private readonly projectDir?: string;

  constructor(config: RuleHostWriterConfig) {
    this.gateDeps = config.gateDeps;
    this.featureFlagProbe = config.featureFlagProbe;
    this.toolSemantics = config.toolSemantics;
    this.projectDir = config.projectDir;
  }

  async canActivate(artifact: PIArtifactSnapshot): Promise<CanActivateResult> {
    if (artifact.artifactKind !== 'rule') {
      return { ok: false, reason: 'artifact_kind_not_rule', riskLevel: 'high' };
    }

    if (artifact.validationStatus !== 'validated') {
      return { ok: false, reason: `artifact_validation_status_${artifact.validationStatus}`, riskLevel: 'high' };
    }

    const parsed = parseContentJson(artifact.contentJson);
    if (!parsed) {
      return { ok: false, reason: 'content_json_parse_failed', riskLevel: 'high' };
    }

    // PRI-484 — gate v2 artifacts on the rulecode_context_v2 feature flag.
    // The check runs BEFORE the sandbox call so that a v2 artifact in a
    // flag-off workspace never pays sandbox cost or risks a stale
    // accepted_shadow decision being activated against v1 expectations.
    // Only literal `2` is treated as a v2 declaration; any other value
    // (including 1, "2", null) falls through to the v1 path unchanged.
    if (Object.hasOwn(parsed, 'requiresContextVersion') && parsed.requiresContextVersion !== 2) {
      return {
        ok: false,
        reason: 'unsupported_context_version',
        riskLevel: 'high',
      };
    }

    if (parsed.requiresContextVersion === 2) {
      const enabled = this.featureFlagProbe
        ? this.featureFlagProbe(RULECODE_CONTEXT_V2_FLAG_ID)
        : false;
      if (!enabled) {
        return {
          ok: false,
          reason: 'rulecode_context_v2_disabled',
          riskLevel: 'high',
        };
      }
    }

    const implementationCode = extractImplementationCode(parsed);
    if (!implementationCode) {
      return { ok: false, reason: 'no_implementation_code', riskLevel: 'high' };
    }

    const goldenTraceResult = extractGoldenTrace(parsed);
    if (!goldenTraceResult.ok) {
      return { ok: false, reason: goldenTraceResult.reason, riskLevel: 'high' };
    }
    const goldenTrace = goldenTraceResult.trace;

    const gateDecision = extractRuleHostGateDecision(parsed);
    if (gateDecision !== 'accepted_shadow') {
      return { ok: false, reason: 'gate_decision_not_accepted_shadow', riskLevel: 'high' };
    }

    // PRI-490 — v2 seed-rule content constraints (allow/block-only +
    // evidenceRefs required). v1 artifacts skip this check entirely, so
    // v1 behavior is unchanged. This runs BEFORE the sandbox so the owner
    // sees an actionable reason rather than an opaque sandbox failure
    // (mirrors the existing extractGoldenTrace defense-in-depth pattern).
    if (parsed.requiresContextVersion === 2) {
      const v2Violation = validateV2SeedRuleContent(parsed, goldenTrace);
      if (v2Violation) {
        return { ok: false, reason: v2Violation, riskLevel: 'high' };
      }
    }

    // PRI-634-F Phase 3 — deterministic Rule Reliability Validation before the
    // sandbox (SPEC §9 V1: Tool存在性). A rule referencing tools the registry
    // cannot resolve would pass replay against fictional inputs while never
    // matching production dispatch — fail loud at activation with the layered
    // attribution instead. Only runs when the host supplied a registry.
    if (this.toolSemantics) {
      const declaredTools = Array.isArray(parsed.affectedTools)
        ? parsed.affectedTools.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      const reliability = validateRuleReliability({
        affectedTools: declaredTools,
        goldenTraceCaseToolNames: goldenTrace.cases.map((c) => c.toolName),
        toolSemantics: this.toolSemantics,
      });
      if (!reliability.valid && reliability.failure) {
        const {failure} = reliability;
        return {
          ok: false,
          reason: `rule_reliability_${failure.reasonCode}:${failure.layer} — ${failure.evidence} (nextAction=${failure.nextAction})`,
          riskLevel: 'high',
        };
      }
    }

    const gateResult: RefinerRuleHostGateResult = evaluateRefinerRuleHostGate(
      {
        code: implementationCode,
        goldenTrace,
        ...(this.toolSemantics ? { toolSemantics: this.toolSemantics } : {}),
        ...(this.projectDir ? { projectDir: this.projectDir } : {}),
      },
      this.gateDeps,
    );

    if (gateResult.decision !== 'accepted_shadow') {
      // rc-9-no-silent-fallback (EP-03, issue #1337): the gate has already
      // computed actionable field-level failure reasons. Dropping them (the
      // pre-#1337 behavior) left the owner an opaque
      // `gate_decision_not_accepted_shadow:<decision>` with no way to
      // self-serve. Surface the reasons, bounded to the first 3 — the same
      // slice convention as extractGoldenTrace. Joining is branch-free: with
      // zero reasons the result degrades to the exact legacy format.
      const reasonParts = [
        `gate_decision_not_accepted_shadow:${gateResult.decision}`,
        ...gateResult.reasons.slice(0, 3),
      ];
      return {
        ok: false,
        reason: reasonParts.join(' — '),
        riskLevel: 'high',
      };
    }

    const affectedTools = Array.isArray(parsed.affectedTools)
      ? parsed.affectedTools.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const protectedCapabilities = new Set(['pd_status', 'rulecode_deactivate', 'rulecode_global_pause', 'owner_review_access']);
    if (affectedTools.length === 0) return { ok: false, reason: 'rulecode_scope_empty', riskLevel: 'high' };
    if (affectedTools.some(value => value === '*' || value.toLowerCase() === 'all')) return { ok: false, reason: 'rulecode_scope_wildcard_forbidden', riskLevel: 'high' };
    if (affectedTools.some(value => protectedCapabilities.has(value))) return { ok: false, reason: 'rulecode_scope_protected_capability', riskLevel: 'high' };

    const riskLevel = assessRiskLevel(parsed);
    return { ok: true, riskLevel };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async activate(input: WriterInput, artifact: PIArtifactSnapshot): Promise<WriterResult> {
    const ruleId = typeof artifact.sourceRuleId === 'string' && artifact.sourceRuleId.trim().length > 0
      ? artifact.sourceRuleId.trim()
      : input.principleId;

    // PRI-489 (seed-MVP readiness): Owner approval creates a SHADOW
    // activation first. Shadow activations are observation-only — the
    // runtime RuleHost (rule-host.ts) records would-block/would-allow into
    // `shadowDecisions` but never blocks or modifies the tool call. The
    // only shadow -> live transition is `pd activation promote
    // --activation-id ... --confirm`, which atomically rewrites the action
    // to `code_tool_hook_live_activate` inside a BEGIN IMMEDIATE
    // transaction (SqliteActivationStateStore.promoteActivation).
    //
    // Returning `code_tool_hook_live_activate` here was the seed-MVP
    // release blocker: a newly approved rule would immediately block
    // production tool calls with no observation window. Shadow-first
    // gives the owner a reversible observation phase before any live
    // enforcement.
    return {
      activationId: `act_code_${ruleId}`,
      action: 'code_tool_hook_shadow_activate',
      targetRef: `impl://${ruleId}`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  buildApprovalContext(
    _input: WriterInput,
    artifact: PIArtifactSnapshot,
    confidence?: number,
  ): Pick<ApprovalEnqueueInput, 'summary' | 'triggerReason' | 'confidenceExplanation' | 'effectDescription' | 'rejectionEffect'> {
    const ruleId = typeof artifact.sourceRuleId === 'string' && artifact.sourceRuleId.trim().length > 0
      ? artifact.sourceRuleId.trim()
      : artifact.artifactId;

    const parsed = parseContentJson(artifact.contentJson);
    const rawPainReason = parsed?.painReasonSummary;
    const painReasonSummary = typeof rawPainReason === 'string'
      ? rawPainReason.trim()
      : '';
    const affectedTools = Array.isArray(parsed?.affectedTools)
      ? (parsed.affectedTools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    // PRI-490 — surface evidence refs in approval context so the owner can
    // see the provenance of the rule when reviewing the approval. Only
    // included when the artifact carries a valid evidenceRefs array.
    const evidenceRefs = parsed ? extractEvidenceRefs(parsed) : null;

    const summary = `Rule activation request for code_tool_hook: ${ruleId}`;

    const triggerReason = painReasonSummary.length > 0
      ? painReasonSummary
      : 'RuleHost candidate requires human approval before activation.';

    const validConfidence = typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    const confidenceExplanation = validConfidence
      ? `Confidence: ${Math.round(confidence * 100)}%. Evaluated through shadow replay and sandbox gate.`
      : 'Confidence score unavailable. Manual review recommended.';

    const toolsClause = affectedTools.length > 0
      ? `This rule will intercept tool calls: ${affectedTools.join(', ')}. After approval, matching calls will be evaluated against the rule logic.`
      : 'This candidate may affect code_tool_hook behavior after approval. Tool scope is not specified.';
    // PRI-490 — append evidence refs to the effect description when present,
    // so the owner has provenance context during approval review.
    const evidenceClause = evidenceRefs && evidenceRefs.length > 0
      ? ` Evidence backing this rule: ${evidenceRefs.join(', ')}.`
      : '';
    const effectDescription = `${toolsClause}${evidenceClause}`;

    const rejectionEffect = 'The rule will not be activated. Current tool calls will continue unchanged.';

    return { summary, triggerReason, confidenceExplanation, effectDescription, rejectionEffect };
  }
}
