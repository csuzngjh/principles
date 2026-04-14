# Phase 19: Unified Workspace Resolution Contract - Context

**Gathered:** 2026-04-11  
**Status:** Ready for planning  
**Mode:** Auto-generated from production diagnosis + PR #238 review

<domain>
## Phase Boundary

This phase hardens one specific failure class:

production code should never guess a workspace directory and never silently fall back to `api.resolvePath('.')`, because that resolves to HOME in the failing OpenClaw contexts we just debugged.

**Scope:**
- Introduce one shared workspace resolution contract for hooks, commands, workers, and HTTP routes
- Replace known ad-hoc workspace resolution paths in production code
- Make missing/invalid workspace context fail fast with explicit errors or safe skips
- Add tests that prove writes stay inside the active workspace `.state`

**Out of scope:**
- Schema validation for `.pain_flag` and snapshots beyond workspace-path usage
- Runtime capability probing redesign beyond what is needed to stop wrong-workspace writes
- New UI or monitoring features
</domain>

<decisions>
## Implementation Decisions

### BC-01 Shared Contract
- **D-01:** Create a single contract entry for workspace resolution, tentatively `WorkspaceDirService.resolve(...)` or equivalent shared module
- **D-02:** All callers must choose one of two modes:
  - `required`: throw / return explicit error when workspace cannot be resolved
  - `optional`: return `undefined` and skip safely without writing state
- **D-03:** The contract must validate the resolved path and treat HOME/root/empty as invalid

### BC-02 No HOME Fallback
- **D-04:** `api.resolvePath('.')` may not be used as a production workspace fallback anywhere in `packages/openclaw-plugin/src`
- **D-05:** Existing helper `resolveValidWorkspaceDir()` cannot remain a "warn and continue" wrapper if it still falls back to HOME

### BC-03 Call-Site Policy
- **D-06:** Hooks that write `.state` or mutate runtime state must use `required` or safe-skip behavior
- **D-07:** Commands must fail fast with a user-facing error if workspace resolution fails
- **D-08:** `/pd-reflect` must resolve the active workspace from command context first; it must not hardcode `'main'`
- **D-09:** HTTP routes must not bind all queries to HOME; they need the same shared contract or an explicit route-level workspace source

### Delivery Shape
- **D-10:** Split the phase into two plans:
  - Plan 01: shared resolver contract + first high-risk callers
  - Plan 02: sweep remaining entry points + regression tests
</decisions>

<canonical_refs>
## Canonical References

**Downstream implementation must read these first:**

- `packages/openclaw-plugin/src/index.ts`
- `packages/openclaw-plugin/src/hooks/pain.ts`
- `packages/openclaw-plugin/src/core/workspace-dir-validation.ts`
- `packages/openclaw-plugin/src/core/path-resolver.ts`
- `packages/openclaw-plugin/src/commands/pd-reflect.ts`
- `packages/openclaw-plugin/src/http/principles-console-route.ts`

**Existing evidence for this phase:**

- PR #238 review comments identified remaining `api.resolvePath('.')` fallbacks in hooks and command wrappers
- Production diagnosis showed wrong-workspace writes into HOME-scoped `.state`
- `hooks/pain.ts` still uses `ctx.workspaceDir || ... || api?.resolvePath?.('.')`
- `index.ts` still uses `ctx.workspaceDir || api.resolvePath('.')` in multiple lifecycle hooks
- `principles-console-route.ts` still builds services from `api.resolvePath('.')`
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `validateWorkspaceDir()` already detects HOME/root/empty as invalid
- `resolveWorkspaceDirFromApi()` already exists for official OpenClaw/env-based resolution
- `resolveCommandWorkspaceDir()` in `index.ts` already encodes a stricter command-specific policy

### Problematic Assets
- `resolveValidWorkspaceDir()` currently still falls back to `api.resolvePath('.')`
- hook paths in `index.ts` bypass the stricter command resolver
- `pd-reflect.ts` bypasses active command context and resolves `'main'`
- `principles-console-route.ts` still assumes `api.resolvePath('.')` is a valid workspace root

### Expected Refactor Direction
- Pull resolver logic out of `index.ts` into a shared service/module
- Make the service expressive enough that call sites declare intent (`required` vs `optional/safeSkip`)
- Remove scattered direct workspace resolution logic from callers
</code_context>

<specifics>
## Specific Ideas

- Keep the service small: resolve, validate, and explain failures; do not mix in business behavior
- Add a narrow helper for command wrappers so `/pd-status`, `/pd-context`, `/pd-reflect`, and future commands all use the same path policy
- Treat HTTP routes as production entry points, not "best effort" utilities
</specifics>

<deferred>
## Deferred Ideas

- Full schema validation for `.pain_flag` and other KV/JSON state files (Phase 20)
- Runtime contract replacement for subagent probing (Phase 21)
- General cleanup of unrelated uses of `api.resolvePath()` outside workspace semantics
</deferred>

---

*Phase: 19-unified-workspace-resolution-contract*  
*Context gathered: 2026-04-11*
