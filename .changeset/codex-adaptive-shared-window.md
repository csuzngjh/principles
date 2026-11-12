---
"@principles/host-runtime": patch
"@principles/codex-adapter": patch
---

Use a shared two-second Codex Adaptive scoring window from send to a validated response, capped by the existing host deadline. Waiting for headers no longer has an independent 500 ms cutoff. Timeouts still cancel the request and fall back to Native; Adaptive remains opt-in.
