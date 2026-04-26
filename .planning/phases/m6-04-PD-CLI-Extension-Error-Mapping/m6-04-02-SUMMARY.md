---
phase: m6-04
plan: "02"
wave: 2
status: complete
completed: 2026-04-24
---

## Wave 2 Summary — HG-01 HARD GATE

**What was built:**
- `probeRuntime()` library function in `packages/principles-core/src/runtime-v2/cli/probe.ts`
- `pd runtime probe --runtime openclaw-cli [--openclaw-local|--openclaw-gateway] [--json]` command
- Human-readable output: health status table + capabilities table
- JSON output: `{ status, runtimeKind, health, capabilities }`
- HG-03 enforcement (same as Wave 1)
- HG-01 enforcement: only `openclaw-cli` runtime supported

**Artifacts:**
- `packages/principles-core/src/runtime-v2/cli/probe.ts` — `probeRuntime()` function
- `packages/principles-core/src/runtime-v2/cli/index.ts` — CLI module exports
- `packages/pd-cli/src/commands/runtime.ts` — `handleRuntimeProbe()`
- `packages/pd-cli/src/index.ts` — `pd runtime probe` command registered

**Key decisions:**
- `probeRuntime()` calls `healthCheck()` + `getCapabilities()` directly on `OpenClawCliRuntimeAdapter`
- No separate `probe()` interface needed (per M4-02 from CONTEXT.md)
- Capabilities displayed as formatted table with `yes`/`no` for booleans

**Commits:**
- `8636def9` feat(m6-04): pd runtime probe command (Wave 2 — HG-01 HARD GATE)
