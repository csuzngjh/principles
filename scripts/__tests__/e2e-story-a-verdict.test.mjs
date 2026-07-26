import { describe, expect, it } from 'vitest';
import { computeStoryAVerdict, exitCodeForStoryAVerdict } from '../e2e-story-a-verdict.mjs';

function validInput() {
  return {
    phase0Ok: true, phase1Ok: true, agentResponded: true,
    painCount: 1, painSource: 'user_correction',
    hasOwnerMessage: true, hasAgentTurn: true,
    tasks: [{ taskId: 'task-1', provenance: 'openclaw_context_bound', hasOwnerMessage: true, hasAgentTurn: true, hasToolCallFailure: false }],
    candidates: [{ taskId: 'task-1', candidateId: 'candidate-1', isAgentBehavior: true }],
    integrityStatus: 'healthy', canaryStatus: 'healthy',
  };
}

describe('Story A strict verdict', () => {
  it('passes only a linked, context-bound owner correction chain', () => {
    const result = computeStoryAVerdict(validInput());
    expect(result.verdict).toBe('story_a_validated');
    expect(exitCodeForStoryAVerdict(result.verdict)).toBe(0);
  });

  it.each([
    [{ phase1Ok: false }, 'failed:phase1:environment_unavailable'],
    [{ hasOwnerMessage: false, tasks: [{ taskId: 'task-1', provenance: 'openclaw_context_bound', hasOwnerMessage: false, hasAgentTurn: true }] }, 'failed:phase4:missing_owner_message'],
    [{ hasAgentTurn: false, tasks: [{ taskId: 'task-1', provenance: 'openclaw_context_bound', hasOwnerMessage: true, hasAgentTurn: false }] }, 'failed:phase4:missing_agent_turn'],
  ])('rejects incomplete evidence %j', (override, expected) => {
    const result = computeStoryAVerdict({ ...validInput(), ...override });
    expect(result.verdict).toBe(expected);
    expect(exitCodeForStoryAVerdict(result.verdict)).toBe(1);
  });

  it('rejects a stale candidate from another task', () => {
    const result = computeStoryAVerdict({
      ...validInput(), candidates: [{ taskId: 'stale-task', candidateId: 'candidate-1', isAgentBehavior: true }],
    });
    expect(result.verdict).toBe('failed:phase5:no_linked_candidates');
  });

  it('fails phase0 when workspace check fails', () => {
    const result = computeStoryAVerdict({ ...validInput(), phase0Ok: false });
    expect(result.verdict).toBe('failed:phase0:workspace_error');
    expect(exitCodeForStoryAVerdict(result.verdict)).toBe(1);
  });

  it('fails phase0 with custom error reason', () => {
    const result = computeStoryAVerdict({ ...validInput(), phase0Ok: false, phase0Error: 'config_missing' });
    expect(result.verdict).toBe('failed:phase0:config_missing');
  });

  it('fails phase3 when agent did not respond', () => {
    const result = computeStoryAVerdict({ ...validInput(), agentResponded: false });
    expect(result.verdict).toBe('failed:phase3:agent_no_response');
  });

  it('fails phase4 when no pain was emitted', () => {
    const result = computeStoryAVerdict({ ...validInput(), painCount: 0 });
    expect(result.verdict).toBe('failed:phase4:no_pain_emitted');
  });

  it.each([
    ['unknown', 'failed:phase4:unknown_pain_source:unknown'],
    [null, 'failed:phase4:unknown_pain_source:null'],
    [undefined, 'failed:phase4:unknown_pain_source:null'],
  ])('fails phase4 when painSource is %s', (painSource, expected) => {
    const result = computeStoryAVerdict({ ...validInput(), painSource });
    expect(result.verdict).toBe(expected);
  });

  it('fails phase5 when no context-bound tasks exist', () => {
    const result = computeStoryAVerdict({
      ...validInput(),
      tasks: [{ taskId: 'task-1', provenance: 'manual' }],
    });
    expect(result.verdict).toBe('failed:phase5:no_context_bound_tasks');
  });

  it('fails phase5 when candidates exist but none link to the task', () => {
    const result = computeStoryAVerdict({
      ...validInput(),
      candidates: [{ taskId: 'unlinked', candidateId: 'c1', isAgentBehavior: true }],
    });
    expect(result.verdict).toBe('failed:phase5:no_linked_candidates');
  });

  it('fails phase5 when linked candidates have no agent_behavior', () => {
    const result = computeStoryAVerdict({
      ...validInput(),
      candidates: [{ taskId: 'task-1', candidateId: 'c1', isAgentBehavior: false }],
    });
    expect(result.verdict).toBe('failed:phase5:no_linked_agent_behavior_candidate');
  });

  it('fails phase5 on integrity error', () => {
    const result = computeStoryAVerdict({ ...validInput(), integrityStatus: 'error' });
    expect(result.verdict).toBe('failed:phase5:integrity_error');
  });

  it('fails phase5 on canary error', () => {
    const result = computeStoryAVerdict({ ...validInput(), canaryStatus: 'error' });
    expect(result.verdict).toBe('failed:phase5:canary_error');
  });

  it('attaches validation notes on success', () => {
    const result = computeStoryAVerdict(validInput());
    expect(result.notes.some(n => n.includes('provenance=openclaw_context_bound'))).toBe(true);
  });

  // PRI-518: tool_failure scenarios (trap-03) produce tool_call_failure
  // evidence + automatic_hook provenance, NOT owner_message + openclaw_context_bound.
  // The verdict must accept the legitimate evidence anchor for each scenario
  // type rather than requiring owner_message for every scenario (a category
  // error that blocked tool-failure runs even when candidates were produced).
  describe('tool_failure scenario evidence anchor (PRI-518)', () => {
    function toolFailureInput() {
      return {
        phase0Ok: true, phase1Ok: true, agentResponded: true,
        painCount: 1, painSource: 'tool_failure',
        hasOwnerMessage: false, hasAgentTurn: false, hasToolCallFailure: true,
        tasks: [{ taskId: 'task-1', provenance: 'automatic_hook', hasOwnerMessage: false, hasAgentTurn: false, hasToolCallFailure: true }],
        candidates: [{ taskId: 'task-1', candidateId: 'candidate-1', isAgentBehavior: true }],
        integrityStatus: 'healthy', canaryStatus: 'healthy',
      };
    }

    it('passes a tool-failure chain with tool_call_failure evidence + automatic_hook provenance', () => {
      const result = computeStoryAVerdict(toolFailureInput());
      expect(result.verdict).toBe('story_a_validated');
      expect(exitCodeForStoryAVerdict(result.verdict)).toBe(0);
    });

    it('fails phase4 when tool-failure scenario has NO tool_call_failure evidence', () => {
      const result = computeStoryAVerdict({
        ...toolFailureInput(),
        hasToolCallFailure: false,
        tasks: [{ taskId: 'task-1', provenance: 'automatic_hook', hasToolCallFailure: false }],
      });
      expect(result.verdict).toBe('failed:phase4:missing_tool_call_failure_evidence');
      expect(exitCodeForStoryAVerdict(result.verdict)).toBe(1);
    });

    it('tool-failure scenario does NOT require agent_turn (diagnosis runs before assistant_turn exists)', () => {
      const result = computeStoryAVerdict({ ...toolFailureInput() });
      expect(result.verdict).toBe('story_a_validated');
    });

    it('user_correction scenario still requires agent_turn (unchanged)', () => {
      const result = computeStoryAVerdict({
        ...validInput(),
        hasAgentTurn: false,
        tasks: [{ taskId: 'task-1', provenance: 'openclaw_context_bound', hasOwnerMessage: true, hasAgentTurn: false }],
      });
      expect(result.verdict).toBe('failed:phase4:missing_agent_turn');
    });

    it('tool-failure scenario accepts openclaw_context_bound provenance too (both valid)', () => {
      const result = computeStoryAVerdict({
        ...toolFailureInput(),
        tasks: [{ taskId: 'task-1', provenance: 'openclaw_context_bound', hasToolCallFailure: true }],
      });
      expect(result.verdict).toBe('story_a_validated');
    });

    it('user_correction scenario is unchanged — still requires owner_message', () => {
      const result = computeStoryAVerdict({
        ...validInput(),
        hasOwnerMessage: false,
        tasks: [{ taskId: 'task-1', provenance: 'openclaw_context_bound', hasOwnerMessage: false, hasAgentTurn: true }],
      });
      expect(result.verdict).toBe('failed:phase4:missing_owner_message');
    });

    it('REGRESSION: evidence on task A + valid provenance on task B must NOT splice (CodeRabbit)', () => {
      // Task A has tool_call_failure evidence but wrong provenance (manual).
      // Task B has correct provenance (automatic_hook) but NO tool_call_failure.
      // Old global-flag code would pass (hasToolCallFailure=true globally,
      // contextBoundTasks includes B). Per-task binding must reject this.
      const result = computeStoryAVerdict({
        ...toolFailureInput(),
        tasks: [
          { taskId: 'task-A', provenance: 'manual', hasToolCallFailure: true },
          { taskId: 'task-B', provenance: 'automatic_hook', hasToolCallFailure: false },
        ],
        candidates: [{ taskId: 'task-B', candidateId: 'c1', isAgentBehavior: true }],
      });
      expect(result.verdict).toBe('failed:phase4:missing_tool_call_failure_evidence');
    });
  });
});
