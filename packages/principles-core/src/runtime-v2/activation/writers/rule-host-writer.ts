import type { PIArtifactSnapshot, CanActivateResult, ChannelWriter, WriterInput, WriterResult, ActivationRiskLevel } from '../activation-types.js';
import type { RefinerRuleHostGateDeps, RefinerRuleHostGateResult } from '../../internalization/refiner-rulehost-gate.js';
import { evaluateRefinerRuleHostGate } from '../../internalization/refiner-rulehost-gate.js';
import type { GoldenTrace } from '../../golden-trace.js';

const DESTRUCTIVE_TOOL_PREFIXES: readonly string[] = ['edit', 'write', 'delete', 'bash', 'exec', 'remove'];

export interface RuleHostWriterConfig {
  gateDeps: RefinerRuleHostGateDeps;
}

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

function extractGoldenTrace(parsed: Record<string, unknown>): GoldenTrace | null {
  const trace = parsed.goldenTrace;
  if (typeof trace !== 'object' || trace === null || Array.isArray(trace)) {
    return null;
  }
  const traceObj = trace as Record<string, unknown>;
  if (!Array.isArray(traceObj.cases) || traceObj.cases.length === 0) {
    return null;
  }
  if (typeof traceObj.traceId !== 'string' || traceObj.traceId.trim().length === 0) {
    return null;
  }
  return trace as unknown as GoldenTrace;
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

  constructor(config: RuleHostWriterConfig) {
    this.gateDeps = config.gateDeps;
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

    const implementationCode = extractImplementationCode(parsed);
    if (!implementationCode) {
      return { ok: false, reason: 'no_implementation_code', riskLevel: 'high' };
    }

    const goldenTrace = extractGoldenTrace(parsed);
    if (!goldenTrace) {
      return { ok: false, reason: 'no_golden_trace', riskLevel: 'high' };
    }

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

    return {
      activationId: `act_code_${ruleId}`,
      action: 'code_tool_hook_shadow_activate',
      targetRef: `impl://${ruleId}`,
    };
  }
}
