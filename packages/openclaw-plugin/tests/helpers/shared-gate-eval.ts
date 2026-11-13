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
  /**
   * The `targetPath` the shared gate actually derived from the rebuilt params.
   * `action.paramsSummary` is lossy, so a migrated test can verify that the
   * reconstruction still lands on the path it intended (oracle drift).
   */
  normalizedPath?: string | null;
}

export interface SharedGateDetailedReport {
  liveDecision: SharedGateBlockResult | undefined;
  normalizedPath?: string | null;
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
  let observedTargetPath: string | null | undefined;
  const runtime = createProductionHostRuntime({
    hostKind: 'openclaw',
    ruleInputEnrichmentProvider: (request) => {
      // The gate hands us exactly the normalizedPath it computed from the
      // rebuilt params — the only non-lossy way to observe the reconstruction.
      observedTargetPath = request.targetPath;
      return {
        epTier: input.evolution.epTier,
        bashRisk: input.derived.bashRisk,
      };
    },
    // v2 rules only load when their context is available; the call site owns
    // the fixture context, exactly as the host provider does in production.
    ruleContextProvider: async () => input.context,
    afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
  });
  const result = await runtime.dispatch({
    kind: 'before_tool_call',
    context: {
      workspaceDir,
      sessionId: input.session.sessionId ?? 'shared-gate-eval',
      toolName,
    },
    rawPayload: { toolInput: { toolName, params: rawParams(input) } },
    source: 'test:shared-gate-eval',
  });
  return { result, normalizedPath: observedTargetPath };
}

function toBlockResult(
  result: { decision: 'allow' | 'deny'; reason?: string; metadata?: Readonly<Record<string, unknown>> },
  normalizedPath: string | null | undefined,
): SharedGateBlockResult | undefined {
  if (result.decision !== 'deny') return undefined;
  const metadata = result.metadata ?? {};
  return {
    decision: 'block',
    matched: true,
    reason: result.reason ?? '',
    ...(typeof metadata['ruleId'] === 'string' ? { ruleId: metadata['ruleId'] } : {}),
    ...(typeof metadata['principleId'] === 'string' ? { principleId: metadata['principleId'] } : {}),
    ...(normalizedPath !== undefined ? { normalizedPath } : {}),
  };
}

export async function evaluateThroughSharedGate(
  workspaceDir: string,
  input: RuleHostInput,
): Promise<SharedGateBlockResult | undefined> {
  const { result, normalizedPath } = await dispatch(workspaceDir, input);
  return toBlockResult(result, normalizedPath);
}

export async function evaluateDetailedThroughSharedGate(
  workspaceDir: string,
  input: RuleHostInput,
): Promise<SharedGateDetailedReport> {
  const { result, normalizedPath } = await dispatch(workspaceDir, input);
  const metadata = result.metadata ?? {};
  const evaluations = Array.isArray(metadata['evaluations']) ? metadata['evaluations'] : [];
  const faults = Array.isArray(metadata['evaluationFaults']) ? metadata['evaluationFaults'] : [];
  return {
    liveDecision: toBlockResult(result, normalizedPath),
    ...(normalizedPath !== undefined ? { normalizedPath } : {}),
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
