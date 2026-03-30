# Architecture Guardrails

## Purpose

The primary risk in this project is no longer isolated bugs. The larger risk is systemic hidden failure:

- one business concept implemented in multiple places
- workflow steps split across hooks, services, prompts, runtime APIs, and state files
- string-based protocols drifting silently
- state written to multiple storage layers without a declared authority
- unit tests proving local correctness while system integrity still fails

This document defines the guardrails that prevent those failures from continuing to accumulate.

---

## Core Rules

### 1. One Domain Concept, One Authoritative Writer

Every important business concept must have exactly one authoritative write path.

Examples:

- a specific pain signal source
- rule match emission
- workflow completion state
- subagent cleanup markers
- promoted principles
- routing decisions

Other modules may request or observe. They may not write directly unless they are the declared owner.

### 2. One Workflow, One Owner

Every critical workflow must have one owner module.

The owner is responsible for:

- trigger entry
- protocol validation
- state transitions
- persistence
- cleanup
- retry policy
- terminal state handling

If a workflow spans many files, ownership still has to be explicit.

### 3. No Hidden String Protocols

Strings may not serve as hidden APIs by default.

If logic depends on:

- session key formats
- event `source`
- event `origin`
- workflow state values
- file naming conventions used as control logic
- prompt tags consumed by runtime hooks

then that protocol must be wrapped in a helper, codec, validator, enum, or schema.

### 4. Truth Source Must Be Declared

Every business concept must declare its authoritative storage layer.

Possible truth sources include:

- SQLite tables
- JSON state files
- event logs
- in-memory state

Logs, summaries, caches, and derived analytics are not authoritative unless declared.

### 5. Invariants Are Mandatory

Each critical workflow must define:

- what must always happen
- what must never happen
- what terminal states are valid
- what cleanup is required
- what overlapping implementations are forbidden

These invariants must be testable and auditable.

---

## Failure Modes We Must Prevent

### A. Duplicate Writers

Multiple files write the same concept independently.

Typical outcome:

- duplicate state
- contradictory analytics
- partial fixes that do not actually retire the old path

### B. Split Workflow Ownership

One chain is spread across hooks, services, files, and prompt instructions with no single owner.

Typical outcome:

- hidden breakpoints
- cleanup omitted
- retries added in one place but not another

### C. Protocol Drift

Two files assume the same string format but interpret it differently.

Typical outcome:

- session matching failures
- wrong branch selection
- stale cleanup
- silent workflow misrouting

### D. Competing Truth Sources

Multiple stores claim to describe the same business fact.

Typical outcome:

- stale UI
- recovery logic using wrong state
- tests passing while runtime behavior is inconsistent

### E. Local Tests, Broken System

Unit tests validate helpers but not workflow integrity.

Typical outcome:

- orphan sessions
- unclosed lifecycle loops
- illegal source/origin combinations
- hidden overlap between old and new paths

---

## Required Governance Mechanisms

### 1. Domain Ownership Map

We maintain a living map of:

- domain concept
- authoritative writer
- authoritative storage
- known readers
- known competing paths

### 2. Workflow Registry

We maintain a registry of important workflows, each with:

- workflow id
- owner module
- trigger
- outputs
- terminal states
- cleanup requirements
- forbidden overlaps
- key invariants

### 3. Audit Scripts

We gradually add scripts that detect:

- duplicate writers
- orphan workflows
- invariant violations
- stale legacy paths

At first these scripts warn only. They should not block development until the signal quality is proven.

### 4. Retirement Policy

When a new path replaces an old path, the old path must be marked explicitly as one of:

- shadow
- deprecated
- disabled
- removed

No path may remain silently active forever.

### 5. Boundary And Invariant Tests

For workflow-heavy code, unit tests are not enough.

We need:

- boundary tests for owner modules
- invariant tests for forbidden conditions
- cleanup tests for terminal states

---

## Rules For Future Changes

Any architecture-sensitive PR must answer:

1. What concept is being written?
2. Who is the single owner?
3. What is the authoritative truth source?
4. Is this adding a second path?
5. What cleanup is required?
6. What invariant protects this flow?
7. What old path is being retired?

If these answers are missing, the change is incomplete.

---

## Immediate Strategy

We will not fix this project through one giant refactor.

We will proceed in four stages:

1. Document and observe.
2. Add audit-only tooling.
3. Introduce shadow governance around one workflow at a time.
4. Retire duplicate paths gradually.

The operating plan for that work lives in `GRADUAL_ROADMAP.md`.
