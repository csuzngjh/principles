---
phase: m9-03
reviewed: 2026-04-29T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts
  - packages/principles-core/src/runtime-v2/index.ts
  - packages/pd-cli/src/commands/diagnose.ts
  - packages/pd-cli/src/index.ts
  - packages/principles-core/src/runtime-v2/cli/probe.ts
  - packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts
  - packages/principles-core/src/workflow-funnel-loader.ts
  - packages/pd-cli/src/commands/runtime.ts
findings:
  critical: 0
  warning: 4
  info: 2
  total: 6
status: issues_found
---

# Phase m9-03: Code Review Report

**Reviewed:** 2026-04-29
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

The m9-03 phase implements CLI commands for diagnosing tasks and probing runtime health, along with the PiAiRuntimeAdapter for direct LLM calls. The code is generally well-structured with thorough error classification, good telemetry coverage, and proper input validation. Four warnings and two info items were identified. No critical security vulnerabilities or data-loss risks were found.

## Warnings

### WR-01: Dead code in `fetchArtifacts` — result of `this.runs.get(runId)` is discarded

**File:** `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts:516`

**Issue:** The `fetchArtifacts` method calls `this.runs.get(runId)` but does not use the returned value. The call is a no-op:

```typescript
async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
  this.runs.get(runId);  // Result discarded — dead code
  return [];
}
```

**Fix:** Remove the orphaned call or replace with a comment explaining why it exists:

```typescript
async fetchArtifacts(_runId: string): Promise<RuntimeArtifactRef[]> {
  // Artifact fetching not yet implemented — pi-ai is a one-shot model
  return [];
}
```

---

### WR-02: Non-null assertions after validation — type safety gap if validation logic changes

**File:** `packages/pd-cli/src/commands/diagnose.ts:215-217`

**Issue:** After validating that `provider`, `model`, and `apiKeyEnv` are truthy (lines 194-212), the code uses non-null assertions at lines 215-217:

```typescript
const validProvider = provider!;
const validModel = model!;
const validApiKeyEnv = apiKeyEnv!;
```

If a future code change removes or weakens the truthiness check, these assertions would turn a potentially undefined value into a runtime crash. The validation (lines 194-212) correctly catches empty strings and other falsy values, so this is defensive coding — but the pattern is fragile.

**Fix:** Use a type assertion with a comment, or restructure so TypeScript can verify the narrowing:

```typescript
// After validation above, all fields are guaranteed to be defined (process.exit never returns)
const validProvider = provider as string;
const validModel = model as string;
const validApiKeyEnv = apiKeyEnv as string;
```

Or better: validate with a schema library that produces a typed narrow result, then destructure with confirmed types.

---

### WR-03: Module-level mutable cache in `createPainSignalBridge` — state persists across workspaces in long-running processes

**File:** `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts:136`

**Issue:** A process-level `Map` is used as a bridge cache:

```typescript
const bridgeCache = new Map<string, PainSignalBridge>();
```

In long-running CLI processes (e.g., pd-cli as a daemon) or when many workspaces are accessed, this cache accumulates entries that are never cleaned up unless `invalidatePainSignalBridge` is explicitly called. No maximum cache size or TTL is enforced.

**Fix:** Document the cache lifetime expectation, or add a maximum cache size with LRU eviction. The existing `invalidatePainSignalBridge` function already supports cache invalidation — ensure callers invoke it appropriately when workspace state changes.

---

### WR-04: `@ts-expect-error` used for intentional type cast — consider an explicit interface

**File:** `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts:73`

**Issue:** The `resolveModel` function uses `@ts-expect-error` to suppress a TypeScript error when calling `getModel` with a runtime string:

```typescript
// @ts-expect-error — getModel requires literal model ID types; runtime strings from config are acceptable
return getModel(provider as KnownProvider, modelId);
```

This is a valid suppression (the comment explains the intent), but `@ts-expect-error` silently hides all type errors in the line, including accidental ones if the types change.

**Fix:** Consider creating a typed wrapper or interface that documents the intentional cast:

```typescript
// Cast is intentional: runtime config strings are validated KnownProviders
const typedProvider = provider as KnownProvider;
return getModel(typedProvider, modelId);
```

Or define a local type assertion function with a clear name and comment.

---

## Info

### IN-01: Unused variable in error handling — `runtimeKind` is always `'pi-ai'` in this branch

**File:** `packages/pd-cli/src/commands/diagnose.ts:326`

**Issue:** In the error handling path for `pi-ai` runtime, `runtimeKind` is always `'pi-ai'` since it is set at line 109 and only `'pi-ai'` enters this branch. The variable is included in the JSON output but is always a constant value:

```typescript
console.log(JSON.stringify({
  status: 'failed',
  errorCategory,
  message,
  runtimeKind,  // Always 'pi-ai' in this branch
}, null, 2));
```

**Fix:** Either hardcode the string `'pi-ai'` for clarity, or remove it if redundant with other context.

---

### IN-02: `probe.ts` conditionally passes `workspaceDir` to `OpenClawCliRuntimeAdapter` — ensure TypeScript types align with runtime behavior

**File:** `packages/principles-core/src/runtime-v2/cli/probe.ts:56-60`

**Issue:** The `OpenClawCliRuntimeAdapter` options object only includes `workspaceDir` when it is defined:

```typescript
const adapter = new OpenClawCliRuntimeAdapter({
  runtimeMode: options.runtimeMode,
  workspaceDir: options.workspaceDir,  // only when defined
  agentId: options.agentId,
});
```

Verify that the `OpenClawCliRuntimeAdapterOptions` type correctly marks `workspaceDir` as optional, so there is no gap between the TypeScript type and the runtime behavior.

---

## Critical Issues

None found.

---

_Reviewed: 2026-04-29_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
