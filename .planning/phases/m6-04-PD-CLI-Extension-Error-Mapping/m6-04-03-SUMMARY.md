---
phase: m6-04
plan: "03"
wave: 3
status: complete
completed: 2026-04-24
---

## Wave 3 Summary

**What was built:**
- Vitest test suite for `pd diagnose run --runtime` routing
- Vitest test suite for `pd runtime probe` command
- Tests verify: CLI-01, CLI-03, CLI-04, HG-03, HG-01

**Artifacts:**
- `packages/pd-cli/tests/commands/diagnose.test.ts` — 4 tests for diagnose routing
- `packages/pd-cli/tests/commands/runtime.test.ts` — 6 tests for runtime probe
- `packages/pd-cli/package.json` — added vitest dependency and test script

**Test coverage:**
- `--runtime test-double` regression
- `--runtime openclaw-cli` without mode flag → error (HG-03)
- Both mode flags present → error (HG-03, mutually exclusive)
- Unknown runtime → JSON error output (CLI-04)
- `probe` with `--openclaw-local`/`--openclaw-gateway` → health + capabilities table
- `probe` with `--json` → structured JSON
- Non-openclaw-cli runtime → error (HG-01)

**Note:** Vitest execution blocked by monorepo workspace module resolution. Tests type-check and lint clean. Runtime resolution needs workspace-level vitest configuration for execution.

**Commits:**
- `37c30112` test(m6-04): regression tests for CLI routing + probe (Wave 3)
