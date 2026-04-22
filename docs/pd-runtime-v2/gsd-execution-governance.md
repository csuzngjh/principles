# PD Runtime v2 GSD Execution Governance

> Status: Draft v1  
> Date: 2026-04-21  
> Scope: How other AIs should execute the refactor without drifting from the architecture

## 1. Purpose

This document defines the governance rules for implementing PD Runtime v2 through GSD with other AI executors.

Its job is to prevent architectural drift.

The main risk is not that other AIs fail to write code.

The main risk is that they solve local implementation pain by reintroducing the old structural mistakes:

- host-specific coupling
- prompt-side hidden logic
- marker-file truth
- unbounded retrieval
- undocumented schema drift

## 2. Canonical Document Set

Any AI executing this refactor must treat the following documents as the canonical source set:

- [PD Runtime-Agnostic Architecture v2](/D:/Code/principles/docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md)
- [PD Runtime Protocol SPEC v1](/D:/Code/principles/docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md)
- [Diagnostician v2 Detailed Design](/D:/Code/principles/docs/spec/2026-04-21-diagnostician-v2-detailed-design.md)
- [Agent Execution Modes Appendix](/D:/Code/principles/docs/pd-runtime-v2/agent-execution-modes-appendix.md)
- [History Retrieval and Context Assembly SPEC](/D:/Code/principles/docs/pd-runtime-v2/history-retrieval-and-context-assembly-spec.md)
- [PD Runtime v2 Milestone Roadmap](/D:/Code/principles/docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md)

If implementation discovers a conflict among these documents, the conflict must be surfaced explicitly instead of papered over in code.

## 3. Non-Negotiable Architectural Constraints

The following constraints are mandatory:

1. LLMs do not own task completion truth
2. marker files are not primary truth for migrated flows
3. runtime selection is explicit, not implicit
4. context retrieval is PD-owned, not improvised by the agent against raw stores
5. OpenClaw is an adapter, not the architecture
6. every migrated flow must be observable
7. commit must be validated before state advances

Any implementation that violates one of these constraints is considered off-plan even if the code appears to “work”.

## 4. Required Deliverables Per Milestone

Each milestone must produce all of the following:

### 4.1 Code

Working implementation for the milestone scope.

### 4.2 Tests

At least:

- unit tests for core logic
- integration tests for the milestone boundary
- regression tests for the bug or failure mode being addressed

### 4.3 Docs

Update any affected runtime-v2 documents when implementation proves an assumption wrong or changes a boundary.

### 4.4 Review Note

A short milestone review note describing:

- what was built
- what assumptions changed
- what risks remain

## 5. Mandatory Review Questions at the End of Each Milestone

Before a milestone is considered complete, the executing AI must answer:

1. Did this milestone reduce host-runtime coupling or accidentally increase it?
2. Did any new prompt-side hidden behavior get introduced?
3. Is task/run/artifact truth explicit and test-covered?
4. Is there a rollback path?
5. Did any schema or error category drift appear?
6. Can operators observe failure in the new path clearly?

If any answer is unclear, the milestone is not ready for sign-off.

## 6. Required Verification Evidence

No milestone may be declared complete without concrete verification evidence.

Acceptable evidence includes:

- test output
- fixture-driven reproduction
- explicit command output
- run traces
- before/after failure comparison

Unacceptable evidence includes:

- “should work”
- “seems fine”
- “code path looks right”

## 7. Required Change Discipline

Implementation AIs must not:

- widen milestone scope casually
- introduce undocumented schema changes
- invent new runtime semantics without updating the specs
- silently bypass the commit path
- move logic into prompts because “it is faster”

Implementation AIs should:

- keep write scopes focused
- prefer explicit interfaces over convention
- update the runtime-v2 docs when new facts invalidate assumptions

## 8. How to Prevent Drift Across Multiple AIs

Use this operating model:

### 8.1 One Milestone at a Time

Only one active implementation milestone should be treated as in-progress in GSD unless the workstreams are clearly separable.

### 8.2 Freeze the Contracts First

If a milestone depends on a contract not yet stabilized, the AI must stop and surface that gap instead of inventing a local substitute.

### 8.3 Force a Milestone Review Gate

After each milestone:

- implementation pauses
- review is performed
- only then does the next milestone begin

### 8.4 Treat Drift as a First-Class Failure

A milestone that adds code but violates the architecture is a failed milestone, not a successful one.

## 9. Recommended GSD Usage Pattern

For each milestone:

1. create or update the milestone context using the roadmap and canonical docs
2. discuss only the milestone’s open design ambiguities
3. plan only the milestone scope
4. execute only the milestone scope
5. run milestone review before advancing

The review should explicitly compare implementation against:

- milestone goal
- exit criteria
- non-negotiable architectural constraints

## 10. Suggested Sign-Off Template

At the end of each milestone, the reviewing AI should produce:

### Outcome

- completed / partial / blocked

### Evidence

- tests run
- commands run
- artifacts inspected

### Architecture Check

- did implementation remain within PD Runtime v2 boundaries
- any host-specific leakage
- any prompt-side hidden logic introduced

### Remaining Risks

- what could still fail in production

### Next-Step Decision

- proceed
- revise
- rollback

## 11. Human Oversight Recommendation

The safest model for this refactor is:

- implementation AI executes milestone
- review AI checks milestone against the runtime-v2 docs
- human approves milestone completion

This three-part loop is strongly preferred over autonomous chaining across all milestones.

## 12. Summary

To keep other AIs from drifting away from the plan:

- give them a milestone, not the whole refactor
- bind them to the canonical docs
- require tests and review evidence
- force review gates after every milestone
- treat architectural drift as failure, not just style disagreement
