# PRI-1116: integration acceptance after independent evidence review

Scope: evidence triage, not G1 approval. SPEC authority:
`docs/specs/PD Adaptive Activation SPEC v0.6.md`, section 8.1.
Independent run audit: `PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md`.
Report authority for this round:
`docs/implementation-reports/pri-1115/coverage-summary-20261106.json`,
`docs/implementation-reports/pri-1115/OWNER-BRIEF-20261106.md`, and
`docs/implementation-reports/pri-1115/FIELD-MAPPING-20261106.md`.

Status vocabulary used below:

- `component`: offline component/contract test, not a host observation.
- `report`: deterministic report/replay over existing evidence, not a new run.
- `controlled-run`: evidence recorded by a real controlled-admission run.
- `pending`: the acceptance requirement is not yet met end-to-end.

## Acceptance matrix

| Case | Original acceptance requirement (SPEC v0.6 §8.1) | Actual entry point | Exact test name (`file :: test`) | Source commit | Evidence layer | PRI-1115 report reference and remaining gap |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | A matching scene selects only the configured eligible target; a normal task keeps the original Native path. | `prepareAdaptiveIntervention`; `renderPrinciplesToDirectives` / `renderAndGuard`. | `adaptive-principle-intervention.test.ts :: prioritizes a qualified target and records the optional displaced activation`; `adaptive-principle-intervention.test.ts :: preserves Native bytes and zero increment when the full directive is already present`; `adaptive-packing-comparison.test.mjs :: an excluded target can replace optional Native content without mutating Reader candidates`. | `3e81b1115`; `60ac56546` | `component` | Report does not add a scene-selection observation. Negative matching remains component-only; the controlled run did not exercise a nonmatching scene. |
| C02 | An unauthorized or revoked artifact must not activate, and must not revive a cached target. | `prepareAdaptiveIntervention` last revalidation; `dispatchActivation` identity gate. | `adaptive-principle-intervention.test.ts :: rejects revoked or changed targets at the last revalidation`; `adaptive-principle-intervention.test.ts :: does not resurrect a revoked target through the cached Native baseline`; `adaptive-principle-intervention.test.ts :: excludes an old cached revision when the new revision fails revalidation`; `activation-dispatcher.test.ts :: F9-3: refuses when existing activation artifactId differs from input (idempotency_artifact_mismatch)`. | `3e81b1115`; `ec96a9532` | `component` | No revocation experiment in the inspected run; authorization/revalidation remains offline evidence. |
| C03 | Native text is byte-preserved; only a small attribute is appended; no duplicate stacking; mandatory constraints are never displaced; budget exhaustion fails closed. | `prepareAdaptiveIntervention`; `preparePromptBudgetSelection`; packer size guard. | `adaptive-principle-intervention.test.ts :: preserves Native bytes and zero increment when the full directive is already present`; `adaptive-principle-intervention.test.ts :: does not displace a mandatory constraint`; `adaptive-principle-intervention.test.ts :: rejects final size-guard truncation instead of treating selection as delivery`; `adaptive-packing-comparison.test.mjs :: Native already containing the complete target is reused byte for byte, with zero added contribution`; `prompt-budget-fair-selection.test.ts :: every round stays within the active hard budget (T5 / AT-02)`; `prompt-budget-fair-selection.test.ts :: packs the full audited fixture under the v2 budget: 16 → 16, truncated false, target present`. | `3e81b1115`; `60ac56546`; `0d47c7de3` | `component` | Endpoint projected the target body once, but Native duplication and budget failure remain separate component obligations; no new host run. |
| C04 | Controlled admission, real request, exact target body and existing hook identity must all agree; otherwise the controlled pass is refused and the failure is preserved. | `scripts/__tests__/aa-controlled-admission.test.mjs` positive gate; `packages/openclaw-plugin/tests/hooks/controlled-admission.test.ts` claim path. | `aa-controlled-admission.test.mjs :: passes only when admission is consumed, identity matches and the target body reached the endpoint`; `aa-controlled-admission.test.mjs :: counterexample: native delivery succeeded but the controlled admission was refused — never a controlled pass`; `aa-controlled-admission.test.mjs :: fails the positive gate on a missing second request and on missing intervention evidence`; `aa-controlled-admission.test.mjs :: persists failure, ledger and cleanup on an abnormal path`; `controlled-admission.test.ts :: claims once, persists consumedAt/consumedBy and hands off to the same-round prompt callback`. | `0508343b7` | `controlled-run` (original gate failed) | Report re-ingests both runs and keeps `aa-run-20261106T1258Z` failed. C04 and G1 remain `pending`: the original online gate failed, the control arm did not run, and the endpoint user-message digest differs from the frozen input. |
| C05 | No signal, no opportunity, or exhausted quota must not produce an intervention; a missed opportunity must be visibly marked. | `prepareAdaptiveIntervention`; `summarizeAdaptiveStudy`; `preparePromptBudgetSelection`. | `adaptive-principle-intervention.test.ts :: never triggers from missing message identity or a quoted/history marker`; `summarize-adaptive-coverage.test.mjs :: known excluded opportunities cannot wash an actual delivery into D`; `adaptive-activation-coverage.test.mjs :: missing opportunity identities are unlinked and invalidate a claim of complete enumeration`; `adaptive-activation-coverage.test.mjs :: empty sets and zero intermediate denominators are not applicable, never failure rates`; `prompt-budget-fair-selection.test.ts :: empty eligible set: no crash, header-only, legacy policy (fair path must not mod by zero)`. | `3e81b1115`; `68c80cafa`; `60ac56546`; `0d47c7de3` | `component` + `report` | Report keeps `units.decisionOpportunities = unknown`; it does not claim a census. T and missed opportunities remain unknown. |
| C06 | Replaying the same session/configuration or concurrent requests must not inject twice; a changed identity must refuse reuse. | `summarizeAdaptiveStudy` identity guards; controlled-admission claim lock and replay rejection. | `summarize-adaptive-coverage.test.mjs :: workspace, session and configuration mismatches refuse aggregation instead of silently dropping failures`; `summarize-adaptive-coverage.test.mjs :: replaying the same opportunity does not turn callback volume into extra opportunities`; `adaptive-activation-coverage.test.mjs :: replayed rows count once, conflicting invocations remain unknown even if one was positive`; `adaptive-config-identity.test.mjs :: reordering fields preserves identity while every observed field change invalidates it`; `controlled-admission.test.ts :: rejects a repeated callback, a new run with the same input and a post-tool second request`; `controlled-admission.test.ts :: never lets a pre-declared cross-session consumer claim the admission`. | `68c80cafa`; `60ac56546`; `0508343b7` | `component` + `controlled-run` | Replay and identity rules are covered offline; this is not a new concurrent-session host experiment. |
| C07 | Reader/tool failure, timeout, crash, or upstream rejection must not reuse old cache, create out-of-order actions, consume twice, or fail uncleanly. | `prepareAdaptiveIntervention` deadline/abort path; controlled-admission failure persistence and budget guards. | `adaptive-principle-intervention.test.ts :: does not restore cached target content when revalidation times out`; `adaptive-principle-intervention.test.ts :: bounds a revalidation that never resolves and aborts its signal`; `adaptive-principle-intervention.test.ts :: does not retain a cached target when the scene is admitted after its deadline`; `aa-controlled-admission.test.mjs :: never invokes the control arm when the positive gate fails`; `aa-controlled-admission.test.mjs :: fails closed on the fourth HTTP request and the second control request`; `aa-controlled-admission.test.mjs :: persists failure, ledger and cleanup on an abnormal path`; `adaptive-packing-comparison.test.mjs :: unavailable or oversized targets preserve the Native result rather than claim empty success`. | `3e81b1115`; `0508343b7`; `60ac56546` | `component` + `controlled-run` | The historical gate stopped before control; failure and cleanup records are preserved. No process-crash injection exists in the real host. |
| C08 | Only an independent behavioral score may claim behavior benefit; without evaluation the result stays `not_evaluated`; without a baseline, use the SPEC formula. | `verify-adaptive-delivery.mjs`; `summarizeAdaptiveStudy` benefit/harm fields. | `verify-adaptive-delivery.test.mjs :: exact pinned request before the first action supports only delivery, never behavior quality`; `verify-adaptive-delivery.test.mjs :: a returned receipt alone cannot confirm model-request delivery`; `verify-adaptive-delivery.test.mjs :: a request after the action is delivered but too late`; `adaptive-activation-coverage.test.mjs :: fixture evidence and invalid verification results cannot become real D`; `summarize-adaptive-coverage.test.mjs :: a self-reported successful verdict or fixture cannot inflate the measured coverage`. | `68c80cafa`; `60ac56546` | `report` + `component` | Report keeps benefit/harm `not_evaluated`. No independent behavioral scoring evidence exists; a new evaluation run would need explicit Owner authorization. |
| C09 | Authorization, expiry, egress limits and refusal paths must have no forbidden side effects; production-incident pollution is excluded by an explicit time boundary. | `aa-controlled-admission` preflight; `controlled-admission` isolation gate; `dispatchActivation` risk gate. | `aa-controlled-admission.test.mjs :: accepts an unconsumed, unexpired, 10-minute admission`; `aa-controlled-admission.test.mjs :: rejects the exact 13:00Z failure: a 115-minute admission lifetime (PD rule)`; `aa-controlled-admission.test.mjs :: rejects an already-consumed admission and an expired admission`; `aa-controlled-admission.test.mjs :: rejects bytes that differ from the frozen hash`; `aa-controlled-admission.test.mjs :: refuses before any write when a resolved path escapes the experiment root`; `aa-controlled-admission.test.mjs :: keeps both arms inside their own root even when the parent declares production paths`; `controlled-admission.test.ts :: is disabled unless both isolation variables are present`; `activation-dispatcher.test.ts :: high-risk code_tool_hook → refused`. | `0508343b7`; `ec96a9532` | `component` + `controlled-run` | This round did not independently re-audit the production database or all egress. The pollution boundary remains the v4 audit, not a new scan. |

