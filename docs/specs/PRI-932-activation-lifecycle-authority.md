# PRI-932 — Activation Lifecycle Durable Authority (AUD-006)

> **Status:** DRAFT v0.3.0 — Ready for Owner Re-Review / 未获批准，禁止 Phase B 实现  
> **Phase:** A.2 — Reality Audit + Design + Adversarial Review; **Version:** 0.3.0; **Date:** 2026-10-12  
> **Baseline:** `main@91d75b21ba8ebf458709406756f4b6e7e883c385` (2026-10-12 07:23 +0800)  
> **Linear:** https://linear.app/principlesdisciple/issue/PRI-932  
> **Evidence:** `docs/specs/PRI-932-activation-writer-reality-map.md` (v0.2.1), `docs/specs/PRI-932-legacy-history-recoverability.md` (v0.2), `docs/specs/PRI-932-phase-a2-adversarial-review.md` (v1.1.0, incl. Owner-round addendum)  
> **v0.1.0 → v0.2.0:** independent adversarial review (2 reviewers, 26 findings, 0×P0, 6×P1) completed; all P1 spec defects fixed in place; enforcement strategy resolved to **B1 + DB guard** (was open OD-02 "B1 vs B2"); AC matrix extended (AC-15/AC-16); OD table updated (OD-02 narrowed, OD-09 added).  
> **v0.2.0 → v0.3.0 (Owner REQUEST CHANGES round):** two Owner-identified P1 design flaws fixed — **P1-01** the DB guard's existential fact check allowed stale-fact replay to resurrect a deactivated principle (verified by real-SQLite reproduction; guard redesigned to *unconsumed-latest-transition* semantics, AC-17); **P1-02** `operation_key` assumed re-activation yields a new approvalId, but `apr_<channel>_<artifactId>` is a deterministic reusable queue slot (`sqlite-approval-store.ts:138-157`) — operation identity redesigned to approval-independent request digest, plus approval-epoch freshness obligation (AC-18, OD-10).  
> **ADR state:** not Accepted; this SPEC is a design proposal, not a deployment authorization.

## 0. Executive decision / 一页结论

**Problem (DIRECT):** `SqliteActivationStateStore.recordActivation()` uses `INSERT OR REPLACE INTO activations`. `activations` has no primary key and has unique `idempotency_key`; deactivation is `UPDATE deactivated_at`. A second activation for the same artifact/channel replaces the old row and erases its prior `activated_at` and `deactivated_at`. An isolated real SQLite reproduction yielded rowid 1 at T1/T2, rowid 2 at T3, and a prior receipt whose time predates the surviving activation row. The underlying historical causal ordering cannot be reconstructed solely from current state.

**Proposed choice:** **Option B — keep `activations` as the present-state projection, add a single immutable durable lifecycle-fact authority in `state.db`, commit each transition atomically with projection/Owner decision updates.** This minimizes disruption to Prompt/RuleHost/Console reads. It is **not** permission to implement. Owner must approve OD-01..OD-10.

**Enforcement strategy (resolved; hardened after the Owner review round):** **B1 — one shared transaction-aware lifecycle-fact helper that every projection writer calls inside its existing transaction, plus DB-level guard triggers on `activations` that abort any projection mutation not justified by an UNCONSUMED current transition fact.** Trigger-authored facts (B2 as a fact *author*) were evaluated and **rejected with experimental evidence** (see §4.4 and review report A-02): triggers cannot obtain attribution (decision/actor/operation context), cannot see the replaced row under `INSERT OR REPLACE`, and mint duplicate facts on replay. Triggers remain in the design **only as guards** (fail-closed refusal), never as fact authors.

**Guard semantics are consumption-aware, not existential (v0.3.0; Owner P1-01).** A v0.2.0 draft guard accepted *any* historical fact with a matching `(idempotency_key, occurred_at)` — but facts are permanent, so a stale replay of the first activation's `INSERT OR REPLACE` could resurrect a deactivated principle with zero new facts. Verified by real-SQLite reproduction (review report §Appendix B, Owner-confirmed). v0.3.0 guards accept a fact **only while it is the latest transition fact for its key** (definition and trigger predicates in §4.4.3); AC-17 requires the attack suite to stay red-proof in Phase B.

**Operation identity is approval-independent (v0.3.0; Owner P1-02).** Approval IDs are deterministic reusable queue slots (`apr_<channel>_<artifactId>`, `INSERT OR IGNORE`), so a genuine re-activation reuses the same approvalId; v0.2.0's `operation_key` would have misread every re-activation as a replay. §4.1 defines a two-identity model: *approval identity* gates authorization (with a new approval-epoch freshness rule, OD-10); *operation identity* is a request-parameter digest that is stable across failed retries and distinct across genuine re-activations.

**Non-negotiable:** No unverifiable historical reconstruction; no second Owner authority; no separate best-effort event write; no change to the approval gate or runtime enforcement semantics. An implementation that only adds a historical table at `recordActivation()` is **NO_GO**.

## 1. Scope / Non-goals

### In scope
- Durable, auditable *transition facts* across activate → deactivate → reactivate; prompt revision supersede; RuleCode shadow → promote_live → deactivate/recover; any operation mutating activation lifecycle.
- Immutable occurrence identity independent of legacy `activation_id`; current projection remains fast.
- All production SQLite mutation paths and the `MemoryActivationStateStore` test double's semantic alignment (enumerated in §4.5).
- Migration readiness, read-only opening, 3-month historical query, idempotency, transaction rollback, dual-host consumer compatibility, fail-closed writes if durability is unavailable.
- Explicit representation of evidence limits and legacy temporal ambiguity.
- Actor/reason attribution for non-decision transitions (CLI/Console deactivations) captured durably with the fact (v0.2.0; was JSONL-only, 7-day retention).

### Out of scope
- PRI-910 canonical Principle identity reconciliation and old title → UUID inference.
- Repairing the **stale control-state reactivation deadlock** (existing defect, verified; see §4.6 — recorded for Owner awareness, fix belongs in an independent follow-up SPEC).
- Expanding Owner authentication/authorization, Principle quality, Evidence Phase-1 completion, causal inference, attribution scoring, AI learning/rule generation, generalized event bus, Console product redesign.
- Migrating live production data or changing application code during Phase A.

## 2. Baseline: existing facts and observed risk

