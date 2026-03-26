# Roadmap: Principles Disciple — Phase 3A-C

## Phases

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Phase 1 | Authoritative runtime summary, legacy trust freeze | (complete) | — |
| 2 | Phase 2a/2b | Empathy eventing, slice-safe rollback | (complete) | — |
| 2.5 | Phase 2.5 | Control plane convergence | (complete) | — |
| **3A** | **Control Plane Cleanup: Input Quarantine** | Stop legacy state from contaminating Phase 3 | A0, A1, A2 | 5 |
| 3B | Gate Split | Split gate.ts by responsibility | A3 | 3 |
| 3C | Defaults & Errors | Centralize config, normalize errors | A4, A5 | 3 |

## Phase 3A: Control Plane Cleanup — Input Quarantine

**Goal:** Enter Phase 3 without carrying forward mixed truth sources, stale directive state, dirty queue history, or polluted trust history.

### Requirements

- [x] **A0**: Phase 3 Input Quarantine — classify inputs as authoritative/rejected/reference_only
- [x] **A1**: Demote `evolution_directive` to compatibility-only  
- [x] **A2**: Runtime truth vs analytics truth boundary cleanup

### Success Criteria

1. `Phase 3` status explicitly reports what is rejected and why
2. `evolution_directive.json` is never required for Phase 3 eligibility
3. Queue rows with legacy or non-canonical status are excluded
4. Workspaces with `frozen !== true` are excluded from trust-ready inputs
5. timeout-only task-outcome history is excluded from positive capability evidence

## Phase 3B: Gate Split

**Goal:** Split oversized gate.ts by responsibility for better maintainability.

### Requirements

- [x] **A3**: Split `gate.ts` by responsibility

### Success Criteria

1. `gate.ts` reduced to under 200 lines (orchestration only) — 289 lines achieved
2. Each extracted module has isolated responsibility — 6 modules extracted
3. All existing tests pass with no behavior drift — 800 passed

## Phase 3C: Defaults & Errors

**Goal:** Centralize scattered defaults and normalize error semantics.

### Requirements

- [x] **A4**: Centralize default configuration
- [x] **A5**: Normalize domain error semantics

### Success Criteria

1. All core policy defaults live in `src/config/defaults/`
2. High-value failure paths use domain-specific errors
3. Logs and summary can distinguish lock contention, parse failure, and derived-state mismatch

---

*Created: 2026-03-26*
