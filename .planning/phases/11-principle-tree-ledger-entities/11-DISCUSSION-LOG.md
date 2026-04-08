# Phase 11: Principle Tree Ledger Entities - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md. This log preserves the auto-mode reasoning that locked them.

**Date:** 2026-04-07
**Phase:** 11-principle-tree-ledger-entities
**Mode:** auto
**Areas discussed:** ledger authority and storage shape, scope and migration constraints, service boundaries, data model expectations

---

## Ledger authority and storage shape

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing principle-tree / training-state store | Keep semantic ledger unified and evolve current state persistence | X |
| Create a separate code-implementation ledger now | Split semantic model from persistence too early and add reconciliation burden | |
| Defer persistence and keep schema-only | Leaves Phase 11 without real ledger entities | |

**Auto choice:** Extend the existing principle-tree / training-state store.
**Notes:** Evidence from `principle-tree-schema.ts` and `principle-training-state.ts` shows the repo already has a natural store target and migration pattern.

## Scope and migration constraints

| Option | Description | Selected |
|--------|-------------|----------|
| Ledger-only phase boundary | Only persist/query Rule and Implementation entities, no runtime host yet | X |
| Combine ledger with Rule Host MVP | Pulls Phase 12 runtime work into Phase 11 | |
| Combine ledger with replay/promotion | Pulls Phase 13 evaluation work into Phase 11 | |

**Auto choice:** Keep Phase 11 ledger-only.
**Notes:** This matches `.planning/ROADMAP.md` and avoids collapsing multiple risk layers into one phase.

## Service boundaries

| Option | Description | Selected |
|--------|-------------|----------|
| Follow existing workspace service pattern | Add ledger access through workspace-scoped services and locked persistence helpers | X |
| Let hooks write ledger files directly | Fast but breaks existing architectural conventions | |
| Defer service boundary decisions | Leaves planner without enough guidance | |

**Auto choice:** Follow the existing workspace service pattern.
**Notes:** `WorkspaceContext` is the cleanest future integration point and already acts as the dependency hub.

## Data model expectations

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve full Principle -> Rule -> Implementation hierarchy | Keeps semantic and runtime layers distinct and queryable | X |
| Flatten Rule and Implementation into one runtime record | Simplifies short term, breaks principle-tree semantics | |
| Support only code implementations for now | Conflicts with milestone philosophy and future routing model | |

**Auto choice:** Preserve the full hierarchy and keep implementation types open-ended.
**Notes:** Phase 11 should not bias the ledger toward `code` only, even if later phases focus on `Implementation(type=code)`.

## Auto-Resolved

- Phase 11 storage anchor: chose the existing `principle_training_state.json` / principle-tree store path rather than inventing a new file
- Phase 11 service integration: chose `WorkspaceContext` as the future access seam
- Phase 11 migration stance: preserve current reducer lifecycle and existing training state behavior

## Deferred Ideas

- Runtime Rule Host, replay evaluation, nocturnal code artifacts, and coverage routing remain deferred to Phases 12-15