Line references re-anchored against baseline `91d75b21` during the A.2 review (method-name anchors are authoritative; line numbers drift — re-verify at PR time).

| Contract | Current code evidence | Risk/required preservation |
| --- | --- | --- |
| Current activation table | `runtime-v2/store/sqlite-connection.ts:473-484`; unique `idx_activations_idempotency` | No PK; one row per key; maintain current reader contract |
| Re-activation | `runtime-v2/activation/sqlite-activation-state-store.ts` `recordActivation` (:84-117) | Active-only lookup (:70-82) + `INSERT OR REPLACE` physically replaces old cycle |
| Deactivate | same file :174-182 `deactivateActivation` | **Standalone UPDATE, no transaction**; can affect multiple same-`activation_id` active rows; guard/cardinality needed |
| Prompt replacement | same file :199-292 `replacePromptActivation` | Existing `BEGIN IMMEDIATE`; replay branch :252-258; preserve all-or-nothing |
| Dead promotion path | same file :293-341 `promoteActivation` | **No production callers (tests only; PRI-818 audited 2026-09-15, see `writers/rule-host-writer.ts:362-368`)**. Production promotion is `commitPromotion` (W07). Phase B disposition in AC-14; do not wire events to W04 without also routing it through the helper |
| RuleCode decisions | `activation/sqlite-activation-safety-store.ts` — `deactivateWithDecision` (:175-216), `recoverToShadow` (:242-260), `commitPromotion` (:319-421, replay branch :341-350), `pauseAllLive`/`releaseGlobalPause` (:127-173), `safetyIsolate` (:273-317), `recordOwnerDecision` (:218-240) | Own `BEGIN IMMEDIATE` transactions; do not bypass |
| Governance entry points | `pd-cli/src/commands/runtime-activation.ts:437-496` (audit-first, fail-closed); `pd-console/src/server/models/ActivationsConsoleModel.ts:739-780` | Preserve permissions; JSONL action audit is not a lifecycle authority; actor/reason live in 7-day-retention JSONL today (W11/W12 + INV-11) |
| Destructive maintenance | `pd-cli/src/commands/legacy-cleanup.ts:196-241` | Direct `DELETE FROM activations` inside `db.transaction`; retention vs cleanup semantics must be made explicit (OD-05) |
| Existing decisions/evidence | `activation_decisions` (immutable, trigger-guarded, 9-value decision enum), `intervention_evidence_records` | Not a continuous lifecycle timeline; old receipts use `activation_id` without an occurrence key |
| Event JSONL | `openclaw-plugin/src/core/event-log.ts:40,93-112`; `receipt-coverage.ts:22` (`INTERVENTION_SHORT_SOURCE_RETENTION_DAYS = 7`) | Short-retention input; cannot be authoritative lifecycle history |
| Migration errors | `runtime-v2/store/sqlite-connection.ts:171-188` | Schema init/migration failures become `schemaInitWarnings`; **only production consumer is `pd-cli/commands/runtime-init.ts:214`** — activation writers never check. Lifecycle writer must fail closed (§4.4, INV-09) |
| Immutability precedent | `sqlite-connection.ts:575-578` (`activation_decisions_no_update/no_delete`), `:598-601` (`activation_evidence_snapshots_*`) | Existing in-repo pattern for trigger-enforced immutability; the lifecycle design reuses this pattern (INV-06) |
| **Stale control-state reactivation deadlock** | `state-store.ts:105-111` (`INSERT OR IGNORE` control seed); `activation_control_states` PK = `activation_id` (`sqlite-connection.ts:579-585`); deterministic `act_code_${ruleId}` (`writers/rule-host-writer.ts:378`); production auto-isolate (`openclaw-plugin/src/core/rulecode-safety-circuit.ts:70-77`); RuleHost skip (`rule-host.ts:438-443`); promotion refuses non-eligible (`safety-store.ts:361-363`) | **Verified existing defect (independent of this SPEC):** isolate → deactivate → reactivate with the same `activation_id` inherits `safety_isolated`; RuleHost silently skips; promotion permanently refuses; no reset API exists. Fail-closed (not an enforcement bypass). See §4.6 and AC-15 |

See separate Writer Map (v0.2.1) for complete enumerated mutation/search coverage, non-production writer registry, and source classification.

### SQL reproduction (DIRECT, isolated in-memory SQLite)
Use exact `activations` table columns and unique index from repository; insert T1, deactivate T2, `INSERT OR REPLACE` same key at T3:
- T1 = `[(rowid=1, act_prompt_P05, 2026-10-01T00:00Z, NULL)]`
- T2 = `[(rowid=1, act_prompt_P05, 2026-10-01T00:00Z, 2026-10-05T00:00Z)]`
- T3 = `[(rowid=2, act_prompt_P05, 2026-10-10T00:00Z, NULL)]`
- Old application at 2026-10-02 joins current activation dated 2026-10-10, yielding a false chronological appearance.
- SQLite 3.45.3 on local host; **schema-faithful Python sqlite3 reproduction, not execution of TypeScript store**. Independent 2026-09-27 repo audit documents an actual TS pathway reproduction and a production-sample anomaly. No fresh production DB was opened in Phase A.

## 3. Options and trade-offs

### Option A — append historical cycles directly to `activations`
- Advantage: one relation preserves periods; simple temporal SQL once identity is fixed.
- Cost: requires removal/alteration of unique idempotency index, `getActivationStatus` and all list queries become latest/live selection; duplicates by deterministic `activation_id` interact with safety control state, promotions and deactivations; makes `SELECT ... WHERE activation_id = ?` ambiguous. Significant migration and broad consumer changes.
- Verdict: **rejected as default for Phase B** unless a measured PoC disproves these costs.

### Option B — existing `activations` projection + durable lifecycle facts (**recommended, guard-backed**)
- `activations` represents current/latest *projection*, not the historical source of truth.
- New append-only lifecycle event relation (normative contract §4.2) is the sole authority for **observed lifecycle transitions**. Legacy snapshot observations live in a **separate relation** (`activation_legacy_observations`, §4.2.1) so the event transition enum stays truthful.
- Owner governance decisions remain authoritative in `activation_decisions` for their own *decision* facts; no copying their auth semantics into a rival policy source. A lifecycle event links `decision_id` when applicable; non-decision transitions carry first-class `actor_kind`/`reason_code` instead (v0.2.0).
- One transaction owns projection mutation + transition fact + existing typed decision where applicable (**fact-first ordering, §4.4**). Projection is **deterministically rebuildable** from post-cutover facts plus the surviving snapshot observation for keys with no post-cutover events (INV-03, made testable in v0.2.0).
- Advantage: protects current read paths and indexes; adds traceability without rewriting host injection.
- Risk: enforcing **100% writer coverage**, mixed-version writers and DB-level protection is mandatory; naïve dual-write creates another authority violation. Mitigated by the §4.4 guard contract, which converts any missed writer into a loud abort instead of silent history loss.

