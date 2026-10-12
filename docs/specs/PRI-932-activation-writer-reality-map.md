# PRI-932 — Activation Writer & Reader Reality Map

> **Phase A / Read-only audit**, 2026-10-12; **v0.2.1** — re-anchored and completed by the A.2 adversarial review (report: `docs/specs/PRI-932-phase-a2-adversarial-review.md`); W13 updated for the v0.3.0 two-identity model (Owner round P1-02). Baseline: `main@91d75b21ba8ebf458709406756f4b6e7e883c385`.  
> **Status:** Owner review draft; no production implementation. Source paths below are relative to `packages/`.  
> **Audit method:** production TS grep (`INSERT/UPDATE/DELETE activations`, store methods) + direct partial source reading, re-verified independently by two A.2 reviewers with whole-repo scans. **Code-path inventory, not an executed full host E2E**. Method-name anchors are authoritative; line numbers drift — re-anchor at PR time (AC-14).

## 1. Scope and definitions

- **Lifecycle transition:** activation period started, stopped, promoted or superseded. Requires durable immutable fact and correct occurrence ID.
- **Governance/control operation:** decision recorded, global pause or `safety_isolated`; not necessarily a lifecycle transition. Do not fabricate activate/deactivate.
- **Current projection:** `activations` remains live/latest operational view with a stable idempotency key, not archival authority.
- **Occurrence:** one discrete interval of activation; `activation_id` can be reused. A receipt with only `activation_id` cannot always identify the precise interval.

## 2. Production writer matrix

Line references re-anchored against baseline `91d75b21` by the A.2 review (both reviewers independently; drift corrections marked). Dispositions implement the SPEC v0.2.0 §4.4 write architecture.

