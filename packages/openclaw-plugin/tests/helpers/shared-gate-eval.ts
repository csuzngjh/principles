/**
 * PRI-1208 Stage 4: evaluate a RuleHostInput through the SINGLE live path.
 *
 * Legacy `RuleHost#evaluate` / `#evaluateDetailed` were deleted. Integration
 * suites that used them as an evaluation oracle now call the shared production
 * gate, so they keep exercising the real decision kernel instead of a retired
 * copy. The returned shapes intentionally mirror the legacy block result so the
 * existing assertions stay meaningful.
 */

import type { RuleHostInput } from '@principles/core/runtime';
import { createProductionHostRuntime } from '@principles/host-runtime';

export interface SharedGateBlockResult {
  decision: 'block';
  matched: true;
  reason: string;
  ruleId?: string;
  principleId?: string;
}

export interface SharedGateDetailedReport {
  liveDecision: SharedGateBlockResult | undefined;
  shadowDecisions: Array<{
    activationId?: string;
    ruleId?: string;
    decision: string;
    matched?: boolean;
    activationMode: 'shadow';
  }>;
  skippedActivations: Array<{
    activationId: string;
    ruleId: string;
    reason: string;
    nextAction: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawParams(input: RuleHostInput): Record<string, unknown> {
  const summary: unknown = input.action.paramsSummary;
  return isRecord(summary) ? { ...summary } : {};
}

async function dispatch(workspaceDir: string, input: RuleHostInput) {
  const toolName = input.action.toolName;
  const runtime = createProductionHostRuntime({
    hostKind: 'openclaw',
    ruleInputEnrichmentProvider: () => ({
      epTier: input.evolution.epTier,
      bashRisk: input.derived.bashRisk,
    }),
    // v2 rules only load when their context is available; the call site owns
    // the fixture context, exactly as the host provider does in production.
    ruleContextProvider: async () => input.context,
    afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
  });
  return runtime.dispatch({
    kind: 'before_tool_call',
    context: {
      workspaceDir,
      sessionId: input.session.sessionId ?? 'shared-gate-eval',
      toolName,
    },
    rawPayload: { toolInput: { toolName, params: rawParams(input) } },
    source: 'test:shared-gate-eval',
  });
}

function toBlockResult(result: { decision: 'allow' | 'deny'; reason?: string; metadata?: Readonly<Record<string, unknown>> }): SharedGateBlockResult | undefined {
  if (result.decision !== 'deny') return undefined;
  const metadata = result.metadata ?? {};
  return {
    decision: 'block',
    matched: true,
    reason: result.reason ?? '',
    ...(typeof metadata['ruleId'] === 'string' ? { ruleId: metadata['ruleId'] } : {}),
    ...(typeof metadata['principleId'] === 'string' ? { principleId: metadata['principleId'] } : {}),
  };
}

export async function evaluateThroughSharedGate(
  workspaceDir: string,
  input: RuleHostInput,
): Promise<SharedGateBlockResult | undefined> {
  return toBlockResult(await dispatch(workspaceDir, input));
}

export async function evaluateDetailedThroughSharedGate(
  workspaceDir: string,
  input: RuleHostInput,
): Promise<SharedGateDetailedReport> {
  const result = await dispatch(workspaceDir, input);
  const metadata = result.metadata ?? {};
  const evaluations = Array.isArray(metadata['evaluations']) ? metadata['evaluations'] : [];
  const faults = Array.isArray(metadata['evaluationFaults']) ? metadata['evaluationFaults'] : [];
  return {
    liveDecision: toBlockResult(result),
    shadowDecisions: evaluations
      .filter(isRecord)
      .filter((entry) => entry['activationMode'] === 'shadow')
      .map((entry) => ({
        ...(typeof entry['activationId'] === 'string' ? { activationId: entry['activationId'] } : {}),
        ...(typeof entry['ruleId'] === 'string' ? { ruleId: entry['ruleId'] } : {}),
        decision: typeof entry['decision'] === 'string' ? entry['decision'] : 'unknown',
        ...(typeof entry['matched'] === 'boolean' ? { matched: entry['matched'] } : {}),
        activationMode: 'shadow' as const,
      })),
    skippedActivations: faults
      .filter(isRecord)
      .filter((entry) => entry['kind'] === 'skipped')
      .map((entry) => ({
        activationId: String(entry['activationId'] ?? ''),
        ruleId: String(entry['ruleId'] ?? ''),
        reason: String(entry['reason'] ?? ''),
        nextAction: String(entry['nextAction'] ?? ''),
      })),
  };
}
