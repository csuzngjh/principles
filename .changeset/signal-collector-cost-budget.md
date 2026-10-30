---
'@principles/core': patch
'principles-disciple': patch
'@principles/pd-cli': patch
---

Signals: bound the cost of correction detection instead of paying it on every message.

- **Zero-match discovery is now budgeted.** Replaying 1,179 real user turns showed
  that 93.5% of them match no keyword at all, and every one of those used to start
  a Stage2 "discover a new correction phrase" call. `SignalCollectorConfig` gained
  `discoveryRateLimitPerHour` (default 6/hour, `0` = unlimited as before). Only
  zero-match discovery is limited — ambiguous hits are confirmations and stay
  unmetered — and the skipped calls are surfaced as
  `stage2DiscoverySkipped` in signal health, so the degradation is observable in
  `pd config doctor` rather than silent.
- **Stage2 calls are single-round-trip.** The classifier now resolves with
  `outputPathStrategy: 'json_mode_first'` and `maxRepairAttempts: 1` instead of
  the tool-call → json_schema → repair chain. Probed on the production path with
  a 30s / 2048-token profile: 2.6–6.8s, structured output preserved.
- **The observer stops re-running on unchanged input.** The periodic cycle skips
  when no user turn arrived since the last successful cycle, and its payload now
  carries at most 40 messages truncated to 400 chars instead of every excerpt from
  10 sessions (25–48KB).
- **One file lock per turn instead of two.** `recordUserTurn` /
  `recordAssistantTurn` used to take the trajectory write lock twice (session
  upsert, then the turn insert) at ~6ms each on Windows, on the
  `before_prompt_build` path.
