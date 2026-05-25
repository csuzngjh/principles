import type {
  ActivationDecision,
  CanActivateResult,
} from './activation/activation-types.js';
import type { GoldenTrace } from './golden-trace.js';
import type { PIArtifactRecord } from './internalization/pi-artifact.js';
import type { RuleHostInput, RuleHostResult } from './internalization/rule-host-contracts.js';
import type { RuleHostHelpers } from './internalization/rule-host-helpers.js';
import { evaluateInRefinerSandbox } from './internalization/refiner-sandbox-wrapper.js';
import type { RefinerSandboxResult } from './internalization/refiner-sandbox-wrapper.js';

export type MvpChannel = 'prompt' | 'code_tool_hook' | 'defer_archive';

export const STORY_A_CHANNELS: readonly MvpChannel[] = ['prompt', 'code_tool_hook', 'defer_archive'] as const;

export interface StoryADemoStage {
  name: StoryADemoStageName;
  status: 'passed' | 'failed' | 'degraded' | 'skipped';
  reason?: string;
  nextAction?: string;
  evidenceRef?: string;
  evidence?: Record<string, unknown>;
}

export type StoryADemoStageName =
  | 'evidence_seed'
  | 'principle_proposal'
  | 'owner_review'
  | 'activation'
  | 'follow_up_observation'
  | 'rollback_proof';

export interface StoryADemoChannelOutcome {
  channel: MvpChannel;
  status: 'passed' | 'failed' | 'degraded';
  activationDecision: ActivationDecision;
  canActivateResult: CanActivateResult;
  evidence: Record<string, unknown>;
  evidenceSource: string;
  principleId: string;
  failureReason?: string;
  nextAction?: string;
}

export interface StoryADemoInputValidationFailure {
  reason: string;
  message: string;
  nextAction: string;
  unknownChannels?: string[];
}

export interface StoryADemoResult {
  status: 'passed' | 'failed' | 'degraded';
  generatedAt: string;
  narrative: string;
  storyDescription: string;
  stages: StoryADemoStage[];
  channelOutcomes: StoryADemoChannelOutcome[];
  isRuntimeV2Exclusive: boolean;
  workspaceDir?: string;
  inputValidationFailure?: StoryADemoInputValidationFailure;
}

export interface StoryADemoOptions {
  channels?: MvpChannel[];
  runId?: string;
}

// ── Pure helpers (remain in core) ────────────────────────────────────────