| ID | Code entry | Mutation | Existing transaction/authority | Phase B obligation |
| --- | --- | --- | --- | --- |
| W01 | `principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts:84-117 recordActivation` | `INSERT OR REPLACE INTO activations` + control-state seed (`INSERT OR IGNORE`, :105-111) | `BEGIN IMMEDIATE` | Remove silent history loss; append `activated` fact (fact-first) in same commit; explicit repeat/reactivate semantics and rollback |
| W02 | same :174-182 `deactivateActivation` | `UPDATE activations SET deactivated_at` by activation_id | **Standalone UPDATE, no transaction** | Refactor under one `BEGIN IMMEDIATE`: cardinality guard (exactly one live subject, else explicit already-inactive/refusal), `deactivated` fact with caller-supplied actor/reason (SPEC INV-11), atomic commit |
| W03 | same :199-292 `replacePromptActivation` | `INSERT INTO activations` (:264-269), `INSERT INTO activation_decisions` (:271-279), old `UPDATE deactivated_at` (:281-284) | `BEGIN IMMEDIATE`; replay/`already_replaced` branch :252-258 | New `activated` + old `superseded` (single fact, subsumes deactivation) in same existing tx; replay branch must mint **zero** new facts; maintain old-only rollback |
| W04 | same :293-341 `promoteActivation` | shadow → live `UPDATE action,promoted_at` | `BEGIN IMMEDIATE`, COUNT guard | **Dead code: no production callers (tests only; PRI-818 audited, in-repo comment `writers/rule-host-writer.ts:362-368`).** Production promotion is W07. Disposition (AC-14): either route through the lifecycle helper like any writer, or delete; never leave silently unwired. `promoted_live` facts are emitted **only** on W07 |
| W05 | `principles-core/src/runtime-v2/activation/sqlite-activation-safety-store.ts:175-216 deactivateWithDecision` | Owner decision INSERT + deactivate UPDATE | `BEGIN IMMEDIATE` with configured-owner/break-glass authorization | Link `decision_id` to `deactivated` fact; actor from decision principal; atomically preserve |
| W06 | same :242-260 `recoverToShadow` | typed recovery decision + **new** shadow activation/control row | `BEGIN IMMEDIATE` | New period/occurrence (`activated` fact, source_kind `safety_store`) for the shadow row, linked to source activation; **no** deactivation fact for the still-live isolated source (verified: source row and its isolation are preserved) |
| W07 | same :319-421 `commitPromotion` (**replay branch :341-350 is the no-double-emission anchor**; v0.1.0 cited 365-422, which missed authorization checks and the replay branch) | promotion decision, evidence snapshot INSERT, possible old-live supersede decision+UPDATE (:401-403), new `UPDATE action,promoted_at` (:406-409), control bump | `BEGIN IMMEDIATE` | `promoted_live` fact for the subject + `superseded` fact for each replaced old live RuleCode, all in same tx, with cardinality checks and replay-first idempotency |
| W08 | same :127-173 `pauseAllLive` and `releaseGlobalPause` | `global_rulecode_pauses` and `activation_decisions`, **no activations UPDATE** | `BEGIN IMMEDIATE` | Do not emit lifecycle events; preserve separately typed control/decision facts |
| W09 | same :273-317 `safetyIsolate` (production trigger: `openclaw-plugin/src/core/rulecode-safety-circuit.ts:70-77`); :218-240 `recordOwnerDecision` | `activation_control_states` and `activation_decisions`, **no lifecycle UPDATE** | `BEGIN IMMEDIATE` | Not an activation stop; no lifecycle events; ensure history API distinguishes effective enforcement |
| W10 | `pd-cli/src/commands/legacy-cleanup.ts:196-241 applyV1ArtifactCleanup` | direct `DELETE FROM activations`, approvals, artifacts | `db.transaction` | Not a lifecycle writer. Guard blocks bare DELETE (SPEC §4.4.3); OD-05 default: `--apply` refuses when facts/observations reference targets; tombstone path needs separate approval |
| W11 | `pd-cli/src/commands/runtime-activation.ts:437-496` (audit-first fail-closed :447-459, store call :469) | `activationStateStore.deactivateActivation` | audit log before store UPDATE, no shared file+DB atomic transaction | Preserve existing fail-closed audit precheck and explicit outcome; actor/reason pass into W02's fact; lifecycle DB transition same tx as projection |
| W12 | `pd-console/src/server/models/ActivationsConsoleModel.ts:739-780` | wraps `activationStore.deactivateActivation` in governance action | authorization wrapper, then store mutation | Preserve Operator/Owner authorization semantics; actor ('session')/reason ('console_disable_confirmed') pass into the fact; do not confuse JSONL action audit with lifecycle authority |
| W13 | `principles-core/src/runtime-v2/activation/activation-dispatcher.ts:227-516` | dispatches to W01/W03; only approved verified path writes | independent approvalId verification (`verifyApprovedDispatch` :537-600 checks existence/status/artifact/channel — **not** `decided_at`, and activation does not consume the approval row); *does not itself SQL write* | Keep identical approval and identity checks; **v0.3.0 obligations:** (1) `operation_key` per SPEC §4.1 = `dispatcher|activate|<idempotency_key>|<request_digest>` — the reusable deterministic approvalId (`sqlite-approval-store.ts:138-157`) is authorization context (`decided_at_snapshot` inside the digest), never the per-occurrence discriminator; (2) approval-epoch freshness: refuse activation when the acting approval's `decided_at` predates the subject's latest stop fact (`approval_epoch_stale`, SPEC §4.4.4) — verified latent replay path today (`:644-646` comment: deactivation re-opens dispatch); (3) dispatcher idempotency gate must not let a post-commit duplicate delivery mint a second occurrence (AC-03) |
| W14 | `principles-core/src/runtime-v2/activation/memory-activation-state-store.ts:4-63` | Map latest value; `deactivateActivation` **first-match-return-true** (:47-56) vs SQLite all-rows `changes > 0` | test-only in-memory semantics; no durable authority | Enumerated alignment (SPEC §4.5): stays fact-free; align deactivation boolean semantics (recommended: all-rows) via dual-store contract test; optional capabilities (`replacePromptActivation`, `promoteActivation`) stay absent and dispatcher-refused |

**Coverage status (re-verified by A.2 whole-repo scans, both reviewers):** production `activations` DML = W01-W07 (9 statements) + W10 (1 DELETE); no missed production writers. `W02`'s UPDATE is the only transaction-less path. `sqlite-connection.ts:839` (002 one-time control-state backfill) is a schema migration write, registered in §2a. Re-run the scans at Phase B merge gate.

### §2a Non-production / one-time writer registry (review B-08 — required for AC-14 closure)

