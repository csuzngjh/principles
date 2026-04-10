# Milestones

## Current: v1.13 Boundary Contract Hardening (Started: 2026-04-11)

**Goal:**

- remove the recurring "implicit assumption + silent fallback" failure mode from the production nocturnal path
- unify workspace resolution, critical file parsing, and runtime capability checks under explicit contracts
- add end-to-end contract tests so OpenClaw boundary drift breaks tests instead of silently corrupting state

**Planned phases:**

- Phase 19: Unified Workspace Resolution Contract
- Phase 20: Critical Data Schema Validation
- Phase 21: Runtime Contract and End-to-End Hardening

---

## v1.12 Nocturnal Production Stabilization (Shipped: 2026-04-10)

**Phases completed:** 3 phases, 4 plans

**Key accomplishments:**

- Snapshot ingress guardrails reject empty fallback workflows before they become noisy active jobs
- Minimal rule bootstrap created live Rule entities so the code-implementation branch can actually run
- Replay and operator validation path exists and was proven locally

---

## v1.9.3 Remaining Lint Stabilization (Shipped: 2026-04-09)

**Phases completed:** 1 phase, 1 plan

**Key accomplishments:**

- ESLint pipeline restored to green
- Mechanical fixes and explicit suppressions documented

---

## v1.9.0 Principle Internalization System (Shipped: 2026-04-08)

**Phases completed:** 5 phases, 10 plans

**Key accomplishments:**

- Principle -> Rule -> Implementation entities became first-class ledger records
- Runtime Rule Host, replay evaluation, lifecycle commands, and nocturnal implementation artifacts shipped
- Coverage, adherence, and routing surfaces were added
