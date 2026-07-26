export function computeStoryAVerdict(input) {
  const notes = [];
  if (!input.phase0Ok) return { verdict: `failed:phase0:${input.phase0Error ?? 'workspace_error'}`, notes };
  if (!input.phase1Ok) return { verdict: `failed:phase1:${input.phase1Error ?? 'environment_unavailable'}`, notes };
  if (!input.agentResponded) return { verdict: 'failed:phase3:agent_no_response', notes };
  if (input.painCount === 0) return { verdict: 'failed:phase4:no_pain_emitted', notes };
  if (!input.painSource || input.painSource === 'unknown') {
    return { verdict: `failed:phase4:unknown_pain_source:${input.painSource ?? 'null'}`, notes };
  }

  // Evidence anchor + context-bound task check are scenario-dependent AND must
  // be bound to the SAME task (PRI-518, CodeRabbit review):
  //   - user_correction / user_empathy → evidence MUST include owner_message;
  //     provenance must be openclaw_context_bound; agent_turn required.
  //   - tool_failure → evidence MUST include tool_call_failure; provenance may
  //     be openclaw_context_bound or automatic_hook; agent_turn optional
  //     (diagnosis runs synchronously in after_tool_call, before the current
  //     turn's assistant response is written to trajectory).
  // The evidence anchor check uses per-task flags (not global) to prevent
  // splicing evidence from task A with provenance from task B.
  const isToolFailureScenario = input.painSource === 'tool_failure';
  const validProvenances = isToolFailureScenario
    ? ['openclaw_context_bound', 'automatic_hook']
    : ['openclaw_context_bound'];

  const contextBoundTasks = input.tasks.filter(task => {
    if (!validProvenances.includes(task.provenance)) return false;
    // Per-task evidence anchor: the SAME task must have both the valid
    // provenance AND the scenario-appropriate evidence.
    if (isToolFailureScenario) {
      return task.hasToolCallFailure === true;
    }
    return task.hasOwnerMessage === true && task.hasAgentTurn === true;
  });
  if (contextBoundTasks.length === 0) {
    // Distinguish "no context-bound tasks at all" from "tasks exist but none
    // has the right evidence on the same task" for actionable diagnostics.
    const provenanceTasks = input.tasks.filter(task => validProvenances.includes(task.provenance));
    if (provenanceTasks.length === 0) {
      return { verdict: 'failed:phase5:no_context_bound_tasks', notes };
    }
    // Tasks with valid provenance exist but none passed the evidence filter.
    // Report which specific evidence is missing for actionable diagnostics.
    if (isToolFailureScenario) {
      return { verdict: 'failed:phase4:missing_tool_call_failure_evidence', notes };
    }
    // For user_correction: determine whether owner_message or agent_turn is
    // the missing piece (the task needs BOTH on the same task).
    const hasOwnerOnAny = provenanceTasks.some(t => t.hasOwnerMessage === true);
    return {
      verdict: hasOwnerOnAny ? 'failed:phase4:missing_agent_turn' : 'failed:phase4:missing_owner_message',
      notes,
    };
  }
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