| Location | Mutation | Classification |
| --- | --- | --- |
| `sqlite-connection.ts:836-848` | 002 migration one-time `INSERT OR IGNORE` into `activation_control_states` | Production, one-time schema migration; not a lifecycle writer |
| `pd-console/scripts/e2e-seed.ts:248,:262-279` | INSERT activations / control states | Development seed script; synthetic |
| `pd-console/tests/ai-user/seeds.ts:72` | INSERT activations | Test seed |
| `pd-cli/scripts/llm-dogfood.ts:398-406` (calls `deactivateActivation` :400) | store-level write against `os.tmpdir()/pd-dogfood-*` workspace | Synthetic (temporary workspace) |
| `scripts/telemetry-production-smoke.mjs:88` | CREATE TABLE activations + writes on synthetic temp db | Synthetic |
| `principles-core/src/runtime-v2/proven-channel-baseline.ts:176-180` | no-op `recordActivation` stub | Baseline stub |

Phase B audit gate re-runs the scan commands and reconciles against this registry; any unregistered DML is a finding.

### Special risk: deterministic public `activation_id`
- `principles-core/src/runtime-v2/activation/low-risk-writers.ts:110-149`: PromptWriter's ID is `act_prompt_${principleId}_sha256(artifactId)`; DeferArchiveWriter uses `act_archive_${principleId}`. RuleHostWriter: `act_code_${ruleId}` (`writers/rule-host-writer.ts:378`). Same artifact/rule reactivated produces the same ID.
- **Stale control-state reactivation deadlock — verified existing defect (review B-01; A-15 blast-radius correction):** if a prior period was `safety_isolated` (production trigger: circuit breaker `rulecode-safety-circuit.ts:70-77`), the reactivated period inherits the stale `safety_isolated` control row (`INSERT OR IGNORE`, `state-store.ts:105-111`); RuleHost silently skips it (`rule-host.ts:438-443`), `commitPromotion` permanently refuses (`safety-store.ts:361-363`), recovery does not apply, and **no reset API exists**. Blast radius is **fail-closed refusal (dead rule), not a silent enforcement bypass**. SPEC §4.6/OD-09/AC-15 record and characterize it; the fix is an independent follow-up, out of PRI-932 scope.
- `activations` is not activation_id-unique; W02's UPDATE can affect more than one row, while W04 protects some cases with COUNT. W02's Phase B refactor adds the cardinality guard (INV-05).

## 3. Read/consumer matrix

| Area | Evidence | Compatibility gate |
| --- | --- | --- |
| Core runtime selector | `SqliteActivationStateStore.getActivationStatus` filters `deactivated_at IS NULL` (:70-82); `listPromptActivations` (:119-137) and `listCodeToolHookActivations` (:139-154) sort/filter; `listAllActivations` (:156-172) | Preserve current-only semantics and stable ordering; do not show all historical periods by default |
| Prompt host-runtime | `host-runtime/src/active-principle-prompt.ts:91`, `prompt-injection-status.ts:109`; plus projection family: `prompt-injection-projection.ts`, `prompt-injection-event-evidence.ts`, `prompt-activation-deliverability.ts` (indirect via core read models; review B-11) | Preserve Prompt active set and existing fair rotation |
| RuleHost host-runtime | `host-runtime/src/production-rulehost-gate.ts:226` joins active activations | No accidental shadow/live/safety bypass |
| OpenClaw host | `openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts:37`; `rule-host.ts:365-449`; `principle-receipt-metadata.ts:186` (display-level fallback only); `rulecode-safety-circuit.ts:63-77` | Same active-only consumption and typed safety controls |
| Codex host | Codex is integrated through host-runtime; test paths `codex-adapter/tests/pd-hook.production.test.ts` and `user-workspace-scripts.test.ts`; **no direct Codex SQL writes** (verified: `pd-hook.ts`, `workspace-worker.ts` are comment/event-type only) | Real Codex host acceptance required for Phase B |
| CLI | `pd-cli/src/commands/runtime-activation.ts:810-818` lists prompt, code, all | `--include-deactivated` keeps current projection meaning, **not** full historical timeline |
| Console | `pd-console/src/server/models/ActivationsConsoleModel.ts:282,498,723,739-780`; `GovernanceProjectionCollector.ts:158`; `OwnerDecisionConsoleModel.ts:325`; `ApprovalsConsoleModel.ts:218,849`; **`ApprovalsGroupedConsoleModel.ts:267` (review B-11)** | No duplicate cards or unsafe actionable state changes; Option B keeps one-row-per-key projection so no card duplication is introduced |
| Core read models | `principles-core/src/runtime-v2/activation-compatibility-read-model.ts:84` (SELECT JOIN activations); `internalization-chain-integrity-read-model.ts:529` (SELECT live rows) — **review B-11** | Read-only; stay on projection semantics |
| Telemetry | `host-runtime/src/product-telemetry/milestone-readers.ts:173` (SELECT EXISTS) — **review B-11** | Read-only |
| Evidence ingress | `host-runtime/src/intervention-evidence-ingress.ts:125,203,207-209` (explicit reused-ID gap → null); `openclaw-plugin/src/core/principle-receipt-metadata.ts:186` | Existing activation_id-only refs are potentially time ambiguous; must not silently reattribute |
| Principle trajectory | `pd-console/src/server/models/PrincipleTrajectoryModel.ts:284` | Future lifecycle read can add provenance but existing API remains unchanged |
| Existing Evidence DB | `principles-core/src/runtime-v2/store/intervention-evidence-schema.ts:35-62` | `activation_ref_json` already exists but typed continuity is not proof of occurrence identity |

