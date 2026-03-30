# Domain Ownership Bootstrap

This is a first-pass ownership map. It is intentionally incomplete, but it should be concrete enough to reveal where risk is concentrated today.

## High-Risk Concepts

| Concept | Current Authoritative Writer | Current Authoritative Storage | Known Readers | Known Competing Paths | Risk | Notes |
|---|---|---|---|---|---|---|
| `pain signal` (generic) | unclear / split across hooks | event log + trajectory + state files | status commands, UI, recovery flows | `hooks/pain.ts`, `hooks/llm.ts`, service flows | High | Core concept currently spans multiple entrypoints. |
| `user_empathy` | currently intended to be observer-only | event log + trajectory + friction/session state | rollback, summaries, runtime UI | recently conflicted between `hooks/llm.ts` and `service/empathy-observer-manager.ts` | High | This is the clearest example of duplicate writer risk. |
| `rule_match` | `DetectionService` via `hooks/llm.ts` | event log | evolution systems, analytics | implicit contamination from audit payloads | High | Owner is clearer than others, but funnel contamination remains a recurring class of risk. |
| `trust change` | split by hook/flow | event log + trust/session state | trust command, UI, policy logic | tool hooks and other system flows | Medium | Ownership is conceptually one domain but physically spread. |
| `pain_flag` lifecycle | split | state file + event log relationship | recovery worker, commands | `hooks/llm.ts`, `hooks/pain.ts`, `hooks/subagent.ts` cleanup paths | High | High risk because cleanup and creation are separated. |
| `subagent session lifecycle` | unclear / split | runtime session state + queue state + logs | subagent hooks, workflow services | `hooks/subagent.ts`, direct runtime usage in services/tools | High | Strong candidate for first consolidation. |
| `evolution task completion` | `hooks/subagent.ts` for diagnostician path | evolution queue + trajectory task outcomes | evolution worker, status commands | placeholder assignment patterns, retry paths | High | Ownership exists in practice but is tightly coupled to session conventions. |
| `workflow cleanup` | split per workflow | runtime sessions, files, queue state | operators, services | ad hoc `deleteSession`, `unlinkSync`, queue clearing | High | Cleanup is a cross-cutting concern with no shared enforcement. |
| `routing shadow evidence` | appears centered in runtime hook layer | registry/state files | routing analysis, rollout logic | prompt guidance vs runtime observation | Medium | Promising structure, but ownership should be made explicit. |
| `promoted principle / rule creation` | split between reducer and upstream workflows | reducer state + dictionaries | prompt injection, evolution reporting | diagnostician output, other future flows | High | Creation paths should be constrained tightly. |
| `rollback of user-facing signals` | commands + llm rollback cues | event log + friction/session state | operator commands, runtime logic | command path vs natural language trigger path | Medium | Needs a declared owner for rollback semantics. |
| `nocturnal subagent lifecycle` | service-level orchestration | runtime sessions + experiment/checkpoint state | nocturnal commands, services | multiple runtime use sites in nocturnal modules | High | Another strong candidate for a future workflow-owner module. |

## Immediate Interpretation

### Most Dangerous Ownership Gaps

1. `subagent session lifecycle`
2. `pain signal`
3. `workflow cleanup`
4. `promoted principle / rule creation`

### Why These Matter

- they cross module boundaries
- they are stateful
- they rely on runtime side effects
- they are hard to fully cover with unit tests
- failures can remain silent for a long time

## Next Step

This bootstrap map should be refined alongside `WORKFLOW_REGISTRY_BOOTSTRAP.md`. The next revision should attach:

- exact owner proposals
- exact files
- exact forbidden writers
- migration order
