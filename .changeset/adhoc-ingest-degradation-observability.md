---
"@principles/host-runtime": minor
"@principles/codex-adapter": minor
---

Fix the Codex transcript ingestion envelope and make refused ingests attributable.

- `host-runtime`: every `degraded` exit of `runConversationIngestion` now appends one
  `conversation_ingestion` / `degraded` line to the existing workspace
  `.state/logs/events_<date>.jsonl` channel (bounded reason + nextAction, no new
  table, no schema change, no flag). A failed write stays observable as a
  `degradation_event_log_failed:*` warning instead of throwing.
- `codex-adapter`: `CODEX_INGESTION_VERIFIED_VERSION` 0.162.1 → 0.167.0 and the
  version parser now accepts prerelease/build suffixes, comparing only the core
  triplet. Verified on a real on-device 0.167.0-alpha.4.1 capture (real 4.4 MB
  rollout transcript decoded with assistant turns; sanitized fixture
  `v0.167.0-alpha.4.1-tool-final-turn.jsonl` added). Above-ceiling and malformed
  versions still degrade with `codex_version_unverified`.