export function makeRunId(opts: StoryADemoOptions): string {
  return opts.runId ?? `story-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makePrincipleArtifactRecord(runId: string): PIArtifactRecord {
  const principleId = `demo-principle-${runId}`;
  return {
    artifactId: `art-demo-principle-${runId}`,
    artifactKind: 'principle',
    sourceTaskId: `task-demo-${runId}`,
    sourcePrincipleId: principleId,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId,
      text: 'Demo principle: prevent writing to system-critical directories',
      painReasonSummary: 'Agent repeatedly wrote to /etc/passwd — owner-corrected behavior pattern',
      evidenceType: 'repeated_owner_correction',
      occurrenceCount: 3,
      ruleHostGateDecision: 'accepted_shadow',
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function makeRuleArtifactRecord(runId: string, principleRecord: PIArtifactRecord): PIArtifactRecord {
  const ruleId = `demo-rule-${runId}`;
  const goldenTrace: GoldenTrace = {
    traceId: `trace-demo-${runId}`,
    cases: [
      {
        caseId: `case-block-${runId}`,
        kind: 'negative',
        toolName: 'write_file',
        params: { path: '/etc/passwd', content: 'malicious' },
        expectedDecision: 'block',
      },
      {
        caseId: `case-allow-${runId}`,
        kind: 'positive',
        toolName: 'write_file',
        params: { path: '/project/src/config.json', content: '{"key":"value"}' },
        expectedDecision: 'allow',
      },
    ],
    createdAt: new Date().toISOString(),
    version: 1,
  };

  return {
    artifactId: `art-demo-rule-${runId}`,
    artifactKind: 'rule',
    sourceTaskId: `task-demo-${runId}`,
    sourceRuleId: ruleId,
    sourcePrincipleId: principleRecord.sourcePrincipleId,
    lineageArtifactIds: [principleRecord.artifactId],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: principleRecord.sourcePrincipleId,
      ruleId,
      implementationCode: 'function evaluate(toolName, params) { return params.path?.startsWith("/etc") ? "block" : "allow"; }',
      goldenTrace,
      ruleHostGateDecision: 'accepted_shadow',
      affectedTools: ['write_file'],
      painReasonSummary: 'Demo: block writes to system directories',
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function computeDemoStatus(
  stages: StoryADemoStage[],
  outcomes: StoryADemoChannelOutcome[],
): 'passed' | 'failed' | 'degraded' {
  if (stages.some(s => s.status === 'failed') || outcomes.some(o => o.status === 'failed')) {
    if (!stages.some(s => s.status === 'passed') && !outcomes.some(o => o.status === 'passed')) {
      return 'failed';
    }
    return 'degraded';
  }
  if (stages.some(s => s.status === 'degraded') || outcomes.some(o => o.status === 'degraded')) {
    return 'degraded';
  }
  return 'passed';
}

export function createDemoSandboxEvaluate(
  implementationCode: string,
): (input: RuleHostInput, _helpers: RuleHostHelpers) => RuleHostResult {
  const wrappedCode = `${implementationCode}; return evaluate(toolName, params);`;
  const rawEvaluate = new Function('toolName', 'params', wrappedCode) as
    (toolName: string, params: Record<string, unknown>) => string;

  return (input: RuleHostInput, _helpers: RuleHostHelpers): RuleHostResult => {
    const {toolName} = input.action;
    const params = input.action.paramsSummary;
    const result = rawEvaluate(toolName, params);
    if (result === 'block') {
      return { decision: 'block', matched: true, reason: 'Demo rule: blocked by sandbox evaluation' };
    }
    return { decision: 'allow', matched: true, reason: 'Demo rule: allowed by sandbox evaluation' };
  };
}

export function evaluateDemoGoldenTrace(
  ruleRecord: PIArtifactRecord,
): RefinerSandboxResult {
  const content = JSON.parse(ruleRecord.contentJson) as Record<string, unknown>;
  const implementationCode = content.implementationCode as string;
  const goldenTrace = content.goldenTrace as GoldenTrace;
  const evaluateCode = createDemoSandboxEvaluate(implementationCode);
  return evaluateInRefinerSandbox(implementationCode, goldenTrace, {
    evaluateCode,
    softTimeoutMs: 1000,
  });
}

export function buildFollowUpObservation(
  channel: MvpChannel,
  outcome: StoryADemoChannelOutcome,
  sandboxResult?: RefinerSandboxResult,
): { status: 'passed' | 'degraded'; evidence: Record<string, unknown> } {
  const isActivated = outcome.activationDecision.decision === 'activated'
    || outcome.activationDecision.decision === 'would_activate'
    || outcome.activationDecision.decision === 'already_activated';

  if (channel === 'code_tool_hook') {
    const enforcementObserved = isActivated && (sandboxResult?.success === true);
    return {
      status: enforcementObserved ? 'passed' : 'degraded',
      evidence: {
        enforcementObserved,
        dangerousPathBlocked: sandboxResult?.success === true
          ? '/etc/passwd → block (verified by sandbox)'
          : '/etc/passwd → block (unverified)',
        safePathAllowed: sandboxResult?.success === true
          ? '/project/src/config.json → allow (verified by sandbox)'
          : '/project/src/config.json → allow (unverified)',
        ruleActivated: isActivated,
        sandboxVerified: sandboxResult?.success ?? false,
        ...(sandboxResult?.failedCases.length ? { sandboxFailures: sandboxResult.failedCases.map(c => c.message) } : {}),
      },
    };
  }

  if (channel === 'prompt') {
    return {
      status: isActivated ? 'passed' : 'degraded',
      evidence: {
        principleActivated: isActivated,
        activationTarget: (outcome.activationDecision as { targetRef?: string }).targetRef ?? 'unknown',
        observableChange: 'Principle text will be included in subsequent prompt injections',
      },
    };
  }

  return {
    status: outcome.status === 'passed' ? 'passed' : 'degraded',
    evidence: {
      deferred: true,
      archived: outcome.status === 'passed',
      notActivated: outcome.activationDecision.decision !== 'refused',
      observableChange: 'Principle archived; no behavioral enforcement active',
    },
  };
}

export interface DemoNarrativeInput {
  runId: string;
  principleId: string;
  channels: MvpChannel[];
  channelOutcomes: StoryADemoChannelOutcome[];
}

export function buildDemoNarrative(input: DemoNarrativeInput): string {
  const { runId, principleId, channels, channelOutcomes } = input;
  const activationSummary = channelOutcomes.map(o =>
    `${o.channel}: ${o.activationDecision.decision}`,
  ).join(', ');

  return [
    `Story A': Owner-Governed Behavior Internalization Demo (run ${runId})`,
    ``,
    `SCENARIO: An AI agent repeatedly writes to /etc/passwd despite owner corrections.`,
    `This is not a one-off error — it is a recurring behavioral pattern.`,
    ``,
    `1. EVIDENCE [SIMULATED]: 3 occurrences of writing to /etc/passwd captured as pain signal.`,
    `2. PROPOSAL [REAL]: PD proposes principle "${principleId}" to prevent this pattern.`,
    `3. REVIEW [SIMULATED]: Owner reviews and approves the principle.`,
    `4. ACTIVATION [REAL]: ${channels.join(', ')} → ${activationSummary}`,
    `5. FOLLOW-UP [REAL]: Comparable scenario shows behavior change or enforcement.`,
    `6. ROLLBACK [SIMULATED]: Each activation has a verified disable/revert path.`,
  ].join('\n');
}

export function validateDemoChannels(channels: MvpChannel[]): StoryADemoInputValidationFailure | null {
  if (channels.length === 0) {
    return {
      reason: 'empty_channels',
      message: 'No channels specified. At least one MVP channel required.',
      nextAction: 'Provide channels: prompt, code_tool_hook, defer_archive',
    };
  }

  const unknownChannels = channels.filter(c => !STORY_A_CHANNELS.includes(c));
  if (unknownChannels.length > 0) {
    return {
      reason: 'unknown_channels',
      message: `Unknown channels: ${unknownChannels.join(', ')}. Valid: prompt, code_tool_hook, defer_archive`,
      nextAction: 'Use only valid MVP channels: prompt, code_tool_hook, defer_archive',
      unknownChannels,
    };
  }

  return null;
}
