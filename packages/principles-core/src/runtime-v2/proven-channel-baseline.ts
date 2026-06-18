import type {
  PIArtifactSnapshot,
  ActivationDecision,
  CanActivateResult,
  DispatchInput,
  ActivationArtifactReadModel,
  ActivationStateReadModel,
  ApprovalQueueStore,
  ApprovalRecord,
  ApprovalEnqueueInput,
  ApprovalStats,
  ChannelWriter,
} from './activation/activation-types.js';
import { ActivationDispatcher } from './activation/activation-dispatcher.js';
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
  evidenceSource: string;
}

export interface InputValidationFailure {
  reason: string;
  message: string;
  nextAction: string;
  unknownChannels?: string[];
}

export interface ProvenChannelBaselineSummary {
  status: 'passed' | 'failed' | 'degraded';
  generatedAt: string;
  workspaceMode: 'temp' | 'explicit_workspace';
  channels: ChannelFixtureResult[];
  inputValidationFailure?: InputValidationFailure;
  continuityMatrix: ContinuityMatrixEntry[];
  recommendedNextIssue?: string;
}

export interface ContinuityMatrixEntry {
  channel: MvpChannel;
  entryPoint: string;
  expectedObservable: string;
  testCommand: string;
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

function makeInMemoryArtifactReadModel(artifacts: Map<string, PIArtifactSnapshot>): ActivationArtifactReadModel {
  return {
    getArtifactById: async (id: string) => artifacts.get(id) ?? null,
  };
}

function makeInMemoryStateReadModel(): ActivationStateReadModel {
  return {
    getActivationStatus: async () => null,
    recordActivation: async () => { void 0; },
    listPromptActivations: async () => [],
    listCodeToolHookActivations: async () => [],
    listAllActivations: async () => [],
    deactivateActivation: async () => false,
  };
}

function makeInMemoryApprovalQueueStore(): ApprovalQueueStore {
  const records = new Map<string, ApprovalRecord>();
  let counter = 0;

  return {
    enqueue: async (input: ApprovalEnqueueInput, now: string) => {
      const approvalId = `apr_synth_${++counter}`;
      const record: ApprovalRecord = {
        approvalId,
        artifactId: input.artifactId,
        channel: input.channel,
        riskLevel: input.riskLevel,
        status: 'pending',
        confidence: input.confidence,
        requestedAt: now,
        summary: input.summary,
        triggerReason: input.triggerReason,
      };
      records.set(approvalId, record);
      return record;
    },
    getById: async (id: string) => records.get(id) ?? null,
    listPending: async () => [...records.values()].filter(r => r.status === 'pending'),
    listAll: async () => [...records.values()],
    countByStatus: async () => {
      const stats: ApprovalStats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
      for (const r of records.values()) {
        stats[r.status]++;
      }
      return stats;
    },
    approve: async (id: string, decidedBy: string, note?: string) => {
      const r = records.get(id);
      if (!r) return { ok: false, error: 'not_found' };
      if (r.status !== 'pending') return { ok: false, error: 'already_decided', status: r.status };
      r.status = 'approved';
      r.decidedAt = new Date().toISOString();
      r.decidedBy = decidedBy;
      r.decisionNote = note;
      return { ok: true, record: r };
    },
    reject: async (id: string, decidedBy: string, reason: string) => {
      const r = records.get(id);
      if (!r) return { ok: false, error: 'not_found' };
      if (r.status !== 'pending') return { ok: false, error: 'already_decided', status: r.status };
      r.status = 'rejected';
      r.decidedAt = new Date().toISOString();
      r.decidedBy = decidedBy;
      r.rejectionReason = reason;
      return { ok: true, record: r };
    },
    resetToPending: async (id: string) => {
      const r = records.get(id);
      if (!r) return { ok: false, error: 'not_found' as const };
      if (r.status !== 'approved') return { ok: false, error: 'not_approved' as const };
      r.status = 'pending'; r.decidedAt = undefined; r.decidedBy = undefined; r.decisionNote = undefined;
      return { ok: true };
    },
    edit: async (input: { approvalId: string; editedBy: string; newArtifactId: string; editReason: string; now: string }) => {
      const r = records.get(input.approvalId);
      if (!r) return { ok: false, error: 'not_found' as const };
      if (r.status !== 'pending') return { ok: false, error: 'already_decided', status: r.status };
      r.previousArtifactId = r.artifactId;
      r.artifactId = input.newArtifactId;
      r.editedAt = input.now;
      r.editedBy = input.editedBy;
      r.editReason = input.editReason;
      return { ok: true, record: r };
    },
  };
}

function makeDispatcher(
  channel: MvpChannel,
  artifact: PIArtifactSnapshot,
  gateDeps?: RefinerRuleHostGateDeps,
): ActivationDispatcher {
  const artifacts = new Map<string, PIArtifactSnapshot>();
  artifacts.set(artifact.artifactId, artifact);

  const writers: ChannelWriter[] = [];

  if (channel === 'prompt') {
    writers.push(new PromptWriter());
  } else if (channel === 'code_tool_hook') {
    const deps = gateDeps ?? makeSandboxAlwaysPass();
    writers.push(new RuleHostWriter({ gateDeps: deps }));
  } else if (channel === 'defer_archive') {
    writers.push(new DeferArchiveWriter());
  }

  return new ActivationDispatcher(
    makeInMemoryArtifactReadModel(artifacts),
    makeInMemoryStateReadModel(),
    { writers, approvalQueueStore: makeInMemoryApprovalQueueStore() },
  );
}

function makeDispatchInput(channel: MvpChannel, artifact: PIArtifactSnapshot): DispatchInput {
  return {
    artifactId: artifact.artifactId,
    channel: channel,
    rolloutDecision: channel === 'code_tool_hook' ? 'require_approval' : 'auto_activate',
    actor: { kind: 'system', source: 'rollout_reviewer' },
    idempotencyKey: `synth-240::${channel}`,
    now: '2026-05-24T00:00:00.000Z',
    confirm: true,
  };
}

export async function runPromptFixture(): Promise<ChannelFixtureResult> {
  const artifact = makePrincipleArtifact();
  const dispatcher = makeDispatcher('prompt', artifact);
  const input = makeDispatchInput('prompt', artifact);

  try {
    const decision = await dispatcher.dispatch(input);

    if (decision.decision === 'would_activate' || decision.decision === 'activated') {
      return {
        channel: 'prompt',
        status: 'passed',
        canActivateResult: { ok: true, riskLevel: 'low' },
        activationDecision: decision,
        evidence: boundedEvidence({
          activationId: decision.activationId,
          action: decision.action,
          targetRef: decision.targetRef,
          evidenceSource: 'ActivationDispatcher.dispatch',
        }),
        dependsOnLegacy: classifyLegacyDependency(decision),
        evidenceSource: 'ActivationDispatcher.dispatch → PromptWriter',
      };
    }

    if (decision.decision === 'already_activated') {
      return {
        channel: 'prompt',
        status: 'passed',
        canActivateResult: { ok: true, riskLevel: 'low' },
        activationDecision: decision,
        evidence: boundedEvidence({ activationId: decision.activationId, evidenceSource: 'ActivationDispatcher.dispatch' }),
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → PromptWriter (idempotent)',
      };
    }

    return {
      channel: 'prompt',
      status: 'failed',
      canActivateResult: { ok: false, reason: 'dispatch_refused', riskLevel: 'low' },
      activationDecision: decision,
      evidence: boundedEvidence({ decision, evidenceSource: 'ActivationDispatcher.dispatch' }),
      failureReason: truncateReason(`Prompt channel dispatch refused: ${decision.decision}`),
      nextAction: 'Check PromptWriter canActivate and artifact contract',
      dependsOnLegacy: classifyLegacyDependency(decision),
      evidenceSource: 'ActivationDispatcher.dispatch',
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
      nextAction: 'Inspect prompt fixture exception; check ActivationDispatcher and PromptWriter',
      dependsOnLegacy: false,
      evidenceSource: 'exception',
    };
  }
}

export async function runRuleHostFixture(
  gateDeps?: RefinerRuleHostGateDeps,
): Promise<ChannelFixtureResult> {
  const artifact = makeRuleArtifact();
  const dispatcher = makeDispatcher('code_tool_hook', artifact, gateDeps);
  const input = makeDispatchInput('code_tool_hook', artifact);

  try {
    const decision = await dispatcher.dispatch(input);

    if (decision.decision === 'would_activate' || decision.decision === 'activated') {
      const dependsOnLegacy = classifyLegacyDependency(decision);
      return {
        channel: 'code_tool_hook',
        status: dependsOnLegacy ? 'degraded' : 'passed',
        canActivateResult: { ok: true, riskLevel: 'high' },
        activationDecision: decision,
        evidence: boundedEvidence({
          activationId: decision.activationId,
          action: decision.action,
          targetRef: decision.targetRef,
          gateDecision: 'accepted_shadow',
          evidenceSource: 'ActivationDispatcher.dispatch',
        }),
        ...(dependsOnLegacy ? { failureReason: 'Channel depends on legacy path', nextAction: 'Mark as deletion blocker for PRI-119/PRI-230' } : {}),
        dependsOnLegacy,
        evidenceSource: 'ActivationDispatcher.dispatch → RuleHostWriter',
      };
    }

    if (decision.decision === 'queued_for_approval') {
      return {
        channel: 'code_tool_hook',
        status: 'passed',
        canActivateResult: { ok: true, riskLevel: 'high' },
        activationDecision: decision,
        evidence: boundedEvidence({
          approvalId: decision.approvalId,
          queuedAt: decision.queuedAt,
          evidenceSource: 'ActivationDispatcher.dispatch → approval queue',
          queueBehavior: 'enqueued',
        }),
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → approval queue (proven)',
      };
    }

    if (decision.decision === 'already_activated') {
      return {
        channel: 'code_tool_hook',
        status: 'passed',
        canActivateResult: { ok: true, riskLevel: 'high' },
        activationDecision: decision,
        evidence: boundedEvidence({ activationId: decision.activationId, evidenceSource: 'ActivationDispatcher.dispatch' }),
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → RuleHostWriter (idempotent)',
      };
    }

    const refusedReason = decision.decision === 'refused' ? (decision as { reason: string }).reason : decision.decision;
    return {
      channel: 'code_tool_hook',
      status: 'failed',
      canActivateResult: { ok: false, reason: refusedReason, riskLevel: 'high' },
      activationDecision: decision,
      evidence: boundedEvidence({ decision, evidenceSource: 'ActivationDispatcher.dispatch' }),
      failureReason: truncateReason(`RuleHost channel dispatch refused: ${refusedReason}`),
      nextAction: 'Check RuleHostWriter canActivate, gate deps, and rule artifact contract',
      dependsOnLegacy: classifyLegacyDependency(decision),
      evidenceSource: 'ActivationDispatcher.dispatch',
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
      nextAction: 'Inspect RuleHost fixture exception; check ActivationDispatcher and RuleHostWriter',
      dependsOnLegacy: false,
      evidenceSource: 'exception',
    };
  }
}

export async function runDeferArchiveFixture(): Promise<ChannelFixtureResult> {
  const artifact = makePrincipleArtifact();
  const dispatcher = makeDispatcher('defer_archive', artifact);
  const input = makeDispatchInput('defer_archive', artifact);

  try {
    const decision = await dispatcher.dispatch(input);

    if (decision.decision === 'would_activate' || decision.decision === 'activated') {
      return {
        channel: 'defer_archive',
        status: 'passed',
        canActivateResult: { ok: true, riskLevel: 'low' },
        activationDecision: decision,
        evidence: boundedEvidence({
          activationId: decision.activationId,
          action: decision.action,
          targetRef: decision.targetRef,
          evidenceSource: 'ActivationDispatcher.dispatch',
        }),
        dependsOnLegacy: classifyLegacyDependency(decision),
        evidenceSource: 'ActivationDispatcher.dispatch → DeferArchiveWriter',
      };
    }

    if (decision.decision === 'already_activated') {
      return {
        channel: 'defer_archive',
        status: 'passed',
        canActivateResult: { ok: true, riskLevel: 'low' },
        activationDecision: decision,
        evidence: boundedEvidence({ activationId: decision.activationId, evidenceSource: 'ActivationDispatcher.dispatch' }),
        dependsOnLegacy: false,
        evidenceSource: 'ActivationDispatcher.dispatch → DeferArchiveWriter (idempotent)',
      };
    }

    const refusedReason = decision.decision === 'refused' ? (decision as { reason: string }).reason : decision.decision;
    return {
      channel: 'defer_archive',
      status: 'failed',
      canActivateResult: { ok: false, reason: refusedReason, riskLevel: 'low' },
      activationDecision: decision,
      evidence: boundedEvidence({ decision, evidenceSource: 'ActivationDispatcher.dispatch' }),
      failureReason: truncateReason(`DeferArchive channel dispatch refused: ${refusedReason}`),
      nextAction: 'Check DeferArchiveWriter canActivate and artifact contract',
      dependsOnLegacy: classifyLegacyDependency(decision),
      evidenceSource: 'ActivationDispatcher.dispatch',
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
      nextAction: 'Inspect defer_archive fixture exception; check ActivationDispatcher and DeferArchiveWriter',
      dependsOnLegacy: false,
      evidenceSource: 'exception',
    };
  }
}

export function computeProvenChannelStatus(results: ChannelFixtureResult[]): 'passed' | 'failed' | 'degraded' {
  if (results.length === 0) return 'failed';
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
      entryPoint: 'ActivationDispatcher.dispatch → PromptWriter.canActivate → PromptWriter.activate',
      expectedObservable: 'decision=would_activate, activationId=act_prompt_{principleId}, action=prompt_activate, targetRef=ledger://{principleId}',
      testCommand: 'npx vitest run packages/principles-core/src/runtime-v2/__tests__/proven-channel-baseline.test.ts',
      dependsOnPluginDiscovery: false,
      pri119ReuseEvidence: 'ActivationDispatcher.dispatch → PromptWriter contract; activationId/action/targetRef shape',
      pri230ReuseEvidence: 'prompt channel risk level (low) and auto-activation path via dispatcher',
    },
    {
      channel: 'code_tool_hook',
      entryPoint: 'ActivationDispatcher.dispatch → RuleHostWriter.canActivate → evaluateRefinerRuleHostGate → RuleHostWriter.activate',
      expectedObservable: 'decision=would_activate|queued_for_approval, activationId=act_code_{ruleId}, action=code_tool_hook_shadow_activate, targetRef=impl://{ruleId}',
      testCommand: 'npx vitest run packages/principles-core/src/runtime-v2/__tests__/proven-channel-baseline.test.ts',
      dependsOnPluginDiscovery: false,
      pri119ReuseEvidence: 'ActivationDispatcher.dispatch → RuleHostWriter gate decision contract; goldenTrace validation path',
      pri230ReuseEvidence: 'code_tool_hook risk level (high) and approval queue path via dispatcher',
    },
    {
      channel: 'defer_archive',
      entryPoint: 'ActivationDispatcher.dispatch → DeferArchiveWriter.canActivate → DeferArchiveWriter.activate',
      expectedObservable: 'decision=would_activate, activationId=act_archive_{principleId}, action=defer_archive, targetRef=ledger://{principleId}#archived',
      testCommand: 'npx vitest run packages/principles-core/src/runtime-v2/__tests__/proven-channel-baseline.test.ts',
      dependsOnPluginDiscovery: false,
      pri119ReuseEvidence: 'ActivationDispatcher.dispatch → DeferArchiveWriter contract; activationId/action/targetRef shape',
      pri230ReuseEvidence: 'defer_archive channel risk level (low) and auto-activation path via dispatcher',
    },
  ];
}

