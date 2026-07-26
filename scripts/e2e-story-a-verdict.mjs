export function computeStoryAVerdict(input) {
  const notes = [];
  if (!input.phase0Ok) return { verdict: `failed:phase0:${input.phase0Error ?? 'workspace_error'}`, notes };
  if (!input.phase1Ok) return { verdict: `failed:phase1:${input.phase1Error ?? 'environment_unavailable'}`, notes };
  if (!input.agentResponded) return { verdict: 'failed:phase3:agent_no_response', notes };
  if (input.painCount === 0) return { verdict: 'failed:phase4:no_pain_emitted', notes };
  if (!input.painSource || input.painSource === 'unknown') {
    return { verdict: `failed:phase4:unknown_pain_source:${input.painSource ?? 'null'}`, notes };
  }

  // Evidence-anchor check is scenario-dependent (PRI-518):
  //   - user_correction / user_empathy pain → evidence MUST include an
  //     owner_message:* entry (the owner's correction text is the anchor).
  //   - tool_failure pain → the legitimate evidence anchor is a
  //     tool_call_failure:* entry (the agent's failed tool call that
  //     triggered the pain). Requiring owner_message for a tool-failure
  //     scenario was a category error — those scenarios have no owner
  //     correction by design. Both anchor types are real pain sources that
  //     justify diagnosis; neither is a weakening of the gate.
  const isToolFailureScenario = input.painSource === 'tool_failure';
  const hasValidEvidenceAnchor = isToolFailureScenario
    ? (input.hasToolCallFailure === true)
    : (input.hasOwnerMessage === true);
  if (!hasValidEvidenceAnchor) {
    return {
      verdict: isToolFailureScenario ? 'failed:phase4:missing_tool_call_failure_evidence' : 'failed:phase4:missing_owner_message',
      notes,
    };
  }
  if (!input.hasAgentTurn) return { verdict: 'failed:phase4:missing_agent_turn', notes };

  // Context-bound task check is also scenario-dependent: a tool_failure pain
  // is produced by the after_tool_call hook, so its provenance is
  // 'automatic_hook' (correctly — it WAS detected automatically). That is a
  // valid context anchor for tool-failure scenarios. user_correction pain
  // arrives via an OpenClaw host session, so its provenance is
  // 'openclaw_context_bound'.
  const validProvenances = isToolFailureScenario
    ? ['openclaw_context_bound', 'automatic_hook']
    : ['openclaw_context_bound'];
  const contextBoundTasks = input.tasks.filter(task => validProvenances.includes(task.provenance));
  if (contextBoundTasks.length === 0) return { verdict: 'failed:phase5:no_context_bound_tasks', notes };
  const taskIds = new Set(contextBoundTasks.map(task => task.taskId));
  const linkedCandidates = input.candidates.filter(candidate => taskIds.has(candidate.taskId));
  if (linkedCandidates.length === 0) return { verdict: 'failed:phase5:no_linked_candidates', notes };
  if (!linkedCandidates.some(candidate => candidate.isAgentBehavior)) {
    return { verdict: 'failed:phase5:no_linked_agent_behavior_candidate', notes };
  }
  if (input.integrityStatus === 'error') return { verdict: 'failed:phase5:integrity_error', notes };
  if (input.canaryStatus === 'error') return { verdict: 'failed:phase5:canary_error', notes };

  notes.push(`provenance=${contextBoundTasks[0]?.provenance ?? '?'}, ${contextBoundTasks.length} task(s), ${linkedCandidates.length} linked candidate(s)`);
  return { verdict: 'story_a_validated', notes };
}

export function exitCodeForStoryAVerdict(verdict) {
  return verdict === 'story_a_validated' ? 0 : 1;
}
