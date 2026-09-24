# @principles/pd-cli

## 1.152.16

### Patch Changes

- da4c731: Identity **writer** boundary (PRI-911A, third gate after the Type Boundary #1851 and the Activation Identity Boundary #1856): `pi_artifacts.source_principle_id` can now only ever hold a **canonical ledger UUID or NULL** — never title/`T-NN`/other display text. Audit trail: `docs/audit/identity-writer-hardening.md`.
  
  **W1 — DreamerRunner no longer carries an LLM-asserted identity.** The runner wrote `output.sourcePrincipleId` straight onto the artifact column; after `stripFabricatedCorePrincipleIds` the only value that can reach it is a Historical Core Principle registry id (`T-NN`), which is not a ledger principle. The column is now left empty and the assertion is reported via `dreamer_identity_assertion_not_carried`. The value still rides in `contentJson`, so the Activations console's Bug-O L1 'unlinked' display is unchanged — stamping the real identity remains ScribeRunner's ledger-verified job (PR #1856 I2).
  
  **W2 — EvaluatorRunner's rule stamp replaced its lenient chain.** Rule assembly previously resolved the identity through column → `contentJson.principleId` → `contentJson.sourcePrincipleId` → `principleDraft.title`, which is exactly how philosopher titles became durable identities in the column. Assembly now reads the bearer's `source_principle_id` column only, gates it through `canonicalLedgerPrincipleId` — the value-level gate split out of PR #1856's `resolveActivationPrincipleId`, so there is still exactly one UUID parser in the repo — and, when the host injects the new optional `EvaluatorRunnerDeps.ledgerIdentity.hasPrinciple`, verifies ledger membership. Outcomes: `evaluator_identity_stamp_success`, or the rule written with a NULL identity plus `evaluator_identity_stamp_failed` carrying `missing_identity` / `non_canonical_identity` / `invalid_identity` (`ambiguous_identity` stays with the bearer/lineage resolvers that can actually see multiplicity).
  
  **Rule assembly is deliberately NOT aborted on an unverified identity** — PR #1856 established that identity gaps are enforced at the publication boundary (rule preserved, no approval subject, no activation), so a wrong identity no longer silently becomes a lost candidate; `evaluator_rule_assembly_failed` keeps its structural meaning. All three production `EvaluatorRunner` construction sites (host-runtime consumer cycle, pd-cli `createEvaluatorRunnerDeps` shared by RuleHost and `runtime internalization run-once`) are wired with the ledger check; unwired callers keep the shape-only gate. The wiring is no longer
  grep-maintained: `identity-writer-production-wiring.test.ts` fails if a production construction site
  drops the injection (or bypasses the sanctioned `createEvaluatorRunnerDeps` factory), or if an identity
  event name drifts away from `TelemetryEventType`. Rollback = revert; no schema change, no data migration, no new flag.
- Updated dependencies [da4c731]
  - @principles/core@1.287.5
  - @principles/host-runtime@0.7.10

## 1.152.15

### Patch Changes

- 42f0f4a: Activation identity boundary is now **ledger-aware and end-to-end** (Phase 3, I2 + I3 — `docs/architecture/principle-identity-reconciliation.md`), fixing the Owner review of PR #1856 where the shape-only gate cut the live production chain.
  
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
  - The pd-console **E2E seed** (`scripts/e2e-seed.ts`) now seeds ledger-backed UUID identities for every `pi_artifact` it writes (10 stable UUIDs + `p-001`). Previously the seed pointed artifacts at non-UUID, non-ledger ids (`p-001`, `p-002`, `p-click-*`, `p-rulecode-*`), so under the fail-closed gate the happy-path approvals returned 500 (`no_principle_id_in_artifact`) and — worse — that gate reason **shadowed** the RuleHostWriter golden-trace schema check that `rule-host-writer-golden-trace.spec.ts` asserts. With ledger-resolved identities the gate passes and the schema check runs, so `golden_trace_schema_invalid` surfaces as the spec requires (its own regression contract). Verified locally: `focus-approve-flow` 2/2, `rule-host-writer-golden-trace` 4/4, BDD `focus-page` 1/1.
  - `resolveActivationPrincipleId` now **lowercase-normalizes** the resolved UUID: ledger keys come from `randomUUID()` (always lowercase), so an uppercase-but-shape-valid UUID previously missed `hasPrinciple` and was misreported as `principle_not_in_ledger`.
- Updated dependencies [42f0f4a]
  - @principles/core@1.287.4
  - @principles/host-runtime@0.7.9

## 1.152.14

### Patch Changes

- de38d90: Principle Ledger write boundary (Phase 1 / PR1): candidate-origin writes to the Principle Ledger now require a validated `recommendation_kind === 'principle'`. Unknown, missing, or malformed kinds are refused fail-closed and reported as an explicit disposition instead of silently collapsing into a principle; candidate persistence, kind routing, and defer handling are unchanged.
- Updated dependencies [4ced615]
- Updated dependencies [de38d90]
  - @principles/core@1.287.3
  - principles-disciple@2.0.4

## 1.152.13

### Patch Changes

- 99e6a8c: RAH-1 (PRI-905): production builds now exclude test code (tsconfig.build.json: *.test.*, __tests__/, __fixtures__/, *.spec.*), clean dist before building, and fail the build if compiled test artifacts appear in dist. Published dist shrinks accordingly (@principles/core tarball was ~57% test artifacts by size); runtime API, source layout and vitest behavior are unchanged. Test files are still type-checked via the new `typecheck` (tsc --noEmit) scripts, wired into verify:merge.
- 454eccf: RAH-2 (PRI-906): add a `files` publish whitelist (`dist`, `README.md`) to @principles/pd-cli. The package previously had no whitelist, so npm shipped the entire working tree: 111 uncompiled source files, the full 111-file test suite, and 2 development scripts alongside dist (~450 published files). Runtime surface (bin/exports/main → dist) is unchanged.
- Updated dependencies [c7453ea]
- Updated dependencies [84c7074]
- Updated dependencies [1ac725c]
- Updated dependencies [df43600]
- Updated dependencies [99e6a8c]
- Updated dependencies [edbbcd9]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/host-runtime@0.7.8
  - @principles/codex-adapter@0.4.7
  - principles-disciple@2.0.3
  - @principles/core@1.287.2
  - @principles/install-layout@0.2.7

## 1.152.12

### Patch Changes

- 75b4ac4: PRI-866 sourcePainId reader convergence: pd-cli's two inline sourcePainId parsers now delegate to the core canonical reader (exported from @principles/core/runtime-v2), and the rulehost pipeline dreamer-task lookup normalizes both sides at the comparison boundary — historical rows or queries carrying surrounding whitespace no longer miss their dreamer seed and are no longer rejected with a misleading no_dreamer_task_seeded.
- Updated dependencies [75b4ac4]
- Updated dependencies [8ae91f4]
  - @principles/core@1.287.1
  - @principles/codex-adapter@0.4.6

## 1.152.11

### Patch Changes

- 8424d60: Baseline-cutover dependency-contract fix: the internal dependency ranges now match the aligned component versions (principles-disciple ^2.0.1, @principles/host-runtime ^0.7.7, @principles/codex-adapter ^0.4.4). Without this, npm would nest stale registry copies inside the workspace after version alignment (ERR-131 single-copy violation; the 2026-09-19 release-train failure mode).
- Updated dependencies [8424d60]
- Updated dependencies [8424d60]
- Updated dependencies [8424d60]
  - @principles/codex-adapter@0.4.5
  - @principles/core@1.287.0
  - principles-disciple@2.0.2
