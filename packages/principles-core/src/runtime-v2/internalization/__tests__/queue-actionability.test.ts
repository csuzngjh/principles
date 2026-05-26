import { describe, it, expect } from 'vitest';
import {
  classifyTaskActionability,
  type ActionabilityPolicyInput,
  MVP_CORE_TASK_KINDS,
  type SuppressedDiagnostic,
} from '../queue-actionability.js';

describe('classifyTaskActionability', () => {
  const defaultPolicy: ActionabilityPolicyInput = {
    enabledChannels: new Set(['prompt', 'code_tool_hook', 'defer_archive']),
    actionableTaskKinds: new Set(MVP_CORE_TASK_KINDS),
  };

  it('classifies enabled-channel MVP-Core dreamer as actionable', () => {
    const result = classifyTaskActionability(
      { taskId: 'dreamer-abc-prompt', taskKind: 'dreamer', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(true);
  });

  it('classifies enabled-channel MVP-Core scribe as actionable', () => {
    const result = classifyTaskActionability(
      { taskId: 'scribe-abc-cth', taskKind: 'scribe', channel: 'code_tool_hook' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(true);
  });

  it('classifies enabled-channel MVP-Core artificer as actionable', () => {
    const result = classifyTaskActionability(
      { taskId: 'artificer-abc-prompt', taskKind: 'artificer', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(true);
  });

  it('suppresses disabled-channel skill task with channel_disabled reason', () => {
    const result = classifyTaskActionability(
      { taskId: 'dreamer-abc-skill', taskKind: 'dreamer', channel: 'skill' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(false);
    if (result.actionable) throw new Error('expected not actionable');
    expect(result.reason).toBe('channel_disabled');
    expect(result.diagnostic.taskId).toBe('dreamer-abc-skill');
    expect(result.diagnostic.taskKind).toBe('dreamer');
    expect(result.diagnostic.channel).toBe('skill');
  });

  it('suppresses disabled-channel model_training task with channel_disabled reason', () => {
    const result = classifyTaskActionability(
      { taskId: 'dreamer-abc-mt', taskKind: 'dreamer', channel: 'model_training' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(false);
    if (result.actionable) throw new Error('expected not actionable');
    expect(result.reason).toBe('channel_disabled');
  });

  it('suppresses rollout_reviewer task with task_kind_not_mvp_actionable reason', () => {
    const result = classifyTaskActionability(
      { taskId: 'rollout-abc-prompt', taskKind: 'rollout_reviewer', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(false);
    if (result.actionable) throw new Error('expected not actionable');
    expect(result.reason).toBe('task_kind_not_mvp_actionable');
    expect(result.diagnostic.taskKind).toBe('rollout_reviewer');
    expect(result.diagnostic.channel).toBe('prompt');
  });

  it('classifies enabled-channel MVP-Core philosopher as actionable (required for dreamer→scribe chain)', () => {
    const result = classifyTaskActionability(
      { taskId: 'phil-abc-prompt', taskKind: 'philosopher', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(true);
  });

  it('suppresses evaluator task with task_kind_not_mvp_actionable reason', () => {
    const result = classifyTaskActionability(
      { taskId: 'eval-abc-prompt', taskKind: 'evaluator', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(false);
    if (result.actionable) throw new Error('expected not actionable');
    expect(result.reason).toBe('task_kind_not_mvp_actionable');
  });

  it('suppresses trainer task with task_kind_not_mvp_actionable reason', () => {
    const result = classifyTaskActionability(
      { taskId: 'trainer-abc-prompt', taskKind: 'trainer', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(false);
    if (result.actionable) throw new Error('expected not actionable');
    expect(result.reason).toBe('task_kind_not_mvp_actionable');
  });

  it('double-suppression: disabled channel AND non-MVP kind reports channel_disabled', () => {
    const result = classifyTaskActionability(
      { taskId: 'rollout-abc-skill', taskKind: 'rollout_reviewer', channel: 'skill' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(false);
    if (result.actionable) throw new Error('expected not actionable');
    expect(result.reason).toBe('channel_disabled');
  });

  it('preserves taskId, taskKind, channel, status in suppressed diagnostic', () => {
    const result = classifyTaskActionability(
      { taskId: 'rr-abc-prompt', taskKind: 'rollout_reviewer', channel: 'prompt' },
      defaultPolicy,
    );
    if (result.actionable) throw new Error('expected not actionable');
    const d: SuppressedDiagnostic = result.diagnostic;
    expect(d.taskId).toBe('rr-abc-prompt');
    expect(d.taskKind).toBe('rollout_reviewer');
    expect(d.channel).toBe('prompt');
    expect(d.reason).toBe('task_kind_not_mvp_actionable');
  });
});

describe('MVP_CORE_TASK_KINDS constant', () => {
  it('includes dreamer, philosopher, scribe, artificer', () => {
    expect(MVP_CORE_TASK_KINDS).toContain('dreamer');
    expect(MVP_CORE_TASK_KINDS).toContain('philosopher');
    expect(MVP_CORE_TASK_KINDS).toContain('scribe');
    expect(MVP_CORE_TASK_KINDS).toContain('artificer');
  });

  it('does not include post-MVP runners', () => {
    expect(MVP_CORE_TASK_KINDS).not.toContain('evaluator');
    expect(MVP_CORE_TASK_KINDS).not.toContain('rollout_reviewer');
    expect(MVP_CORE_TASK_KINDS).not.toContain('trainer');
  });
});
