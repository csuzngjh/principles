export function computeStoryAVerdict(input) {
  const notes = [];
  if (!input.phase0Ok) return { verdict: `failed:phase0:${input.phase0Error ?? 'workspace_error'}`, notes };
  if (!input.phase1Ok) return { verdict: `failed:phase1:${input.phase1Error ?? 'environment_unavailable'}`, notes };
  if (!input.agentResponded) return { verdict: 'failed:phase3:agent_no_response', notes };
  if (input.painCount === 0) return { verdict: 'failed:phase4:no_pain_emitted', notes };
  if (!input.painSource || input.painSource === 'unknown') {
    return { verdict: `failed:phase4:unknown_pain_source:${input.painSource ?? 'null'}`, notes };
  }
  if (!input.hasOwnerMessage) return { verdict: 'failed:phase4:missing_owner_message', notes };
  if (!input.hasAgentTurn) return { verdict: 'failed:phase4:missing_agent_turn', notes };

  const contextBoundTasks = input.tasks.filter(task => task.provenance === 'openclaw_context_bound');
  if (contextBoundTasks.length === 0) return { verdict: 'failed:phase5:no_context_bound_tasks', notes };
  const taskIds = new Set(contextBoundTasks.map(task => task.taskId));
  const linkedCandidates = input.candidates.filter(candidate => taskIds.has(candidate.taskId));
  if (linkedCandidates.length === 0) return { verdict: 'failed:phase5:no_linked_candidates', notes };
  if (!linkedCandidates.some(candidate => candidate.isAgentBehavior)) {
    return { verdict: 'failed:phase5:no_linked_agent_behavior_candidate', notes };
  }
  if (input.integrityStatus === 'error') return { verdict: 'failed:phase5:integrity_error', notes };
  if (input.canaryStatus === 'error') return { verdict: 'failed:phase5:canary_error', notes };

  notes.push(`provenance=openclaw_context_bound, ${contextBoundTasks.length} task(s), ${linkedCandidates.length} linked candidate(s)`);
  return { verdict: 'story_a_validated', notes };
}

export function exitCodeForStoryAVerdict(verdict) {
  return verdict === 'story_a_validated' ? 0 : 1;
}
