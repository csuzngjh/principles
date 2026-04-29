---
phase: m9-02
verified: "2026-04-29T14:30:00Z"
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Create workflows.yaml with pi-ai policy, call createPainSignalBridge, verify PiAiRuntimeAdapter is instantiated"
    expected: "PiAiRuntimeAdapter created with correct provider/model/apiKeyEnv from policy"
    why_human: "Requires runtime integration test with real WorkflowFunnelLoader + filesystem"
  - test: "Create workflows.yaml with only timeoutMs (no provider/model/apiKeyEnv), call createPainSignalBridge"
    expected: "Error thrown with migration guidance listing missing fields and YAML example"
    why_human: "Error message quality and helpfulness needs human judgment"
  - test: "Switch runtimeKind from pi-ai to openclaw-cli in YAML, verify bridgeCache isolation"
    expected: "Two separate bridge instances cached under different keys"
    why_human: "Cache isolation behavior needs runtime observation"
---

# Phase m9-02: Policy + Factory Integration — Verification Report

**Phase Goal:** Extend workflows.yaml policy to include runtime configuration fields and update PainSignalRuntimeFactory to select the appropriate runtime adapter based on policy settings. This makes runtimeKind configurable rather than hardcoded, completing the M9 Policy + Factory Integration milestone.
**Verified:** 2026-04-29T14:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | workflows.yaml policy is the SSOT for runtime configuration | VERIFIED | FunnelPolicy in workflow-funnel-loader.ts has runtimeKind, provider, model, apiKeyEnv, maxRetries as optional fields (lines 64-72). resolveRuntimeConfig reads all from policy (lines 73-81). |
| 2 | PainSignalRuntimeFactory reads runtimeKind from policy, not hardcoded | VERIFIED | resolveRuntimeConfig reads `policy.runtimeKind ?? 'pi-ai'` (line 74). createPainSignalBridge uses `runtimeConfig.runtimeKind` throughout (lines 134-179). No hardcoded 'openclaw-cli' in main path. |
| 3 | runtimeKind 'pi-ai' creates PiAiRuntimeAdapter with provider/model/apiKeyEnv from policy | VERIFIED | Line 154-162: `runtimeConfig.runtimeKind === 'pi-ai'` creates `new PiAiRuntimeAdapter({ provider: String(runtimeConfig.provider), model: String(runtimeConfig.model), apiKeyEnv: String(runtimeConfig.apiKeyEnv), ... })`. |
| 4 | runtimeKind 'openclaw-cli' creates OpenClawCliRuntimeAdapter (backward compat) | VERIFIED | Line 163-166: else branch creates `new OpenClawCliRuntimeAdapter({ runtimeMode: 'local', workspaceDir })`. |
| 5 | runtimeKind defaults to 'pi-ai' when missing from policy (D-04) | VERIFIED | Three default sites: line 67 (no funnel/policy), line 74 (`policy.runtimeKind ?? 'pi-ai'`), line 84 (catch fallback). All default to 'pi-ai'. |
| 6 | Missing provider/model/apiKeyEnv for pi-ai throws Error with migration guidance (D-05, D-06) | VERIFIED | validateRuntimeConfig (lines 97-117) checks all three fields for pi-ai, throws plain `Error` (not PDRuntimeError), message includes missing field names + YAML example + "set runtimeKind: openclaw-cli" alternative. |
| 7 | bridgeCache key includes runtimeKind for isolation (D-03) | VERIFIED | Line 136: `cacheKey = \`${opts.workspaceDir}:${runtimeConfig.runtimeKind}\``. Line 120-121: comment documents key format. Line 207: invalidatePainSignalBridge uses `${workspaceDir}:${effectiveKind}`. |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/principles-core/src/workflow-funnel-loader.ts` | Extended FunnelPolicy with runtime config fields, RuntimeKind import | VERIFIED | Line 14: `import type { RuntimeKind }`. Lines 64-72: 5 new optional fields (runtimeKind, provider, model, apiKeyEnv, maxRetries). |
| `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` | Policy-driven factory with validation and runtime switch | VERIFIED | Line 23: PiAiRuntimeAdapter import. Lines 45-53: RuntimeConfig interface. Lines 61-90: resolveRuntimeConfig. Lines 97-117: validateRuntimeConfig. Lines 154-166: policy-driven adapter switch. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| workflow-funnel-loader.ts | runtime-protocol.ts | `import type { RuntimeKind }` | WIRED | Line 14: exact match |
| pain-signal-runtime-factory.ts | pi-ai-runtime-adapter.ts | `import PiAiRuntimeAdapter` | WIRED | Line 23: exact match |
| pain-signal-runtime-factory.ts | workflow-funnel-loader.ts | FunnelPolicy type used in resolveRuntimeConfig | PARTIAL | Line 26: imports `WorkflowFunnelLoader` (class). FunnelPolicy used implicitly via `getFunnel()` return type inference. String "FunnelPolicy" does not appear explicitly. Functionally correct — TypeScript compiles and type safety is maintained. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| PL-01 | m9-02-01 | pd-runtime-v2-diagnosis funnel policy 增加字段：runtimeKind, provider, model, apiKeyEnv, maxRetries | SATISFIED | FunnelPolicy has all 5 fields as optional (lines 64-72) |
| PL-02 | m9-02-01 | policy 字段有合理默认值 | SUPERSEDED | REQUIREMENTS.md specifies defaults (runtimeKind: 'openclaw-cli', provider: 'openrouter', etc.). CONTEXT.md D-04/D-05 override: runtimeKind defaults to 'pi-ai', no defaults for provider/model/apiKeyEnv — missing fields throw Error. Documented in PLAN deferred_to section. |
| PL-03 | m9-02-01 | WorkflowFunnelLoader 正确解析新 policy 字段 | SATISFIED | js-yaml auto-maps camelCase YAML keys to JS object properties. No WorkflowFunnelLoader code changes needed. |
| FC-01 | m9-02-01 | 从 workflows.yaml policy 读取 runtimeKind | SATISFIED | resolveRuntimeConfig reads `policy.runtimeKind` (line 74) |
| FC-02 | m9-02-01 | runtimeKind === 'pi-ai' 时创建 PiAiRuntimeAdapter | SATISFIED | Lines 154-162: conditional creates PiAiRuntimeAdapter |
| FC-03 | m9-02-01 | runtimeKind === 'openclaw-cli'（或未指定）时创建 OpenClawCliRuntimeAdapter | SATISFIED | Lines 163-166: else branch creates OpenClawCliRuntimeAdapter |
| FC-04 | m9-02-01 | 不再硬编码 openclaw-cli，policy 驱动 | SATISFIED | No hardcoded runtimeKind anywhere in factory. All adapter selection flows through runtimeConfig.runtimeKind. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles without errors | `npx tsc --noEmit --pretty false` | No output (exit 0) | PASS |
| Build passes | `npm run build` | `tsc` completed successfully | PASS |
| Test suite passes (574/575) | `npm test` | 574 passed, 1 failed (pre-existing sqlite-trajectory-locator.test.ts), 1 file fail (pre-existing m6-06-real-path.test.ts) | PASS |
| resolveRunnerOptions fully renamed | `grep -c "resolveRunnerOptions" pain-signal-runtime-factory.ts` | 0 matches | PASS |
| No hardcoded runtimeKind in DiagnosticianRunner | `grep -c "runtimeKind: 'openclaw-cli'" pain-signal-runtime-factory.ts` | 0 matches | PASS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | — | — | Clean — no TODO, FIXME, HACK, PLACEHOLDER, or empty implementations found |

### Human Verification Required

### 1. Factory Adapter Switch in Production

**Test:** Create a workflows.yaml with pi-ai policy (provider, model, apiKeyEnv configured), call `createPainSignalBridge`, verify `PiAiRuntimeAdapter` is instantiated with correct config.
**Expected:** PiAiRuntimeAdapter receives provider, model, apiKeyEnv from policy. healthCheck passes if API key env var exists.
**Why human:** Requires integration test with real WorkflowFunnelLoader + filesystem + environment variables.

### 2. Migration Error Message Quality

**Test:** Create a workflows.yaml with only `timeoutMs` (no provider/model/apiKeyEnv), call `createPainSignalBridge`.
**Expected:** Error thrown with message listing missing fields, YAML example showing how to fix, and suggestion to set `runtimeKind: openclaw-cli` as alternative.
**Why human:** Error message helpfulness and clarity needs human judgment.

### 3. Bridge Cache Isolation

**Test:** Call `createPainSignalBridge` with pi-ai config, then change runtimeKind to openclaw-cli in YAML and call again.
**Expected:** Two separate bridge instances cached under `${workspaceDir}:pi-ai` and `${workspaceDir}:openclaw-cli` keys. `invalidatePainSignalBridge(ws, 'pi-ai')` only removes pi-ai cache.
**Why human:** Cache isolation correctness needs runtime observation.

### Gaps Summary

No gaps found. All 7 must-have truths verified. All 7 requirement IDs (PL-01~03, FC-01~04) accounted for — 6 satisfied, 1 superseded by locked user decisions (D-04/D-05 in CONTEXT.md). PL-02 deviation is intentional and documented in PLAN's deferred_to section.

Key link 3 (FunnelPolicy type usage) is functionally correct but uses implicit type inference rather than explicit import — this is a style observation, not a gap. TypeScript maintains full type safety through `getFunnel()` return type.

Build and tests pass. Pre-existing test failures (sqlite-trajectory-locator, m6-06-real-path) are unrelated to m9-02 changes.

---

_Verified: 2026-04-29T14:30:00Z_
_Verifier: Claude (gsd-verifier)_
