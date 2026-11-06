# PRI-1116: integration acceptance after independent evidence review

Scope: evidence triage, not G1 approval. SPEC authority:
`docs/specs/PD Adaptive Activation SPEC v0.6.md`, section 8.1.
Independent run audit: `PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md`.

| Case | Current independently inspected evidence | Remaining acceptance action |
| --- | --- | --- |
| C01 | The controlled positive carries one configured target; this audit did not rerun scene-selection negatives. | Reuse original matching/nonmatching component tests; do not infer the negative from the positive. |
| C02 | No revocation experiment in the inspected run. | Index existing authorization/revalidation tests and their exact source revisions. |
| C03 | Endpoint projects target body exactly once per request. Native duplication, mandatory constraints and budget failure are separate component obligations. | Index existing packer tests; no second host run needed to review them. |
| C04 | Consumed operator admission, target body at local fake endpoint, successful run-level read association. Original online gate failed and no control ran. Endpoint user-message hash differs from frozen input hash. | Keep full C04/G1 pending; do not label confirmed/timely or identical-input transmission from this evidence alone. |
| C05 | One observable read, not a task-opportunity census. | Report only the observed sample; T and missed opportunities remain unknown. |
| C06 | Two real gate defects now have regression coverage in the 34-test script suite. | Reuse replay/session/config boundary tests; this is not a concurrent-session host experiment. |
| C07 | The historical gate stopped before control; original failure and cleanup records preserved. | Index timeout/dependency/disablement tests and distinguish intended fallback from missing evidence. |
| C08 | Fake provider prescribed a tool action; no independent behavioral-quality inference is justified. | Use the known fixtures permitted by SPEC section 8.1 for scoring discrimination first; real behavior benefit remains later work. |
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
