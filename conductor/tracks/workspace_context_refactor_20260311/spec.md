# Track Specification: WorkspaceContext Refactor (Governance Skeleton)

## 1. Overview
Implement a centralized `WorkspaceContext` class to encapsulate all workspace-related metadata, path resolution, and state-dependent services. This refactor will eliminate the manual passing of `workspaceDir` and `stateDir` strings, resolving "Primitive Obsession" and reducing coupling across the codebase.

## 2. Functional Requirements
- **Context Factory**: Provide a static `fromHookContext(ctx)` method that can handle various OpenClaw hook and command context shapes, extracting and validating `workspaceDir` and `stateDir`.
- **Cached Lifecycle Management**: 
    - Implement an internal cache to reuse `WorkspaceContext` instances per `workspaceDir`.
    - Use a strategy (e.g., `WeakMap` or explicit `dispose()`) to prevent memory leaks in long-running processes.
    - Provide an `invalidate()` method to refresh configuration and paths if on-disk settings change.
- **Strict Validation**: Throw explicit errors if a `WorkspaceContext` is requested without a valid `workspaceDir`.
- **Key-based Path Resolver**: Implement a `resolve(fileKey)` method that uses strictly typed keys (from `PD_FILES`) to return absolute paths.
- **Service Encapsulation (Lazy Load)**: Expose services via lazy-loading getters (first access initializes the service):
    - `config`: Scoped governance settings.
    - `eventLog`: Workspace internal event logs.
    - `trust`: Trust engine and scorecard.
    - `dictionary`: Pain dictionary.
- **Backward Compatibility Layer**: Maintain existing functional APIs (e.g., `recordFailure`, `getAgentScorecard`) as thin wrappers around the `WorkspaceContext` to allow for incremental migration and prevent breaking existing tests.
- **Identity Awareness**: Distinguish between Project Root (OpenClaw bootstrap files) and Governance Root (`.principles/`).

## 3. Technical Requirements
- Create `src/core/workspace-context.ts`.
- Implement `createTestContext()` factory for unit testing without physical disk reliance.
- Refactor `src/core/paths.ts` to support the context's resolver.
- Performance Targets:
    - Context creation (no service load): < 0.1ms
    - Cache hit: < 0.01ms
    - Initial service load: < 10ms

## 4. Acceptance Criteria
- [x] WorkspaceContext can be successfully instantiated from any OpenClaw hook context.
- [ ] No manual `path.join` for system files remains in the refactored modules.
- [ ] `WorkspaceContext` cache clears correctly when a workspace is disposed or changed.
- [ ] Existing functional APIs remain operational (verified by 203+ existing tests).
- [ ] `invalidate()` successfully reloads `pain_settings.json` changes.
- [ ] Performance targets are met under load.

## 5. Out of Scope
- Changing actual file locations (handled in previous track).
- Modifying OpenClaw core engine internal state.
