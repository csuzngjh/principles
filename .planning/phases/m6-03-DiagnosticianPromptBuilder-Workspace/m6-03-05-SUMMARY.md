---
phase: m6-03
plan: "05"
status: complete
completed_at: "2026-04-24T22:39:56.000Z"
commit: 2f19a82a
---

## m6-03-05 Summary: OCRA-06/07 Unit Tests for OpenClawCliRuntimeAdapter

**Goal:** Unit tests covering OCRA-06 (workspace boundary via cwd) and OCRA-07 (runtimeMode controls --local flag).

**What was shipped:**

### Changes to
- `packages/principles-core/src/runtime-v2/adapter/__tests__/openclaw-cli-runtime-adapter.test.ts`

### New test cases (11 added, all existing 19 updated)
- runtimeMode='local' → --local flag present
- runtimeMode='gateway' → --local flag absent (HG-03)
- workspaceDir passed as cwd when provided
- workspaceDir undefined → runCliProcess default
- workspaceDir passed as cwd even when runtimeMode='gateway'
- HG-03 no silent fallback: gateway mode never passes --local

**All 19 existing tests** updated from `new OpenClawCliRuntimeAdapter()` (no-arg) to `new OpenClawCliRuntimeAdapter({ runtimeMode: 'local' })`.

### Success criteria verified
- [x] All vitest tests pass (30 total: 19 existing + 11 new)
- [x] OCRA-06 covered: workspaceDir passed as cwd to runCliProcess
- [x] OCRA-07 covered: runtimeMode='local' passes --local, runtimeMode='gateway' omits --local
- [x] HG-03 covered: no silent fallback (gateway mode never passes --local)
- [x] All existing tests updated to new constructor signature
- [x] runCliProcess mocked so tests run without real openclaw binary

### Requirements covered
- OCRA-06: workspace boundary via cwd
- OCRA-07: runtimeMode explicit, no silent fallback
- HG-03: HARD GATE satisfied
