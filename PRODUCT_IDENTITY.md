# Principles Disciple Product Identity

> **Status**: Active canonical product boundary
> **Read for**: new issues, product or architecture decisions, roadmap changes, user journeys, surfaced functionality, and MVP scope questions
> **Scope authority**: [ADR-0014](docs/adr/0014-mvp-first-strategy-and-product-pivot.md)

## Definition

**Principles Disciple (PD) is an owner-governed behavior internalization system for AI agents.** It turns repeated, owner-relevant behavioral evidence into reviewed, reversible principles that can change future behavior.

`Pain` is PD's current technical name for incoming behavior evidence. It does not mean every tool failure deserves a principle.

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

## Decision Gate

For a new issue, surfaced subsystem, user journey, or product/architecture change, answer:

1. Which step of the owner-governed loop improves?
2. What owner-visible evidence verifies it?
3. How is it disabled, rolled back, or deferred?
4. Does it duplicate a host/runtime capability?

If these cannot be answered, do not add the work to MVP scope. Use ADR-0014 and the post-MVP conditional roadmap for deferred work; use architecture documents only for implementation structure.
