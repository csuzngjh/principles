import { describe, it, expect } from 'vitest';
import {
  STORY_A_CHANNELS,
  makeRunId,
  makePrincipleArtifactRecord,
  makeRuleArtifactRecord,
  computeDemoStatus,
  buildFollowUpObservation,
  buildDemoNarrative,
  validateDemoChannels,
} from '../story-a-demo.js';
import type {
  StoryADemoStage,
  StoryADemoChannelOutcome,
} from '../story-a-demo.js';

const FORBIDDEN_TERMS = [
  'skill', 'model_training', 'Nocturnal', 'nocturnal',
  'idle', 'night', 'Trainer', 'trainer',
  'sleep_reflection', 'sleep-cycle', 'Phase 1C', 'Phase 1D',
  'Attribution', 'PRRR', 'BALM', 'LRAS', 'GAP',
  'MissionScheduler', 'WorkspaceLearningSummary', 'Probation',
] as const;

function hasForbiddenTerm(text: string): string | undefined {
  for (const term of FORBIDDEN_TERMS) {
    if (text.includes(term)) return term;
  }
  return undefined;
}

function makeOutcome(overrides: Partial<StoryADemoChannelOutcome> = {}): StoryADemoChannelOutcome {
  return {
    channel: 'prompt',
    status: 'passed',
    activationDecision: { decision: 'activated', activationId: 'act-test', action: 'activate', targetRef: 'test' },
    canActivateResult: { ok: true, riskLevel: 'low' },
    evidence: {},
    evidenceSource: 'test',
    principleId: 'test-principle',
    ...overrides,
  };
}

