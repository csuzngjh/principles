**Analysis Date:** 2026-04-02

|
| Code Style
 |
| **Formatting:**
- No linter (ESLint, Prettier, Biome, etc.) configured — rely solely on `tsc` type checking
- TypeScript strict mode: `"strict": true`, target `ES2022`, `moduleResolution: "bundler"`
- Indentation: 2 spaces soft tabs (consistent per use within codebase — no enforcement)
- Trailing commas: No enforcement
- Semicolons: No enforcement

- Quotes: single quotes for strings, double quotes for multi-line strings
 |
| **Module System:**
- ESM: `"type": "module"` in `package.json`
- Import style: `import * as fs from 'fs'` (namespace imports), 
- Import extensions: `.js` suffix required — `import { X } from './module.js'` (TypeScript E5+ ESM)
- Target: `ES2022`
 |
| **Linting:**
- No ESLint or Prettier configuration files found
- CI runs `npm run lint --if-present` (no-op if missing)
- Type safety enforced via `tsc --noEmit` in CI pipeline
 |
| **Key config files:**
- `packages/openclaw-plugin/tsconfig.json`
- `packages/openclaw-plugin/vitest.config.ts`
- No `.eslintrc`, `.prettierrc`, `biome.json`, or or `eslint.config.*` present |

 |
| **Key compiler settings** (from `packages/openclaw-plugin/tsconfig.json`):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  }
}
```

 |
| **Naming** |
| **Files:**
- `kekebab-case` for multi-word: `detection-funnel.ts`, `evolution-engine.ts`, `session-tracker.ts`, `risk-calculator.ts`
- `camelCase` for single-word: `config.ts`, `pain.ts`, `paths.ts`, `profile.ts`, `init.ts`
- `PascalCase` for classes names: `WorkspaceContext`, `EvolutionEngine` `EvolutionReducerImpl` `PainConfig` `EventLog`
 `TrajectoryDatabase`
- `UPPER_SNAKE_CASE` in constants: `PD_FILES`, `PD_DIRS`, `TIER_DEFINITIONS`
 ` `DEFAULT_SETTINGS`
 |
