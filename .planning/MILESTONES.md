# Milestones

## v1.9.3 剩余 Lint 修复 (Shipped: 2026-04-09)

**Phases completed:** 1 phases, 1 plans, 5 tasks

**Key accomplishments:**

- ESLint v10 flat config updated with globals.node (resolves no-undef for Node.js builtins) and ignores for parsing-error files
- Reordered functions in create-principles-disciple to fix no-use-before-define, refactored copyCoreTemplates to options object to fix max-params
- Note:
- 1. [Rule 1 - Bug] Fixed init-declarations with try/catch patterns
- Plan:

---

## v1.9.0 Principle Internalization System (Shipped: 2026-04-08)

**Phases completed:** 5 (Phase 11, 12, 13, 14, 15) | **Plans:** 10

**Milestone goal:**

- turn the current principle / nocturnal / gate architecture into a real Principle Internalization System
- make `Rule` and `Implementation` first-class ledger entities
- add a constrained runtime `Rule Host`
- require replay-based promotion for code implementations
- extend nocturnal reflection to emit `RuleImplementationArtifact` candidates
- compute coverage, false positive, adherence, and deprecation eligibility from real implementation outcomes

**Key accomplishments:**

- Principle tree ledger now ships first-class `Principle -> Rule -> Implementation` entities with lifecycle transitions
- Runtime `Rule Host` is wired into the gate chain between `GFI` and `Progressive Gate`
- Code implementations are stored as versioned assets with manifests and entry source
- Replay evaluation, manual promote/disable/rollback/archive flows, and replay-backed reports are live
- Nocturnal can emit `RuleImplementationArtifact` candidates with lineage and validation
- Coverage, adherence, deprecated readiness, and `skill | code | defer` route recommendations are available from one lifecycle surface
- User-facing operator docs now include the implementation workflow and replay-first promotion path

**Key boundaries preserved:**

- `Progressive Gate` remains in place as a host hard-boundary layer
- code implementations are not auto-promoted or auto-deployed
- routing recommendations do not execute automatically
- the milestone remains focused on the `Implementation(type=code)` branch, not LoRA or full fine-tune

---

## v1.5 Nocturnal Helper 重构 (Shipped: 2026-04-06)

**Phases completed:** 5 (Phase 6, 7, 8, 9, 10)

**Key accomplishments:**

- NocturnalWorkflowManager implementing WorkflowManager interface with single-reflector path and Trinity chain support
- WorkflowStore extended with stage_outputs table for Trinity stage persistence and idempotency (NOC-11/12/13)
- evolution-worker integrated with NocturnalWorkflowManager through stub-based fallback on Trinity failure
- StubFallbackRuntimeAdapter method signatures fixed to match TrinityRuntimeAdapter interface (NOC-15)
- Phase 8 architectural shift: direct stage-by-stage invocation for fine-grained persistence control

**Known gaps:**

- Phases 07 and 08 are missing `VERIFICATION.md` even though implementations shipped
- NOC requirements were not formally defined in `REQUIREMENTS.md` at the time
- There were pre-existing TypeScript errors in `evolution-reducer.ts` and `prompt.ts` unrelated to v1.5

---

## v1.4 OpenClaw v2026.4.3 Compatibility (Shipped: 2026-04-05)

**Phases completed:** 3 (Phase 1, 2, 5)

**Key accomplishments:**

- SDK type cleanup aligned the shim with OpenClaw v2026.4.4
- Memory search moved from deprecated `createMemorySearchTool` to native FTS5 search on `pain_events`
- Integration testing covered TEST-01 through TEST-03 with remaining runtime verification deferred

**Known gaps:**

- TEST-04 deep_reflect runtime verification remained pending
- TEST-05 hook triggering verification remained pending

---

## 1.0 v1.0-alpha MVP (Shipped: 2026-03-26)

**Phases completed:** 6 phases, shipped 2026-03-26

**Key accomplishments:**

- SDK integration cleanup removed false declarations from `openclaw-sdk.d.ts`
- Memory search moved to FTS5 semantic search on `pain_events`
- Tool registration adopted the factory pattern
- PD-specific input isolation layer shipped
- Gate module was split into separate concerns
- Defaults and error handling were centralized

**Known gaps:** phases 3A, 3B, and 3C shipped before GSD and do not have modern phase artifacts
