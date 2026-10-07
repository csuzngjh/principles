---
"@principles/pd-cli": patch
---

PRI-946 (accept-as-is) — clarify in `runtime-activation.ts` that the local activation path reads `PD_CONSOLE_TOKEN` from env only, by Owner decision: unlike owner identity it never falls back to `~/.pd/owner.json` or companion-held encrypted tokens, and an absent env token intentionally degrades to break_glass. Comment-only; no behavior change.