describe('Story A\' pure helpers', () => {
  it('STORY_A_CHANNELS contains exactly 3 MVP channels', () => {
    expect(STORY_A_CHANNELS).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });

  it('makeRunId uses provided runId', () => {
    expect(makeRunId({ runId: 'custom-42' })).toBe('custom-42');
  });

  it('makeRunId generates unique IDs when no runId provided', () => {
    const a = makeRunId({});
    const b = makeRunId({});
    expect(a).not.toBe(b);
    expect(a).toContain('story-a-');
  });

  it('makePrincipleArtifactRecord produces valid principle artifact', () => {
    const record = makePrincipleArtifactRecord('test-run');
    expect(record.artifactKind).toBe('principle');
    expect(record.validationStatus).toBe('validated');
    expect(record.sourcePrincipleId).toBe('demo-principle-test-run');
    expect(record.artifactId).toBe('art-demo-principle-test-run');
    const content = JSON.parse(record.contentJson) as Record<string, unknown>;
    expect(content.principleId).toBe('demo-principle-test-run');
    expect(content.text).toContain('system-critical');
  });

  it('makeRuleArtifactRecord produces valid rule artifact with GoldenTrace', () => {
    const principle = makePrincipleArtifactRecord('test-run');
    const rule = makeRuleArtifactRecord('test-run', principle);
    expect(rule.artifactKind).toBe('rule');
    expect(rule.sourceRuleId).toBe('demo-rule-test-run');
    expect(rule.sourcePrincipleId).toBe(principle.sourcePrincipleId);
    expect(rule.lineageArtifactIds).toContain(principle.artifactId);
    const content = JSON.parse(rule.contentJson) as Record<string, unknown>;
    expect(content.implementationCode).toBeTruthy();
    const trace = content.goldenTrace as { cases: unknown[] };
    expect(trace.cases).toHaveLength(2);
  });

  it('two different runIds produce different artifact IDs', () => {
    const a = makePrincipleArtifactRecord('run-a');
    const b = makePrincipleArtifactRecord('run-b');
    expect(a.artifactId).not.toBe(b.artifactId);
  });

  it('validates empty channel list', () => {
    const result = validateDemoChannels([]);
    expect(result).not.toBeNull();
    expect((result as { reason: string }).reason).toBe('empty_channels');
  });

  it('validates unknown channels', () => {
    const result = validateDemoChannels(['invalid'] as unknown as ('prompt' | 'code_tool_hook' | 'defer_archive')[]);
    expect(result).not.toBeNull();
    const r = result as { reason: string; unknownChannels: string[] };
    expect(r.reason).toBe('unknown_channels');
    expect(r.unknownChannels).toContain('invalid');
  });

  it('returns null for valid channels', () => {
    expect(validateDemoChannels(['prompt'])).toBeNull();
    expect(validateDemoChannels(['prompt', 'code_tool_hook', 'defer_archive'])).toBeNull();
  });

  it('computeDemoStatus returns passed when all pass', () => {
    const stages: StoryADemoStage[] = [{ name: 'evidence_seed', status: 'passed' }];
    const outcomes = [makeOutcome({ status: 'passed' })];
    expect(computeDemoStatus(stages, outcomes)).toBe('passed');
  });

  it('computeDemoStatus returns degraded when outcomes degraded', () => {
    const stages: StoryADemoStage[] = [{ name: 'evidence_seed', status: 'passed' }];
    const outcomes = [makeOutcome({ status: 'degraded' })];
    expect(computeDemoStatus(stages, outcomes)).toBe('degraded');
  });

  it('computeDemoStatus returns degraded when mixed pass/fail', () => {
    const stages: StoryADemoStage[] = [{ name: 'evidence_seed', status: 'passed' }];
    const outcomes = [makeOutcome({ status: 'passed' }), makeOutcome({ status: 'failed', channel: 'code_tool_hook' })];
    expect(computeDemoStatus(stages, outcomes)).toBe('degraded');
  });

  it('computeDemoStatus returns failed when everything fails', () => {
    const stages: StoryADemoStage[] = [{ name: 'evidence_seed', status: 'failed' }];
    const outcomes: StoryADemoChannelOutcome[] = [];
    expect(computeDemoStatus(stages, outcomes)).toBe('failed');
  });

  it('code_tool_hook activated shows enforcement observed', () => {
    const outcome = makeOutcome({
      channel: 'code_tool_hook',
      status: 'passed',
      activationDecision: { decision: 'activated', activationId: 'act-1', action: 'hook', targetRef: 'ref' },
    });
    const obs = buildFollowUpObservation('code_tool_hook', outcome);
    expect(obs.status).toBe('passed');
    const {evidence} = obs;
    expect(evidence.enforcementObserved).toBe(true);
    expect(evidence.ruleActivated).toBe(true);
  });

  it('code_tool_hook queued_for_approval shows NOT enforcement observed and degraded', () => {
    const outcome = makeOutcome({
      channel: 'code_tool_hook',
      status: 'passed',
      activationDecision: { decision: 'queued_for_approval', approvalId: 'apr-1', queuedAt: 'now', channel: 'code_tool_hook', riskLevel: 'high' },
    });
    const obs = buildFollowUpObservation('code_tool_hook', outcome);
    expect(obs.status).toBe('degraded');
    const {evidence} = obs;
    expect(evidence.enforcementObserved).toBe(false);
    expect(evidence.ruleActivated).toBe(false);
  });

  it('prompt activated shows principle activated', () => {
    const outcome = makeOutcome({
      channel: 'prompt',
      status: 'passed',
      activationDecision: { decision: 'activated', activationId: 'act-1', action: 'inject', targetRef: 'prompt' },
    });
    const obs = buildFollowUpObservation('prompt', outcome);
    expect(obs.status).toBe('passed');
    expect((obs.evidence).principleActivated).toBe(true);
  });

  it('defer_archive shows archived', () => {
    const outcome = makeOutcome({
      channel: 'defer_archive',
      status: 'passed',
      activationDecision: { decision: 'would_activate', activationId: 'act-1', action: 'archive', targetRef: 'archive' },
    });
    const obs = buildFollowUpObservation('defer_archive', outcome);
    expect(obs.status).toBe('passed');
    expect((obs.evidence).deferred).toBe(true);
  });

  it('buildDemoNarrative includes run ID and activation info', () => {
    const narrative = buildDemoNarrative({
      runId: 'run-42',
      principleId: 'principle-42',
      channels: ['prompt'],
      channelOutcomes: [
        makeOutcome({ channel: 'prompt', activationDecision: { decision: 'activated', activationId: 'act-1', action: 'inject', targetRef: 'prompt' } }),
      ],
    });
    expect(narrative).toContain('run-42');
    expect(narrative).toContain('principle-42');
    expect(narrative).toContain('activated');
  });

  it('artifact content contains no forbidden terms', () => {
    const principle = makePrincipleArtifactRecord('test');
    const rule = makeRuleArtifactRecord('test', principle);
    const combined = JSON.stringify({ principle, rule });
    const forbidden = hasForbiddenTerm(combined);
    expect(forbidden, `Artifact content contains forbidden term: "${forbidden}"`).toBeUndefined();
  });
});
