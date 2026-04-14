# Phase 22: BC-02 Residual Fallback Cleanup - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Remove the last two `api.resolvePath('.')` fallback calls in secondary tool files so BC-02 is fully satisfied.

**Scope:**
- Remove `api.resolvePath?.('.')` fallback from `deep-reflect.ts` (line 141)
- Remove `api?.resolvePath?.('.')` fallback from `critique-prompt.ts` (line 35)
- Align failure mode: both call sites should throw when workspace cannot be resolved

**Out of scope:**
- New workspace resolution logic (Phase 19 already built it)
- Schema validation changes (Phase 20)
- Runtime contract changes (Phase 21)
</domain>

<decisions>
## Implementation Decisions

### Failure Mode
- **D-01:** Both `deep-reflect.ts` and `critique-prompt.ts` must throw when workspace resolution fails — no silent fallback, no user-facing error-message returns
- **D-02:** `deep-reflect.ts` current behavior returns a user-facing error message `("❌ 反思执行失败: Workspace directory is required...")` — this must be converted to a thrown exception
- **D-03:** `critique-prompt.ts` already throws `Error('Workspace directory is required for deep reflection.')` — just remove the fallback, no error handling change needed

### Removal Strategy
- **D-04:** Remove the `|| api.resolvePath?.('.')` expression from `resolveReflectionWorkspace()` in `deep-reflect.ts`
- **D-05:** Remove the `|| api?.resolvePath?.('.')` expression from the workspace resolution chain in `critique-prompt.ts`
- **D-06:** After removal, verify `rg "api\.resolvePath" packages/openclaw-plugin/src` returns zero matches (UAT criterion)

### Claude's Discretion
- Exact error message text for deep-reflect's new throw
- Whether to add logging before the throw
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Workspace Resolution Contract (Phase 19)
- `packages/openclaw-plugin/src/core/path-resolver.ts` — shared resolver, `resolveWorkspaceDirFromApi()`, `PathResolver` class
- `packages/openclaw-plugin/src/core/workspace-dir-validation.ts` — workspace dir validation helpers

### Target Files
- `packages/openclaw-plugin/src/tools/deep-reflect.ts` — contains `resolveReflectionWorkspace()` with `api.resolvePath?.('.')` fallback at line 141
- `packages/openclaw-plugin/src/tools/critique-prompt.ts` — contains `api?.resolvePath?.('.')` fallback at line 35

### Prior Phase Decisions
- `packages/openclaw-plugin/src/core/AGENTS.md` — documents `api.resolvePath()` as the only compliant entry (line 20)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveWorkspaceDirFromApi()` in `path-resolver.ts` — already used by both target files as the preferred resolution path before the fallback
- Both files already have the shared resolver in their import chain

### Call Site Analysis
- `deep-reflect.ts`: `resolveReflectionWorkspace()` → caller checks undefined → returns error message → needs conversion to throw
- `critique-prompt.ts`: inline resolution chain → already throws on undefined → just remove fallback

### Expected Changes
- `deep-reflect.ts`: Change `resolveReflectionWorkspace` return type from `string | undefined` to `string` (throw on failure)
- `deep-reflect.ts`: Simplify caller at line 110-113 — remove the undefined check since function now throws
- `critique-prompt.ts`: Remove `|| api?.resolvePath?.('.')` from line 35, keep the existing throw
</code_context>

<specifics>
## Specific Ideas

- The `resolveReflectionWorkspace()` function should throw a `PathResolutionError` or equivalent workspace error, matching the Phase 19 error taxonomy
- The caller in `deep-reflect.ts` can be simplified: remove the `if (!effectiveWorkspaceDir)` guard since the function now throws
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>

---

*Phase: 22-bc02-residual-fallback-cleanup*
*Context gathered: 2026-04-11*