## Execution order

1. The component-evidence index above is complete for the named tests. Do not
   demand a new host experiment for a row that is still `component`; record the
   layer honestly instead.
2. PRI-1115 validates aggregation against the existing observed sample with
   unknown denominators. A missing control prevents causal claims, not parsing
   and deterministic report development.
3. If the Owner requires the missing control for protocol closure, first request
   an explicit continuation decision. Do not spend the remaining host/HTTP budget
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

Report behavior this round:

- Every run id, count, fact and conclusion in the Owner brief is derived from
  the supplied inputs. A zero-run invocation emits no historical run id or
  historical conclusion.
- `1105` is now `weak_candidate` (`action_timestamp_proximity`, 22 ms); `1258`
  is `matched_by_run` via trusted `hook_invocation_id`. A timestamp or a shared
  session is never an experiment-level strong link.
- Duplicate invocation ids are deduplicated only when scope and semantic facts
  match; conflicting content or scope fails loudly. Input order does not change
  facts.
- V/O/D follow SPEC v0.6 §6.1: V is pre-action visible signal (not delivery),
  O is pre-action recognition (not Agent adherence), D is independent
  confirmation that the target body entered the actual request before the key
  action. Missing evidence stays `unknown`.

Still not satisfied by this report: C04 remains pending (original online gate
failed, no control arm, endpoint user-message digest differs from frozen input);
G1 remains pending. The report supplies machine-readable input wiring and an
Owner brief, not an acceptance pass for any case.
