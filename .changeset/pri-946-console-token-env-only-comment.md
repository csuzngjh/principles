---
"@principles/pd-cli": patch
---

PRI-946 (accept-as-is) — clarify in `runtime-activation.ts` that the local activation path reads `PD_CONSOLE_TOKEN` from env only, by Owner decision: it adds no `~/.pd/owner.json`/store fallback of its own and trusts whatever the caller placed in env (the companion decrypts its stored token into env before spawning the CLI), degrading to break_glass when env has none. Comment-only; no behavior change.
