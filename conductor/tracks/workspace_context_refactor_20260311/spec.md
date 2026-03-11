# Track Specification: WorkspaceContext Refactor (Governance Skeleton)

## 1. Overview
Implement a centralized `WorkspaceContext` class to encapsulate all workspace-related metadata, path resolution, and state-dependent services. This refactor will eliminate the manual passing of `workspaceDir` and `stateDir` strings, resolving "Primitive Obsession" and reducing coupling across the codebase.

## 2. Functional Requirements
- **Context Factory**: Provide a static `fromHookContext(ctx)` method that can handle various OpenClaw hook and command context shapes, extracting and validating `workspaceDir` and `stateDir`.
- **Cached Singleton Management**: Implement an internal cache to reuse `WorkspaceContext` instances per `workspaceDir`, ensuring performance in high-frequency hooks like `before_tool_call`.
- **Strict Validation**: Throw explicit errors if a `WorkspaceContext` is requested without a valid `workspaceDir`.
- **Key-based Path Resolver**: Implement a `resolve(fileKey)` method that uses strictly typed keys (from `PD_FILES`) to return absolute paths.
- **Service Encapsulation (Lazy Load)**: Expose the following services via lazy-loading getters:
    - `config`: Scoped to the workspace's governance settings.
    - `eventLog`: Scoped to the workspace's internal event logs.
    - `trust`: Access to the workspace's trust engine and scorecard.
    - `dictionary`: Access to the workspace's pain dictionary.
- **Identity Awareness**: The context should distinguish between the Project Root (OpenClaw files) and the Governance Root (`.principles/`).

## 3. Technical Requirements
- Create `src/core/workspace-context.ts`.
- Refactor `src/core/paths.ts` to support the context's resolver.
- Gradually refactor all hooks and commands to use `WorkspaceContext` as their primary interface for data and services.
- Update unit tests to use a `MockWorkspaceContext` where applicable.

## 4. Acceptance Criteria
- [ ] `WorkspaceContext` can be successfully instantiated from any OpenClaw hook context.
- [ ] No manual `path.join` for system files remains in the refactored modules.
- [ ] `recordFailure` and `recordSuccess` are called through the context's trust service.
- [ ] All 203+ existing tests pass after the refactor.
- [ ] Performance overhead of context creation is negligible (< 1ms).

## 5. Out of Scope
- Changing the actual file locations (handled in the previous track).
- Refactoring external dependencies outside the `packages/openclaw-plugin/src` directory.
