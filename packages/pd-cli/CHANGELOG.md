# @principles/pd-cli

## 1.155.2

### Patch Changes

- ec96a95: PRI-915: wire `ledgerIdentity.isAvailable` in the evaluator factory and both
  scribe wirings (rulehost pipeline + run-once) so an unreadable principle ledger
  surfaces as `identity_source_unavailable` instead of `invalid_identity` drift.
- Updated dependencies [ec96a95]
- Updated dependencies [ec96a95]
  - @principles/host-runtime@0.8.1
  - @principles/core@1.291.0

## 1.155.1

### Patch Changes

- a334874: PRI-936: `pd pain retry --pain-id` now makes the budget guard bypass observable. The family reset always passes `force=true` (an explicit retry IS the operator's recovery decision), but the `forceApplied` verdict returned by the single recovery authority (`recoverFailedTask`) was dropped — operators could not see which tasks had their attempt budget silently extended. `recoveredTasks` now carries `{taskId, forceApplied}` in the strict JSON output (same shape on the failed and succeeded branches, cli-1) and the text path annotates extended budgets as `(budget extended)` — the size of the extension is core-owned, so the CLI names no number — same-source as JSON.

## 1.155.0

### Minor Changes

- 0b981bb: 提示词容量与生效反馈修复（PD_PROMPT_CAPACITY_V1，阶段 A/B1/B2/C）：
  
  - core：`listEntryLine` 列表行格式单一权威；prompt 版本替换——dispatcher `supersedeActivationId` 通道 + state store 单事务 `replacePromptActivation`（新激活+不可变 supersede 决策+旧版停用，故障回滚不留双活）；`detectPromptReplacementTarget` / `buildOwnerRevisionArtifact`（复用真实 Scribe 内容合同）；Scribe prompt v5 正文最短充分要求。
  - host-runtime：宿主事实绑定的有效注入路由解析（声明∪pain_events，Codex 恒共享、OpenClaw 按 flag、未知不猜测）；投影合同扩展（unit/计费范围/超长透传/诊断截断标记）；单一 `checkPromptArtifactDeliverability` 写入前预检；激活级注入状态读取；注入事件诚实读模型（无日志=unknown 非零）。
  - pd-cli：`pd activation approve --target-host` + prompt 写入前容量门（拒绝零写入、单一 JSON、结构化 nextAction）。
  - console（随 create-principles-disciple 发布）：审批预检门与 422 拒绝、未确认宿主横幅与请求级目标宿主、激活页注入状态与「修改为可注入版本」入口、替换事务 UX。

### Patch Changes

- Updated dependencies [d5732f8]
- Updated dependencies [0b981bb]
- Updated dependencies [0b981bb]
  - @principles/core@1.290.0
  - @principles/host-runtime@0.8.0
  - principles-disciple@2.1.0
  - @principles/codex-adapter@0.5.0

## 1.154.3

### Patch Changes

- 9d44428: PRI-946 (accept-as-is) — clarify in `runtime-activation.ts` that the local activation path reads `PD_CONSOLE_TOKEN` from env only, by Owner decision: it adds no `~/.pd/owner.json`/store fallback of its own and trusts whatever the caller placed in env (the companion decrypts its stored token into env before spawning the CLI), degrading to break_glass when env has none. Comment-only; no behavior change.

## 1.154.2

### Patch Changes

- df2a1fb: R7 gate-bypass fix — `pd candidate intake`, `pd candidate repair` and
  `pd candidate internalization backfill` now construct their
  CandidateIntakeService through the same Reuse Review Gate assembly as
  `pd diagnose` / `pd pain retry` / the automatic bridge. Previously the three
  manual commands ran with `reuseCheck='not_configured'`, so a semantic
  duplicate the gate had parked (`reuse_review_required`) could be written into
  the Principle Ledger as a duplicate Principle with exit 0 (P0 bypass proven on
  shipped 2.2.0/2.2.1). A parked candidate now surfaces
  `status: review_required` (intake/repair) or a deferred result with a
  `pd candidate review --decide` next action (backfill), mutates nothing, and
  emits the `reuse_gate_triggered` telemetry event like every other path.
  `reuseEvaluation.enabled=false` still restores the exact pre-fix behavior.
- 4b18048: PRI-941 Option A — Codex CLI pain record consumes the already-authorized tool_calls failure evidence (PRI-624 tool-governance surface) from the workspace trajectory via a new scoped acquisition that NEVER queries conversation tables (user_turns / assistant_turns remain ingestion-exclusive) and never opens rollout transcripts. An empty failure set keeps the honest unavailable degradation with an accurate reason (empty_trajectory). PainProvenance, painIngress.v1, the admission gate, consent and the G2A disclosure are untouched.
- 6365e2e: R7: the two candidate→ledger read/audit surfaces are now reuse-aware. `pd trace`
  (`PainChainReadModel`) resolves a consumed candidate into the ledger through BOTH
  expressions — `derivedFromPainIds` (created) and `Principle.reuseEvidence[]`
  (resolved into an existing principle by a reuse decision, zero ledger growth by
  design) — so a successful reuse chain traces as `succeeded` with the reuse target
  in `ledgerEntryIds` instead of the false `degraded/ledger_write_failed`.
  `auditCandidateLedgerConsistency` (pd health / pd candidate audit, now one shared
  judgment) no longer flags by-design-absent candidates as missing: reuse-resolved
  candidates are counted in the new additive `reusedResolvedCount`, and consumed
  candidates whose `recommendation_kind` never targets the Principle Ledger (rule /
  implementation / prompt / defer; fail-closed unknown kinds) are counted in
  `nonLedgerKindCount`. Only a consumed principle-kind candidate with no resolution
  anywhere remains true drift (`missingLedgerEntryIds` lists them). On the R7
  production workspace this drops the audit from 63 missing (52+ kind/reuse false
  positives masking real drift) to 5 true-drift entries. No write path changes.
  Audit error results additionally surface the bounded underlying failure reason
  (e.g. a stale state.db schema) with a concrete next action instead of a generic
  refusal, on `pd candidate audit` and every surface sharing the judgment.
- Updated dependencies [6365e2e]
  - @principles/core@1.289.2

## 1.154.1

### Patch Changes

- 0139c88: PRI-939 Option A — reuse gate degradation visibility. The semantic reuse evaluation's unavailable state is now Owner-visible: reuse_gate_triggered and reuse_evaluation_unavailable persist to the workspace critical-events.jsonl sink (recommended deliberately excluded — no second decision log), the four short-lived CLI commands (pain record / pain retry / diagnose / candidate review) emit through a workspace-scoped telemetry emitter instead of the unsubscribed singleton, the intake gate carries the hook outcome on the CREATE result so CLI outputs show why duplicate protection did not run, and `pd health` summarizes the last unavailable event. Gate behavior unchanged (Rule 4, park semantics, reuseDecision/reuseEvidence untouched).
- Updated dependencies [0139c88]
  - @principles/core@1.289.1
  - @principles/host-runtime@0.7.14

## 1.154.0

### Minor Changes

- df9e555: PRI-917 v0.3.3 (OD-PRI917-05): Reuse Review Gate — automatic candidate intake now consults the semantic reuse evaluation capability before creating a Principle.
  
  A `reuse` recommendation parks the candidate (`refused/reuse_pending_owner`): no Principle is written, no evidence is appended, the candidate stays pending for the Owner, and the bridge emits an observable `reuse_gate_triggered` event plus a `reuse_review_required` outcome pointing at `pd candidate review --decide reuse|create`. `create`/`uncertain` recommendations and every evaluation failure degrade to normal creation (learning never blocks). `reuseEvaluation.enabled=false` restores the exact pre-v0.3.3 behavior.
  
  Also fixes the R5 "two-heads-block" defect: `pd candidate review --decide reuse` no longer lets the PRI-442 admission pre-check reject low-confidence candidates — a reuse verdict creates nothing, so the ledger-quality gate does not apply (the `--decide create` pre-check is unchanged).
  
  PR review fixes (4×P2, PRI-938): the bridge cache key now folds in the reuse-gate switch so a long-lived host picks up `reuseEvaluation.enabled` toggles in both directions (T11 rollback without a restart); mixed batches and replays keep parked candidates visible (`reuse_review_required` degraded outcome, Codex worker `reuseReviewRequiredCandidateIds`, OpenClaw `PAIN_SERVICE_REUSE_REVIEW_REQUIRED` log gated on the park disposition); `pd diagnose` / `pd pain-retry` render parked candidates with review guidance and exclude them from `internalize` next-action lists.
  
  Follow-up review fixes: evaluation profile and timeout changes invalidate the cached reuse hook. Replay verifies the original diagnosis admission and performs a read-only reuse check before reporting a parked candidate, preserving failed-intake and gate-disabled behavior without additional persisted state.
  
  Owner-approved configuration hardening: constructing CandidateIntakeService with both reuseRecommendation and reuseDecision now fails explicitly before either callback or any candidate mutation, instead of silently prioritizing the decision channel.

### Patch Changes

- Updated dependencies [cee2304]
- Updated dependencies [df9e555]
  - @principles/codex-adapter@0.4.8
  - @principles/host-runtime@0.7.13
  - @principles/core@1.289.0
  - principles-disciple@2.0.8

## 1.153.1

### Patch Changes

- d37e61a: PRI-917 v0.3.2 review fixes (PR #1902 review findings, 2 P1 + 4 P2).
  
  principles-core: the missing-profile warning in the effective config now
  judges the RESOLVED enabled value (legacy configs without the
  reuseEvaluation section no longer silently skip it); isValidReuseEvaluation
  Output delegates to the full trust boundary (closed field set + cross-field
  rules) instead of the bare open-field-set schema check.
  
  pd-cli: a source=default OpenClaw profile resolves in delegated mode in the
  runtime-adapter-resolver (identical semantics to
  pain-signal-runtime-factory's validateRuntimeConfig) — the semantic reuse
  evaluation capability now actually RUNS under the default configuration
  instead of permanently degrading to unavailable; the evaluation timeout
  falls back to the resolved profile's own timeoutMs; a hallucinated
  selectedPrincipleId is downgraded to unavailable
  (selected_principle_not_in_shortlist) instead of being shown as an
  executable recommendation; the production-validation E2E creates its
  workspace under os.tmpdir().
- Updated dependencies [d37e61a]
  - @principles/core@1.288.1

## 1.153.0

### Minor Changes

- cc8c84a: PRI-917 v0.3.2 — Semantic Reuse Evaluation Capability (five-layer merge train).
  
  principles-core: reuse-evaluation-output contract (closed field set +
  cross-field rules), ReuseEvaluationRunner (proposal-only, PDRuntimeAdapter +
  structured-output-repair), reuseEvaluation config section, profile-id
  runtime resolution, reuse_evaluation_recommended/unavailable telemetry
  events.
  
  pd-cli: pd candidate review shows the semantic evaluation (advisory — the
  Owner decides; observable degrade to lexical-only), and reuse_selected
  intake outcomes report the resolution instead of a refused-write error.
  
  Governance boundary unchanged: the capability only RECOMMENDS; the Owner's
  verdict is recorded exclusively in Principle.reuseEvidence[]. No new
  database, decision storage, relationship entity, capability registry, or
  agent registration.

### Patch Changes

- Updated dependencies [cc8c84a]
  - @principles/core@1.288.0

## 1.152.18

### Patch Changes

- 0939eac: fix: address PR 1900 review findings — admission gate bypass, reuse proposal validation, CLI contract hardening, and telemetry registration
- Updated dependencies [0939eac]
  - @principles/core@1.287.8

## 1.152.17

### Patch Changes

- b50ec74: `pd pain retry` no longer dead-ends on a failed diagnosis task: it now
  recovers the failed diagnostician family (parent + rootcause/distiller/router
  stages) through the shared recovery authority before re-running, and a
  surviving `lease_conflict` says so with a nextAction pointing at
  `pd runtime recovery failed-tasks`. Both CLI diagnosis paths
  (`pd diagnose run` and `pd pain retry`, including dead-letter replay) now
  write the `pain_diagnoses` attribution ledger when the
  `pain_diagnosis_persistence` flag is on — the result reports
  `attempted` / `disabled` / `skipped_no_pain_lineage` honestly instead of
  silently dropping the attribution row (PRI-934, PRI-935).
- Updated dependencies [7421049]
- Updated dependencies [b50ec74]
  - @principles/host-runtime@0.7.12
  - principles-disciple@2.0.7
  - @principles/core@1.287.7

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
