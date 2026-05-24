import type {
  PIArtifactSnapshot,
  ActivationDecision,
  CanActivateResult,
  WriterInput,
} from './activation/activation-types.js';
import { PromptWriter, DeferArchiveWriter } from './activation/low-risk-writers.js';
import { RuleHostWriter } from './activation/writers/rule-host-writer.js';
import type { RefinerRuleHostGateDeps } from './internalization/refiner-rulehost-gate.js';
import type { GoldenTrace } from './golden-trace.js';
import { boundedEvidence, truncateReason, safeStringify } from './synthetic-baseline.js';

export type MvpChannel = 'prompt' | 'code_tool_hook' | 'defer_archive';

export const MVP_CHANNELS: readonly MvpChannel[] = ['prompt', 'code_tool_hook', 'defer_archive'] as const;

export interface ChannelFixtureResult {
  channel: MvpChannel;
  status: 'passed' | 'failed' | 'degraded';
  canActivateResult: CanActivateResult;
  activationDecision: ActivationDecision;
  evidence: Record<string, unknown>;
  failureReason?: string;
  nextAction?: string;
  dependsOnLegacy: boolean;
}

export interface ProvenChannelBaselineSummary {
  status: 'passed' | 'failed' | 'degraded';
  generatedAt: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  channels: ChannelFixtureResult[];
  continuityMatrix: ContinuityMatrixEntry[];
  recommendedNextIssue?: string;
}

export interface ContinuityMatrixEntry {
  channel: MvpChannel;
  entryPoint: string;
  expectedObservable: string;
  testCommand: string;
  dependsOnNocturnal: boolean;
  dependsOnIdleTrigger: boolean;
  dependsOnPluginDiscovery: boolean;
  pri119ReuseEvidence: string;
  pri230ReuseEvidence: string;
}

const SYNTH_PRINCIPLE_ID = 'synth-principle-PRI240';
const SYNTH_RULE_ID = 'synth-rule-PRI240';

function makePrincipleArtifact(): PIArtifactSnapshot {
  return {
    artifactId: 'art-synth-principle-240',
    artifactKind: 'principle',
    sourceTaskId: 'task-synth-240',
    sourcePrincipleId: SYNTH_PRINCIPLE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: SYNTH_PRINCIPLE_ID,
      text: 'Synthetic baseline principle: handle tool failures gracefully',
      ruleHostGateDecision: 'accepted_shadow',
    }),
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

function makeRuleArtifact(): PIArtifactSnapshot {
  const goldenTrace: GoldenTrace = {
    traceId: 'trace-synth-240',
    cases: [
      {
        caseId: 'case-neg-1',
        kind: 'negative',
        toolName: 'write_file',
        params: { path: '/etc/passwd', content: 'hacked' },
        expectedDecision: 'block',
      },
      {
        caseId: 'case-pos-1',
        kind: 'positive',
        toolName: 'write_file',
        params: { path: '/safe/project/file.txt', content: 'safe content' },
        expectedDecision: 'allow',
      },
    ],
    createdAt: '2026-05-24T00:00:00.000Z',
    version: 1,
  };

  return {
    artifactId: 'art-synth-rule-240',
    artifactKind: 'rule',
    sourceTaskId: 'task-synth-240',
    sourceRuleId: SYNTH_RULE_ID,
    sourcePrincipleId: SYNTH_PRINCIPLE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: SYNTH_PRINCIPLE_ID,
      ruleId: SYNTH_RULE_ID,
      implementationCode: 'function evaluate(toolName, params) { return params.path?.startsWith("/etc") ? "block" : "allow"; }',
      goldenTrace,
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['write_file'],
      painReasonSummary: 'Synthetic: prevent writing to system directories',
    }),
    createdAt: '2026-05-24T00:00:00.000Z',
    updatedAt: '2026-05-24T00:00:00.000Z',
  };
}

function makeSandboxAlwaysPass(): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: () => ({
      success: true,
      failedCases: [],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    }),
  };
}

