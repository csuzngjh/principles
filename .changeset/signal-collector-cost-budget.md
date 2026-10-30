---
'@principles/core': patch
'principles-disciple': patch
'create-principles-disciple': patch
'@principles/pd-cli': patch
---

Signals: bound the cost of correction detection instead of paying it on every message.

- **Zero-match discovery is now budgeted.** Replaying live user turns showed that
  ~90% (93.5% in an earlier window, 90.9% in the most recent one) match no keyword
  at all, and every one of those used to start a Stage2 "discover a new
  correction phrase" call. `SignalCollectorConfig` gained
  `discoveryRateLimitPerHour` (default 6/hour, `0` = unlimited as before). Only
  zero-match discovery is limited — ambiguous hits are confirmations and stay
  unmetered — and the skipped calls are surfaced as `stage2DiscoverySkipped` in
  signal health, so the degradation is observable in `pd config doctor` rather
  than silent. Measured end-to-end through the production host with real messages:
  12 messages started 12 calls before, 6 after.
- **Stage2 calls are bounded.** The classifier now resolves with
  `outputPathStrategy: 'json_mode_first'` and `maxRepairAttempts: 1`. On the same
  5 real messages the two strategies both needed one HTTP request, but
  `json_mode_first` finished in 11.5s total (max 3.5s) against 36.2s (max 23.9s),
  and it does not depend on the provider supporting tool calls.
- **The observer stops re-running on unchanged input.** The periodic cycle skips
  when no user turn arrived since the last successful cycle (measured: 4ms versus
  14.1s for a real dispatch), and its payload now carries at most 40 messages
  truncated to 400 chars instead of every excerpt from 10 sessions (live measure:
  31.9KB → 23.5KB).
- **One file lock per turn instead of two.** `recordUserTurn` /
  `recordAssistantTurn` used to take the trajectory write lock twice (session
  upsert, then the turn insert). Measured on real SQLite: 8.69ms → 4.47ms per
  turn over 300 writes, byte-identical rows, on the `before_prompt_build` path.