| **Types/Interfaces:** `PascalCase`: `PainSettings`, `EvolutionContextConfig` `TrajectoryToolCallInput`, `EvolutionScorecard`
 ` `LockOptions` ` `LockContext`
 - **Type aliases:** `ProjectFocusMode` ( `TaskDifficulty` ( `CorrectionSampleReviewStatus` |
- **Enums:** `PascalCase`: `EvolutionTier` |
- **Classes:**
- Use `XxxService.get(stateDir)` singleton factory + cache pattern:
 `ConfigService`, `DetectionService`, `EventLogService`, `DictionaryService`
 `TrajectoryRegistry`
 - Use PascalCase` for class names (NOT `XxxService`): `EvolutionReducerImpl` `LockAcquisitionError`
 - Use `export default` for module objects, `export function`/`export const` pattern
 |
- **Directories:**
- `src/core/` — Domain core (46 files)
- `src/hooks/` — Lifecycle hooks (15 files)
 - `src/commands/` — Slash command handlers (15 files)
- `src/service/` — Background workers (12 files)
 - `src/tools/` — Custom tools (3 files)
- `src/utils/` — Shared utilities (7 files)
- `src/config/` — Configuration & errors (3 files)
 - `src/constants/` — Tool sets and app constants (2 files)
 |
- **Variables:**
- `camelCase` for local variables: `workspaceDir`, `stateDir`, `exitCode`, `painScore`
 - `snake_case` in constants: `PAIN_PROTOCOL_TOKENS`, |
- `CONST` assertions in constant objects: `const TIER_DEFINITIONS` as const`, `DEFAULT_SETTINGS` |
 `SCREAMING_SNAKE` in file-level constants: `PD_FILES` |
 |
 |
| **Functions:**
- `camelCase` in exported functions: `computePainScore`, `writePainFlag` `resolvePdPath` ` `normalizePath` ` `handleBeforeToolCall`
 ` `handleAfterToolCall` - `handleInitStrategy`
 - `createTestContext` in test utilities
 - `acquireLock`/`withLock` |
 `computeHash` |
- `denoiseError` |
- **Error Handling** |
 |
| **Custom Error Classes** (from `src/config/errors.ts` and `src/utils/file-lock.ts`):
 |
- Base class: `PdError` extends `Error` — with `code` string property (e.g., `'LOCK_UNAVAILABLE'`)
- Base class: `LockAcquisitionError` extends Error` — file path and lock path properties
 `PathResolutionError` extends `PdError` — with `key` string property, `Base class: `SampleNotFoundError` extends Error` — not a `src/config/errors.ts` but imported via `../config/index.js`
 |
- **Error hierarchy:** `PdError` → `LockUnavailableError` / `PathResolutionError` |
- Each has acode`, `message`, and `name`, `cause` properties via options)
- **Error handling in hooks** (top-level catch in `src/index.ts`): Errors are caught and `try/catch` and logged, never rethrown:
 - Gate hook (`src/hooks/gate.ts`): fail-closed — invalid regex → block, not allow). Errors are caught, logged, and `recordGateBlockAndReturn` is called
 - Pain hook (`src/hooks/pain.ts`): errors are caught, logged, NOT propagated. Pain hook must never throw
 - Evolution worker (`src/service/evolution-worker.ts`): `LockUnavailableError` caught → task fails gracefully, - lock unavailable error logged, task continues)
 - **Core domain functions** (in `src/core/*.ts`): wrap operations results in try/catch, and silent return ` null`/`{}` / empty defaults) - Use `withLock()` / `withLockAsync()` for critical state writes operations |
 |
- **Anti-pattern: Do NOT throw from hooks** — errors must be caught and logged, not propagated

 This prevents unhandled errors from crashing the OpenClaw gateway |
| **Logging:**
 |
- **Framework:** `SystemLogger` (fire-and-forget async append) in `src/core/system-logger.ts`), `console.log`/`console.error` for initialization
 - Format: `[YYYY-MM-DDTHH:mm:ss.sssZ] [EVENT_TYPE     ] Message`
- **Log file:** `{stateDir}/logs/SYSTEM.log`
 |
- **Event buffering:** `EventLog` class (`src/core/event-log.ts`) batches 20 entries or flushes every 30s
- **Evolution logger:** `EvolutionLogger` (`src/core/evolution-logger.ts`) writes structured JSON log entries |
- **Logging pattern:** Use `[PD]` or `[PD:Lock]` or `[PD:Path]` prefixes in domain-specific error classes |
 |
| **Comments:**
 |
- **When to Comment:**
- JSDoc comments are rare — most documentation is in code comments (not formal JSDoc
- Inline comments are common, especially in complex logic ( Chinese characters are used as English explanatory comments)
- Module-level doc comments explain the purpose, e.g.:
```typescript
/**
 * System Logger for Principles Disciple
 * Writes critical evolutionary events to the project's memory/logs/SYSTEM.log
 * Uses asynchronous writing to avoid blocking the Node.js event loop.
 */
```
- Section separators: Unicode box art used as section dividers ( e.g. `// ── Track A: Empirical Friction (GFI) ──`)
- Chinese comments occasionally present additional context ( e.g. `// 1. Determine if this was a failure`)
- **Bilingual comments:** Both English and Chinese comments appear in codebase, with Chinese in design docs and inline explanations
 |
| **Function Design** |
 |
- **Size:** Functions range from small utilities (1 line) to large orchestrations functions (300+ lines)
- **Parameters:** Named parameters with interfaces preferred over positional params
- **Return Values:** Concrete types returned; avoid returning bare objects
- **Async:** Mix of sync and async patterns; some hooks sync, some async (event loop hooks are gateway hooks)
- **Visibility:** `public` by default; test-only functions use `/* internal */`
 |
| **Module Design** |
 |
- **Exports:** Each module exports a primary public API (classes, functions, types, constants)
- **Barrel files:** No `index.ts` barrel files — direct imports used across modules
- **Service pattern:** `XxxService.get(stateDir)` singleton factory + cache pattern
- **WorkspaceContext facade:** All hooks go through `WorkspaceContext.fromHookContext(ctx)` to access services
 |
| **Path Resolution** |
 |
- **Compliant entry point:** `api.resolvePath(path)` is the ONLY correct way to resolve filesystem paths
- **Internal resolution:** `resolvePdPath(workspaceDir, fileKey)` resolves PD paths via `PD_FILES` mapping
- **`PathResolver` class** (`src/core/path-resolver.ts`): normalizes paths, handle workspace/state dir fallback
- **Never hardcode absolute paths** — always use path resolution utilities
 |
| **File Locking** |
 |
- **`withLock()`** Synchronous file lock with automatic acquire/release
- **`withLockAsync()`**: async file lock for automatic acquire/release
- **`withAsyncLock()`**: in-process async lock (no file system lock)
- **Lock files:** Created with `.lock` suffix, contain PID of lock holder
- **Stale lock handling:** Locks expire after 10 seconds (configurable)
- **`LockAcquisitionError`** thrown when lock cannot be acquired after max retries
- **Usage:**
```typescript
import { withLock } from '../utils/file-lock.js';

// For synchronous operations
withLock(targetPath, () => {
  // ... critical state write ...
});

// For async operations
await withLockAsync(targetPath, async () => {
  // ... critical state write ...
});
```
- **Where used:**
- `src/core/evolution-reducer.ts` — evolution event stream writes
- `src/core/evolution-engine.ts` — scorecard persistence
- `src/core/trajectory.ts` — database writes (SQLite) |
 |
| **Anti-Patterns** |
 |
- ❌ **Never use `as any`** — use proper type annotations instead
- ❌ **never use `@ts-ignore` or `@ts-expect-error`** — fix the underlying type issue
- ❌ **never hardcode absolute paths** — always use `api.resolvePath()` or `resolvePdPath()`
- ❌ **never bypass WorkspaceContext** — always go through the facade
- ❌ **never write directly to `.state/` files** — use service layer
- ❌ **never throw from hooks** — errors must be caught and logged
- ❌ **never delete tests to "pass"** — fix the underlying issue
- ❌ **never share state between tests** — each test gets isolated workspace
- ❌ **never suppress type errors** — no `as any`, `@ts-ignore`
- ❌ **Stage 1-2: cannot modify risk paths** (`.principles/`, `.state/`)
- ❌ **Stage 3: risk path modifications require `PLAN.md` with `STATUS: READY`**

- ❌ **Never push directly to main** — PR + review required
 |
| *Convention analysis: 2026-04-02*
