# Conventions

**Analysis Date:** 2026-03-26

## Naming Conventions

| Pattern | Convention | Example |
|---------|------------|---------|
| TypeScript files | kebab-case | `evolution-engine.ts`, `trust-engine.ts` |
| Type/Interface names | PascalCase | `TrustStage`, `PainSignal`, `EvolutionEvent` |
| Function names | camelCase | `calculatePainScore()`, `getTrustStage()` |
| Constants | SCREAMING_SNAKE_CASE | `LOCK_MAX_RETRIES`, `EP_THRESHOLDS` |
| Class names | PascalCase | `WorkspaceContext`, `EvolutionReducerImpl` |
| Test files | `.test.ts` suffix | `trust-engine.test.ts` |
| Directory names | kebab-case | `core/`, `hooks/`, `utils/` |

## Error Handling Patterns

**Strategy:** Fail-closed for security-critical paths, graceful degradation for non-critical operations

### Gate Hook (Security-Critical)
```typescript
// Fail-closed: invalid regex → block, never allow
if (!isValidPattern(pattern)) {
  return { block: true, reason: 'Invalid regex pattern' }
}
```

### Pain Detection (Non-Critical)
```typescript
// Best-effort: errors logged, not propagated
try {
  detectPain(toolResult)
} catch (e) {
  ctx.logger.warn('Pain detection failed', e)
  // Continue execution
}
```

### Service Factories (Critical)
```typescript
// Fail hard on initialization errors
const service = XxxService.get(stateDir)
if (!service) throw new Error('Failed to initialize XxxService')
```

### File Locking
```typescript
// Retry with exponential backoff
const result = await withLockAsync('critical-operation', async () => {
  // operation
}, { retries: 3 })
```

## Type Safety Approach

**Strict Mode:** Enabled in `tsconfig.json`

| Setting | Value |
|---------|-------|
| `strict` | `true` |
| `target` | `ES2022` |
| `module` | `ESNext` (plugin), `NodeNext` (CLI) |
| `noUncheckedIndexedAccess` | `true` |
| `noImplicitReturns` | `true` |

**Anti-patterns explicitly prohibited:**
- ❌ `as any` — Never allowed
- ❌ `@ts-ignore` — Never allowed  
- ❌ `@ts-expect-error` — Never allowed
- ❌ Empty catch blocks (`catch(e) {}`)

**Validation approach:**
- Gate hook validates all inputs before security decisions
- `PainConfig` type with dot-notation accessor for config
- TypeScript types used for runtime validation via `TypeBox`

## Git Commit Conventions

**Format:** Conventional Commits (required for semantic-release)

```
feat:     New feature
fix:      Bug fix
docs:     Documentation only
style:    Formatting, missing semi colons, etc
refactor: Code change that neither fixes a bug nor adds a feature
test:     Adding or refactoring tests
chore:    Maintenance tasks
```

**Examples:**
```
feat: add deep-reflect tool for pre-task reflection
fix: gate regex validation false positive
docs: update command reference
```

## Code Organization Patterns

### Module Structure
1. **Imports** — Node.js stdlib → external deps → internal (relative imports)
2. **Types/Interfaces** — Type definitions next
3. **Constants** — Module-level constants
4. **Functions/Classes** — Implementation
5. **Exports** — Named exports only (no default export)

### Import Organization
**Order:**
1. Node.js standard library: `import * as fs from 'fs'`, `import * as path from 'path'`
2. Third-party dependencies: `import { describe, it, expect } from 'vitest'`
3. Internal relative imports: `import { WorkspaceContext } from './workspace-context.js'`

**Path Extensions:**
- All internal imports use `.js` extension (ESM requirement)
- Example: `import { WorkspaceContext } from './workspace-context.js'`

### JSDoc/TSDoc
**Usage:**
- Minimal JSDoc on major exports
- Format: Standard JSDoc with `@param`, `@returns`
- Example:
  ```typescript
  /**
   * Creates a WorkspaceContext for testing purposes.
   * If no workspaceDir is provided, a temporary directory is created.
   */
  export function createTestContext(overrides: {...}): WorkspaceContext
  ```

### Function Design
**Size:**
- Functions kept focused on single responsibility
- Large functions broken down into helpers (e.g., `gate.ts` uses helper functions)

**Parameters:**
- Objects for complex parameters
- Destructuring for clarity: `const { toolName, params } = event;`

**Return Values:**
- Explicit return types on exported functions
- Early returns for guard clauses
- Optional returns: `PluginHookBeforeToolCallResult | void` for hooks

### Singleton Service Pattern
```typescript
// Factory + cache pattern
class XxxService {
  private static cache = new Map<string, XxxService>()
  
  static get(stateDir: string): XxxService {
    if (!this.cache.has(stateDir)) {
      this.cache.set(stateDir, new XxxService(stateDir))
    }
    return this.cache.get(stateDir)!
  }
}
```

### File Locking for Critical Sections
```typescript
// Sync version
const result = withLock('evolution-write', () => {
  // critical write
})

// Async version  
const result = await withLockAsync('trajectory-write', async () => {
  // async critical write
})
```

### Event Sourcing Pattern
```typescript
// Append-only event log
eventLog.append({ type: 'pain_detected', payload: {...} })

// Rebuild state on load
const events = readEvents('evolution.jsonl')
const state = events.reduce(reducer, initialState)
```

## Logging Approach

| Logger | Purpose | Location |
|--------|---------|----------|
| `SystemLogger` | Plugin runtime logs | `{stateDir}/logs/SYSTEM.log` |
| `EventLog` | Structured events (JSONL) | `{stateDir}/logs/events.jsonl` |
| `ctx.logger` | OpenClaw-provided | Hook context |
| `api.logger` | Plugin API logger | OpenClaw SDK |
| `console.log/error` | Development fallback | When logger unavailable |

**Log levels:** Uses standard levels (info, warn, error, debug)

**Patterns:**
- **Fire-and-forget async writes**: `fs.appendFile()` with callback, silent failure
- **Context logger fallback**: `const logger = ctx.logger || console;`
- **Optional chaining**: `logger?.info?.(...)`, `logger?.warn?.(...)`
- **Structured SystemLogger**: Format `[timestamp] [EVENT_TYPE        ] Message\n`
- **Silent failure**: Logging errors never crash the system

## Path Resolution

**Rule:** NEVER hardcode absolute paths — always use `api.resolvePath()`

```typescript
// CORRECT
const configPath = api.resolvePath('.state/config.json')

// WRONG  
const configPath = '/Users/name/.openclaw/.../config.json'
```

## Anti-Patterns to Avoid

| Anti-Pattern | Why | Alternative |
|--------------|-----|-------------|
| Hardcoded paths | Breaks cross-platform | `api.resolvePath()` |
| `as any` | Type safety violation | Proper types or `unknown` |
| Empty catch blocks | Silent failures | Log errors or rethrow |
| Default exports | Breaks tree-shaking | Named exports |
| Singleton state in modules | Testing difficulty | `XxxService.get()` pattern |
| Synchronous file I/O in hooks | Blocks event loop | Async alternatives |

---

*Conventions analysis: 2026-03-26*
