---
"create-principles-disciple": patch
---

PRI-956 (R1 F15): the principles review page discloses runtime revocation instead of implying "in effect" from the ledger's asset status.

- Background (Owner-adjudicated): the ledger `status` is an ASSET lifecycle with no deactivated value — a deactivated principle stays `active` there forever, while the runtime authority is the activations table (verified: after Owner deactivation, new sessions inject zero activations). The review page classified ledger-`active` as "approved & in effect" and its cross-check queried approvals rather than activations, so the two governance pages could disagree.
- Change: `GET /api/v1/principles` items now carry `runtimeDeactivated: true` when the activations table reports a deactivated activation targeting the principle (read-only query; degrades with a reason). The review page renders a "运行时已停用 / Runtime Revoked" badge next to the governance decision. No second write authority is introduced; the ledger status semantics are unchanged (no deactivate→ledger sync), and the classification bucket is unchanged.
- Regression: `pd health --host codex`-style cross-new-session revocation checks remain covered by the structured injection events (runtime_v2_prompt_activations_injected injectedCount); a full browser approve→activate→inject→deactivate→no-inject regression runs in the R1 acceptance report.
