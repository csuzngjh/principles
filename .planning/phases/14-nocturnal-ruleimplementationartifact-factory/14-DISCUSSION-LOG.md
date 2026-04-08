# Phase 14: Nocturnal RuleImplementationArtifact Factory - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-08
**Phase:** 14-nocturnal-ruleimplementationartifact-factory
**Areas discussed:** Pipeline architecture, Artifact trigger and routing, Code validation and safety, Storage and handoff

---

## Pipeline Architecture

| Option | Description | Selected |
|--------|-------------|----------|
| 4th Trinity stage | Add Artificer after Scribe, same subagent pattern | ✓ |
| Post-Trinity code sub-chain | Separate sub-chain after main Trinity | |
| Extend Scribe output | Scribe produces both text and code | |

**User's choice:** 4th Trinity stage (Artificer)
**Notes:** Named "Artificer" (工匠) over "Coder". Follows existing subagent invocation pattern. Behavioral sample pipeline unchanged.

---

## Artifact Trigger and Routing

| Option | Description | Selected |
|--------|-------------|----------|
| Same run, both artifacts | Single nocturnal run can produce both types | ✓ |
| Mutually exclusive per run | Each run produces only one artifact type | |
| Operator manual trigger only | Code candidates only via manual command | |

**User's choice:** Same run can produce both artifact types
**Notes:** Artificer fires after Scribe, conditionally.

### Trigger condition

| Option | Description | Selected |
|--------|-------------|----------|
| Rule coverage gap | Based on Rule having no active code implementation | |
| Always attempt, fallback to behavioral only | Every Trinity run tries Artificer | |
| Pain/gate data density | Only trigger when sufficient pain events and gate blocks exist | ✓ |

**User's choice:** Based on pain/gate data density
**Notes:** Minimum threshold (e.g., >= 3 pain events + gate blocks) ensures adequate signal before generating code.

---

## Code Validation and Safety

| Option | Description | Selected |
|--------|-------------|----------|
| Static validation + sandbox parse | Helper whitelist, return type, forbidden API, node:vm parseable | ✓ |
| Static validation + trial run | Above + actual sandbox execution with sample input | |
| No pipeline validation | Leave entirely to Phase 13 ReplayEngine | |

**User's choice:** Static validation + sandbox parse
**Notes:** Pure-function validation like existing Arbiter. Does not run full replay evaluation.

---

## Storage and Handoff

| Option | Description | Selected |
|--------|-------------|----------|
| Direct into implementation storage | Candidate goes straight to Phase 12 storage as lifecycleState=candidate | ✓ |
| Nocturnal/samples first, promote later | Intermediate storage in samples dir, promote to impl storage after evaluation | |
| Dedicated code-candidate directory | New directory for code candidates only | |

**User's choice:** Direct into implementation storage

### Registration approach

| Option | Description | Selected |
|--------|-------------|----------|
| Ledger + Storage + Dataset (3-point) | Full registration across all three systems | ✓ |
| Ledger + Storage only (2-point) | Skip nocturnal-dataset registration | |

**User's choice:** Ledger + Storage + Dataset three-point registration
**Notes:** Ensures full lineage tracking. Dataset gets 'code-candidate' classification.

---

## Claude's Discretion

- Exact Artificer subagent prompt design and output JSON contract
- Minimum pain/gate event threshold for Artificer triggering
- How to represent 'code-candidate' classification in nocturnal-dataset.ts
- Whether Artificer gets its own agent prompt file or shares with Scribe

## Deferred Ideas

- Auto-promotion of code candidates — after replay/rollback metrics stabilize
- Coverage/adherence/deprecation — Phase 15
- Internalization Strategy routing (skill/code/LoRA) — Phase 15+
- Multi-candidate tournament selection from Artificer — future enhancement