### Option C — rely on event-log JSONL or existing Evidence ledger
- Rejected. Log source retention ~7 days; Evidence records represent delivered/applied/episode/effect/outcome rather than all transitions; `activation_decisions` only captures specific governance decisions and omits ordinary lifecycle entries.

## 4. Data, identity and write contracts (normative as of v0.2.0; requires Owner OD approval)

### 4.1 Principle, artifact, activation and occurrence identities
- `principle_id`: canonical ledger UUID when already validated; **never** mint from title or fuzzy matching (PRI-910 separate). Stored on the fact for durable attribution after `pi_artifacts` cleanup (W10 deletes artifacts; string-reversing `act_prompt_${principleId}_sha256(...)` is forbidden).
- `artifact_id + channel`: existing idempotency key for current activation, **not** a historical occurrence identifier.
- `activation_id`: legacy public/runtime handle, **not guaranteed unique across reactivations**; PromptWriter derives `act_prompt_${principleId}_sha256(artifactId)` (`low-risk-writers.ts:118`), DeferArchiveWriter `act_archive_${principleId}` (:143), RuleHostWriter `act_code_${ruleId}` (`rule-host-writer.ts:378`).
- `occurrence_id`: new opaque, immutable identifier for **one successfully committed activation period** (T1 and T3 must have different occurrence IDs even when activation_id matches). Created once inside the committed activation transaction.
- `event_id`: unique identity of one transition fact (opaque, generated at commit).
- **Approval identity vs operation identity (v0.3.0, Owner P1-02 — two distinct identities, never conflated):**
  - *Approval identity* = the approval queue slot. Verified code fact: it is **deterministic and reusable** — `makeApprovalId(artifactId, channel) = 'apr_<channel>_<artifactId>'` (`sqlite-approval-store.ts:138-140`), `enqueue` uses `INSERT OR IGNORE` (:157), and `resetToPending` (:258-265) recycles the same row while clearing `decided_at`. The same approvalId therefore legitimately spans multiple activation cycles; it also spans zero-new-approval re-dispatch risk: `verifyApprovedDispatch` (`activation-dispatcher.ts:537-600`) checks existence, `status === 'approved'`, artifact and channel — but **not** `decided_at`, and activation does not consume the approval row. Approval identity gates *authorization* (§4.4.4 approval-epoch rule); it MUST NOT be part of operation identity.
  - *Operation identity* = `operation_key` below; it identifies **one attempted transition**. It must be stable across failed retries of the same attempt (free: B1 commits atomically, so a failed attempt leaves no state change and the recomputed key is identical) and distinct for two genuinely different transitions of the same subject.
