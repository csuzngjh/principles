# PRI-932 — Legacy Activation History Recoverability Assessment

> **Status:** Phase A draft v0.2.0, NOT a migration authorization. 2026-10-12.  
> **v0.1.0 → v0.2.0:** C0 gains a per-source verification protocol, a designated judge, and the no-silent-batch-import rule (review B-05); §7 gains the string-identity-match prohibition; the surviving 09-22 deactivation record is pre-classified as a worked example (≤ C2).  
> **Scope:** documented source evidence + latest code; **did not open current live Owner `state.db`, did not copy / write production workspace**. Baseline: `main@91d75b21`.  
> **Source:** `docs/audit/pd-core-pipeline-health-audit-20260927.md` AUD-006, AUD-010, AUD-027; `docs/audit/principle-identity-reconciliation-phase1.md` (historical snapshot); relevant TS/SQLite schema.

## 1. Owner question

Three months later, can PD prove that an Owner-governed principle was activated on date A and deactivated on date B?

**For transitions committed after a durable-lifecycle cutover:** this must become YES by construction (Phase B acceptance).

**For pre-cutover transitions already overwritten:** sometimes **NO / UNKNOWN**. An event missing from `activations` and already-expired JSONL cannot be recovered by counting current rows or joining old receipts. No model or inference should invent it.

## 2. Source inventory and evidentiary rank

| Evidence source | What it can prove | Retention / limitations | Grade |
| --- | --- | --- | --- |
| Current `state.db.activations` | Present/latest activation row and its stored timestamps at snapshot time | `REPLACE` can erase previous periods; latest row is not full history | DIRECT current-state observation only |
| `activation_decisions` | Typed Owner/system governance decisions (e.g., emergency stop / supersede / promotion when stored) | Only subset of lifecycle; cannot infer a missing activation from a decision alone; decision may be about control state | DIRECT specific decision, not entire timeline |
| `global_rulecode_pauses`, `activation_control_states` | Global safety/eligibility state where persisted | May not mean activation end | DIRECT control-state observation |
| `principle_applications` | Recorded injection/effect/presence with timestamps and possibly `activation_id` | A receipt supports an observed use, not the beginning or end of the activation period; legacy text IDs; retention varies | DIRECT receipt, INFERRED period bounds only |
| `intervention_evidence_records` | Typed delivery/application/episode/effect/outcome if ingested | Identity may be legacy activation_id only; behavior evidence cannot replace activation decision fact | DIRECT episode/delivery, not lifecycle transition |
| OpenClaw `events_YYYY-MM-DD.jsonl` | Exact event when extant and provenance intact | `receipt-coverage.ts:22`: `INTERVENTION_SHORT_SOURCE_RETENTION_DAYS = 7` (constant now at `event-log.ts:40`); plugin deletes aged files by mtime | DIRECT surviving event only |
| Workstation/file backups and archives | Previously snapshotted state/events if demonstrably intact | **Not investigated**; no assumption of existence/completeness; rollback files may reflect an earlier version | UNKNOWN until inventory |

**Key consequence:** "earlier receipt than surviving activated_at" is a **temporal contradiction in current projection**, not proof of premature injection or a known original activation timestamp.

## 3. Historical evidence from AUD-006 (2026-09-27)

- Existing audit reports `recordActivation(T1) → deactivate(T2) → same-key recordActivation(T3)`: old row replaced.
- Audit records example `act_prompt_结论必须由可观察证据背书：无查验则显式降级为推断`: its then-current `activated_at` was `2026-09-25T01:04Z`; a surviving `events_2026-09-22.jsonl:4` documented an earlier deactivate at `2026-09-22T23:52:53Z` with actor CLI and experiment reason.
- Audit reports 15 `prompt_injected` `principle_applications` were 50–77 hours older than the surviving current activation timestamp.
- Audit documented 7-day cleanup of older JSONL source events and predicted later removal of the remaining September event. **Prediction is not fresh evidence of actual deletion**; we have not inspected current live log files.
- These are **historical audit observations**, not a 2026-10-12 production census or freshly repeated Owner-workspace test.

## 4. Isolated reproducibility proof, 2026-10-12 (DIRECT)

Executed Python's real SQLite 3.45.3 in-memory engine with the same `activations` column set and `UNIQUE(idempotency_key)` index as `sqlite-connection.ts`, and the same `INSERT OR REPLACE` conflict mode used in `sqlite-activation-state-store.ts`.

| Point | SQL observation |
| --- | --- |
| T1 2026-10-01 activated | rowid 1, same activation_id, activated_at 10/01, deactivated_at NULL |
| T2 2026-10-05 deactivated | rowid 1, activated_at 10/01, deactivated_at 10/05 |
| T3 2026-10-10 reactivated, same idempotency key | rowid **2**, activated_at **10/10**, deactivated_at NULL; **rowid 1 no longer exists** |
| Old application dated 2026-10-02 | JOIN by activation_id resolves to latest row dated 10/10 and satisfies `application.occurred_at < activation.activated_at` |

Method limitations: this reproduces the **database/SQL semantics** in isolation, not the full TS dispatcher/Owner approval flow; the TS path itself is source-verified and separately described by the old audit. No local real production store was changed.

## 5. Recoverability classification (proposal, v0.2.0 with verification protocol)