## 4. Dangerous equivalences to forbid

1. `activation_id` ≠ `occurrence_id`: a single deterministic ID may denote multiple distinct intervals.
2. `activation_decisions` ≠ every lifecycle event: it captures typed Owner and safety decisions, not every ordinary activation.
3. A global pause or safety isolation ≠ setting `deactivated_at`: enforcement status is separate.
4. An app-logged "authorized" action ≠ committed SQLite lifecycle fact.
5. Current `activations.activated_at` ≠ first-ever activated time after REPLACE.
6. A receipt `occurred_at` earlier than current `activated_at` ≠ confirmed pre-activation execution.
7. **(v0.2.0)** A trigger on `activations` is a **guard**, never a fact author (review A-02): triggers cannot carry decision/actor/operation attribution and cannot see the replaced row under `INSERT OR REPLACE`.

## 5. Required Phase B mutation review checklist

- Re-run whole repository search over SQL strings, dynamic query builders, scripts, installers and data migrations, not only listed TS paths; reconcile against the §2a registry.
- Every projection DML (INSERT/UPDATE/DELETE/REPLACE) must have an explicit transition classification: emit durable lifecycle fact; emit typed governance/control fact; or block destructive maintenance.
- All fact appends follow SPEC §4.4: caller-owned transaction, helper appends only (never BEGIN/COMMIT), fact-first ordering, SELECT-first idempotency by `operation_key`.
- Existing `replacePromptActivation` and `commitPromotion` must not call nested `BEGIN IMMEDIATE`; add writes inside their existing transaction.
- Verify cardinality and compare-and-swap under transaction, including same activation_id across artifacts (W02 refactor).
- Verify schema-init warnings cannot allow current-only writes (INV-09 verification at every write-method entry).
- Ensure no old writable binaries bypass new history (§4.4.3 guards; old binary sees the RAISE message) and no retention cleanup deletes immutable events.
- Test snapshot-based evidence with reused activation_id: no confident causal association when time/occurrence ambiguous.
- Preserve Owner approval and break-glass boundaries, no new automatic activation.

## 6. Known evidence and investigation limits

**DIRECT:** SQL/method declarations above (re-anchored by two independent reviewers); local isolated SQLite reproduction recorded in main SPEC; A.2 better-sqlite3 experiments (guard feasibility, REPLACE/trigger semantics, nested transactions, concurrency serialization — review report Appendix A); existing 2026-09-27 audit supports production observations.  
**INFERRED:** historical ambiguity may affect other data; the stale control-state deadlock is code-verified with a real production trigger path but has **not** been observed as a live incident (AC-15 characterizes it).  
**UNKNOWN:** current production data counts, all runtime installed version mappings, non-TS script coverage beyond §2a registry, rollout mixed-version concurrency, ability to recover deleted event files.

**Result:** SRC_MAP_DRAFT_READY = YES (v0.2.1, re-anchored + registry + v0.3.0 W13 obligations); WRITER_COVERAGE_CERTIFIED_FOR_MERGE = NO (re-certify at Phase B audit gate); PHASE_B_AUTHORIZED = NO.
