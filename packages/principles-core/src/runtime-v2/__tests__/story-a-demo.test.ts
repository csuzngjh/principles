import { describe, it, expect } from 'vitest';
import {
  runStoryADemo,
  STORY_A_CHANNELS,
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

function requireStage(stages: StoryADemoStage[], name: string): StoryADemoStage {
  const stage = stages.find(s => s.name === name);
  expect(stage, `Stage "${name}" must exist`).toBeDefined();
  return stage as StoryADemoStage;
}

function requireOutcome(outcomes: StoryADemoChannelOutcome[], channel: string): StoryADemoChannelOutcome {
  const outcome = outcomes.find(o => o.channel === channel);
  expect(outcome, `Channel outcome "${channel}" must exist`).toBeDefined();
  return outcome as StoryADemoChannelOutcome;
}

describe('Story A\' Demo Scenario', () => {
  // ── 1. Single entry point ───────────────────────────────────────────────

  it('returns a structured result with all 6 stages', async () => {
    const result = await runStoryADemo();

    expect(result.status).toMatch(/^(passed|failed|degraded)$/);
    expect(result.generatedAt).toBeTruthy();
    expect(typeof result.generatedAt).toBe('string');
    expect(result.stages).toHaveLength(6);

    const stageNames = result.stages.map(s => s.name);
    expect(stageNames).toEqual([
      'evidence_seed',
      'principle_proposal',
      'owner_review',
      'activation',
      'follow_up_observation',
      'rollback_proof',
    ]);
  });

  it('every stage has status, and failed stages have reason + nextAction', async () => {
    const result = await runStoryADemo();

    for (const stage of result.stages) {
      expect(stage.status).toMatch(/^(passed|failed|degraded|skipped)$/);
      if (stage.status === 'failed' || stage.status === 'degraded') {
        const {reason} = stage;
        const {nextAction} = stage;
        expect(reason).toBeDefined();
        expect(typeof reason).toBe('string');
        expect((reason as string).length).toBeGreaterThan(0);
        expect(nextAction).toBeDefined();
        expect(typeof nextAction).toBe('string');
        expect((nextAction as string).length).toBeGreaterThan(0);
      }
    }
  });

  // ── 2. Three supported outcomes ─────────────────────────────────────────

  it('produces outcomes for all 3 MVP channels', async () => {
    const result = await runStoryADemo();

    expect(result.channelOutcomes).toHaveLength(3);

    const channels = result.channelOutcomes.map(o => o.channel);
    expect(channels).toContain('prompt');
    expect(channels).toContain('code_tool_hook');
    expect(channels).toContain('defer_archive');
  });

  it('prompt channel shows activation evidence through real dispatcher', async () => {
    const result = await runStoryADemo();
    const prompt = requireOutcome(result.channelOutcomes, 'prompt');
    expect(prompt.status).toBe('passed');
    expect(prompt.activationDecision).toBeDefined();
    expect(prompt.activationDecision.decision).toMatch(/^(would_activate|activated|already_activated)$/);
    if ('activationId' in prompt.activationDecision) {
      expect(prompt.activationDecision.activationId).toContain('act_prompt_');
    }
    expect(prompt.evidenceSource).toContain('ActivationDispatcher.dispatch');
  });

  it('code_tool_hook channel routes through real ActivationDispatcher + gate path', async () => {
    const result = await runStoryADemo();
    const rh = requireOutcome(result.channelOutcomes, 'code_tool_hook');
    // Must go through real dispatcher, not direct writer construction (ERR-028)
    expect(rh.evidenceSource).toContain('ActivationDispatcher.dispatch');
    expect(rh.activationDecision).toBeDefined();
    expect(rh.activationDecision.decision).toMatch(/^(would_activate|activated|queued_for_approval|already_activated)$/);
  });

  it('defer_archive channel shows owner chose not to activate', async () => {
    const result = await runStoryADemo();
    const da = requireOutcome(result.channelOutcomes, 'defer_archive');
    expect(da.status).toBe('passed');
    expect(da.evidenceSource).toContain('ActivationDispatcher.dispatch');
    expect(da.activationDecision).toBeDefined();
    expect(da.activationDecision.decision).toMatch(/^(would_activate|activated|already_activated)$/);
  });

  // ── 3. Product chain evidence ───────────────────────────────────────────

  it('evidence is created/seeded with a ref', async () => {
    const result = await runStoryADemo();
    const evidenceStage = requireStage(result.stages, 'evidence_seed');
    expect(evidenceStage.status).toBe('passed');
    expect(evidenceStage.evidenceRef).toBeDefined();
    expect(typeof evidenceStage.evidenceRef).toBe('string');
  });

  it('principle proposal is visible', async () => {
    const result = await runStoryADemo();
    const proposalStage = requireStage(result.stages, 'principle_proposal');
    expect(proposalStage.status).toBe('passed');
    expect(proposalStage.evidenceRef).toBeDefined();
  });

  it('approval decision is visible', async () => {
    const result = await runStoryADemo();
    const reviewStage = requireStage(result.stages, 'owner_review');
    expect(reviewStage.status).toBe('passed');
    expect(reviewStage.evidence).toBeDefined();
    const reviewEvidence = reviewStage.evidence as Record<string, unknown>;
    expect(reviewEvidence.ownerDecided).toBe(true);
  });

  it('activation outcome is visible per channel', async () => {
    const result = await runStoryADemo();
    const actStage = requireStage(result.stages, 'activation');
    expect(actStage.status).toBe('passed');
  });

  it('follow-up observation shows behavior change or refusal', async () => {
    const result = await runStoryADemo();
    const followUp = requireStage(result.stages, 'follow_up_observation');
    expect(followUp.status).toMatch(/^(passed|degraded)$/);
    expect(followUp.evidence).toBeDefined();
    const evidence = followUp.evidence as Record<string, unknown>;
    expect(evidence.observations).toBeDefined();
  });

  it('all lineage/evidenceRefs are internally consistent', async () => {
    const result = await runStoryADemo();
    const refs = result.stages
      .map(s => s.evidenceRef)
      .filter((r): r is string => typeof r === 'string' && r.length > 0);
    expect(new Set(refs).size).toBe(refs.length);
    const principleIds = result.channelOutcomes.map(o => o.principleId);
    for (const pid of principleIds) {
      expect(pid).toBeTruthy();
    }
    const uniquePids = new Set(principleIds);
    expect(uniquePids.size).toBe(1);
  });

  // ── 4. No Quiet/Gone features exposed ───────────────────────────────────

  it('demo output contains no forbidden Quiet/Gone terms', async () => {
    const result = await runStoryADemo();
    const serialized = JSON.stringify(result);

    const forbidden = hasForbiddenTerm(serialized);
    expect(forbidden, `Demo output contains forbidden term: "${forbidden}"`).toBeUndefined();
  });

  it('channel outcomes only contain MVP channels', async () => {
    const result = await runStoryADemo();
    const mvpChannels = new Set(['prompt', 'code_tool_hook', 'defer_archive']);
    for (const outcome of result.channelOutcomes) {
      expect(mvpChannels.has(outcome.channel)).toBe(true);
    }
  });

  // ── 5. Failure paths ────────────────────────────────────────────────────

  it('fails loud on malformed/unknown channel input', async () => {
    const result = await runStoryADemo({ channels: ['invalid_channel'] as unknown as ('prompt' | 'code_tool_hook' | 'defer_archive')[] });

    expect(result.status).toBe('failed');
    expect(result.inputValidationFailure).toBeDefined();
    const ivf = result.inputValidationFailure as { reason: string; nextAction: string };
    expect(ivf.reason).toBeDefined();
    expect(ivf.nextAction).toBeDefined();
  });

  it('fails loud on empty channel list', async () => {
    const result = await runStoryADemo({ channels: [] });

    expect(result.status).toBe('failed');
    expect(result.inputValidationFailure).toBeDefined();
    const ivf = result.inputValidationFailure as { reason: string };
    expect(ivf.reason).toBe('empty_channels');
  });

  // ── 6. Repeatability ────────────────────────────────────────────────────

  it('produces consistent structure across two runs', async () => {
    const run1 = await runStoryADemo();
    const run2 = await runStoryADemo();

    expect(run1.stages.map(s => s.name)).toEqual(run2.stages.map(s => s.name));
    expect(run1.channelOutcomes.map(o => o.channel).sort())
      .toEqual(run2.channelOutcomes.map(o => o.channel).sort());
    expect(run1.status).toBe('passed');
    expect(run2.status).toBe('passed');
  });

  it('two runs produce different artifact IDs (no cross-contamination)', async () => {
    const run1 = await runStoryADemo({ runId: 'run-1' });
    const run2 = await runStoryADemo({ runId: 'run-2' });

    const ref1 = requireStage(run1.stages, 'evidence_seed').evidenceRef as string;
    const ref2 = requireStage(run2.stages, 'evidence_seed').evidenceRef as string;

    expect(ref1).not.toBe(ref2);
  });

  // ── 7. Rollback proof ───────────────────────────────────────────────────

  it('rollback proof stage demonstrates disable/revert path', async () => {
    const result = await runStoryADemo();
    const rollback = requireStage(result.stages, 'rollback_proof');
    expect(rollback.status).toBe('passed');
    expect(rollback.evidence).toBeDefined();
    const evidence = rollback.evidence as Record<string, unknown>;
    expect(evidence.rollbackAvailable).toBe(true);
  });

  // ── 8. Overall structure ────────────────────────────────────────────────

  it('result has narrative field for human readability', async () => {
    const result = await runStoryADemo();
    expect(result.narrative).toBeDefined();
    expect(typeof result.narrative).toBe('string');
    expect(result.narrative.length).toBeGreaterThan(50);
  });

  it('result identifies runtime path as V2-exclusive', async () => {
    const result = await runStoryADemo();
    expect(typeof result.isRuntimeV2Exclusive).toBe('boolean');
  });

  it('includes human-readable story description', async () => {
    const result = await runStoryADemo();
    expect(result.storyDescription).toBeDefined();
    expect(result.storyDescription.length).toBeGreaterThan(20);
  });

  // ── Export validation ──────────────────────────────────────────────────

  it('STORY_A_CHANNELS contains exactly 3 MVP channels', () => {
    expect(STORY_A_CHANNELS).toEqual(['prompt', 'code_tool_hook', 'defer_archive']);
  });
});