| Class | Definition | Allowed action |
| --- | --- | --- |
| C0 — verified transition | Individual committed transition with surviving integrity-verifiable event/decision **and proven un-replaced period identity** (protocol below) | Import only per protocol; per-record Owner-visible review; preserve source ID |
| C1 — surviving current snapshot | Current `activations` row exists but earlier cycles unknown | Preserve observed current state as `activation_legacy_observations` row with `observed_at`; **not** assert first-ever activation |
| C2 — weak bound | Receipts or related records show use within a time window, exact activation/deactivation unknown | Retain as evidence hint and possible time *bound*, never synthesize a lifecycle event |
| C3 — irretrievable / ambiguous | Deleted JSONL, overwritten row and no verifiable backup; or deterministic activation_id reused with overlapping ambiguity | Mark `unknown_pre_cutover_history` / `ambiguous_occurrence`; no fabricated timestamps |
| C4 — source conflict | Surviving sources disagree on subject/time/order or old identity | Preserve both source references, mark conflict, escalate; do not select the more convenient narrative |

**C0 verification protocol (v0.2.0, review B-05)** — "integrity-verifiable" is per-source and mandatory:
1. **JSONL events:** schema-validate the record; verify file provenance (archive checksum / chain-of-custody recorded at archive time); **and prove the targeted projection row was not later `INSERT OR REPLACE`d** (e.g., surviving row's `activated_at` predates the event and identity matches, or the fact's subject occurrence is independently bounded). Failure of any check ⇒ downgrade to C2 (time bound) or C3.
2. **Typed decisions (`activation_decisions`):** row survives with immutability-trigger protection, so identity/integrity is structural; the C0 question reduces to whether the *matching lifecycle transition* is unambiguous (e.g., a supersede decision plus its surviving old-row deactivation).
3. **Judge:** the Phase B migration tool emits per-record classifications with evidence references; **no silent batch import** — every C0 import is individually listed for Owner review in the migration report.
4. **Worked example (pre-classified):** the surviving `events_2026-09-22.jsonl:4` deactivation of `act_prompt_结论必须…` is **at most C2**, not C0: the targeted row was demonstrably later replaced (SPEC §4 reproduction — rowid 1 deleted at T3), so its period identity cannot be proven; string-matching its `activation_id` to a surviving row is exactly the forbidden shortcut (§7).

Any import operation must distinguish **observation** from **transition**; `activated_at` stored in a surviving row does not authorize inventing a `deactivated` event for a preceding interval.

## 6. Proposed cutover protocol (requires Owner decision)

1. Use an explicit `cutover_at`, `protocol_version`, checksum, source snapshot metadata and migration results on an isolated copy first.
2. Archive and checksum any verifiably surviving historical logs, typed decisions and state rows before retention cleanup; never modify live Owner workspace without separate explicit approval.
3. Reconcile `activation_id`, artifact/channel and canonical identity strictly. Do not apply PRI-910's unresolved historical identity mappings as if already approved.
4. Bootstrap legacy **observations**, not fake lifecycle transitions. Post-cutover lifecycle transitions must be exact, immutable, queryable and bound to unambiguous occurrence IDs.
5. Persist `coverage_start_at`, `coverage_quality` and known gaps in a readily queryable way; readers must surface `partial/unknown`, not a falsely complete history.
6. Test replay and restart; ensure 90 days later the timeline is still queryable without short-retention sources.
7. Do not delete old backup/source records as part of this change. Keep rollback able to restore projected state without allowing new unlogged writes.

## 7. Data migration: forbidden shortcuts

- Deriving missing T1 from the earliest `principle_applications` timestamp.
- Interpreting every `activation_decisions` row as a completed deactivate or a fresh activation.
- Backfilling a principle ID from a philosopher-generated title or fuzzy matching.
- Treating absence of a JSONL event as evidence the action never happened.
- Re-labeling legacy activation_id-only receipts with a guessed new occurrence.
- **(v0.2.0)** Treating an `activation_id` **string match** between an old event/receipt and a surviving row as proof of the same *period* (REPLACE makes the same string denote different intervals — the §4/§5 worked example).
- Wiping or replaying production `state.db` during Phase A.
- Overwriting `activated_at` to "repair" chronological appearance.

## 8. Owner Decision Card (design decisions, not approvals)

**Decision D1:** Accept pre-cutover irrecoverable transitions as explicit UNKNOWN rather than fabricate a best guess? **Recommendation: YES**.

**Decision D2:** Will durable lifecycle structural facts survive ordinary JSONL/Evidence retention cleanup? **Recommendation: YES**; any personal-data erasure requires separate deliberate policy.

**Decision D3:** Allow automatic import of historical events? **Recommendation (v0.2.0): only individually protocol-verified C0 records, each surfaced for Owner review in the migration report; C1/C2/C3 remain observations/bounds/unknown; the 09-22 example is C2 and is not importable as a transition**.

**Decision D4:** How do legacy cleanup and future workspace erasure behave? **Recommendation: never silently delete lifecycle authority; SPEC §5.7 default refuses `legacy-cleanup --apply` when facts/observations reference targets; explicit retained-identifier/tombstone requires separate approval, consistent with privacy policy**.

**Decision D5:** Does the old Owner workspace require inventory/recovery now? **Recommendation: optional strictly read-only inventory on Owner-provided backed-up copy; not a precondition for forward bug fix**.

## 9. Current exit status

- **Defect mechanism:** CONFIRMED by source and isolated SQLite SQL.
- **Historical full recovery:** NOT POSSIBLE TO ASSERT / partially unrecoverable.
- **Fresh production counts:** NOT CHECKED.
- **Forward durable history:** NOT IMPLEMENTED.
- **Owner migration authorization:** NONE.
- **Phase B:** BLOCKED until SPEC approved.
