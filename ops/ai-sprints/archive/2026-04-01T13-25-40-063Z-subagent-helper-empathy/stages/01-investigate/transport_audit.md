# Empathy Observer - Transport Audit

## Overview
This document audits the empathy observer's subagent transport mechanism, comparing it against the registry_backed alternative.

---

## Transport Type: RUNTIME_DIRECT

**Verdict**: The empathy observer uses **RUNTIME_DIRECT** transport

### Evidence

**File**: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`

**Runtime Probe** (L193-200):
```typescript
const result = await api.runtime.subagent.run({
    sessionKey,
    message: prompt,
    lane: 'subagent',
    deliver: false,
    idempotencyKey: `${sessionId}:${Date.now()}`,
    expectsCompletionMessage: true,
}) as SubagentRunResult;
```

**Direct Runtime Calls**:
| Method | Line | Purpose |
|--------|------|---------|
| `api.runtime.subagent.run()` | L193 | Spawn subagent |
| `api.runtime.subagent.waitForRun()` | L253 | Wait for completion |
| `api.runtime.subagent.getSessionMessages()` | L321 | Retrieve results |
| `api.runtime.subagent.deleteSession()` | L385 | Cleanup session |

**Runtime Availability Probe** (`subagent-probe.ts` L94):
```typescript
export async function isSubagentRuntimeAvailable(
    subagent: unknown
): Promise<boolean> {
    return typeof subagent?.run === 'function' &&
           typeof subagent?.waitForRun === 'function' &&
           typeof subagent?.getSessionMessages === 'function' &&
           typeof subagent?.deleteSession === 'function';
}
```

---

## Transport Comparison

### RUNTIME_DIRECT (Used by Empathy)

| Aspect | Behavior |
|--------|----------|
| Discovery | Direct `api.runtime.subagent.*` calls |
| Transport | Direct function calls to OpenClaw runtime |
| Session Mode | `deliver: false`, `expectsCompletionMessage: true` |
| Fallback | `subagent_ended` hook |
| Timeout Handling | `waitForRun()` with 30s default |

### REGISTRY_BACKED (Alternative - NOT Used)

| Aspect | Behavior |
|--------|----------|
| Discovery | Via agent registry |
| Transport | Registry-mediated session management |
| Session Mode | Unknown |
| Fallback | Unknown |
| Timeout Handling | Unknown |

---

## Session Key Format

**Empathy Observer Sessions**:
```
agent:main:subagent:empathy-obs-{safeParentSessionId}-{timestamp}
```

**Example**: `agent:main:subagent:empathy-obs-session123-1712000000000`

**Construction** (`empathy-observer-manager.ts` L77-83):
```typescript
buildEmpathyObserverSessionKey(parentSessionId: string): string {
    const safeParentSessionId = parentSessionId
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 64);
    const timestamp = Date.now();
    return `${OBSERVER_SESSION_PREFIX}${safeParentSessionId}-${timestamp}`;
}
```

---

## Idempotency Key Analysis

**Current Implementation** (`empathy-observer-manager.ts` L198):
```typescript
idempotencyKey: `${sessionId}:${Date.now()}`
```

**Issue**: Uses `Date.now()` which is NOT stable for retries:
- If a spawn fails and retries, a new `Date.now()` is generated
- The idempotency key is therefore NOT idempotent
- This is the **correct** answer to hypothesis `empathy_lacks_dedupe_key`

**Migration Target** (for workflow helper):
- Should use stable key: `${sessionId}` only
- Or use a hash of the parent session + workspace

---

## Runtime Mode Detection

**Detection Logic** (`subagent-probe.ts`):
```typescript
export async function isSubagentRuntimeAvailable(subagent: unknown): Promise<boolean> {
    // Probe for required methods
    return typeof subagent?.run === 'function' &&
           typeof subagent?.waitForRun === 'function' &&
           typeof subagent?.getSessionMessages === 'function' &&
           typeof subagent?.deleteSession === 'function';
}
```

**Usage** (`empathy-observer-manager.ts` L151):
```typescript
const subagentOk = isSubagentRuntimeAvailable(api.runtime?.subagent);
```

---

## Key Finding: `expectsCompletionMessage` Parameter

**Observation**: `expectsCompletionMessage` is NOT in the official `SubagentRunParams` type (`openclaw-sdk.d.ts` L86-93)

**SDK Type**:
```typescript
export interface SubagentRunParams {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    lane?: string;
    deliver?: boolean;
    idempotencyKey?: string;
}
```

**Empathy Usage**:
```typescript
api.runtime.subagent.run({
    ...
    expectsCompletionMessage: true, // NOT in official SDK type!
})
```

**Analysis**: This appears to be an extension beyond the official SDK, possibly:
1. A plugin-specific extension
2. An undocumented official feature
3. A custom parameter that happens to work

**Risk**: This parameter may not be officially supported

---

## Evidence

**Files Examined**:
- `packages/openclaw-plugin/src/service/empathy-observer-manager.ts` (511 lines)
- `packages/openclaw-plugin/src/utils/subagent-probe.ts` (94 lines)
- `packages/openclaw-plugin/src/openclaw-sdk.d.ts` (464 lines)
- `packages/openclaw-plugin/src/tools/deep-reflect.ts` (410 lines)

**SHA**: Current HEAD