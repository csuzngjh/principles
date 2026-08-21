# Principles Disciple Product Identity

> **Status**: Active canonical product boundary
> **Read for**: new issues, product or architecture decisions, roadmap changes, user journeys, surfaced functionality, and MVP scope questions
> **Scope authority**: [ADR-0014](docs/adr/0014-mvp-first-strategy-and-product-pivot.md)

## Definition

**Principles Disciple (PD) is an owner-governed behavior internalization system for AI agents.** It turns repeated, owner-relevant behavioral evidence into reviewed, reversible principles that can change future behavior.

`Pain` is PD's current technical name for incoming behavior evidence. It does not mean every tool failure deserves a principle.

## Public Category

The internal definition above and the public category below are two layers of one statement — they must not drift apart:

- **Public category (Category — how PD is classified externally):**
  *Principles Disciple is an AI Agent Governance System.*
- **Internal definition (System Type — how it works):**
  *Owner-governed Agent Behavior Internalization System.*

```
Category            →  what PD is (external copy, website, README, marketplace)
System Type         →  what kind of system PD is
Internal Mechanism  →  how PD works (this document)
```

All external copy uses the public category sentence. The canonical text for external surfaces is [`docs/concepts/pd-canonical-definition.md`](../concepts/pd-canonical-definition.md); if the two documents ever disagree, this document wins and the canonical definition must be updated.

## Boundary

PD owns:

- behavior evidence the owner considers worth changing;
- reviewable principle proposals;
- owner approval, rejection, channel selection, rollback, and archive decisions;
- reversible activation and later observation of behavior change.

PD does not own:

- task execution or general agent orchestration;
- general memory;
- tool retries or JSON/output-format repair;
- autonomous value decisions without an owner.

PD builds on host/runtime capabilities; it does not duplicate them.

## MVP Contract

```text
behavior evidence -> diagnosis -> principle proposal -> owner review
-> reversible activation -> observable later behavior
```

Supported MVP activation outcomes are `prompt`, `code_tool_hook` / RuleHost, and `defer_archive`.

MVP success is an owner observing a better-aligned response in a comparable later scenario. It is not statistical attribution, autonomous learning infrastructure, or a new activation channel.

## Emotional Value

PD features must deliver measurable emotional value to the Owner. Read [`docs/product/emotional-value.md`](docs/product/emotional-value.md) for the full framework.

Core promise: **把 Owner 面对 Agent 时的失控感、疲惫感、重复纠正感，转化为安心感、掌控感、沉淀感和清醒感。**

Every feature design must answer: which negative emotion does it reduce, and what positive feeling does it create? A feature that only proves "it works" without explaining how it improves the Owner's psychological state is incomplete.

## Decision Gate

For a new issue, surfaced subsystem, user journey, or product/architecture change, answer:

1. Which step of the owner-governed loop improves?
2. What owner-visible evidence verifies it?
3. How is it disabled, rolled back, or deferred?
4. Does it duplicate a host/runtime capability?
5. What emotional value does it deliver? (See emotional-value.md — which negative emotion does it reduce, what positive feeling does it create?)

If these cannot be answered, do not add the work to MVP scope. Use ADR-0014 and the post-MVP conditional roadmap for deferred work; use architecture documents only for implementation structure.
