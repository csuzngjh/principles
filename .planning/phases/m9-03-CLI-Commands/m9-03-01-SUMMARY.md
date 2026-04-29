---
phase: m9-03
plan: 01
type: summary
status: complete
depends_on: []
files_modified:
  - packages/principles-core/src/runtime-v2/cli/probe.ts
  - packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts
  - packages/principles-core/src/runtime-v2/index.ts
  - packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts
  - packages/principles-core/src/workflow-funnel-loader.ts
  - packages/pd-cli/src/commands/runtime.ts
  - packages/pd-cli/src/commands/diagnose.ts
  - packages/pd-cli/src/index.ts
---

# m9-03-01 Summary: probeRuntime() + pd runtime probe for pi-ai

## What Changed

### 1. FunnelPolicy: baseUrl added
- `workflow-funnel-loader.ts`: Added `baseUrl?: string` to `FunnelPolicy` interface

### 2. resolveModel: clear error for custom providers without baseUrl
- `pi-ai-runtime-adapter.ts`: Non-built-in provider without baseUrl now throws `PDRuntimeError('runtime_unavailable', ...)` instead of falling back to `https://{provider}.example.com/v1`

### 3. Factory: baseUrl as first-class config
- `pain-signal-runtime-factory.ts`:
  - `RuntimeConfig` exported with `baseUrl?: string`
  - `resolveRuntimeConfig()` reads `policy.baseUrl`
  - `validateRuntimeConfig()` requires `baseUrl` for non-built-in providers
  - `createPainSignalBridge()` passes `baseUrl` to PiAiRuntimeAdapter

### 4. probe.ts: discriminated union extended
- `ProbeOptions` and `ProbeResult` now support `runtimeKind: 'pi-ai'` with `baseUrl?: string`
- `probeRuntime()` creates PiAiRuntimeAdapter for pi-ai, returns ProbeResult with provider/model

### 5. CLI: --baseUrl flag registered
- `pd-cli/src/index.ts`: Added `--baseUrl`, `--provider`, `--model`, `--apiKeyEnv`, `--maxRetries`, `--timeoutMs` to probe command
- `pd-cli/src/commands/runtime.ts`: Added pi-ai branch with flag validation, probeRuntime call, formatted output including `baseUrlPresent` in JSON

### 6. diagnose.ts: pi-ai branch with baseUrl
- Added `PiAiRuntimeAdapter`, `resolveRuntimeConfig` imports
- Added `baseUrl` to `DiagnoseRunOptions` interface
- Added pi-ai branch: flag → policy fallback → validation → PiAiRuntimeAdapter creation → telemetry
- JSON output includes `baseUrlPresent` (never the actual URL or key)

### 7. Barrel exports
- `runtime-v2/index.ts`: Exports `resolveRuntimeConfig`, `validateRuntimeConfig`, `RuntimeConfig`

## Hard Gate Result

```
Provider: xiaomi-coding
Model:    mimo-v2.5-pro
Key:      ANTHROPIC_AUTH_TOKEN
BaseUrl:  https://token-plan-cn.xiaomimimo.com/v1
```

```json
{
  "status": "succeeded",
  "runtimeKind": "pi-ai",
  "provider": "xiaomi-coding",
  "model": "mimo-v2.5-pro",
  "baseUrlPresent": true,
  "health": {
    "healthy": true,
    "degraded": false,
    "warnings": [],
    "lastCheckedAt": "2026-04-29T07:43:34.197Z"
  }
}
```

- health.healthy = true
- status = succeeded
- exit code = 0
- baseUrlPresent = true

**P1 Hard Gate: PASSED**

## Tests

- 48/48 PiAiRuntimeAdapter unit tests: PASSED
- 74/74 workflow-funnel-loader tests: PASSED
- TypeScript compilation: CLEAN (both packages)

## Security

- No API key values in any console output
- JSON output includes `baseUrlPresent: boolean` (not the URL itself for diagnose)
- `apiKeyEnv` string (env var name) is safe to log; `process.env[apiKeyEnv]` never appears