function makeWriterInput(channel: MvpChannel): WriterInput {
  return {
    artifactId: channel === 'code_tool_hook' ? 'art-synth-rule-240' : 'art-synth-principle-240',
    channel,
    principleId: SYNTH_PRINCIPLE_ID,
    idempotencyKey: `synth-240::${channel}`,
    now: '2026-05-24T00:00:00.000Z',
  };
}

const LEGACY_KEYWORDS = ['nocturnal', 'idle_trigger', 'plugin_discovery'];

function hasLegacyKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return LEGACY_KEYWORDS.some(kw => lower.includes(kw));
}

function classifyLegacyDependency(decision: ActivationDecision, canActivateResult?: CanActivateResult): boolean {
  if (decision.decision === 'refused') {
    const reason = decision.reason ?? '';
    if (hasLegacyKeyword(reason)) {
      return true;
    }
  }
  if (canActivateResult && !canActivateResult.ok) {
    const reason = canActivateResult.reason ?? '';
    if (hasLegacyKeyword(reason)) {
      return true;
    }
  }
  return false;
}

export async function runPromptFixture(): Promise<ChannelFixtureResult> {
  const writer = new PromptWriter();
  const artifact = makePrincipleArtifact();
  const input = makeWriterInput('prompt');

  try {
    const canActivateResult = await writer.canActivate(artifact);

    if (!canActivateResult.ok) {
      return {
        channel: 'prompt',
        status: 'failed',
        canActivateResult,
        activationDecision: { decision: 'refused', reason: canActivateResult.reason ?? 'can_activate_refused', channel: 'prompt', riskLevel: canActivateResult.riskLevel },
        evidence: boundedEvidence({ canActivateResult, artifactKind: artifact.artifactKind, validationStatus: artifact.validationStatus }),
        failureReason: truncateReason(`PromptWriter.canActivate refused: ${canActivateResult.reason ?? 'unknown'}`),
        nextAction: 'Check artifact kind is "principle" and validationStatus is "validated"',
        dependsOnLegacy: false,
      };
    }

    const writerResult = await writer.activate(input, artifact);
    const activationDecision: ActivationDecision = {
      decision: 'would_activate',
      activationId: writerResult.activationId,
      action: writerResult.action,
      targetRef: writerResult.targetRef,
    };

    return {
      channel: 'prompt',
      status: 'passed',
      canActivateResult,
      activationDecision,
      evidence: boundedEvidence({
        activationId: writerResult.activationId,
        action: writerResult.action,
        targetRef: writerResult.targetRef,
        riskLevel: canActivateResult.riskLevel,
      }),
      dependsOnLegacy: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      channel: 'prompt',
      status: 'failed',
      canActivateResult: { ok: false, reason: 'exception', riskLevel: 'low' },
      activationDecision: { decision: 'refused', reason: 'prompt_fixture_exception', channel: 'prompt' },
      evidence: boundedEvidence({ error: safeStringify(msg) }),
      failureReason: truncateReason(`Prompt fixture threw: ${msg}`),
      nextAction: 'Inspect prompt fixture exception; check PromptWriter implementation',
      dependsOnLegacy: false,
    };
  }
}

