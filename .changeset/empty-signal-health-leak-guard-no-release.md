---
---

No release needed.

This PR (`signal-health.ts` + `workspace-leak-guard.ts`) only changes
test-environment behavior: in production `guardWorkspaceLeak` is a no-op that
returns the path unchanged, so the shipped runtime for real users is identical.
The only observable effect is that unit-test mock paths (`/fake/state`) are now
isolated into the test temp dir instead of being written to the user's `D:\`
root. No user-facing behavior change => explicit no-release declaration.

Refs: PRI-1133
