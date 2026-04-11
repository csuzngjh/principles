# Milestones

## Current: v1.14 Evolution Worker Decomposition & Contract Hardening (Started: 2026-04-11)

**Goal:**

- decompose the 2133-line evolution-worker.ts into 5 focused modules with clear boundaries
- equip each extracted module with boundary contracts (input validation + fail-fast/fail-visible)
- audit and classify all 16 silent fallback points
- preserve existing behavior: all tests pass, public API unchanged, lifecycle correct

**Planned phases:**

- Phase 24: Queue Store Extraction (DECOMP-01, CONTRACT-01, CONTRACT-02, CONTRACT-06)
- Phase 25: Pain Flag Detector Extraction (DECOMP-02)
- Phase 26: Task Dispatcher Extraction (DECOMP-03)
- Phase 27: Workflow Orchestrator Extraction (DECOMP-04)
- Phase 28: Context Builder + Service Slim + Fallback Audit (DECOMP-05, DECOMP-06, CONTRACT-03, CONTRACT-04, CONTRACT-05)
- Phase 29: Integration Verification (INTEG-01, INTEG-02, INTEG-03, INTEG-04)

---

## v1.13 Boundary Contract Hardening (Shipped: 2026-04-11)

**Phases completed:** 5 phases (19-23)

**Key accomplishments:**

- Removed recurring "implicit assumption + silent fallback" failure mode from production nocturnal path
- Unified workspace resolution, critical file parsing, and runtime capability checks under explicit contracts
- Added end-to-end contract tests so OpenClaw boundary drift breaks tests instead of silently corrupting state

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