- `operation_key`: **NOT NULL for all post-cutover writer facts**; NULL only for imported C0 facts. Deterministic format (v0.3.0, supersedes v0.2.0's approvalId-based format):

  ```text
  operation_key = <writer_id> "|" <operation> "|" <idempotency_key> "|" <request_digest>
  request_digest = "sha256:" hex(sha256(canonical_json({
     kind, occurred_at, actor_kind, reason_code, target_ref,
     action_before_or_after, decided_at_snapshot   -- approval.decided_at read inside the tx when present
  })))
  examples:
    dispatcher|activate|<idempotency_key>|sha256:…
    state_store|deactivate|<activation_id>|sha256:…
    safety_store|emergency_deactivate|<activation_id>|sha256:…
    prompt_replacement|replace|<new_idempotency_key>|sha256:…
  ```

  Two executions of the *same logical request* (same parameters, same approval decision snapshot) produce the same key; a genuinely new Owner decision necessarily carries a new `occurred_at`/`decided_at_snapshot` and therefore a new key and a new occurrence. The helper's SELECT-first on `operation_key` (INV-04) then yields: failed-retry ⇒ re-execute over unchanged state (atomicity); post-commit duplicate delivery ⇒ return the existing fact; new re-approval ⇒ new key ⇒ new occurrence. No random IDs; no relaxation of approval rules.
- Do **not** rewrite historical Evidence's `activation_id` as a newly minted occurrence. Old evidence can be linked via validated time window only when unambiguous, and must otherwise remain `legacy_ambiguous`. Evidence ingestion keeps its existing explicit-gap behavior (`intervention-evidence-ingress.ts:207-209` returns null for reused IDs).

### 4.2 Lifecycle fact relation (normative contract)

```text
activation_lifecycle_events
  event_id TEXT PRIMARY KEY                 -- opaque, minted at commit
  occurrence_id TEXT NOT NULL               -- one activation period; groups events
  transition_kind TEXT NOT NULL
      CHECK (transition_kind IN ('activated','deactivated','promoted_live','superseded'))
  activation_id TEXT NOT NULL               -- legacy public handle
  idempotency_key TEXT NOT NULL
  artifact_id TEXT NOT NULL
  principle_id TEXT NOT NULL                -- canonical UUID; durable attribution (v0.2.0)
  channel TEXT NOT NULL
      CHECK (channel IN ('prompt','defer_archive','code_tool_hook'))
  target_ref TEXT NOT NULL
  action_before TEXT                        -- NULL for 'activated'; NOT NULL otherwise
  action_after  TEXT                        -- NOT NULL for 'activated'/'promoted_live';
                                            --   NULL for 'deactivated'/'superseded'
  actor_kind TEXT NOT NULL
      CHECK (actor_kind IN ('owner','operator','system_safety','system','break_glass'))
  reason_code TEXT NOT NULL                 -- required even for non-decision transitions (v0.2.0)
  decision_id TEXT                          -- link to activation_decisions when one exists
  approval_ref TEXT                         -- dispatcher approvalId where applicable
  occurred_at TEXT NOT NULL                 -- transition time (ISO-8601 UTC, CHECK format)
  recorded_at TEXT NOT NULL                 -- durable commit observation (>= occurred_at, CHECK)
  operation_key TEXT NOT NULL UNIQUE        -- NULL only for imported C0 facts (see below)
  source_kind TEXT NOT NULL
      CHECK (source_kind IN ('state_store','safety_store','prompt_replacement','import_c0'))
  context_json TEXT NOT NULL                -- bounded snapshot (<= 4 KiB post-serialization),
                                            -- redaction-mandatory (rc-8); no secrets
```

Constraints and rules (all normative):
- **No foreign key** from events to `activations` (facts precede projection rows inside the same transaction; immediate FK validation would invert; authority direction forbids the projection as FK target).
- **Facts precede projection** inside each transaction (§4.4); guards rely on this ordering.
- `superseded` **subsumes** the old period's deactivation: W03/W07 emit exactly one `superseded` fact (with `action_before` = old action) plus the new `activated` fact. Never emit a second `deactivated` fact for the same transition (prevents double counting; AC-01 arithmetic depends on this).
- `promoted_live` records `action_before='code_tool_hook_shadow_activate'`, `action_after='code_tool_hook_live_activate'`. Emitted **only** on the W07 `commitPromotion` path (W04 is tests-only; see §2 and AC-14).
- CHECK on time format: `occurred_at`/`recorded_at` match ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS[.sss]Z`, the style the stores already write); `recorded_at >= occurred_at`.
- CHECK (transition shape): `'activated'` ⇒ `action_after IS NOT NULL AND action_before IS NULL`; `'promoted_live'` ⇒ both NOT NULL; `'deactivated'`/`'superseded'` ⇒ `action_before IS NOT NULL AND action_after IS NULL`.
- Immutability: `*_no_update` / `*_no_delete` triggers (`RAISE(ABORT)`), same pattern as `activation_decisions` (`sqlite-connection.ts:575-578`). Retention: permanent for as long as the workspace ledger is retained; no TTL; privacy deletion / workspace erasure policy is a separate explicit design (OD-05).
- Global pause / safety isolation / continue_observing are **not** lifecycle transitions and never mint events here; they are governance/control facts in their existing authorities (`global_rulecode_pauses`, `activation_control_states`, `activation_decisions`).

#### 4.2.1 Legacy snapshot observations (separate relation, resolves v0.1.0 ambiguity)

```text
activation_legacy_observations
  observation_id TEXT PRIMARY KEY
  activation_id TEXT NOT NULL
  idempotency_key TEXT NOT NULL
  artifact_id TEXT NOT NULL
  principle_id TEXT NOT NULL            -- only when validated; never guessed (PRI-910 fence)
  channel TEXT NOT NULL CHECK (channel IN ('prompt','defer_archive','code_tool_hook'))
  observed_action TEXT NOT NULL
  observed_activated_at TEXT NOT NULL   -- as stored in the surviving row; NOT asserted first-ever
  observed_deactivated_at TEXT          -- as stored, usually NULL
  observed_promoted_at TEXT
  observed_at TEXT NOT NULL             -- when the snapshot was taken
  source_ref TEXT NOT NULL              -- migration run id + digest of source snapshot
  context_json TEXT NOT NULL            -- bounded, redacted
```

- Snapshot rows are **observations**, never transitions; they never satisfy a §4.4 guard by themselves and never enter INV-03 rebuild as events (the rebuild rule consumes them as the base state for keys with no post-cutover facts).
- `source_kind='legacy_snapshot_observation'` is **removed** from the events enum (v0.1.0 self-contradiction fixed; review B-07).

### 4.3 Invariant set
- **INV-01**: An acknowledged lifecycle change MUST have exactly one durable matching transition fact. No state-only success.
- **INV-02**: One activation period = one occurrence ID; every deactivation/promote/supersede references the correct current occurrence.
- **INV-03 (deliverable as of v0.2.0)**: Current visible state must equal a deterministic projection of (a) all post-cutover facts for the key, plus (b) the surviving `activation_legacy_observations` row for keys with no post-cutover facts, adjusted only by separately specified safety control and global pause. Determinism requirements that make this testable: `action_after` NOT NULL on `activated`/`promoted_live`; snapshot rows carry the full observed projection state; `operation_key` NOT NULL for writer facts (no ambiguity between same-instant facts). Rebuild entry point: a **documented, read-only verification command** recomputes the projection from facts and reports divergence; on divergence the **fact side wins and the divergence is a P1 defect** — the repair action is a bounded, logged projection rebuild, never a fact mutation. AC-01 round-trip proves the rule.
- **INV-04 (v0.3.0, two-level idempotency):** Replays are idempotent at two levels. *Level 1 — subject state:* a transition request whose requested end-state and timestamps already match the current latest fact for the key returns the existing occurrence without writing (e.g., re-delivered activation of an already-active subject); a request that contradicts the current state is refused, never silently applied. *Level 2 — operation identity:* SELECT-first by `operation_key` returns the existing fact unchanged. A **new** approved reactivation after a stop carries a new request digest (new `occurred_at`/`decided_at_snapshot`) ⇒ new operation_key ⇒ a new occurrence. The replay/new-operation boundary is the request content itself — never a timestamp comparison against projection rows and never the approvalId (deterministic queue slot, see §4.1).
- **INV-05**: No successful deactivation if matching cardinality is 0 or >1; report already-inactive distinctly from a durable write failure. Same rigor for promotion/replacement.
- **INV-06**: Facts immutability enforced in SQLite triggers (pattern precedent `activation_decisions_no_update/no_delete`); no silent cleanup of facts. Owner-sanctioned corrections are **append-only correction events** (context_json carries `corrects_event_id`); physical mutation requires the documented escape-hatch protocol (§5.8) and is never silent.
- **INV-07**: Preserve existing Owner auth/approval verification and RuleHost shadow/live/global pause safety semantics. Nothing in this SPEC changes who may authorize what.
- **INV-08**: Source-backed historical UNKNOWN is first-class, never backfilled by inference.
- **INV-09 (enforcement point specified, v0.2.0)**: A schema/migration failure must prevent lifecycle writes from reporting success. Enforcement: **every lifecycle-relevant write method** (state store W01-W04, safety store W05-W07, dispatcher path) verifies, before its first mutation: (a) `activation_lifecycle_events` + guard triggers exist (`sqlite_master` probe), (b) `getSchemaInitWarnings()` is empty, (c) `recursive_triggers = OFF` pragma holds. Any miss ⇒ `PDRuntimeError('storage_unavailable')` with nextAction "run pd runtime init / repair workspace schema". The connection-level pattern to follow is the existing pragma verification (`sqlite-connection.ts:135-158`).
- **INV-10**: No second state writer or shadow authority; `activation_decisions` retains decision authority and the lifecycle table retains transition authority.
- **INV-11 (v0.2.0)**: Non-decision transitions (CLI/Console deactivations without typed decisions) must carry durable `actor_kind` + `reason_code` in the fact itself; attribution may not live only in 7-day-retention JSONL.

### 4.4 Write architecture — resolved: B1 shared transaction-aware helper + DB guard triggers

#### 4.4.1 Transaction ownership contract (review A-01)
- **Callers own transactions.** The lifecycle-fact helper performs **statement appends only**: it MUST NOT `BEGIN`, MUST NOT `COMMIT`, MUST NOT `ROLLBACK`. It asserts `db.inTransaction === true` on entry and **fails loud** if called outside a transaction (negative AC-04 case). Error handling stays with the owning method's existing try/ROLLBACK.
- Every currently transaction-less production write path gains a `BEGIN IMMEDIATE` owner: W02 `deactivateActivation` is the only one today (verified); its Phase B refactor wraps projection UPDATE + fact append + caller-supplied actor/reason in one `BEGIN IMMEDIATE`.
- Existing transaction owners (W01, W03, W07, W05, W06; W04 if retained) **append** fact statements inside their existing `BEGIN IMMEDIATE` block. better-sqlite3 `db.transaction()` nesting (savepoint semantics) is an acceptable implementation vehicle for the helper's internal structure, but the contract above is what reviewers verify. W08/W09 remain non-lifecycle (no events).

#### 4.4.2 Fact-first ordering (review A-03)
Inside each transaction, **facts are appended before the projection mutation that they justify**. The guard triggers (§4.4.3) validate existence of the just-appended fact; same-transaction reads see uncommitted rows (verified experimentally). Prescribed order per transition:
1. validate subject + auth prerequisites (unchanged);
2. `BEGIN IMMEDIATE` (owner) → assert expected state/cardinality/version;
3. SELECT-first by `operation_key` (idempotency); hit ⇒ return existing, no writes;
4. append lifecycle fact(s);
5. mutate projection (+ typed decision where applicable);
6. `COMMIT`. Any error ⇒ owner ROLLBACKs everything.

#### 4.4.3 DB guard contract (v0.3.0 — consumption-aware; Owner P1-01; reviews A-03/A-08/A-09; B2 demoted per A-02)

**Fact consumption (normative definition).** A transition fact F for key K is **consumable** if and only if no other fact for K has a greater `(occurred_at, event_id)` ordering key — i.e., F is the **latest transition fact** for K. A newer fact for the same key consumes every older one. Guards accept only consumable facts; "a matching fact existed once" is never sufficient.

Guards are `RAISE(ABORT)` triggers on `activations` — they **refuse mutations not justified by an unconsumed fact; they never author facts**:

| Trigger | Fires when | Requires |
| --- | --- | --- |
| `BEFORE INSERT ON activations` | any INSERT incl. `INSERT OR REPLACE` | a **consumable** `activated` fact with `occurred_at = NEW.activated_at`, `action_after = NEW.action`, `target_ref = NEW.target_ref` (NEW row must equal the projection the fact asserts; `deactivated_at` must be NULL). A matching-but-consumed fact ⇒ ABORT |
| `BEFORE UPDATE ON activations` | `deactivated_at` change | a **consumable** `deactivated`/`superseded` fact with `occurred_at = NEW.deactivated_at` and matching occurrence |
| same | `promoted_at`/`action` change to live | a **consumable** `promoted_live` fact with `occurred_at = NEW.promoted_at` |
| `BEFORE DELETE ON activations` | any DELETE | unconditional `RAISE(ABORT)` (facts are permanent; cleanup policy is OD-05) |

Recency sub-predicate (both INSERT and UPDATE guards): the matching fact F is consumable iff `NOT EXISTS (SELECT 1 FROM events f WHERE f.idempotency_key = NEW.idempotency_key AND (f.occurred_at > F.occurred_at OR (f.occurred_at = F.occurred_at AND f.event_id > F.event_id)))`. `event_id` is the deterministic total tie-breaker; within one transaction at most one fact per key is appended, so ties do not arise in practice.

**Why consumption-awareness is mandatory (Owner P1-01, verified):** facts are permanent. Under the v0.2.0 existential check, the replay `INSERT OR REPLACE` of a first activation (old `activated_at`, no new fact) matched the old fact and silently reset `deactivated_at` to NULL — a deactivated principle resurrected outside governance, violating INV-01/INV-03. Real-SQLite reproduction (15 checks) confirmed the bypass under v0.2.0 semantics and confirms closure under v0.3.0 semantics for: stale-INSERT replay after deactivation, T3-replay after a second deactivation, symmetric stale-UPDATE with an old `deactivated` fact, fact-less writes, and DELETE — while first activation, deactivation, genuine reactivation, idempotent same-state rewrite, and W03's two-key atomic replacement all remain allowed (review report §Appendix B; AC-17 pins this suite).

- Correlation key is `(idempotency_key, transition_kind, occurred_at)` plus the consumability predicate — precise enough to bind guard to fact, cheap to index.
- **`RAISE(ABORT)` message text IS the old binary's only error surface** (review A-08): message must carry its own nextAction, e.g. `activation writes require an unconsumed lifecycle fact (PD >= <min version>) — upgrade the runtime or run 'pd runtime init'; see docs/specs/PRI-932`. AC-10 asserts the CLI/Console render this message readably.
- **SQLite semantics pinned by contract:**
  - `recursive_triggers` MUST be `OFF` for every PD connection (the default), verified at connection setup alongside `journal_mode/busy_timeout/foreign_keys` (`sqlite-connection.ts:135-158` pattern). If enabled, `INSERT OR REPLACE`'s implicit DELETE starts firing the DELETE guard and aborts every reactivation (review A-09). Changing this pragma on a PD connection is a schema-protocol violation.
  - `INSERT OR REPLACE`'s implicit DELETE does **not** fire DELETE triggers when `recursive_triggers=OFF` — verified experimentally; this is what makes the REPLACE-based reactivation path compatible with the unconditional DELETE guard.
  - Guard triggers can read same-transaction uncommitted fact rows — verified experimentally. **Fact-first ordering (§4.4.2) is therefore load-bearing for the guards**: the appended fact must be committed-in-transaction before the projection mutation it justifies.
- **B2 (trigger-authored facts) rejected as fact author** (review A-02): `NEW.*` carries no decision/actor/operation attribution; the replaced row is invisible to INSERT triggers; replay would mint duplicates (no operation context). Triggers appear in this design **only as guards**. If a future proposal re-litigates B2, it must first deliver a PoC solving attribution and REPLACE capture deterministically under clock collision.
- Alternatives considered for consumption tracking and rejected: a separate "authorization token" table would add a third write per transition and a garbage-collection surface for tokens (more state, same guarantee); a projection version column changes the reader-facing schema Option B promised to leave untouched. The latest-fact predicate needs no new state — facts already encode the order.

#### 4.4.4 Writer coverage and dispatcher approval-epoch obligation
Every production writer W01-W13 in the Writer Map (v0.2.1) is matched to this contract; W04 (dead code) and non-production writers are dispositioned in the Writer Map §2/§2a and AC-14. `legacy-cleanup` is not a lifecycle writer; its interaction with guards is governed by OD-05 (§5.7).

**Approval-epoch freshness rule (v0.3.0, Owner P1-02; OD-10).** Verified current-code fact: a successful activation does **not** consume its approval row, and `verifyApprovedDispatch` does not check `decided_at` (`activation-dispatcher.ts:537-600`); combined with the deterministic reusable approvalId, a stale 'approved' row can authorize a re-dispatch after the subject was deactivated — a reactivation **without a fresh Owner approval action** (the code comment at `:644-646` documents that deactivation deliberately re-opens the dispatch path). Once lifecycle facts exist, Phase B MUST close this: **a dispatch may create an `activated` transition only if the acting approval's `decided_at` is strictly newer than the subject's latest `deactivated`/`superseded` fact for that key** (checked inside the activation transaction against the just-appended fact context); otherwise refuse with reason `approval_epoch_stale` + nextAction "re-approve the artifact to activate it again". This **tightens** the existing approval gate to its evident intent (each activation period requires its own Owner decision); it does not relax any approval, break-glass, or authentication requirement. The non-decision writers (W02 CLI/Console stop) are unaffected.

### 4.5 Current-state consumers and compatibility
Keep the behavior and signatures of `getActivationStatus`, `listPromptActivations`, `listCodeToolHookActivations`, `listAllActivations` compatible by retaining `activations` projection. Preserve `idx_activations_idempotency`; no ambiguous activation return. Expose history through a **new read-only, bounded, paginated query**; cannot repurpose existing `includeDeactivated` to mean full lifetime without consumer audit. Consumer inventory (v0.2.0, review B-11): the Writer Map §3 matrix is authoritative and now includes `ApprovalsGroupedConsoleModel`, `activation-compatibility-read-model`, `internalization-chain-integrity-read-model`, `milestone-readers`, and the prompt-injection projection family.

`MemoryActivationStateStore` (W14) alignment is **enumerated, not gestured at** (review A-14/B-09):
1. It remains a test double; it never stores or asserts facts/occurrences.
2. Its `deactivateActivation` is first-match-return-true today vs SQLite all-rows `changes > 0`; Phase B aligns the externally visible boolean semantics (recommended: all-rows) and states the choice in the store's contract test.
3. Optional capabilities it does not implement (`replacePromptActivation`, `promoteActivation`) stay absent; the dispatcher already refuses those paths for the memory store. No invented persistence.

Guard old binaries: they may write projection without matching facts. **No mixed-version writable window without fail-closed DB protection or an explicitly controlled writer-stop migration** — the §4.4.3 guards are that protection; a guard-triggered abort in an old binary surfaces as its raw SQLite error whose message is the nextAction (§4.4.3). Compatible old readers continue to work (additive schema only). New writes only when schema and mutation guard verified. Migration/writer feature readiness separate from a UI toggle.

### 4.6 Known adjacent defect: stale control-state reactivation deadlock (review B-01/A-15; NOT fixed here)
**Verified existing defect**, independent of lifecycle history loss: `activation_control_states` is keyed by `activation_id` (PK, `sqlite-connection.ts:579-585`); `recordActivation` seeds it with `INSERT OR IGNORE` (`state-store.ts:105-111`); RuleCode IDs are deterministic (`act_code_${ruleId}`, `rule-host-writer.ts:378`). Therefore isolate → Owner `emergency_deactivate` → re-approve the same rule ⇒ the new period inherits `safety_isolated`: RuleHost silently skips the activation (`rule-host.ts:438-443`, so no shadow evidence accrues), promotion permanently refuses (`safety-store.ts:361-363`), recovery-to-shadow does not apply (source not live), and **no API resets the control state to eligible**. The production auto-isolate trigger is real (`rulecode-safety-circuit.ts:70-77`). Blast radius is fail-closed refusal (dead rule), **not** an enforcement bypass.
- This SPEC does not repair it (scope fence per Writer Map "don't broaden PRI-932"), but Phase B must not cement the coupling: lifecycle facts bind to `occurrence_id`; control state remains `activation_id`-keyed; isolation associations use `activation_id` + time window, never copied onto occurrences.
- **OD-09** asks the Owner to acknowledge this defect and authorize an independent follow-up ticket. AC-15 pins the current observable behavior in a real-SQLite test so the follow-up starts from a characterized baseline.

## 5. Migration, rollout, rollback

1. Preflight on isolated **byte-consistent SQLite backup** (protocol: `VACUUM INTO` a fresh file, or `wal_checkpoint(TRUNCATE)` + file copy — the latter already exists at connection close, `sqlite-connection.ts:872`; verify by digest comparison of source and copy); measure schema, indexes, anomalies and references; never assume historical copies equal present production.
2. Schema delivery is a **versioned migration** (`schema_version` 003; existing versioned-migration precedent is 002 at `sqlite-connection.ts:831-850`), executed inside `BEGIN IMMEDIATE`, creating events + observations tables, their immutability triggers, guard triggers, and indexes. `initSchema` keeps only an idempotent fallback creation; the **write-path verification of INV-09 is the real gate**, not schema presence. Repeated migration and mid-migration crash are AC-10 cases; `schema_version` rows are append-only audit.
3. Record a **cutover checkpoint**: `cutover_at`, `schema_protocol` (=003), row-count/digest, observations of surviving projection. A snapshot only asserts "this row was observed", not all historical transitions.
4. Existing valid rows are recorded as `activation_legacy_observations` rows (§4.2.1) with `observed_at`; preserve their stored timestamps as unverified original metadata, not proven true origin. Never auto-create historical deactivation events.
5. Run active-consumer parity and Writer Coverage checks on a temporary copy; confirm new transition sequence and all-or-nothing rollback; then deploy to controlled writable windows only.
6. **Rollback**: preserve additive history tables; never DROP them. Rolling the application version back must not leave an old writer able to silently write an unlogged projection — with guards in place an old binary is **refused loudly** (abort message = nextAction, §4.4.3); the documented minimum compatible binary version and the refusal message text ship with the release. Keep backups and migration version.
7. Scope of destructive `legacy-cleanup` (OD-05, concrete default): `--apply` refuses (structured `errors[]` + exit non-zero + nextAction) when target artifacts/activations are referenced by lifecycle facts or observations; a governed tombstone path (append a tombstone observation, retain identifiers) requires separate Owner approval. Guards block bare `DELETE FROM activations` regardless.
8. **Owner-sanctioned correction protocol (review B-10)**: fact corrections are append-only correction events referencing `corrects_event_id` in `context_json`; physical mutation/deletion of facts requires (a) explicit recorded Owner authorization, (b) the §4.4.3 DELETE/UPDATE guard to be bypassed via a documented operator procedure (drop-trigger/recreate within one audited transaction), (c) an observation row recording what changed and why. Silent mutation remains impossible.

## 6. Test & merge acceptance matrix (Phase B)

| ID | Mandatory green proof |
| --- | --- |
| AC-01 | SQLite T1 activate → T2 deactivate → T3 reactivate, 2 distinct occurrences, 3 durable transitions, one current live row. **v0.2.0 extension:** projection round-trip — rebuild projection from facts+observation, result must equal original row-for-row (INV-03) |
| AC-02 | `getActivationStatus` active/null and all list APIs behavior identical to baseline across the full consumer matrix (Writer Map §3, including review B-11 additions) |
| AC-03 | Duplicate submit/retry/no-op does not create duplicate fact or change activated_at. **v0.2.0 extension:** four-quadrant replay matrix — same-request replay × {live, deactivated} and new-request re-activation × {live, deactivated} (review A-07). **v0.3.0 extension:** operation identity follows §4.1 (request digest) — a genuine re-activation under the same reusable approvalId MUST produce a new occurrence, and a post-commit duplicate delivery MUST return the existing one |
| AC-04 | Inject lifecycle INSERT/constraint failure: projection, control and typed decision rollback; fail closed. **v0.2.0 extension:** helper invoked outside a transaction fails loud (§4.4.1) |
| AC-05 | Prompt replacement: new activated + old superseded (single `superseded` fact, no double deactivation event) + existing decision atomic; idempotent recovery branch replays with zero new facts (replay branch `state-store.ts:252-258` is the anchor) |
| AC-06 | RuleCode shadow, promotion (W07 only), safety isolate, recover_to_shadow, supersede, reject/emergency deactivate; correct event kind and transaction; pause/release/isolation mint **no** lifecycle events |
| AC-07 | Concurrent activating/stopping same key serialized (two real connections); no double live or duplicate period; conflicting operation refused |
| AC-08 | Console, CLI, host-runtime, OpenClaw, Codex read current state unchanged; owner approval cannot be bypassed |
| AC-09 | Direct SQL mutation cannot silently erase/change history: bare `INSERT OR REPLACE` without fact, fact-less `UPDATE deactivated_at`/`promoted_at`, and `DELETE FROM activations` are each aborted by guards with nextAction-bearing messages; facts tables reject UPDATE/DELETE via immutability triggers. **v0.3.0 extension:** **stale-fact replay is also aborted** — a fact matching `(idempotency_key, occurred_at)` that is no longer the latest transition for its key (consumed by a newer stop/re-activation) must not authorize an INSERT or UPDATE (Owner P1-01) |
| AC-10 | Fresh/old schema upgrade, repeated migration, injected migration failure, readonly open (no bootstrap writes), crash before COMMIT, old-binary compatibility (old writer refused with readable nextAction text; old readers unaffected) |
| AC-11 | Evidence with reused activation_id across cycles is UNKNOWN unless validated occurrence/window, never false positive causal attribution |
| AC-12 | At T+90d query complete post-cutover activate/deactivate history without JSONL; pre-cutover Unknown conspicuous |
| AC-13 | DB transaction-level fault tests include failed typed governance decision and no partial prompt/rule supersede |
| AC-14 | Formal writer coverage review: each production INSERT/UPDATE/DELETE into `activations` is matched to required lifecycle transition; no unreviewed bypass. **v0.2.0 additions:** W04 disposition recorded (dead code: route through helper or delete — never leave silently unwired); non-production writer registry (Writer Map §2a) reconciled; re-anchor all line references at PR time |
| AC-15 (new) | Stale control-state reactivation observability (review B-01): isolate → deactivate → reactivate same `activation_id` on real SQLite; assert control state contents, `commitPromotion` refusal, RuleHost skip are each explicitly observed and asserted — characterizes today's defect as the baseline for the OD-09 follow-up; the lifecycle events for all three transitions must still be correct and complete |
| AC-16 (new) | Real-SQLite migration of the state-store test suite (review B-06/AUD-021): `sqlite-activation-state-store.test.ts` mock-string assertions are migrated to real SQLite (or explicitly deleted and superseded by AC-01/AC-02 coverage); AUD-021 closure is part of this SPEC's DoD |
| AC-17 (new, Owner P1-01) | **Stale-fact replay closure suite** on real SQLite, red-first against any existential-guard implementation: (a) T1 activate → T2 deactivate → stale T1 `INSERT OR REPLACE` replay ⇒ ABORT, `deactivated_at` unchanged; (b) T1→T2→T3 reactivate → T4 deactivate → stale T3 INSERT replay ⇒ ABORT; (c) stale UPDATE reusing an older consumed `deactivated` fact on a live row ⇒ ABORT; (d) fact-less INSERT/UPDATE ⇒ ABORT; DELETE ⇒ ABORT; (e) legitimate-path parity: first activation, deactivation, genuine reactivation (new fact, latest), idempotent same-state rewrite, and W03 two-key atomic replacement all still succeed. Mirrors the review reproduction (report §Appendix B, 15/15 checks) |
| AC-18 (new, Owner P1-02) | **Approval-epoch freshness**: after T2 deactivates a subject, a re-dispatch referencing the still-'approved' reusable approval row (same deterministic approvalId, `decided_at` predating the deactivation fact) is refused `approval_epoch_stale`; re-activation succeeds only after a fresh Owner approve action (new `decided_at`); no approval/break-glass/auth requirement is weakened. Positive control: the normal first dispatch of a freshly approved artifact is unaffected |

All AC tests need real SQLite (not mock SQL strings), with red-first regression for AC-01. Capture unit/integration/host tests, migration/rollback reproducibility, no changed Owner authorization, independent reviewer P0/P1=0 and PR evidence. **No implementation code or merge until Owner signs off**.

## 7. Risks, unknowns and Owner decisions

| ID | Decision required | Proposed default / implication |
| --- | --- | --- |
| OD-01 | Choose data architecture A or B | Recommend **B**, retains `activations` as projection, new durable timeline facts + separate legacy observations |
| OD-02 | **(narrowed v0.2.0; hardened v0.3.0)** Approve the resolved B1+guard write architecture: transaction-ownership contract, fact-first ordering, **consumption-aware** guard triggers (unconsumed-latest-transition predicate, §4.4.3), `recursive_triggers` pinning, old-binary loud refusal | **BLOCKING for Phase B.** The B1-vs-B2 architecture question is closed by code facts + experiments (review A-01/A-02/A-03); what Owner approves here is risk acceptance: upgrade discipline (old binaries refuse writes), pragma pinning, guard message as old-binary error surface |
| OD-03 | **(revised v0.3.0)** Occurrence identity and the two-identity model: approval identity (authorization gate, reusable queue slot) is separate from operation identity (`operation_key` = request-parameter digest, §4.1) | Opaque per-period occurrence; replay boundary = request content; re-activation under the same approvalId yields a new occurrence |
| OD-04 | Pre-cutover historic loss and source hierarchy | Unknown for lost facts; only source-verifiable observations, no inferred events; C0 import requires per-record protocol (Recoverability doc §5) |
| OD-05 | Retention/tombstone for cleanup and artifact deletion | Permanent structural history; §5.7 concrete default: `legacy-cleanup --apply` refuses when facts/observations reference targets; tombstone path needs separate approval |
| OD-06 | Upgrade and rollback policy for old writable binaries | Reject incompatible writers loudly (guard message = nextAction); no mixed-version silent loss; minimum compatible version documented |
| OD-07 | Evidence contract evolution | New facts expose occurrence; legacy `activation_id` alone never automatically proves a specific period |
| OD-08 | Delivery sequence/PR boundaries | One approved schema+writers PR with gates or scoped PRs, never partial writer deployment |
| OD-09 (new) | Acknowledge the verified stale control-state reactivation deadlock (§4.6) and authorize an independent follow-up SPEC/ticket | Recommended: acknowledge + authorize follow-up; PRI-932 does not fix it but AC-15 characterizes it |
| OD-10 (new, v0.3.0) | Approve the approval-epoch freshness rule (§4.4.4): a stale still-'approved' approval row can no longer authorize re-activation of a deactivated subject; re-activation requires a fresh Owner approve action (`approval_epoch_stale` refusal otherwise) | Recommended: approve — this **closes** a verified latent replay path (today a stale approved row can re-activate without any new Owner action) and thereby matches the approval gate's evident intent; no approval/break-glass/authentication requirement is weakened |

### Phase A exit criteria
- [x] Latest main confirmed and exact source locations inspected (re-anchored at A.2 review)
- [x] Real in-memory SQLite reproduction recorded
- [x] Options A/B assessed, C rejected
- [x] Reader/writer map and legacy evidence boundaries documented (v0.2 with writer registry + consumer completion)
- [x] Migration, rollback, Owner decisions and AC matrix drafted (v0.2: normative contracts, AC-15/AC-16 added)
- [x] Independent adversarial code/design review completed by separate reviewers (2 reviewers, 26 findings; report: `docs/specs/PRI-932-phase-a2-adversarial-review.md`)
- [x] Owner review round 1 processed (REQUEST CHANGES: P1-01/P1-02 verified by real-SQLite reproduction and code inspection; fixed in v0.3.0)
- [ ] Owner OD-01..10 signed off
- [ ] SPEC PR created/approved

**SPEC readiness for Owner review:** YES (v0.3.0); **IMPLEMENTATION AUTHORIZED:** NO; **Phase B:** BLOCKED; **Merge:** NO_GO until Owner approves.

## 8. Source references and evidence discipline
- Linear PRI-932, read 2026-10-12 (Todo; SPEC-only; no comments or approval).
- `docs/audit/pd-core-pipeline-health-audit-20260927.md` AUD-006 (still open; PR #1882 is PRI-933 process hardening, not an AUD-006 fix), AUD-010 (requalified as AUD-006 symptom), AUD-027, AUD-021 (**partially mitigated**: PRI-904 added real-SQLite tie-break cases at `sqlite-activation-state-store.test.ts:347-391`; deactivate/replace/promote branches remain mock-only — see AC-16).
- Code paths in section 2 and `docs/specs/PRI-932-activation-writer-reality-map.md` (v0.2.1); W04 dead-code determination per in-repo PRI-818 audit comment (`writers/rule-host-writer.ts:362-368`).
- A.2 adversarial review experiments: better-sqlite3 in-memory verification of `recursive_triggers` default, REPLACE/delete-trigger interaction, guard feasibility, nested-transaction semantics, concurrency serialization (review report, Appendix A).
- Owner review round 1 (v0.2.0 → v0.3.0): Owner-identified P1-01 (stale-fact guard bypass) and P1-02 (deterministic reusable approvalId) — both verified independently: 15-check real-SQLite reproduction of the bypass and of the v0.3.0 consumption-aware guard (report §Appendix B); `sqlite-approval-store.ts:138-157,258-265` and `activation-dispatcher.ts:537-600,644-646` inspected for the approval-identity facts.
- `docs/adr/0027-principle-intervention-evidence-and-delivery-contract.md` is Proposed; it is not proof of a completed full outcome loop.
- Statements labeled DIRECT are source/SQL-backed; INFERRED indicates design risk or consequence; PROPOSED indicates design choice awaiting authorization.
