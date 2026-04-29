---
phase: m9-01
plan: 01
subsystem: runtime-v2
tags: [adapter, pi-ai, llm, diagnostician]
dependencies:
  requires: []
  provides: [pi-ai-runtime-adapter]
  affects: [runtime-v2, diagnostician-runner]
tech_stack:
  added: []
  patterns: [one-shot-adapter, abort-signal-timeout, typebox-validation, exponential-backoff]
key_files:
  created:
    - packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts
  modified: []
decisions:
  - "resolveModel() uses (getModel as any) cast because getModel() generic is too strict for dynamic config values from workflows.yaml"
  - "isAbortError() and extractJsonObject() are standalone functions (not class methods) to satisfy eslint class-methods-use-this"
  - "completeWithRetry() takes options object { signal, apiKey } to stay under max-params lint limit"
metrics:
  completed: "2026-04-29"
  tasks: 2
  files_created: 1
  lines_added: 471
---

# Phase m9-01 Plan 01: PiAiRuntimeAdapter Core — Summary

PiAiRuntimeAdapter: one-shot LLM completion via @mariozechner/pi-ai with AbortSignal.timeout, TypeBox validation, exponential backoff retry, and telemetry emission.

## Tasks Completed

### Task 1: Verify pi-ai dependency and barrel exports
- **Status:** Pre-satisfied (no changes needed)
- **Commit:** N/A — all verifications passed against existing code
- **Verified:**
  - `@mariozechner/pi-ai` = `^0.70.6` in package.json
  - `RuntimeKindSchema` includes `'pi-ai'` literal (line 24 of runtime-protocol.ts)
  - `adapter/index.ts` exports `PiAiRuntimeAdapter` and `PiAiRuntimeAdapterConfig`
  - `runtime-v2/index.ts` re-exports from `./adapter/index.js`

### Task 2: Implement PiAiRuntimeAdapter class
- **Status:** Complete
- **Commit:** `41458e4d`
- **File:** `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` (471 lines)
- **Implementation:**
  - `kind()` returns `'pi-ai'` literal
  - `getCapabilities()` returns 9-field RuntimeCapabilities (supportsStructuredJsonOutput, supportsModelSelection, supportsCancellation = true; rest false)
  - `healthCheck()` — 3-stage probe: apiKey exists → getModel valid → complete with `{"ok":true}` verification
  - `startRun()` — one-shot: AbortSignal.timeout → build Context → completeWithRetry → extractJsonObject → Value.Check(DiagnosticianOutputV1Schema) → store output
  - `pollRun()` — returns stored RunStatus (always terminal)
  - `fetchOutput()` — returns stored StructuredRunOutput | null
  - `fetchArtifacts()` — returns `[]`
  - `cancelRun()` — no-op for one-shot pattern
  - `completeWithRetry()` — exponential backoff, maxRetries default 2, passes maxRetries:0 to pi-ai
  - `extractJsonObject()` — code-fenced + balanced-bracket JSON extraction
  - `isAbortError()` — broad abort/timeout detection for any provider SDK
  - Telemetry: `runtime_invocation_started`, `runtime_invocation_succeeded`, `runtime_invocation_failed`

## Verification Results

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| TypeScript build | exit 0 | exit 0 | PASS |
| File lines | >= 200 | 471 | PASS |
| Value.Check usage | >= 1 | 1 | PASS |
| extractJsonObject | >= 2 | 3 | PASS |
| isAbortError | >= 2 | 4 | PASS |
| timeoutMs in complete() | >= 2 | 6 | PASS |
| emitTelemetry | >= 3 | 3 | PASS |
| healthCheck probe | 1 | 1 | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Type] getModel() generic too strict for dynamic config**
- **Found during:** Task 2
- **Issue:** `getModel<TProvider, TModelId>()` requires `TModelId extends keyof (typeof MODELS)[TProvider]` — when TProvider is the full KnownProvider union, TModelId becomes `never`
- **Fix:** Created `resolveModel()` helper that casts `getModel as any` with a comment explaining the safety assumption (config values come from workflows.yaml policy layer)
- **Files modified:** pi-ai-runtime-adapter.ts
- **Commit:** 41458e4d

**2. [Rule 3 - Lint] 7 ESLint errors in initial implementation**
- **Found during:** Task 2 commit
- **Issues:** unused variable, uninitialized declaration, class-methods-use-this (2), array destructuring, max-params, useless assignment
- **Fix:** Moved isAbortError/extractJsonObject to standalone functions, restructured healthCheck to combine stage 2+3 into single try-catch, used options object for completeWithRetry params
- **Files modified:** pi-ai-runtime-adapter.ts
- **Commit:** 41458e4d

## Known Stubs

None — all methods are fully implemented with real pi-ai API calls.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes. API keys are read from environment variables (not hardcoded).

## Self-Check: PASSED

- [x] pi-ai-runtime-adapter.ts exists
- [x] Commit 41458e4d exists
- [x] SUMMARY.md exists
