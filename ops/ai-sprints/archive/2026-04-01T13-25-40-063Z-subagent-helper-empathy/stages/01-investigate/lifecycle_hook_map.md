# Empathy Observer - Lifecycle Hook Map

## Overview
This document maps all lifecycle hooks used by the empathy observer system, their registration points, and their relationships.

## Hook Inventory

### 1. `subagent_ended`

**Purpose**: Fallback recovery when main path (waitForRun) fails or times out

**Empathy Observer Usage**: `empathy-observer-manager.ts` L401-428

**Registration**: 
- File: `index.ts`
- Line: 232
- Handler: `handleSubagentEnded` in `subagent.ts`

**Handler Dispatch** (`subagent.ts` L175-178):
```typescript
if (isEmpathyObserverSession(targetSessionKey || '')) {
    await empathyObserverManager.reap(ctx.api, targetSessionKey!, workspaceDir);
    return;
}
```

**Empathy Observer Configuration**:
- `deliver: false` - No announce delivery
- `expectsCompletionMessage: true` - Completion mode (NOT session mode)

**Run Mode Analysis**:
| Parameter | Value | Meaning |
|-----------|-------|---------|
| `deliver` | `false` | No announce delivery needed |
| `expectsCompletionMessage` | `true` | Completion mode (waits for subagent to finish) |
| Resulting Mode | **Completion Mode** | subagent_ended WILL fire |

**Cross-Repo Verification** (reviewer B findings):
- Completion-mode `subagent_ended` is **DEFERRED** until announce delivery resolves
- **HOWEVER**: empathy uses `deliver: false`, meaning NO announce delivery is needed
- With `deliver: false`, completion-mode subagent_ended fires PROMPTLY after subagent completion
- Session-mode (`expectsCompletionMessage: false`) `subagent_ended` is **NEVER** emitted

**Failure Mode**: Fire-and-forget (parallel, errors swallowed) - `hooks.ts` L946

---

### 2. `subagent_spawning`

**Purpose**: Shadow routing (NOT empathy-specific)

**Empathy Observer Usage**: NOT used by empathy observer directly

**Registration**: `index.ts` (general plugin registration)

**Reference**: `prompt.ts` L836 mentions shadow evidence from `subagent_spawning`

---

### 3. `subagent_spawned`

**Purpose**: Not used by empathy observer

**Empathy Observer Usage**: NOT registered

---

### 4. `subagent_delivery_target`

**Purpose**: Determines delivery target for subagent messages

**Empathy Observer Usage**: NOT directly used by empathy observer

**OpenClaw SDK Type** (`openclaw-sdk.d.ts` L382-395):
```typescript
export type PluginHookSubagentDeliveryTargetEvent = {
    childSessionKey: string;
    requesterSessionKey: string;
    requesterOrigin?: { ... };
    childRunId?: string;
    spawnMode?: 'run' | 'session';
    expectsCompletionMessage: boolean;
};
```

---

## Hook Call Flow

### Main Recovery Path (Primary)
```
1. spawn() → api.runtime.subagent.run()
2. finalizeRun() → api.runtime.subagent.waitForRun()
3. If OK: reapBySession() → trackFriction() → deleteSession()
4. If timeout/error: cleanupState(..., false) → preserve activeRuns entry
```

### Fallback Recovery Path (Secondary - via `subagent_ended`)
```
1. subagent_ended hook fires (completion-mode)
2. handleSubagentEnded() in subagent.ts
3. Dispatch to empathyObserverManager.reap()
4. reapBySession() → trackFriction() → deleteSession()
5. markCompleted() → add to completedSessions TTL map
```

---

## Session Key Format

**Empathy Observer Sessions**:
- Prefix: `agent:main:subagent:empathy-obs-`
- Format: `agent:main:subagent:empathy-obs-{safeParentSessionId}-{timestamp}`
- Example: `agent:main:subagent:empathy-obs-session123-1712000000000`

**Detection Function** (`empathy-observer-manager.ts` L509-511):
```typescript
export function isEmpathyObserverSession(sessionKey: string): boolean {
    return typeof sessionKey === 'string' && sessionKey.startsWith(OBSERVER_SESSION_PREFIX);
}
```

---

## Completion vs Session Mode

| Mode | `expectsCompletionMessage` | `subagent_ended` Behavior | Empathy Usage |
|------|---------------------------|---------------------------|--------------|
| **Completion** | `true` | Fires (deferred if announce delivery needed) | YES - empathy uses this |
| **Session** | `false` | NEVER emitted | NO |

**Empathy Observer Configuration**:
- Uses `deliver: false` + `expectsCompletionMessage: true`
- This is **Completion Mode**
- `subagent_ended` WILL fire (promptly since `deliver: false`)

---

## TTL and Cleanup

**Active Runs TTL**: 5 minutes (`activeRuns` map)
- Location: `empathy-observer-manager.ts` L99, L113, L122
- Purpose: Orphan detection if fallback never fires

**Completed Sessions TTL**: 5 minutes (`completedSessions` map)
- Location: `empathy-observer-manager.ts` L92-104
- Purpose: Idempotency dedupe

---

## Files Examined

| File | Purpose |
|------|---------|
| `empathy-observer-manager.ts` | Main empathy observer implementation |
| `subagent.ts` | Lifecycle hook handlers including `subagent_ended` |
| `index.ts` | Hook registration |
| `openclaw-sdk.d.ts` | Type definitions for hooks |
| `prompt.ts` | Shadow routing evidence |
| `deep-reflect.ts` | Similar pattern comparison (uses `deliver: false`) |

---

## Evidence

**Source**: Principles repository, `packages/openclaw-plugin/src/`

**Cross-Repo Verification**: reviewer B verified at `D:/Code/openclaw/src/agents/subagent-registry.steer-restart.test.ts`:
- L283-313: Completion-mode subagent_ended deferred until announce resolves
- L315-339: Session-mode subagent_ended never emitted
- L946: subagent_ended is fire-and-forget (parallel, errors swallowed)