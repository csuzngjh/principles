# Phase 42: Quick Wins - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix 3 security/reliability issues in the codebase:
- QW-01: Replace busy-wait spin loop in `src/utils/io.ts` with `setTimeout`-based delay for Windows EPERM/EBUSY retry
- QW-02: Add JSON structure validation before `JSON.parse()` on queue failure event payload
- QW-03: Replace string comparison with constant-time comparison (`crypto.timingSafeEqual`) for Bearer token auth in HTTP route
</domain>

<decisions>
## Implementation Decisions

### QW-01: Busy-wait loop replacement
- **D-01:** Keep `atomicWriteFileSync` synchronous signature — do NOT make it async
- **D-02:** Hybrid approach: try rename once first (fast path), if EPERM/EBUSY then fall back to `setTimeout`-based retry loop with max retries
- **D-03:** Use `setTimeout` loop for backoff delays (50ms base, exponential backoff), not spin loop

### QW-02: JSON validation before parse
- **D-04:** Create a structured validation helper function (not a schema library dependency)
- **D-05:** Helper checks for required fields (`type`, `workspaceId`) before returning parsed object
- **D-06:** Helper should be reusable across queue event handlers

### QW-03: Constant-time token comparison
- **D-07:** Use inline `crypto.timingSafeEqual` with `Buffer` comparison directly in `validateGatewayAuth`
- **D-08:** Do NOT create a separate utility file — inline is sufficient for single call site
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Quick Wins Specifics
- `packages/openclaw-plugin/src/utils/io.ts` — atomicWriteFileSync with busy-wait loop (QW-01)
- `packages/openclaw-plugin/src/http/principles-console-route.ts` lines 560-569 — validateGatewayAuth with string comparison (QW-03)

### No external specs — requirements fully captured in decisions above
</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `packages/openclaw-plugin/src/utils/io.ts` — existing atomic write utility, fix in place
- `packages/openclaw-plugin/src/http/principles-console-route.ts` — HTTP auth, single call site for QW-03

### Established Patterns
- Exponential backoff already used in retry logic elsewhere
- `crypto` module already imported in the project

### Integration Points
- QW-01: Changes stay within `io.ts`, no external integration needed
- QW-02: New helper will be used by queue event handlers (to be identified during planning)
- QW-03: `validateGatewayAuth` in `principles-console-route.ts` line 560
</codebase_context>

<specifics>
## Specific Ideas

- QW-01 hybrid approach: try renameSync first, if it fails with EPERM/EBUSY use setTimeout retry
- QW-02: Validation helper checks `typeof payload === 'string'` and required fields exist before returning parsed object
- QW-03: Use `Buffer.from(providedToken) === Buffer.from(gatewayToken)` with `crypto.timingSafeEqual`
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>
