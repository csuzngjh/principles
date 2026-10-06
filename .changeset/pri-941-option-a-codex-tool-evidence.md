---
"@principles/pd-cli": patch
---

PRI-941 Option A — Codex CLI pain record consumes the already-authorized tool_calls failure evidence (PRI-624 tool-governance surface) from the workspace trajectory via a new scoped acquisition that NEVER queries conversation tables (user_turns / assistant_turns remain ingestion-exclusive) and never opens rollout transcripts. An empty failure set keeps the honest unavailable degradation with an accurate reason (empty_trajectory). PainProvenance, painIngress.v1, the admission gate, consent and the G2A disclosure are untouched.