export async function runRuleHostFixture(
  gateDeps?: RefinerRuleHostGateDeps,
): Promise<ChannelFixtureResult> {
  const deps = gateDeps ?? makeSandboxAlwaysPass();
  const writer = new RuleHostWriter({ gateDeps: deps });
  const artifact = makeRuleArtifact();
  const input = makeWriterInput('code_tool_hook');

  try {
    const canActivateResult = await writer.canActivate(artifact);

    if (!canActivateResult.ok) {
      return {
        channel: 'code_tool_hook',
        status: 'failed',
        canActivateResult,
        activationDecision: { decision: 'refused', reason: canActivateResult.reason ?? 'can_activate_refused', channel: 'code_tool_hook', riskLevel: canActivateResult.riskLevel },
        evidence: boundedEvidence({ canActivateResult, artifactKind: artifact.artifactKind, validationStatus: artifact.validationStatus }),
        failureReason: truncateReason(`RuleHostWriter.canActivate refused: ${canActivateResult.reason ?? 'unknown'}`),
        nextAction: 'Check artifact kind is "rule", has implementationCode, goldenTrace, and gateDecision=accepted_shadow',
        dependsOnLegacy: false,
      };
    }

    const writerResult = await writer.activate(input, artifact);
    const activationDecision: ActivationDecision = {
      decision: 'would_activate',
      activationId: writerResult.activationId,
      action: writerResult.action,
      targetRef: writerResult.targetRef,
    };

    const dependsOnLegacy = classifyLegacyDependency(activationDecision, canActivateResult);

    return {
      channel: 'code_tool_hook',
      status: dependsOnLegacy ? 'degraded' : 'passed',
      canActivateResult,
      activationDecision,
      evidence: boundedEvidence({
        activationId: writerResult.activationId,
        action: writerResult.action,
        targetRef: writerResult.targetRef,
        riskLevel: canActivateResult.riskLevel,
        gateDecision: 'accepted_shadow',
      }),
      ...(dependsOnLegacy ? { failureReason: 'Channel depends on legacy path', nextAction: 'Mark as deletion blocker for PRI-119/PRI-230' } : {}),
      dependsOnLegacy,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      channel: 'code_tool_hook',
      status: 'failed',
      canActivateResult: { ok: false, reason: 'exception', riskLevel: 'high' },
      activationDecision: { decision: 'refused', reason: 'rulehost_fixture_exception', channel: 'code_tool_hook' },
      evidence: boundedEvidence({ error: safeStringify(msg) }),
      failureReason: truncateReason(`RuleHost fixture threw: ${msg}`),
      nextAction: 'Inspect RuleHost fixture exception; check RuleHostWriter and gate deps',
      dependsOnLegacy: false,
    };
  }
}

export async function runDeferArchiveFixture(): Promise<ChannelFixtureResult> {
  const writer = new DeferArchiveWriter();
  const artifact = makePrincipleArtifact();
  const input = makeWriterInput('defer_archive');

  try {
    const canActivateResult = await writer.canActivate(artifact);

    if (!canActivateResult.ok) {
      return {
        channel: 'defer_archive',
        status: 'failed',
        canActivateResult,
        activationDecision: { decision: 'refused', reason: canActivateResult.reason ?? 'can_activate_refused', channel: 'defer_archive', riskLevel: canActivateResult.riskLevel },
        evidence: boundedEvidence({ canActivateResult, artifactKind: artifact.artifactKind, validationStatus: artifact.validationStatus }),
        failureReason: truncateReason(`DeferArchiveWriter.canActivate refused: ${canActivateResult.reason ?? 'unknown'}`),
        nextAction: 'Check artifact kind is "principle" and validationStatus is "validated"',
        dependsOnLegacy: false,
      };
    }

    const writerResult = await writer.activate(input, artifact);
    const activationDecision: ActivationDecision = {
      decision: 'would_activate',
      activationId: writerResult.activationId,
      action: writerResult.action,
      targetRef: writerResult.targetRef,
    };

    return {
      channel: 'defer_archive',
      status: 'passed',
      canActivateResult,
      activationDecision,
      evidence: boundedEvidence({
        activationId: writerResult.activationId,
        action: writerResult.action,
        targetRef: writerResult.targetRef,
        riskLevel: canActivateResult.riskLevel,
      }),
      dependsOnLegacy: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      channel: 'defer_archive',
      status: 'failed',
      canActivateResult: { ok: false, reason: 'exception', riskLevel: 'low' },
      activationDecision: { decision: 'refused', reason: 'defer_archive_fixture_exception', channel: 'defer_archive' },
      evidence: boundedEvidence({ error: safeStringify(msg) }),
      failureReason: truncateReason(`DeferArchive fixture threw: ${msg}`),
      nextAction: 'Inspect defer_archive fixture exception; check DeferArchiveWriter implementation',
      dependsOnLegacy: false,
    };
  }
}

