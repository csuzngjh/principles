# Coding Conventions

**Analysis Date:** 2026-04-15

## Naming Patterns

**Files:**
- PascalCase for modules: `detection-service.ts`, `risk-calculator.ts`
- kebab-case for utilities with multiple exports: `retry.ts`, `hashing.ts`
- `.test.ts` suffix for test files co-located in `tests/` directory

**Directories:**
- Flat structure under `src/`: `commands/`, `core/`, `hooks/`, `service/`, `utils/`
- Tests mirror source structure in `tests/` parallel directory

**Functions:**
- camelCase: `normalizePath`, `handleBeforeToolCall`, `computeDynamicTimeout`
- Verb prefixes for actions: `handle*`, `compute*`, `extract*`, `serialize*`
- Getter-style for services: `DetectionService.get()`, `WorkspaceContext.fromHookContext()`

**Types & Interfaces:**
- PascalCase: `DeepReflectionSettings`, `PainSettings`, `GfiGateSettings`
- Suffix for type variants: `*Types`, `*Contract`, `*Schema`
- Barrel exports via `index.ts` in each directory

## Code Style

**Formatting:**
- ESLint with `@typescript-eslint` plugin
- No Prettier config detected (not enforced)
- 2-space indentation
- No trailing semicolons in ESLint config (but not explicitly disabled)

**Key ESLint Rules:**
```javascript
'no-empty': 'error',
'no-console': 'warn',
'@typescript-eslint/no-explicit-any': 'warn',
'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
'@typescript-eslint/no-non-null-assertion': 'warn',
```

**Linting (test files relaxed):**
```javascript
'@typescript-eslint/no-explicit-any': 'off',
'no-empty': 'warn',
'no-console': 'off',
```

**Import Organization:**
1. Node.js built-ins (`path`, `fs`, `os`)
2. External packages (`vitest`, `better-sqlite3`)
3. Internal modules (`../../src/core/...`, `./hooks/...`)
4. Type-only imports use `import type` syntax

**Path Aliases:**
- No `paths` aliasing in `tsconfig.json`
- Relative imports with `.js` extension for ESM compatibility: `from '../../src/utils/io.js'`

## Error Handling

**Patterns:**
- Return `undefined` for "not found" / "allowed" cases (not exceptions)
- Throw typed errors from `src/config/errors.ts`
- Result objects with `allowed: boolean` for gate checks
- Log warnings via `plugin-logger.ts` for non-critical failures

**Example - Gate pattern:**
```typescript
// Return block result, not exceptions
export function handleBeforeToolCall(event, ctx): BlockResult | undefined {
  if (someCondition) {
    return { block: true, blockReason: '...' };
  }
  return undefined; // Allowed
}
```

**SQLite errors:**
- Use `better-sqlite3` with synchronous API
- Wrap in try/catch for migration failures

## Logging

**Framework:** `src/utils/plugin-logger.ts`

**Patterns:**
- Structured logging with levels: `warn`, `error`, `info`, `debug`
- Context passed as object: `logger.warn({ context: 'Gate' }, 'message')`
- No `console.log` in production paths (warn-only via ESLint)

## Comments

**When to Comment:**
- Complex cross-platform logic (Windows EPERM handling in `atomicWriteFileSync`)
- Magic numbers explained: `const RENAME_MAX_RETRIES = 3`
- Task markers in tests: `// Task 4: Default Values Consistency Tests`

**JSDoc:**
- Used in config files and public APIs
- Not enforced on internal functions

## Function Design

**Size:**
- Prefer small, focused functions
- Complex modules split into helpers (e.g., `rule-host-helpers.ts`)

**Parameters:**
- Max 3-4 parameters before grouping into options object
- Destructure for clarity: `function ({ workspaceDir, stateDir })`

**Return Values:**
- Explicit return types in public APIs
- `undefined` for "not applicable" vs `null` for "intentionally empty"

## Module Design

**Exports:**
- Named exports preferred over default exports
- Barrel `index.ts` files aggregate directory exports
- Factory functions for singleton services: `DetectionService.get(dir)`

**Service Pattern:**
```typescript
// Singleton pattern for stateful services
class DetectionService {
  private static instances = new Map<string, DetectionFunnel>();
  
  static get(stateDir: string): DetectionFunnel {
    if (!instances.has(stateDir)) {
      instances.set(stateDir, new DetectionFunnel(...));
    }
    return instances.get(stateDir);
  }
  
  static reset(): void { instances.clear(); }
}
```

**Static Analysis:**
- Vitest used for unit tests
- ESM modules with `.js` extension in imports
- `"type": "module"` in `package.json`

---

*Convention analysis: 2026-04-15*
