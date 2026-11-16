---
'create-principles-disciple': patch
---

Dependency lock sync: `@principles/install-layout` resolved 0.4.0 -> 0.8.2 in the installer's own `package-lock.json`, matching the already-declared `^0.8.2` range. The stale 0.4.0 pin predates the `resolvePdHome` / WorkBuddy host-config / mcp-binding-contract exports that `src/update/bootstrap-executor.ts` and the host installers import.
