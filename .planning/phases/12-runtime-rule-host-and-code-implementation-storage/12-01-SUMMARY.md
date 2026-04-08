---
phase: 12-runtime-rule-host-and-code-implementation-storage
plan: 01
subsystem: gate-security
tags: [vm, sandbox, rule-host, gate-chain, principle-tree, ledger]

# Dependency graph
requires:
  - phase: 11-principle-tree-ledger-entities
    provides: "principle-tree-ledger with Implementation types, lifecycle states, findActiveImplementation"
provides:
  - "RuleHost class with constrained vm-based evaluation of active code implementations"
  - "RuleHostInput/RuleHostResult/RuleHostDecision type contracts"
  - "Frozen RuleHostHelpers whitelist (7 pure functions)"
  - "Gate chain insertion point between GFI and Progressive Gate"
  - "Conservative degradation on host errors (D-08)"
  - "Block persistence through recordGateBlockAndReturn with blockSource=rule-host"
affects: [13-replay-evaluation-and-manual-promotion-loop, gate-pipeline, progressive-trust-gate]

# Tech tracking
tech-stack:
  added: [node:vm]
  patterns: [constrained-vm-execution, frozen-snapshot-input, conservative-degradation]

key-files:
  created:
    - packages/openclaw-plugin/src/core/rule-host-types.ts
    - packages/openclaw-plugin/src/core/rule-host-helpers.ts
    - packages/openclaw-plugin/src/core/rule-host.ts
    - packages/openclaw-plugin/src/utils/node-vm-polyfill.ts
    - packages/openclaw-plugin/tests/core/rule-host.test.ts
    - packages/openclaw-plugin/tests/core/rule-host-helpers.test.ts
    - packages/openclaw-plugin/tests/hooks/gate-rule-host-pipeline.test.ts
  modified:
    - packages/openclaw-plugin/src/hooks/gate.ts

key-decisions:
  - "Used node:vm.compileFunction with codeGeneration:{strings:false,wasm:false} for sandboxing instead of vm.Script"
  - "Created node-vm-polyfill.ts to isolate node:vm dependency for testability"
  - "Gate insertion between GFI and Progressive Gate preserves both existing gates"
  - "Host errors degrade conservatively to undefined, never bypassing downstream gates"

patterns-established:
  - "Frozen snapshot input: implementations receive pre-computed values, never live workspace handles"
  - "Decision merge: block short-circuits, requireApproval collects, allow is implicit (returns undefined)"
  - "node-vm-polyfill pattern: thin wrappers around built-in modules for mock-friendly testing"

requirements-completed: [HOST-01, HOST-02, HOST-03, HOST-04]

# Metrics
duration: 17min
completed: 2026-04-07
---

# Phase 12 Plan 01: Rule Host and Gate Integration Summary

**Constrained RuleHost executing active code implementations via node:vm with frozen helper whitelist, wired into gate chain between GFI and Progressive Gate**

## Performance

- **Duration:** 17 min
- **Started:** 2026-04-07T11:52:35Z
- **Completed:** 2026-04-07T12:09:20Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- RuleHost class loads active code implementations from principle-tree ledger, executes in constrained vm context, merges decisions
- Frozen RuleHostHelpers whitelist with 7 pure functions (isRiskPath, getToolName, getEstimatedLineChanges, getBashRisk, hasPlanFile, getPlanStatus, getCurrentEpiTier)
- Gate chain correctly ordered: Thinking -> GFI -> Rule Host -> Progressive Gate -> Edit Verification
- Conservative degradation: host errors return undefined, never bypass Progressive Gate or Edit Verification
- All blocks use single authoritative persistence path via recordGateBlockAndReturn with blockSource='rule-host'
- 40 tests passing (23 host + 17 pipeline integration)

## Task Commits

Each task was committed atomically:

1. **Task 1: Define host types, helper whitelist, and RuleHost evaluator** - `e830360` (feat)
2. **Task 2: Wire Rule Host into gate.ts between GFI and Progressive Gate** - `602c0b6` (feat)

## Files Created/Modified
- `packages/openclaw-plugin/src/core/rule-host-types.ts` - RuleHostInput, RuleHostDecision, RuleHostResult, RuleHostMeta, LoadedImplementation contracts
- `packages/openclaw-plugin/src/core/rule-host-helpers.ts` - Frozen helper whitelist with createRuleHostHelpers()
- `packages/openclaw-plugin/src/core/rule-host.ts` - RuleHost class with evaluate() using constrained vm
- `packages/openclaw-plugin/src/utils/node-vm-polyfill.ts` - Thin wrapper around node:vm for testability
- `packages/openclaw-plugin/src/hooks/gate.ts` - Added Rule Host evaluation as POLICY STEP 2.5 with 8 private helper functions
- `packages/openclaw-plugin/tests/core/rule-host.test.ts` - 13 tests: host decisions, error handling, merge semantics
- `packages/openclaw-plugin/tests/core/rule-host-helpers.test.ts` - 10 tests: frozen object, pure functions, correct values
- `packages/openclaw-plugin/tests/hooks/gate-rule-host-pipeline.test.ts` - 9 tests: gate ordering, block/approval, degradation

## Decisions Made
- Used `node:vm.compileFunction` with `codeGeneration: { strings: false, wasm: false }` for sandboxing. This prevents `eval()` and WebAssembly instantiation inside hosted code (T-12-01)
- Created `node-vm-polyfill.ts` to isolate the `node:vm` import, enabling clean vi.mock() in tests without module resolution issues
- Gate insertion point between GFI and Progressive Gate ensures Rule Host can act before capability-boundary fallback while preserving both existing gates (D-02)
- Private helper functions in gate.ts (prefixed with `_`) populate the frozen snapshot without exposing live workspace handles to implementations

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Vitest mock factory pattern required function constructors (not arrow functions) for class mocking. Resolved by using `function(this: any)` pattern with shared mutable `_mockEvaluate` variable.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- RuleHost is ready for Phase 12 Plan 02 (implementation storage paths)
- Phase 13 can use the RuleHost's LoadedImplementation contract for replay evaluation
- Phase 14 will create actual code implementation assets that the host can load

---
*Phase: 12-runtime-rule-host-and-code-implementation-storage*
*Completed: 2026-04-07*

## Self-Check: PASSED

- All 9 created files verified present on disk
- Both task commits verified in git log (e830360, 602c0b6)
- All 40 tests passing across 4 test files

## Self-Check: PASSED

All 9 created files verified present on disk.
Both task commits verified in git log (e830360, 602c0b6).
All 40 tests passing across 4 test files.
