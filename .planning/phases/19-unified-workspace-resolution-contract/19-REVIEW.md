# Phase 19 Review Notes

## Planning Verdict

PASS

## Why this split is correct

- Plan 01 isolates the shared resolver contract and first high-risk callers.
- Plan 02 finishes the migration sweep and adds regression guards.
- The phase stays inside the milestone boundary: workspace contract only, not schema or runtime redesign.

## Main execution risks

- Some callers may genuinely need "optional workspace" semantics rather than mandatory failure.
- HTTP routes may need a route-specific workspace source instead of blindly reusing command semantics.
- Existing tests may encode the old fallback behavior and require deliberate rewriting.

## Guardrails

- Do not reintroduce `api.resolvePath('.')` under a renamed helper.
- Do not couple workspace resolution with business logic.
- If a caller cannot identify a workspace, prefer explicit failure or safe skip over guessed writes.
