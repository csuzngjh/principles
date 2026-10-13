---
"@principles/codex-adapter": patch
"@principles/pd-cli": patch
---

PRI-953 (R1 F1/F2): extend the verified Codex ingestion envelope to 0.162.1 and make stale installs / unverified CLI versions visible.

- codex-adapter: `CODEX_INGESTION_VERIFIED_VERSION` 0.150.1 → 0.162.1, backed by an on-device contract probe against real codex-cli 0.162.1 (125/125 captured hook payloads decode; 8/8 real rollout transcripts ingest with only designed unknown-record-type skips) and sanitized G1 fixtures (`hook-payloads/v0.162.1/`, `transcripts/v0.162.1-tool-final-turn.jsonl`) with end-to-end ingestion + replay-idempotency tests.
- pd-cli: `pd health --host codex` now reports the runtime actually installed for hooks (PLUGIN_DATA) vs the marketplace-cache pin (`install.staleInstall` + blocker when it diverges with ingestion enabled), the canonical `~/.pd/runtime` adapter version, and the Codex CLI version observed in the newest rollout (`install.latestObservedCliVersion` + `cliStatus`); an unverified CLI with ingestion enabled is a §15 ready blocker with a nextAction — version or install incompatibility is no longer silent.
