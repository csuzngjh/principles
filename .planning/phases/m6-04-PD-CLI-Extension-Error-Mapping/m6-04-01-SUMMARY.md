---
phase: m6-04
plan: "01"
wave: 1
status: complete
completed: 2026-04-24
---

## Wave 1 Summary

**What was built:**
- `OpenClawCliRuntimeAdapter` re-exported from `@principles/core/runtime-v2`
- `pd diagnose run --runtime openclaw-cli` now routes to `OpenClawCliRuntimeAdapter`
- `pd diagnose run --runtime test-double` continues to work (regression)
- HG-03 enforcement: `--openclaw-local`/`--openclaw-gateway` must be explicit, mutually exclusive
- CLI-04: `PDRuntimeError` surfaces as `error: <message> (<errorCategory>)` with `--json` structured output

**Artifacts:**
- `packages/principles-core/src/runtime-v2/index.ts` — added `OpenClawCliRuntimeAdapter` export
- `packages/pd-cli/src/commands/diagnose.ts` — runtime selection + error output
- `packages/pd-cli/src/index.ts` — added CLI flags to `diagnose run`

**Key decisions:**
- `runtimeKind` defaults to `'test-double'` when not specified
- `openclaw-cli` requires explicit mode (`--openclaw-local` or `--openclaw-gateway`)
- Error output format: console → `error: <msg> (<category>)`, JSON → `{ status, errorCategory, message, runtimeKind }`

**Commits:**
- `e4f54409` feat(m6-04): CLI routing + error output (Wave 1)
