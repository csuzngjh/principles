# Workflow Registry Bootstrap

This is a first-pass workflow registry for the current codebase. It is meant to expose where ownership is explicit, where it is split, and which workflows should be prioritized for gradual consolidation.

| Workflow ID | Current Owner | Trigger | Primary Outputs | Authoritative State | Terminal States | Cleanup Required | Forbidden Overlaps | Ownership Status |
|---|---|---|---|---|---|---|---|---|
| `wf.empathy_observer` | partially `service/empathy-observer-manager.ts` | `before_prompt_build` -> runtime subagent -> `subagent_ended` | `user_empathy`, friction, event log, trajectory record | runtime session + event log + trajectory | spawn_failed, no_damage, persisted, cleaned | yes | main-model self-report empathy | Partially clear |
| `wf.llm_pain_detection` | `hooks/llm.ts` + `DetectionService` | `llm_output` | rule match, pain signal, pain flag | event log + pain flag + trajectory side effects | detected, ignored, rolled_back | sometimes | audit payloads, duplicate semantic funnels | Partially clear |
| `wf.manual_pain` | `hooks/pain.ts` | command/tool outcomes | pain signal, trajectory pain event | event log + trajectory + session/friction | applied, reset | no explicit cleanup | other direct pain writers | Split |
| `wf.subagent_completion.diagnostician` | `hooks/subagent.ts` | `subagent_ended` | queue completion, task outcome, principle creation | evolution queue + trajectory + reducer | completed, retried, unmatched, failed | yes | non-diagnostician subagent flows | Partially clear |
| `wf.rollback.user_empathy` | commands + `llm.ts` rollback cue | rollback command or rollback marker in output | event rollback + friction reset | event log + session/friction state | rolled_back, skipped | no | multiple empathy write paths | Split |
| `wf.routing.shadow_observation` | runtime hook layer + shadow registry | runtime subagent spawning/ending | shadow routing evidence | registry/state files | recorded, completed, dropped | yes | prompt-only routing hints pretending to be evidence | Partially clear |
| `wf.nocturnal.training_eval` | nocturnal services/core modules | commands + service orchestration | experiment state, checkpoints, eval outputs | nocturnal state + runtime subagent session + files | success, timeout, failed, cleaned | yes | generic subagent lifecycle rules not reused | Split |
| `wf.pain_flag_lifecycle` | unclear | llm detection, pain hook, subagent cleanup | `.pain_flag` create/update/delete | state file | created, queued, cleared, stale | yes | independent cleanup branches | Unclear |
| `wf.principle_creation` | reducer plus upstream callers | diagnostician and other evolution paths | principle state mutation | reducer state / dictionaries | created, rejected, probation, promoted | no special cleanup | multiple creation entrypoints | Split |

## Priority Candidates For Governance Trial

### Candidate 1: `wf.subagent_completion.diagnostician`

Why:

- bounded enough to isolate
- strongly stateful
- relies on runtime completion and cleanup
- already has observable terminal events

### Candidate 2: `wf.empathy_observer`

Why:

- compact workflow
- clearly demonstrates duplicate-path risk
- cleanup requirement is obvious

### Candidate 3: `wf.pain_flag_lifecycle`

Why:

- high operational impact
- multiple modules can indirectly affect it
- stale state can distort downstream recovery

## Immediate Recommendation

Do not attempt to centralize all workflows at once.

Use this order:

1. subagent lifecycle and completion
2. observer-like bounded workflows
3. pain flag lifecycle
4. principle creation paths
5. nocturnal runtime lifecycle