export function recommendProvenChannelNextIssue(results: ChannelFixtureResult[]): string | undefined {
  const legacyDeps = results.filter(r => r.dependsOnLegacy);
  if (legacyDeps.length > 0) {
    const channels = legacyDeps.map(r => r.channel).join(', ');
    return `DELETION BLOCKER: channels [${channels}] depend on legacy paths. Must resolve before PRI-119/PRI-230 can proceed.`;
  }
  const degraded = results.filter(r => r.status === 'degraded');
  if (degraded.length > 0) {
    const channels = degraded.map(r => r.channel).join(', ');
    return `BLOCKER: channels [${channels}] are degraded — operator path not fully proven. Resolve before PRI-119/PRI-230.`;
  }
  const firstFailed = results.find(r => r.status === 'failed');
  if (!firstFailed) return undefined;
  switch (firstFailed.channel) {
    case 'prompt':
      return 'PRI-240: Prompt channel fixture failed — check ActivationDispatcher and PromptWriter contract';
    case 'code_tool_hook':
      return 'PRI-240: RuleHost channel fixture failed — check ActivationDispatcher, RuleHostWriter, and gate deps';
    case 'defer_archive':
      return 'PRI-240: DeferArchive channel fixture failed — check ActivationDispatcher and DeferArchiveWriter contract';
    default:
      return undefined;
  }
}

export function isMvpChannel(channel: string): channel is MvpChannel {
  return MVP_CHANNELS.includes(channel as MvpChannel);
}

export function parseChannels(raw: string): { channels: MvpChannel[]; unknowns: string[] } {
  const parts = raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
  const channels: MvpChannel[] = [];
  const unknowns: string[] = [];
  for (const part of parts) {
    if (isMvpChannel(part)) {
      channels.push(part);
    } else {
      unknowns.push(part);
    }
  }
  return { channels, unknowns };
}

export { makePrincipleArtifact, makeRuleArtifact, makeSandboxAlwaysPass, classifyLegacyDependency };
