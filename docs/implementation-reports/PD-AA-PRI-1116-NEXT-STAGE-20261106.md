# PRI-1116: integration acceptance after independent evidence review

Scope: evidence triage, not G1 approval. SPEC authority:
`docs/specs/PD Adaptive Activation SPEC v0.6.md`, section 8.1.
Independent run audit: `PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md`.

| Case | Current independently inspected evidence | Remaining acceptance action |
| --- | --- | --- |
| C01 | The controlled positive carries one configured target; this audit did not rerun scene-selection negatives. | Reuse original matching/nonmatching component tests; do not infer the negative from the positive. |
| C02 | No revocation experiment in the inspected run. | Index existing authorization/revalidation tests and their exact source revisions. |
| C03 | Endpoint projects target body exactly once per request. Native duplication, mandatory constraints and budget failure are separate component obligations. | Index existing packer tests; no second host run needed to review them. |
| C04 | Consumed operator admission, target body at local fake endpoint, successful run-level read association. Original online gate failed and no control ran. Endpoint user-message hash differs from frozen input hash. PRI-1115 report re-ingests both runs, keeps run `aa-run-20261106T1258Z` failed, and records `D/T = unknown`. | Keep full C04/G1 pending; do not label confirmed/timely or identical-input transmission from this evidence alone. Report: `docs/implementation-reports/pri-1115/coverage-summary-20261106.json`. |
| C05 | One observable read, not a task-opportunity census. PRI-1115 maps calls, runs, attempts and opportunities separately; `units.decisionOpportunities = unknown` and no population ratio is emitted. | Report only the observed sample; T and missed opportunities remain unknown. |
| C06 | Two real gate defects now have regression coverage in the 34-test script suite. PRI-1115 keeps these defects as post-hoc replay explanations; the original verdict is unchanged. | Reuse replay/session/config boundary tests; this is not a concurrent-session host experiment. |
| C07 | The historical gate stopped before control; original failure and cleanup records preserved. PRI-1115 budget section separates cumulative usage from per-run `attempt.used`. | Index timeout/dependency/disablement tests and distinguish intended fallback from missing evidence. |
| C08 | Fake provider prescribed a tool action; no independent behavioral-quality inference is justified. PRI-1115 report sets benefit/harm to `not_evaluated`. | Use the known fixtures permitted by SPEC section 8.1 for scoring discrimination first; real behavior benefit remains later work. |
| C09 | P0 policy report and isolated run are available; this reviewer did not independently re-audit the production database or all egress. | Carry forward environment/permission evidence with explicit limits and preserve the earlier incident boundary. |

## Execution order

1. Finish the offline component-evidence index on this matrix, using exact test
   names and revisions rather than demanding a new host experiment for every row.
2. PRI-1115 may validate aggregation against the existing observed sample with
   unknown denominators. A missing control prevents causal claims, not parsing
   and deterministic report development.
3. If Owner requires the missing control for protocol closure, first request an
   explicit continuation decision. Do not spend the remaining host/HTTP budget
   automatically after a stopped positive; do not reset or enlarge the ledger.
4. Keep the original run failed. A later control would be separately dated and
   described as a resumed protocol, not an originally uninterrupted paired run.

No new host execution or model calls were performed for this document.

## PRI-1115 report evidence (report-related rows only)

Artifacts:

- `docs/implementation-reports/pri-1115/FIELD-MAPPING-20261106.md`
- `docs/implementation-reports/pri-1115/coverage-summary-20261106.json`
- `docs/implementation-reports/pri-1115/OWNER-BRIEF-20261106.md`

Source hashes ingested by the report:

| Source | SHA-256 | Run |
| --- | --- | --- |
| run-record (1105) | `0ad44b19bd7a6ab5d156b02b0e7a28702f1a89e6cc0c47566c6f79fc71545346` | `aa-run-20261106T1105Z` |
| run-record (1258) | `9b339ff239c210ada4a733f417588b2f21b9b0a5e3e1ef08f2987a010669f736` | `aa-run-20261106T1258Z` |
| `pd activation link` (1105 window) | `122f3b8bb042e316b1f381a15f1e01ed8e4123da53c2d902c3acc10dbdadb785` | host run `f5927a58-c99d-4c1a-be74-a742fe65a45a` |
| `pd activation link` (1258 window) | `18159a3c109db81ac94adbedb6ae69c681463a090fc61d1fd763aa518f9cb462` | host run `88b37c98-3052-47ff-9840-37e2d21463da` |
| experiment budget (cumulative) | `e2b948dcccdfb653222ff1a24f876ccd134d783e10c666834505f1bc28899e38` | all runs |
| offline re-evaluation | `5b7ade6c7ba5e2586b6c923ac8fd948d06b57ce6cf81cc33e6836e161c70d24c` | `aa-run-20261106T1258Z` |
| production pollution audit v4 | `604453fea3a5a04bad7d2b6ddf502dc9494925c4f493a61d914abe1493138524` | incident boundary only |

Still not satisfied by this report: C04 remains pending (original online gate failed,
no control arm, endpoint user-message digest differs from frozen input); G1 remains
pending. The report supplies machine-readable input wiring and an Owner brief, not an
acceptance pass for any case.