export function computeProvenChannelStatus(results: ChannelFixtureResult[]): 'passed' | 'failed' | 'degraded' {
  const hasFailed = results.some(r => r.status === 'failed');
  const hasDegraded = results.some(r => r.status === 'degraded');
  const hasPassed = results.some(r => r.status === 'passed');
  if (hasFailed && !hasPassed) return 'failed';
  if (hasFailed || hasDegraded) return 'degraded';
  return 'passed';
}

export function generateContinuityMatrix(): ContinuityMatrixEntry[] {
  return [
    {
      channel: 'prompt',
      entryPoint: 'PromptWriter.canActivate → PromptWriter.activate',
      expectedObservable: 'activationId=act_prompt_{principleId}, action=prompt_activate, targetRef=ledger://{principleId}',
      testCommand: 'npx vitest run packages/principles-core/src/runtime-v2/__tests__/proven-channel-baseline.test.ts',
      dependsOnNocturnal: false,
      dependsOnIdleTrigger: false,
      dependsOnPluginDiscovery: false,
      pri119ReuseEvidence: 'PromptWriter.canActivate + activate contract; activationId/action/targetRef shape',
      pri230ReuseEvidence: 'prompt channel risk level (low) and auto-activation path',
    },
    {
      channel: 'code_tool_hook',
      entryPoint: 'RuleHostWriter.canActivate → evaluateRefinerRuleHostGate → RuleHostWriter.activate',
      expectedObservable: 'activationId=act_code_{ruleId}, action=code_tool_hook_shadow_activate, targetRef=impl://{ruleId}',
      testCommand: 'npx vitest run packages/principles-core/src/runtime-v2/__tests__/proven-channel-baseline.test.ts',
      dependsOnNocturnal: false,
      dependsOnIdleTrigger: false,
      dependsOnPluginDiscovery: false,
      pri119ReuseEvidence: 'RuleHostWriter.canActivate gate decision contract; goldenTrace validation path',
      pri230ReuseEvidence: 'code_tool_hook risk level (high) and approval queue path',
    },
    {
      channel: 'defer_archive',
      entryPoint: 'DeferArchiveWriter.canActivate → DeferArchiveWriter.activate',
      expectedObservable: 'activationId=act_archive_{principleId}, action=defer_archive, targetRef=ledger://{principleId}#archived',
      testCommand: 'npx vitest run packages/principles-core/src/runtime-v2/__tests__/proven-channel-baseline.test.ts',
      dependsOnNocturnal: false,
      dependsOnIdleTrigger: false,
      dependsOnPluginDiscovery: false,
      pri119ReuseEvidence: 'DeferArchiveWriter.canActivate + activate contract; activationId/action/targetRef shape',
      pri230ReuseEvidence: 'defer_archive channel risk level (low) and auto-activation path',
    },
  ];
}

export function recommendProvenChannelNextIssue(results: ChannelFixtureResult[]): string | undefined {
  const legacyDeps = results.filter(r => r.dependsOnLegacy);
  if (legacyDeps.length > 0) {
    const channels = legacyDeps.map(r => r.channel).join(', ');
    return `DELETION BLOCKER: channels [${channels}] depend on legacy paths. Must resolve before PRI-119/PRI-230 can proceed.`;
  }
  const firstFailed = results.find(r => r.status === 'failed');
  if (!firstFailed) return undefined;
  switch (firstFailed.channel) {
    case 'prompt':
      return 'PRI-240: Prompt channel fixture failed — check PromptWriter and principle artifact contract';
    case 'code_tool_hook':
      return 'PRI-240: RuleHost channel fixture failed — check RuleHostWriter, gate deps, and rule artifact contract';
    case 'defer_archive':
      return 'PRI-240: DeferArchive channel fixture failed — check DeferArchiveWriter and principle artifact contract';
    default:
      return undefined;
  }
}

export function isMvpChannel(channel: string): channel is MvpChannel {
  return MVP_CHANNELS.includes(channel as MvpChannel);
}

export { makePrincipleArtifact, makeRuleArtifact, makeSandboxAlwaysPass, makeWriterInput, classifyLegacyDependency };
