---
'@principles/core': patch
---

Activation identity boundary is now **ledger-aware and end-to-end** (Phase 3, I2 + I3 — `docs/architecture/principle-identity-reconciliation.md`), fixing the Owner review of PR #1856 where the shape-only gate cut the live production chain.

**I2 — production chain stamping (the missing half of the ADR §6).** `ScribeRunner` now resolves the ledger principle identity through the real chain and stamps it at write time: scribe context → dreamer artifact (`sourceDreamerArtifactId`) → dreamer task seed `diagnosticJson.candidateId` (fallback: the `dreamer-<candidateId>-<channel>` task-id spelling) → `ledger.listForCandidate` exactly-one. Stamping is fail-soft and observable (`identity_stamp_failed` / `identity_stamp_skipped` events; `task_succeeded` carries `sourcePrincipleId`) — an unresolvable or ambiguous chain writes the artifact unstamped instead of guessing. Requires the new optional `ScribeRunnerDeps.ledgerIdentity` dep; unwired callers are unchanged.

**I3 — ledger membership, verified BEFORE the commit.** The gate moved out of the writers (they now only guard `kind` + `validationStatus`) into `ActivationDispatcher.resolveActivationIdentity`, which runs on **both** paths: `enqueueForApproval` (before the approval record — that record *is* the pre-commit state change) and `activateArtifact` (before the activation commit). Resolution states:
- `direct_validated` — a stamped UUID that the ledger actually contains;
- `candidate_lineage` — an unstamped artifact resolved through the dreamer lineage;
- unresolved → `invalid_artifact`. A stamped-but-unknown UUID is data drift (`principle_not_in_ledger: <id>`) and never falls through to lineage guessing.

UUID shape alone never proves membership. Writers no longer refuse identity-less artifacts (they lack ledger deps; the dispatcher is the single gate). Without `ledgerIdentity` deps the legacy strict UUID-shape boundary applies unchanged, so unwired callers keep prior behavior.

Console / CLI / E2E fixtures were migrated to real ledger-backed UUID identities, and **all manual identity stamping in tests was removed** — the identity must now come from the production chain.

**Every production dispatch site is now wired with ledger deps**, so the identity chain is not cut at any entry point:

- `demo-story-a-runner` previously used the synthetic string `demo-principle-<runId>` as the artifact identity and built its dispatcher with no ledger deps — the new gate refused all three channels (`invalid_artifact`). It now mints a **real ledger principle** (`PrincipleTreeLedgerAdapter.writeProbationEntry`, `derivedFromPainIds: [demo-<runId>]`), stamps that UUID onto both artifacts (`makePrincipleArtifactRecord(runId, principleId)`), and passes `ledgerIdentity` to both dispatchers. The Story-A demo exercises the SAME identity contract production does instead of bypassing it.
- `pd-cli` rollout-parity fixtures seed the durable ledger entry their scribe chain implies (a real principle UUID + `sourceRef`), matching what a production internalization produces.
- `resolveActivationPrincipleId` now **lowercase-normalizes** the resolved UUID: ledger keys come from `randomUUID()` (always lowercase), so an uppercase-but-shape-valid UUID previously missed `hasPrinciple` and was misreported as `principle_not_in_ledger`.
