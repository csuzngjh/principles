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
  // Policy that deliberately excludes rollout_reviewer. Used to exercise the
  // task_kind_not_mvp_actionable suppression PATH independently of the
  // MVP_CORE_TASK_KINDS constant contents (rollout_reviewer was promoted into
  // the constant as a manual-gate kind; the suppression logic itself is
  // unchanged and must still be covered by a test).
  const rolloutExcludedPolicy: ActionabilityPolicyInput = {
    enabledChannels: new Set(['prompt', 'code_tool_hook', 'defer_archive']),
    actionableTaskKinds: new Set(['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator']),
  };

  it('classifies enabled-channel MVP-Core dreamer as actionable', () => {
    const result = classifyTaskActionability(
      { taskId: 'dreamer-abc-prompt', taskKind: 'dreamer', channel: 'prompt' },
      defaultPolicy,
    );
    expect(result.actionable).toBe(true);
  });

  // PRI-891: the per-kind actionable-true its for scribe/artificer/evaluator
  // were the same SOT-membership echo as the dreamer/philosopher cases and
  // were removed; two distinct kinds are kept so a hardcoded-kind regression
  // in the SUT would still be caught.

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

  it('suppresses a kind excluded from actionableTaskKinds with task_kind_not_mvp_actionable reason', () => {
    const result = classifyTaskActionability(
      { taskId: 'rollout-abc-prompt', taskKind: 'rollout_reviewer', channel: 'prompt' },
      rolloutExcludedPolicy,
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
      rolloutExcludedPolicy,
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
  // PRI-891: the five-kind membership echo was removed (same source of truth
  // as the policy input above). The rollout_reviewer pin stays because it
  // documents the manual-gate decision, not mere membership.
  it('includes rollout_reviewer (manual-gate kind — visible in queue, not auto-consumed)', () => {
    expect(MVP_CORE_TASK_KINDS).toContain('rollout_reviewer');
  });
});
