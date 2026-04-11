# CONVENTIONS.md - Code Style & Patterns

## Code Style

- **ES Modules**: Entire project uses `import/export`, `"type": "module"` in both packages
- **TypeScript strict mode**: Enabled for all packages
- **Import order**: Standard library → Third-party → Local relative paths
- **Type imports**: Use `import type` to separate type and value imports (ESLint `consistent-type-imports`)

## Naming Conventions

| Category | Convention | Example |
|----------|-----------|---------|
| Classes | PascalCase | `EvolutionEngine`, `PdError`, `WorkspaceContext` |
| Functions/Variables | camelCase | `handleBeforePromptBuild`, `workspaceDir` |
| Constants | UPPER_SNAKE_CASE | `PD_LOCAL_PROFILES`, `DEFAULT_EVOLUTION_CONFIG` |
| Files | kebab-case | `evolution-engine.ts`, `file-lock.ts` |
| Directories | kebab-case | `subagent-workflow/`, `principle-internalization/` |

## Error Handling Pattern

```typescript
// 1. Semantic error classes (config/errors.ts)
export class PdError extends Error {
  constructor(message: string, public readonly code: string, options?: { cause?: unknown }) { ... }
}

// 8 derived error types for semantic error handling

// 2. Standard try-catch in hooks
try {
  const result = handleBeforeToolCall(event, ctx);
  eventLog.recordHookExecution({ hook: 'before_tool_call' });
  return result;
} catch (err) {
  eventLog.recordHookExecution({ hook: 'before_tool_call', error: String(err) });
  api.logger.error(`[PD] Error in before_tool_call: ${String(err)}`);
}

// 3. Silent failure for non-critical paths
} catch (_err) {
  // Non-critical: don't log, just skip
}
```

## Retry Pattern

```typescript
// retry.ts (546 lines)
// - retryAsync with exponential backoff
// - withRetry wrapper
// - retryWithAdaptiveTimeout for dynamic timeout calculation
```

## File Lock Pattern

```typescript
// file-lock.ts
// - withLock / withLockAsync prevent concurrent file write corruption
// - Used for SQLite and state file access
```

## ESLint Disable Comments

~40 instances of `eslint-disable-next-line`, all with `-- Reason:` comments:
- `@typescript-eslint/no-explicit-any`: When third-party API types are unavailable
- `@typescript-eslint/no-non-null-assertion`: When logic guarantees non-null
- `@typescript-eslint/no-unused-vars`: Intentionally unused catch bindings

## Test Patterns

```typescript
// Standard test structure
describe('EvolutionEngine', () => {
  let workspace: string;
  let engine: EvolutionEngine;

  beforeEach(() => {
    workspace = createTempWorkspace();
    engine = new EvolutionEngine(workspace);
  });

  afterEach(() => {
    disposeAllEvolutionEngines();
    cleanupWorkspace(workspace);
  });

  test('should start at Seed tier with 0 points', () => { ... });
});
```

- Temp directories (`os.tmpdir()`) for test isolation
- `it.todo()` for unimplemented tests
- E2E tests: `evolution-e2e.test.ts`, `evolution-user-stories.e2e.test.ts`
