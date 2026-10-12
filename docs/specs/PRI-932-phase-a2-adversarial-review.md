# PRI-932 — Phase A.2 Independent Adversarial Review Report

> **Version:** 1.1.0; **Date:** 2026-10-12; **Baseline reviewed:** `main@91d75b21ba8ebf458709406756f4b6e7e883c385` (verified == origin/main at review start)  
> **v1.0.0 → v1.1.0:** added Owner review round 1 record (§7 REQUEST CHANGES: P1-01/P1-02) with real-SQLite reproduction evidence (§Appendix B) and v0.3.0 resolution mapping.  
> **Materials under review:** SPEC v0.1.0, Writer Reality Map v0.1.0 (untracked drafts), Legacy History Recoverability v0.1.0 (untracked drafts)  
> **Method:** main agent (architecture adjudicator) + two parallel read-only adversarial reviewers:  
> — **Reviewer A (SQLite / Persistence):** schema, transactions, idempotency, migration, old-binary bypass, trigger semantics; plus **better-sqlite3 experiments** (Appendix A).  
> — **Reviewer B (Runtime / Governance / Evidence):** writer-coverage whole-repo re-scan, deterministic-ID reuse, control-state interaction, read-side consumers, evidence ambiguity, migration honesty, test gaps.  
> **Reviewer independence:** reviewers did not modify the SPEC; they submitted findings first; the main agent adjudicated conflicts by direct code inspection (verification greps recorded in §4).  
> **Outcome:** SPEC revised to **v0.2.0** incorporating all P1 fixes; Writer Map and Recoverability docs revised to v0.2.0. **0×P0, 6×P1 — all resolved in v0.2.0. No blocking finding remains open.**

## 1. Verdict summary

