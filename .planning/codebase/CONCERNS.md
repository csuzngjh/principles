# CONCERNS.md - Technical Debt & Issues

## TODOs / Pending Items

| Location | Content |
|----------|---------|
| `src/hooks/bash-risk.ts:18` | `// TODO: Extract types from gate.ts related to bash risk analysis` |
| `tests/service/nocturnal-workflow-manager.test.ts:435-437` | 3 `it.todo()` — Trinity state transition tests unimplemented |

## Large Files / Complexity Concerns

| File | Lines | Concern |
|------|-------|---------|
| `src/service/evolution-worker.ts` | 2133 | Largest file. Contains worker loop, pain checks, queue processing, workflow management, watchdog. Single responsibility violation. |
| `src/hooks/prompt.ts` | 1049 | Prompt building with empathy matching, subagent workflows, context injection, truncation logic. |
| `src/index.ts` | 777 | Plugin registration with all hooks/services/commands. |
| `src/utils/retry.ts` | 546 | Retry utility library with adaptive timeout. |

## Potential Issues

### 1. `evolution-worker.ts` — Single Responsibility Violation
The 2133-line file contains: worker loop, pain checking, queue processing, workflow management, watchdog, startup logic. **Recommendation**: Split into separate modules (worker loop, pain handler, queue processor, watchdog).

### 2. `prompt.ts` — Overly Long Hook Handler
At 1049 lines, contains empathy matching, subagent workflows, context injection, and truncation. **Recommendation**: Extract empathy logic and context injection into separate modules.

### 3. `index.ts` — `setTimeout` Initialization Risk
Line 138 uses `setTimeout(..., 1000)` for startup health check. **Risk**: Timing dependency could cause race conditions if OpenClaw isn't fully ready.

### 4. Module-Level Mutable State
- `index.ts`: `workspaceInitialized` (boolean flag), `pendingShadowObservations` (Map)
- `prompt.ts`: `_empathyTurnCounter`, `_empathyKeywordCache`
- **Risk**: These could produce race conditions in concurrent scenarios.

### 5. `any` Type Usage
~40 ESLint disables, mostly `@typescript-eslint/no-explicit-any`. **Indicates**: Incomplete type integration with OpenClaw host framework.

### 6. Test Coverage Gaps
Branch coverage at only 60% indicates gaps in branch coverage.

### 7. ESLint Ignores Test Files
`eslint.config.js` ignores `**/tests/**` — test code bypasses linting, which could degrade test code quality over time.

### 8. UI Code Not Linted
`**/ui/src/**` ignored by ESLint — React code has no lint constraints.

## Positive Observations

- Complete error hierarchy (`PdError` with 8 derived types)
- All catch blocks log to event log (`eventLog.recordHookExecution`)
- File lock mechanism prevents concurrent corruption
- Workspace directory resolution has strict validation chain
- Abundant test coverage (143 files, 2524+ cases)
- i18n support for Chinese/English
- Production build uses esbuild with tree-shaking + minification
- Semantic release + changesets for automated versioning
