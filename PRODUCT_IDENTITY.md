# Principles Disciple Product Identity

> **Status**: Active / canonical product definition
> **Last updated**: 2026-05-25
> **Execution boundary**: [ADR-0014](docs/adr/0014-mvp-first-strategy-and-product-pivot.md) and the [MVP execution plan](docs/plans/2026-05-roadmap/07-mvp-first-pivot.md)

## One-Sentence Definition

**Principles Disciple (PD) is an owner-governed behavior internalization system for AI agents: it turns repeated, owner-relevant behavioral evidence into reviewed, reversible principles that can change future agent behavior.**

This definition is the anchor for product decisions, architecture work, issue planning, and user-facing explanation.

## What PD Owns

PD owns the layer above individual task execution:

| Concept | Meaning in PD |
| --- | --- |
| **Behavior evidence** | Repeated friction, explicit correction, risky near-miss, or persistent behavior pattern that the owner considers worth improving |
| **Principle proposal** | A reviewable statement of how the agent should behave differently in similar future situations |
| **Owner decision** | Human approval, rejection, channel selection, rollback, or defer/archive decision |
| **Activation** | Applying an approved principle through a reversible behavior channel |
| **Observed behavior change** | Evidence from a subsequent real or controlled scenario that the activated principle affected agent behavior as intended |

`Pain` is PD's current technical name for incoming behavior evidence. It does **not** mean every tool failure deserves a principle, and it does not limit PD to error handling.

## What PD Does Not Own

PD is deliberately not:

- a task execution engine;
- a general memory system or external brain;
- a tool-call retry or JSON-format repair product;
- a general multi-agent orchestration framework;
- an autonomous self-improvement system that decides values without an owner.

OpenClaw, Claude Code, and other host/runtime products can become better at execution, memory, tools, and agent coordination. PD should build on those capabilities, not duplicate them. PD's differentiated value is the governed transition from **repeated behavior evidence** to **durable, reviewable behavior policy**.

## The Product Loop

```text
Real work evidence
  -> pattern diagnosis
  -> principle proposal
  -> owner review and channel decision
  -> reversible activation
  -> observable behavior in a later scenario
```

The owner is not an exception path in this loop. The owner supplies the value judgment: which behavior matters, which principle is acceptable, how strongly it may be applied, and whether it should remain active.

## MVP Promise

The MVP must demonstrate one simple promise:

> An owner can identify a repeated agent behavior they want changed, review a proposed principle, activate it through a supported channel, and observe a better-aligned response in a comparable later scenario.

The supported MVP channels are:

- `prompt`: soft behavioral guidance;
- `code_tool_hook` / RuleHost: reviewed enforcement for sensitive behavior;
- `defer_archive`: a deliberate decision not to activate a proposal.

MVP success is **demonstrated behavior change**, not statistical causal attribution.

## Product Horizons

### Short Term: First Seed Customer

Goal: make the owner-governed loop usable and observable.

Must deliver:

- one trustworthy Runtime V2 forward path;
- a clear Pain / Principle / Approval operator journey;
- the three supported MVP channels;
- a reproducible demonstration based on an owner-specified behavior preference;
- disable, rollback, and failure-diagnosis paths.

Must not expand into:

- new activation channels;
- autonomous attribution or auto-pruning;
- general agent lifecycle or mission scheduling;
- replacement execution, memory, or tool frameworks.

### Medium Term: Evidence of Product Value

Start only after seed customers repeatedly use the MVP loop.

Goal: determine whether activated principles remain useful over time without claiming false causality.

Possible work, only when triggered by observed customer evidence:

- outcome observation and comparison across similar situations;
- principle usefulness review and assisted archive decisions;
- cautious attribution experiments with explicit uncertainty;
- better handling of conflicting or low-quality principles.

The activation of this horizon is governed by the restart conditions in [post-mvp-conditional-roadmap.md](docs/plans/post-mvp-conditional-roadmap.md).

### Long Term: Governed Behavioral Adaptation Layer

Goal: become a portable governance layer for agents running across capable host systems.

PD may eventually help owners understand which behavioral policies work across tasks, tools, agents, and workspaces. It should still remain owner-governed, auditable, and reversible. It should not compete with host runtimes on basic execution, memory, or tool orchestration.

## Decision Filter For Every Issue

Before implementation, ask:

1. Which part of the owner-governed product loop does this improve?
2. What owner-visible behavior or evidence becomes better?
3. Can the change be disabled, rolled back, or safely deferred?
4. Does it duplicate a capability that should belong to the host/runtime instead?
5. Is it required for the current horizon, or is it an untriggered future idea?

If an issue cannot answer these questions, it should not enter the active MVP queue.

## Document Authority

Use this document for the stable product identity.

- Use `ADR-0014` for current strategic scope and deferred work.
- Use the MVP execution plan for active sequencing.
- Use architecture documents for component boundaries and data flow.
- Use the Owner Reader Companion for longer-term interpretation and systems-thinking context.

If a roadmap or architecture document implies PD owns task execution, general memory, generic tool repair, or unapproved autonomous self-evolution, it conflicts with this product identity and must be corrected before it drives implementation.