| Question | Verdict |
| --- | --- |
| Does Option B (projection + durable facts) survive adversarial attack? | **YES** — no P0 found; both reviewers affirm the architecture direction |
| Is the write-coverage enforcement strategy decidable without Owner architecture arbitration? | **YES** — resolved to **B1 + DB guard triggers** by code facts + experiments (was OD-02 "B1 vs B2"); Owner decision narrowed to risk acceptance |
| Was any writer missed? | **No production writer missed.** W01–W13 complete; registry added for 6 non-production/one-time writers (B-08) |
| Was any old audit conclusion invalidated? | AUD-021 **partially mitigated** (real-SQLite cases exist for tie-break; deactivate/replace/promote still mock-only); W04 "potential overlap" question **closed by PRI-818 audit comment** (dead code); AUD-006 **still open** (PR #1882 is unrelated process hardening) |
| P0 / P1 open after revision | **0 / 0** |

## 2. Findings register and resolution mapping

Severity as assessed at review time. "Resolution" names the v0.2.0 section that fixes it. All line numbers were re-verified against baseline `91d75b21`.

### P1 (all blocking; all resolved in v0.2.0)

| ID | Title | Evidence anchor | Resolution |
| --- | --- | --- | --- |
| A-01 | B1 shared-helper transaction contract undefined — native nested `BEGIN IMMEDIATE` throws; SPEC said "don't nest" but not how to join | `state-store.ts:94,212,303`, `safety-store.ts:133,161,184,224,247,278,339`; experiment: nested BEGIN errors, `db.transaction()` savepoint works | SPEC §4.4.1: callers own transactions; helper appends only, asserts `inTransaction`, fails loud outside tx; W02 refactored under its own BEGIN |
| A-02 | B2 (trigger-authored facts) undeliverable under its own INV-01/02: no attribution in `NEW.*`, replaced row invisible to INSERT triggers under REPLACE, replay mints duplicates | `safety-store.ts:193-206` (decision INSERT has no shared key with the UPDATE); SQLite `lang_conflict` semantics; experiments | SPEC §4.4.3: B2 demoted to guard-only; rejection rationale recorded; future B2 proposal needs a PoC solving attribution + REPLACE capture deterministically |
| A-03 | DB bypass-guard for old binaries was one sentence; real design (fact-first, correlation key, message-as-nextAction) missing | bypass source `state-store.ts:97`; guard feasibility proven by experiment (BEFORE INSERT/UPDATE correlated on `(idempotency_key, transition_kind, occurred_at)` + `RAISE(ABORT)`) | SPEC §4.4.3 guard table + fact-first ordering §4.4.2; AC-09 negative cases |
| A-04 | INV-09 fail-closed had no enforcement point — `schemaInitWarnings` consumed only by `runtime-init.ts:214`; writers never check | `sqlite-connection.ts:171-188` (warning-only); whole-repo grep | SPEC INV-09: every lifecycle write method verifies (events+guard triggers exist, warnings empty, pragma holds) else `PDRuntimeError('storage_unavailable')` |
| A-05 | INV-03 "projection rebuildable from facts" not deliverable per v0.1.0 contract: nullable `action_after`, no snapshot-row columns, nullable `operation_key`, no divergence owner | projection DDL `sqlite-connection.ts:473-483` vs §4.2 contract | SPEC INV-03 rewritten: `action_after` NOT NULL on activated/promoted_live; separate observations relation §4.2.1 carries observed state; `operation_key` NOT NULL for writer facts; read-only rebuild verification command; fact-side-wins divergence rule; AC-01 round-trip |
| B-01 | Stale `safety_isolated` control state permanently deadlocks a reactivated period (deterministic `act_code_${ruleId}` + `INSERT OR IGNORE` seed + no reset API); SPEC only said "INVESTIGATE"; no AC | `state-store.ts:105-111`; `rule-host-writer.ts:378`; production auto-isolate `rulecode-safety-circuit.ts:70-77`; RuleHost skip `rule-host.ts:438-443`; promote refusal `safety-store.ts:361-363` | SPEC §4.6 records the verified defect with the scope fence (fix = independent follow-up); OD-09 asks Owner to acknowledge + authorize follow-up; AC-15 characterizes current behavior on real SQLite; §4.2 forbids welding occurrence identity to the activation_id-keyed control state |

### P2 (resolved in v0.2.0 or explicitly gated to Phase B pre-work)

| ID | Title | Evidence anchor | Resolution |
| --- | --- | --- | --- |
| A-06 | Event contract below in-repo CHECK precision; missing `principle_id`/`artifact_digest`-class attribution; superseded/deactivated double-record ambiguity; unbounded `context_json` (rc-8); no no-FK declaration | `sqlite-connection.ts:536-572` as precision benchmark; W10 deletes `pi_artifacts` (`legacy-cleanup.ts:228-230`) | SPEC §4.2 normative: `principle_id`/`reason_code` columns, CHECK system, superseded-subsumes-deactivated rule, 4 KiB bounded redacted context_json, explicit no-FK, time-format CHECK |
| A-07 | `operation_key` generation/ownership/replay-read protocol missing; INV-04 replay-vs-new-operation boundary undecidable | dispatcher idempotency `activation-dispatcher.ts:237-244`; replay precedent `safety-store.ts:341-350` | SPEC §4.1 concrete `operation_key` format + caller-owned idempotency identity; AC-03 four-quadrant replay matrix |
| A-08 | "Old binary shows explicit nextAction" overpromise — old binary's only surface is the guard's RAISE text | CLI catch-path `runtime-activation.ts:497-499` renders raw message | SPEC §4.4.3: guard message text IS the nextAction; AC-10 asserts readable CLI/Console rendering |
| A-09 | `recursive_triggers` unpinned — enabling it later turns the DELETE guard into a recordActivation kill-switch | `sqlite-connection.ts:127-158` pins other pragmas, not this; default OFF verified | SPEC §4.4.3: pragma pinned OFF + connection-level verification (INV-09(c)); AC-10 negative case |
| A-10 | `legacy-cleanup` behavior change under guards not aligned with AC/OD | `legacy-cleanup.ts:216-241`; test expects deletion success | SPEC §5.7 concrete default (refuse when referenced) + OD-05; AC-09/AC-14 disposition |
| A-11 | Migration mechanism vague: initSchema vs versioned migration; `schema_version` written but unread; backup protocol undefined | versioned precedent 002 `sqlite-connection.ts:831-850`; checkpoint at close `:872` | SPEC §5.1-5.2: versioned migration 003 inside BEGIN IMMEDIATE; VACUUM INTO / wal_checkpoint(TRUNCATE)+digest protocol |
| B-02 | W04 `promoteActivation` is dead code (tests only) yet listed as a production writer; overlap miscited as W08 | in-repo PRI-818 comment `rule-host-writer.ts:362-368`; production paths `runtime-activation.ts:666-677`, `ActivationsConsoleModel.ts:693-702` | Writer Map v0.2 W04 row: dead code, disposition via AC-14 (route through helper or delete); overlap corrected to W07; `promoted_live` facts only from W07 (SPEC §4.2) |
| B-03 | Writer Map line drift systematic; W07's cited range (365-422) missed the authorization checks and the replay branch (:341-350) — exactly the no-double-emission anchor | both reviewers independently re-anchored | Writer Map v0.2 all rows re-anchored; W07 row names the replay branch; AC-14 re-anchoring rule |
| B-04 | Non-decision transitions lose actor/reason to 7-day JSONL — new authority would repeat AUD-006's "fact without attribution" | CLI `runtime-activation.ts:447-469` (JSONL only); Console `ActivationsConsoleModel.ts:739-780`; retention `event-log.ts:40` | SPEC INV-11 + §4.2 `actor_kind`/`reason_code` NOT NULL; W11/W12 obligations pass actor/reason into the fact; AC test asserts CLI deactivation fact carries actor/reason |
| B-05 | C0 "integrity-verifiable" had no protocol/judge; the surviving 09-22 deactivation would be misclassified C0 via string identity match | JSONL has no hash chain; §4 reproduction proves the targeted row was replaced | Recoverability v0.2 §5: per-source C0 protocol, judge = migration tool + per-record Owner review, no silent batch import; 09-22 pre-classified ≤C2; §7 string-match prohibition |
| B-06 | AUD-021 stands for the state-store suite: mock-string assertions (:19-345); `deactivateActivation` zero tests; no real-SQLite T1→T2→T3 anywhere | `sqlite-activation-state-store.test.ts:10-17,19-345`; contrast: safety-store suite is real SQLite | AC-16 (new): migrate suite to real SQLite or supersede explicitly; AUD-021 closure in DoD; SPEC §8 staleness note |

### P3 (accepted improvements; incorporated or recorded)

| ID | Title | Resolution |
| --- | --- | --- |
| A-12 / B-03 | Documentation line drift (largest: W07 actual 319-421) | All references re-anchored in v0.2 docs; method-name anchors authoritative; AC-14 re-anchor rule |
| A-13 | AUD-021 partially mitigated (PRI-904 real-SQLite cases `:347-391`) | SPEC §8 staleness note; merged with B-06 into AC-16 |
| A-14 / B-09 | Memory store semantics enumeration (first-match vs all-rows; optional capabilities) | SPEC §4.5 enumerated alignment; Writer Map W14 row |
| A-15 | Stale control-state blast radius is fail-closed refusal, not silent bypass | Merged into SPEC §4.6 framing (B-01's fuller account adopted, A-15's fail-closed classification kept) |
| B-07 | `legacy_snapshot_observation` self-contradiction in §4.2 enum | SPEC §4.2.1 separate `activation_legacy_observations` relation; enum cleaned (4 transition kinds + 4 source kinds) |
| B-08 | Non-production writers unregistered (llm-dogfood, e2e-seed, ai-user seeds, telemetry smoke, baseline stub, 002 backfill) | Writer Map §2a registry; AC-14 reconciliation |
| B-10 | No sanctioned escape hatch for immutable facts (C4 conflicts, mis-import) | SPEC §5.8 correction protocol: append-only correction events; physical mutation only via documented Owner-authorized procedure; silent mutation impossible |
| B-11 | Read-consumer matrix incomplete (ApprovalsGroupedConsoleModel, compatibility read model, chain-integrity read model, milestone-readers, projection family) | Writer Map §3 completed; AC-02 references full matrix |

## 3. Enforcement-strategy adjudication (B1 vs B2 vs B3)

| Dimension | **B1 + DB guard (ADOPTED)** | B2 trigger-authored facts (REJECTED as fact author) | B3 variants (REJECTED) |
| --- | --- | --- | --- |
| New-code writer coverage | 100% (AC-14 checklist + missed helper call ⇒ loud guard abort) | 100% incl. unknown paths | — |
| Old-binary bypass | Guard aborts, message = nextAction (experimentally proven) | Same blocking power | — |
| Attribution (decision/actor/operation) | Complete — application layer owns context | **Impossible**: `NEW.*` has none; reverse lookup non-deterministic under clock collision | — |
| Replaced-row capture | Native — app reads old row first (W03 already does, `state-store.ts:214`) | Invisible to INSERT triggers under REPLACE; BEFORE-INSERT snapshot pollutes semantics | — |
| Replay idempotency | SELECT-first by `operation_key` (precedent `safety-store.ts:341-350`) | Triggers have no operation context; replay mints duplicates | — |
| Failure mode | Missed writer ⇒ **fail-closed abort** | Attribution silently lost ⇒ **fail-open**, violates INV-01 | — |
| Complexity | One helper + 4 guard triggers; reuses existing transactions | Second state machine in SQL (P4 risk) | — |
| Rollback | Additive tables/triggers; DROP to roll back | Same | — |
| SQLite risk | `recursive_triggers` must be pinned (A-09); fact-first ordering; tx-ownership contract | recursive_triggers + attribution lookup + REPLACE visibility, three fragile dependencies | — |

B3 variants examined and rejected: (i) Option A append-rows (reader contract rewrite, index removal — SPEC §3); (ii) CHECK-constraint fact validation (**SQLite CHECK forbids subqueries** — not implementable); (iii) separate-connection fact write (breaks single-transaction atomicity, SPEC §4.4); (iv) daemon/read-time reconciliation (best-effort, violates fail-closed). Adopted composite: **B1 helper + BEFORE INSERT/UPDATE/DELETE guard triggers + `recursive_triggers=OFF` pinned + fact-first ordering + operation_key SELECT-first idempotency.**

## 4. Main-agent verification record (adjudication duty)

Load-bearing claims re-verified by the main agent before adoption (worktree `PRI-932-spec-adversarial-review`, HEAD = baseline):
1. `rg promoteActivation` (non-test): only the definition, its error strings, and two comments — incl. the PRI-818 audit comment stating "no production callers (tests only)" → **B-02 confirmed**.
2. `rg getSchemaInitWarnings`: production consumer only `pd-cli/src/commands/runtime-init.ts:214` → **A-04 confirmed**.
3. `rule-host-writer.ts:362-380`: PRI-818 comment + deterministic `act_code_${ruleId}` → **B-01/B-02 anchors confirmed**.
4. `rulecode-safety-circuit.ts:63-80`: circuit trip fires `safetyIsolate` with `system_safety` principal (production auto-isolate real) → **B-01 trigger confirmed**.
5. `rule-host.ts:438-443`: `safety_isolated` ⇒ skip with `continue` (no shadow evidence recorded) → **B-01 blast radius confirmed**.
6. `memory-activation-state-store.ts:47-56`: first-match `return true` → **A-14/B-09 confirmed**.

Reviewer disagreement check: A-13 ("AUD-021 partially mitigated") vs B-06 ("AUD-021 stands") — reconciled as complementary (file contains both mock-string sections and a real-SQLite section; deactivate/replace/promote branches remain untested against real SQL). A-15 vs B-01 — same mechanism, B-01's fuller blast radius adopted. No finding required a tie-breaking experiment beyond the reviewers' own recorded experiments.

## 5. Verified-clean register (both reviewers)

1. No missed production `activations` writers (independent whole-repo scans, incl. non-TS and scripts).
2. W08/W09 correctly emit no lifecycle events (pause/isolation/continue_observing touch only decisions/control/pauses tables).
3. W11 audit-first fail-closed ordering and W12 authorization wrapper intact; W13 dispatcher writes no SQL itself.
4. Existing immutability-trigger precedent works (`activation_decisions`, `activation_evidence_snapshots`).
5. 7-day JSONL retention chain (`receipt-coverage.ts:22` → `event-log.ts:40,93-112`) accurately described.
6. SPEC §2 SQL reproduction is faithful to the real DDL and REPLACE semantics.
7. Read APIs: active-only semantics, `--include-deactivated` wiring, Option B keeps one-row-per-key projection (no Console card duplication introduced).
8. Codex has no direct SQL writes; OpenClaw consumption paths are within the compatibility commitment.
9. Governance boundary: nothing in v0.1.0 or v0.2.0 changes Owner approval conditions, break-glass, or RuleHost enforcement semantics.
10. Baseline discipline: SPEC/WMap/Recoverability were untracked drafts; reviewed content == worktree copies (sha256-verified before modification).

## 6. Residual risks and Phase B gates (honest ledger)

- **Writer coverage re-certification** stays a Phase B merge-gate duty (Writer Map §2a + AC-14); this review certifies the inventory at baseline, not future drift.
- **Guard design is specified but not yet implemented**: §4.4.3 is experiment-validated at the SQL-semantics level; the Phase B red-first tests (AC-09/AC-10) are where it becomes engineering truth.
- **Stale control-state deadlock (B-01)** remains unfixed by design (scope fence); it is characterized (AC-15) and routed to Owner as OD-09.
- **Pre-cutover history** remains partially unrecoverable (Recoverability doc); no SPEC language can change that.
- Line numbers drift; the docs use method-name anchors and mandate re-anchoring at PR time (AC-14).

**Review gate status (after adversarial round):** P0_OPEN = 0; P1_OPEN = 0; P2 unresolved = 0 (all resolved or explicitly gated); SPEC_READY_FOR_OWNER = YES (v0.2.0 — superseded by the Owner round, §7).

---

## 7. Owner review round 1 (v0.2.0 → v0.3.0)

The Owner issued **REQUEST CHANGES** on v0.2.0 with two P1 design defects. Both were independently verified by the main agent before fixing (real-SQLite reproduction + code inspection); both are fixed in SPEC v0.3.0.

### OC-P1-01 [P1] — Stale-fact replay bypasses the DB guard (Owner-identified; CONFIRMED)

**Owner's finding:** the §4.4.3 `BEFORE INSERT` guard as specified accepted *any* historical `activated` fact matching `(idempotency_key, occurred_at)`. Facts are permanent, so replaying the first activation's `INSERT OR REPLACE` after an Owner deactivation matched the old fact and reset `deactivated_at` to NULL — resurrecting a deactivated principle with **zero new facts** (violates INV-01/INV-03 and Owner-governance invariance).

**Verification:** real better-sqlite3 reproduction, exact scenario per the Owner's 5 steps — see §Appendix B checks A1–A4 (bypass confirmed under v0.2.0 semantics: stale replay not aborted, state resurrected, still only 2 facts).

**Resolution (SPEC v0.3.0 §4.4.3):** guards now accept a fact **only while it is the latest transition fact for its key** (normative "consumable fact" definition + recency sub-predicate with deterministic `event_id` tie-break). An INSERT (incl. `INSERT OR REPLACE`) must be justified by a consumable `activated` fact whose shape the NEW row matches; the UPDATE guard gets the same predicate (closing the symmetric stale-UPDATE bypass). Alternatives (authorization-token table, projection version column) evaluated and rejected in-spec (more state, same guarantee / reader-facing schema change). **AC-17** pins the full closure suite, including the Owner's exact scenario and legitimate-path parity.

### OC-P1-02 [P1] — operation_key assumed re-activation yields a new approvalId (Owner-identified; CONFIRMED, and broader than reported)

**Owner's finding:** `makeApprovalId(artifactId, channel) = 'apr_<channel>_<artifactId>'` is deterministic and `enqueue` uses `INSERT OR IGNORE` (`sqlite-approval-store.ts:138-157`), so a genuine re-activation reuses the same approvalId; v0.2.0's `operation_key = …|<approvalId>` would misread every re-activation as a replay, making AC-01 impossible.

**Verification:** confirmed at `sqlite-approval-store.ts:138-140,155-157` (`INSERT OR IGNORE`), `:258-265` (`resetToPending` recycles the same row and clears `decided_at`). **Broader than reported:** `verifyApprovedDispatch` (`activation-dispatcher.ts:537-600`) checks existence, `status === 'approved'`, artifact and channel — but not `decided_at` — and activation does not consume the approval row; the comment at `:644-646` documents that deactivation deliberately re-opens the dispatch path. Net: a stale 'approved' row can authorize a re-activation **without any fresh Owner approval action** — a latent governance-replay path in current code that the lifecycle work must close, not just an operation_key formatting issue.

**Resolution (SPEC v0.3.0 §4.1/§4.4.4):** two-identity model. *Approval identity* (reusable queue slot) gates authorization only; *operation identity* `operation_key = <writer>|<operation>|<idempotency_key>|<request_digest>` is a deterministic digest over the requested transition parameters (incl. the approval's `decided_at` snapshot read inside the transaction) — stable across failed retries, distinct across genuine re-activations, never random. INV-04 is restated as two-level idempotency (subject-state replay + operation_key). New **approval-epoch freshness rule**: a dispatch may create an `activated` transition only when the acting approval's `decided_at` postdates the subject's latest stop fact, else refuse `approval_epoch_stale` — this **tightens** the approval gate to its evident intent, relaxing nothing. **AC-18** (positive + negative controls) and **OD-10** (Owner approval of this behavior change) added.

### Round gate status

Both Owner P1s: CONFIRMED → FIXED in v0.3.0. Reproduction evidence: §Appendix B (15/15 checks: bypass reproduced under v0.2.0 semantics; closure + legitimate-path parity under v0.3.0 semantics). SPEC v0.3.0 gate: P0_OPEN = 0; P1_OPEN = 0; SPEC_READY_FOR_OWNER = YES (pending Owner re-review; no self-approval).

---

## Appendix B — Stale-fact replay reproduction and guard-fix validation (better-sqlite3, in-memory, 2026-10-12)

Setup: repo-exact `activations` DDL (no PK, `UNIQUE(idempotency_key)`) + minimal `activation_lifecycle_events(event_id PK, idempotency_key, transition_kind, action_after, target_ref, occurred_at)`.

**v0.2.0 guard (existential check):** `BEFORE INSERT … RAISE(ABORT) WHERE NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = NEW.idempotency_key AND transition_kind='activated' AND occurred_at = NEW.activated_at)`.

**v0.3.0 guard (consumption-aware):** same correlation, plus row-shape equality (`action_after = NEW.action AND target_ref = NEW.target_ref`) plus **consumability**: `AND NOT EXISTS (SELECT 1 FROM events f WHERE f.idempotency_key = NEW.idempotency_key AND (f.occurred_at > e.occurred_at OR (f.occurred_at = e.occurred_at AND f.event_id > e.event_id)))`. UPDATE guard: same predicate per changed column (`deactivated`/`superseded` vs `promoted_live`). DELETE guard: unconditional ABORT.

| # | Check | Result |
| --- | --- | --- |
| A1 | T1 activate + T2 deactivate under v0.2.0 guard → `deactivated_at` set | PASS |
| A2 | **Stale T1 replay under v0.2.0 guard → NOT aborted (P1-01 confirmed)** | PASS |
| A3 | After attack: `deactivated_at` is NULL again, no new fact | PASS |
| A4 | Still only 2 facts after the state change (INV-01 broken) | PASS |
| B1 | T1 legitimate first activation under v0.3.0 guards | PASS |
| B2 | T2 legitimate deactivation | PASS |
| B3 | **Stale T1 replay → ABORTED (fact consumed by newer E2)** | PASS |
| B4 | `deactivated_at` unchanged after attack | PASS |
| B5 | T3 genuine reactivation (new fact @T3, latest) allowed; `deactivated_at` cleared | PASS |
| B6 | Idempotent same-state rewrite of committed T3 allowed | PASS |
| B7 | **Owner scenario step 5: T3 INSERT replay after T4 deactivation → ABORTED** | PASS |
| B8 | **Stale UPDATE reusing old `deactivated` fact on a live row → ABORTED** | PASS |
| B9 | Fact-less INSERT → ABORTED | PASS |
| B10 | DELETE on populated projection → ABORTED | PASS |
| B11 | W03 two-key atomic replacement (new INSERT + old supersede UPDATE, one tx) allowed | PASS |

15/15. Reproduction harness retained in the session workspace (`.tmp/pri932-p101-repro.mjs`); AC-17 requires the equivalent cases as committed Phase B tests on the production schema.

**Review gate status:** P0_OPEN = 0; P1_OPEN = 0; SPEC_READY_FOR_OWNER = YES (v0.3.0).
