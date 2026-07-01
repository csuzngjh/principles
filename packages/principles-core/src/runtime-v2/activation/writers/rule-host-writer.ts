import type { PIArtifactSnapshot, CanActivateResult, ChannelWriter, WriterInput, WriterResult, ActivationRiskLevel, ApprovalEnqueueInput } from '../activation-types.js';
import type { RefinerRuleHostGateDeps, RefinerRuleHostGateResult } from '../../internalization/refiner-rulehost-gate.js';
import { evaluateRefinerRuleHostGate } from '../../internalization/refiner-rulehost-gate.js';
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

export class RuleHostWriter implements ChannelWriter {
  readonly channel = 'code_tool_hook' as const;

  private readonly gateDeps: RefinerRuleHostGateDeps;
  private readonly featureFlagProbe?: (flagId: string) => boolean;

  constructor(config: RuleHostWriterConfig) {
    this.gateDeps = config.gateDeps;
    this.featureFlagProbe = config.featureFlagProbe;
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

    const gateResult: RefinerRuleHostGateResult = evaluateRefinerRuleHostGate(
      { code: implementationCode, goldenTrace },
      this.gateDeps,
    );

    if (gateResult.decision !== 'accepted_shadow') {
      return {
        ok: false,
        reason: `gate_decision_not_accepted_shadow:${gateResult.decision}`,
        riskLevel: 'high',
      };
    }

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

    const summary = `Rule activation request for code_tool_hook: ${ruleId}`;

    const triggerReason = painReasonSummary.length > 0
      ? painReasonSummary
      : 'RuleHost candidate requires human approval before activation.';

    const validConfidence = typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    const confidenceExplanation = validConfidence
      ? `Confidence: ${Math.round(confidence * 100)}%. Evaluated through shadow replay and sandbox gate.`
      : 'Confidence score unavailable. Manual review recommended.';

    const effectDescription = affectedTools.length > 0
      ? `This rule will intercept tool calls: ${affectedTools.join(', ')}. After approval, matching calls will be evaluated against the rule logic.`
      : 'This candidate may affect code_tool_hook behavior after approval. Tool scope is not specified.';

    const rejectionEffect = 'The rule will not be activated. Current tool calls will continue unchanged.';

    return { summary, triggerReason, confidenceExplanation, effectDescription, rejectionEffect };
  }
}
