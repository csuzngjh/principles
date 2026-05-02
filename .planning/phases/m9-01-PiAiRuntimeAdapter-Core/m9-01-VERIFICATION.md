---
phase: m9-01-PiAiRuntimeAdapter-Core
verified: 2026-04-29T11:15:00Z
status: passed
score: 17/17 requirement IDs verified
re_verification: false
gaps: []
human_verification: []
---

# Phase m9-01: PiAiRuntimeAdapter Core — Verification Report

**Phase Goal:** PiAiRuntimeAdapter Core — implement PDRuntimeAdapter interface + pi-ai complete call + DiagnosticianOutputV1 validation
**Verified:** 2026-04-29T11:15:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (PLAN 01 must_haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | PiAiRuntimeAdapter satisfies the full PDRuntimeAdapter contract | VERIFIED | 471-line class implements all 8 required methods: `kind()`, `getCapabilities()`, `healthCheck()`, `startRun()`, `pollRun()`, `cancelRun()`, `fetchOutput()`, `fetchArtifacts()`. TypeScript build passes with exit 0. All 40 tests pass. |
| 2 | LLM calls time out cleanly when the provider is slow | VERIFIED | `AbortSignal.timeout(effectiveTimeoutMs)` used (line 271). `isAbortError()` broad detection covers DOMException AbortError, message patterns, and object shape. Test: "throws PDRuntimeError('timeout') when LLM request is aborted/timed out" passes. |
| 3 | Missing API key produces a clear runtime_unavailable error | VERIFIED | `process.env[this.config.apiKeyEnv]` check at line 253 throws `PDRuntimeError('runtime_unavailable', ...)`. Test: "throws PDRuntimeError('runtime_unavailable') when apiKeyEnv missing from process.env" passes. |
| 4 | Invalid LLM output is caught and reported as output_invalid | VERIFIED | Three-stage validation: text content guard (line 309), `extractJsonObject()` null check (line 315), `Value.Check(DiagnosticianOutputV1Schema, parsed)` (line 320). Tests: no parseable JSON and schema mismatch both pass. |
| 5 | Transient LLM failures are retried before giving up | VERIFIED | `completeWithRetry()` (lines 436-470) implements exponential backoff with `maxRetries ?? 2`. Passes `maxRetries: 0` to pi-ai to avoid double-retry. Tests: "retries transient failures up to maxRetries times" and "succeeds on second attempt after first transient failure" both pass. |
| 6 | Telemetry events are emitted for every invocation lifecycle | VERIFIED | Three `emitTelemetry()` calls: `runtime_invocation_started` (line 288), `runtime_invocation_succeeded` (line 334), `runtime_invocation_failed` (line 363). Tests verify all three events are emitted. |

**Score:** 6/6 truths verified

### Observable Truths (PLAN 02 must_haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | All PDRuntimeAdapter methods are tested for PiAiRuntimeAdapter | VERIFIED | Test file has `describe` blocks for: kind(), getCapabilities(), healthCheck(), startRun(), pollRun(), cancelRun(), fetchOutput(), fetchArtifacts(). 40 tests total. |
| 2 | pi-ai getModel/complete calls are verified with correct parameters | VERIFIED | Tests verify `getModel('openrouter', 'anthropic/claude-sonnet-4')` and `complete(model, context, { apiKey, timeoutMs, maxRetries: 0 })`. |
| 3 | DiagnosticianOutputV1 validation uses TypeBox Value.Check | VERIFIED | Implementation uses `Value.Check(DiagnosticianOutputV1Schema, parsed)` at line 320. Schema mismatch test confirms `output_invalid` error. |
| 4 | AbortError maps to PDRuntimeError('timeout') | VERIFIED | `isAbortError()` function covers broad abort detection. Test: "throws PDRuntimeError('timeout') when LLM request is aborted/timed out" passes. |
| 5 | Missing apiKeyEnv maps to PDRuntimeError('runtime_unavailable') | VERIFIED | Test: "throws PDRuntimeError('runtime_unavailable') when apiKeyEnv missing from process.env" passes. |
| 6 | JSON parse failure maps to PDRuntimeError('output_invalid') | VERIFIED | Test: "throws PDRuntimeError('output_invalid') when LLM response contains no parseable JSON" passes. |
| 7 | Retry with exponential backoff is tested | VERIFIED | Tests verify retry counts (2 retries, 3 total calls), second-attempt success, and non-retry on PDRuntimeError. Backoff delay: `Math.min(1000 * Math.pow(2, attempt), 30_000)`. |
| 8 | Telemetry events are emitted on success/failure | VERIFIED | Tests: "emits runtime_invocation_started", "emits runtime_invocation_succeeded", "emits runtime_invocation_failed", "emits runtime_invocation_started before LLM call (even if call fails)" — all pass. |

**Score:** 8/8 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` | PiAiRuntimeAdapter class implementing PDRuntimeAdapter, min 200 lines | VERIFIED | 471 lines. Full implementation with all 8 interface methods, 3 private helpers (resolveModel, isAbortError, extractJsonObject, completeWithRetry). |
| `packages/principles-core/package.json` | @mariozechner/pi-ai dependency declaration | VERIFIED | `"@mariozechner/pi-ai": "^0.70.6"` in dependencies (line 77). |
| `packages/principles-core/src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` | PiAiRuntimeAdapter unit tests, min 250 lines | VERIFIED | 605 lines. 40 passing tests with mocked pi-ai module. vi.mock for both `@mariozechner/pi-ai` and `store/event-emitter`. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `adapter/index.ts` | `pi-ai-runtime-adapter.ts` | `export { PiAiRuntimeAdapter }` | VERIFIED | Lines 5-6 of index.ts |
| `runtime-v2/index.ts` | `adapter/index.js` | `export { PiAiRuntimeAdapter }` | VERIFIED | Line 188 of runtime-v2/index.ts |
| `runtime-protocol.ts` | `RuntimeKindSchema` | `Type.Literal('pi-ai')` | VERIFIED | Line 24 of runtime-protocol.ts |
| `pi-ai-runtime-adapter.ts` | `@mariozechner/pi-ai` | `import { getModel, complete }` | VERIFIED | Lines 17-18 of adapter file |
| `pi-ai-runtime-adapter.ts` | `diagnostician-output.ts` | `import { DiagnosticianOutputV1Schema }` | VERIFIED | Line 21 of adapter file |
| `pi-ai-runtime-adapter.ts` | `error-categories.ts` | `import { PDRuntimeError }` | VERIFIED | Line 20 of adapter file |
| `pi-ai-runtime-adapter.ts` | `store/event-emitter.ts` | `import { storeEmitter }` | VERIFIED | Lines 22-23 of adapter file |
| Test file | `pi-ai-runtime-adapter.ts` | `import { PiAiRuntimeAdapter }` | VERIFIED | Line 26 of test file |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript build | `cd packages/principles-core && npm run build` | exit 0 (no errors) | PASS |
| Unit tests pass | `npx vitest run src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts` | 40/40 passed, 5.29s | PASS |
| Implementation file lines | `wc -l pi-ai-runtime-adapter.ts` | 471 lines (>= 200) | PASS |
| Test file lines | `wc -l pi-ai-runtime-adapter.test.ts` | 605 lines (>= 250) | PASS |
| Value.Check usage | grep | 1 occurrence (line 320) | PASS |
| emitTelemetry calls | grep | 3 occurrences (lines 288, 334, 363) | PASS |
| Barrel exports | grep adapter/index.ts | PiAiRuntimeAdapter + PiAiRuntimeAdapterConfig exported | PASS |
| pi-ai dependency | package.json | `^0.70.6` declared | PASS |
| RuntimeKindSchema | runtime-protocol.ts | `'pi-ai'` literal at line 24 | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| RS-01 | Plan 01 | RuntimeKindSchema has `'pi-ai'` literal | SATISFIED | Line 24 of runtime-protocol.ts: `Type.Literal('pi-ai')` |
| RS-02 | Plan 01+02 | `kind()` returns `'pi-ai'` | SATISFIED | Implementation line 142: `return 'pi-ai'`. Test: "returns 'pi-ai' (RS-02)" passes. |
| AD-01 | Plan 01+02 | Implement all PDRuntimeAdapter methods | SATISFIED | 8 methods implemented: kind, getCapabilities, healthCheck, startRun, pollRun, cancelRun, fetchOutput, fetchArtifacts. All tested. |
| AD-02 | Plan 01+02 | `getModel(provider, modelId)` uses pi-ai | SATISFIED | `resolveModel()` calls `(getModel as any)(provider as KnownProvider, modelId)`. Test verifies `getModel('openrouter', 'anthropic/claude-sonnet-4')`. |
| AD-03 | Plan 01+02 | `complete(model, context, options?)` returns AssistantMessage | SATISFIED | `completeWithRetry()` calls `complete(model, context, { signal, apiKey, timeoutMs, maxRetries: 0 })`. Test verifies call parameters. |
| AD-04 | Plan 01+02 | DiagnosticianOutputV1 validation | SATISFIED | `Value.Check(DiagnosticianOutputV1Schema, parsed)` at line 320. Tests: schema mismatch and valid output both pass. |
| AD-05 | Plan 01+02 | `AbortSignal.timeout(timeoutMs)` | SATISFIED | Line 271: `const signal = AbortSignal.timeout(effectiveTimeoutMs)`. Timeout test passes. |
| AD-06 | Plan 01+02 | Constructor accepts config | SATISFIED | `PiAiRuntimeAdapterConfig` interface: `{ provider, model, apiKeyEnv, maxRetries?, timeoutMs?, workspace?, eventEmitter? }`. Test uses `makeAdapter()` helper. |
| AD-07 | Plan 01+02 | Missing apiKeyEnv throws runtime_unavailable | SATISFIED | Line 253-257: throws `PDRuntimeError('runtime_unavailable', ...)`. Test passes. |
| AD-08 | Plan 01+02 | maxRetries retry with exponential backoff | SATISFIED | `completeWithRetry()` lines 446-464. Delay: `Math.min(1000 * Math.pow(2, attempt), 30_000)`. Tests verify retry counts. |
| AD-09 | Plan 01+02 | startRun() one-shot: complete → validate → store → return | SATISFIED | Full flow in `startRun()`: completeWithRetry → extractJsonObject → Value.Check → store output → return RunHandle. Test verifies end-to-end. |
| AD-10 | Plan 01+02 | pollRun() returns terminal status | SATISFIED | Line 390-403: looks up RunState in Map, returns RunStatus. Test: "returns terminal status (succeeded) for completed run" passes. |
| AD-11 | Plan 01+02 | fetchOutput() returns stored StructuredRunOutput | SATISFIED | Lines 417-423: returns `state.output` or `null`. Test: "returns StructuredRunOutput with runId and payload" passes. |
| AD-12 | Plan 01+02 | fetchArtifacts() returns empty array | SATISFIED | Line 427: `return []`. Test: "returns empty array" passes. |
| AD-13 | Plan 01+02 | healthCheck() validates apiKey + getModel | SATISFIED | 3-stage probe: apiKey exists (line 171), getModel valid (line 183), complete probe with `{"ok":true}` verification (lines 193-222). 5 healthCheck tests pass. |
| AD-14 | Plan 01+02 | getCapabilities() returns correct shape | SATISFIED | Lines 147-158: `{ supportsStructuredJsonOutput: true, supportsToolUse: false, ..., supportsStreaming: false }`. Test verifies all 9 boolean fields. |
| AD-15 | Plan 01+02 | Telemetry events: started, succeeded, failed | SATISFIED | 3 `emitTelemetry()` calls with correct eventTypes. 4 telemetry tests pass. |

**All 17 requirement IDs (RS-01, RS-02, AD-01 through AD-15) are SATISFIED.**

---

### Context Decisions Honored

| Decision | Description | Status | Evidence |
|----------|-------------|--------|----------|
| D-01 | One-shot mode — startRun() blocks until LLM completes | HONORED | `startRun()` awaits `completeWithRetry()`, stores output, returns terminal RunHandle. pollRun() returns stored state. |
| D-02 | No default provider/model — must be explicitly configured | HONORED | Config requires `provider` and `model` fields (no defaults in PiAiRuntimeAdapterConfig). |
| D-03 | TypeBox strict validation — any schema mismatch → output_invalid | HONORED | `Value.Check(DiagnosticianOutputV1Schema, parsed)` at line 320 throws `PDRuntimeError('output_invalid', ...)` on failure. |
| Claude | AbortSignal.timeout for timeout control | HONORED | Line 271. |
| Claude | Exponential backoff retry, maxRetries default 2 | HONORED | `completeWithRetry()` with `maxRetries ?? 2`. |
| Claude | healthCheck validates apiKey + getModel + complete probe | HONORED | 3-stage probe implemented (lines 167-241). |
| Claude | Error mapping: AbortError→timeout, JSON→output_invalid, missing key→runtime_unavailable, retries→execution_failed | HONORED | All 5 error categories tested and verified. |

### Research Pitfalls Checked

| Pitfall | Description | Status | Evidence |
|---------|-------------|--------|----------|
| Pitfall 1 | UserMessage.timestamp missing | AVOIDED | Line 279: `timestamp: Date.now()` included in UserMessage. Test verifies `typeof context.messages[0].timestamp === 'number'`. |
| Pitfall 2 | Provider type cast unsafe | AVOIDED | `resolveModel()` helper (lines 67-72) uses `(getModel as any)` cast with safety comment. |
| Pitfall 3 | AbortSignal.timeout availability | AVOIDED | Used directly at line 271. Node.js >= 17.3.0 requirement met (project uses recent Node.js). |
| Pitfall 4 | AssistantMessage content array access | AVOIDED | Line 308: `response.content.find(c => c.type === 'text')` with null guard. |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | None found. No TODO/FIXME/placeholder comments. No hardcoded secrets. No console.log. No empty implementations. |

---

### Human Verification Required

No human verification needed. All behaviors have automated test coverage.

---

### Gaps Summary

No gaps found. All 17 requirement IDs are satisfied. All must-have truths are verified. All artifacts exist, are substantive, and are properly wired. TypeScript build passes. All 40 unit tests pass.

---

_Verified: 2026-04-29T11:15:00Z_
_Verifier: Claude (gsd-verifier)_
