# PRI-917 Reuse Before Create — SPEC v0.2.1

> **Status:** Implementation Ready — Reality Audit PASS; Owner Decisions OD-PRI917-01, OD-PRI917-02, OD-PRI917-03 recorded
> **Scope:** Principle Reuse Decision Loop Phase 1
> **Change type:** Runtime behavior correction (knowledge governance)
> **Historical migration:** None
> **New SSOT:** None
> **Persistence route:** `Principle.reuseEvidence[]` — additive optional field on the existing Principle (OD-PRI917-03)
> **Implementation:** NOT started by this SPEC revision
>
> **Revision v0.1.1 (2026-09-28):** recorded OD-PRI917-01 (R1 approved). Superseded on the persistence question by v0.2.
>
> **Revision v0.2 (2026-09-28):** a pre-implementation reality check **refuted R1**. `Principle.derivedFromPainIds` does not hold supporting Pain ids — it holds **source Candidate ids**, and is simultaneously the intake idempotency index, the candidate→principle join key, and the Console evidence-presence signal. §12 was rewritten around `reuseEvidence[]` (OD-PRI917-02).
>
> **Revision v0.2.1 (2026-09-28):** records the **PR3A stop reason** (OD-PRI917-03). `activation_decisions` was investigated as the governance audit sink for the Owner decision and **rejected**: its `subject_kind` and `decision` are closed by CHECK constraints to the activation lifecycle, and it holds no typed Candidate→Principle relation. `reuseEvidence[]` is therefore the **authoritative and only** persistence for both the reuse decision and its relation, and **PR3B (persistence) now precedes PR3A (decision surface)**. Retrieval, Top-3 proposal, Owner review flow, failure semantics, test matrix, rollback, and INV-R05 are unchanged.

---

## 1. Problem

`CandidateIntakeService.intake()` turns every eligible `recommendation_kind=principle` candidate into a brand-new canonical Principle via `randomUUID()` → `writeProbationEntry()`. Its only dedup is `existsForCandidate(candidateId)`, which answers *"was THIS candidate already intaken?"* — never *"did we already learn this?"*.

Consequence: two semantically identical pains produce two Principles. Live evidence (`principle_training_state.json`, 122 principles; `state.db`, 138 candidates / 54 principle-kind) shows a corpus where the same behavioral demand is restated repeatedly under different wording. Knowledge fragments instead of accumulating.

## 2. Product Intent

> A new Pain should not default to a new Principle. Before creating, ask *"have we already learned this?"*; if an existing Principle covers it, strengthen that one instead.

Target flow:

```text
Pain → Diagnosis → Principle Candidate → Search Existing Principles → Reuse | Create
```

## 3. Current Production Flow (verified at `1f5f8307`)

```text
PainSignalBridge / pd candidate / pd diagnose --intake / pain-retry
  → CandidateIntakeService.intake(candidateId)          packages/principles-core/src/runtime-v2/candidate-intake-service.ts:167
      1  input validation
      2  existsForCandidate(candidateId)                → early return (idempotency, same candidate only)
      3  stateManager.getCandidate(candidateId)
      3b isPrincipleLedgerEligibleKind(rawRecommendationKind)   → FAIL-CLOSED refusal (non-principle kinds)
      4  stateManager.getArtifact(...)
      4c parse recommendation (sourceRecommendationJson → contentJson fallback)
      5  build LedgerPrincipleEntry { id: randomUUID(), status:'probation', sourceRef:'candidate://<id>' }   :294-306
      6  ledgerAdapter.writeProbationEntry(entry)        :310
  → PrincipleTreeLedgerAdapter → addPrincipleToLedger(stateDir, principle)
  → {stateDir}/principle_training_state.json → _tree.principles
```

**Write chokepoint confirmed (Audit A = PASS).** Production callers of `.intake()`: `pain-signal-bridge.ts`, `pd-cli/commands/candidate.ts` (manual + batch), `pd-cli/commands/diagnose.ts`, `pd-cli/commands/pain-retry.ts`. The only other `writeProbationEntry` caller is `pd-cli/services/demo-story-a-runner.ts`, an explicit Story-A demo whose own comment states it exercises the dispatcher path. `candidate.ts:572` builds a `randomUUID()` entry but lives inside `if (opts.dryRun)` — it `console.log`s a preview and returns; it never writes. **No production bypass.**

## 4. Target Flow

```text
intake() → eligible principle candidate
   → extract candidate semantics (text / triggerPattern / action)
   → retrieve shortlist of existing canonical Principles
   → no credible candidate  ──────────────→ CREATE (existing writeProbationEntry, unchanged)
   → credible candidate
        → PrincipleReuseProposal (advisory, Top-3)
        → Owner / AI Owner decision through the existing governance surface
             ├── REUSE  → no new Principle; record the durable relation
             └── CREATE → existing writeProbationEntry path
```

The gate sits **after** step 4c (semantics available) and **before** step 5 (`randomUUID()`). No parallel intake pipeline.

## 5. Scope

- Reuse / Create decision for `recommendation_kind == principle` candidates.
- Read-only retrieval of existing canonical Principles.
- Advisory proposal with explainable evidence.
- Owner/AI-Owner makes an explicit `reuse | create` decision.
  - **REUSE** is durably recorded in `Principle.reuseEvidence[]`.
  - **CREATE** proceeds through the existing canonical Principle creation path; Phase 1 creates no duplicate standalone decision record.
- Telemetry for proposal / decision / outcome.

## 6. Non-Goals

No embedding, vector store, knowledge graph, new retrieval service, background indexing, semantic merge, Principle text modification, Principle versioning, historical cleanup/migration, second Principle identity source, parallel ledger, parallel approval system, new SSOT, large refactor. **No `EXTEND` / `MERGE` / `REWRITE` / auto archive / auto delete.** No speculative interfaces for future phases.

## 7. Terminology

| Term | Meaning |
|---|---|
| Candidate | A `principle_candidates` row with `recommendation_kind='principle'` |
| Existing Principle | A canonical entry in `_tree.principles` addressed by `Principle.id` |
| Reuse Candidate | An existing Principle proposed as covering the new Candidate |
| Proposal | Advisory shortlist produced by retrieval; **never** a decision |
| Decision | An **explicit** Owner / AI Owner verdict, required **only when a credible reuse proposal exists**. There is no Decision on the no-match path. |
| no-match CREATE | The **automatic** gate outcome when retrieval finds nothing credible. **Not** an Owner decision: no proposal was ever put to anyone. |
| proposal → CREATE | An **explicit** Owner / AI Owner decision to create despite a credible reuse proposal being on the table. |

## 8. Canonical Identity

Canonical Principle identity is **`Principle.id` (UUID)**, per the established invariant that title/text-hash/candidateId/artifactId are not identity. `principle_applications` is **evidence**, never a resolver.

**Audit B correction:** `title` is **not persisted** in `_tree.principles` (live entries carry an empty title). Matching must therefore use `text`, `triggerPattern`, `action`. Any retrieval design assuming a usable `title` is invalid against current data.

## 9. Existing Principle Retrieval

**Audit C findings (live, 2026-09-27):** 122 principles — `candidate` 109, `archived` 11, `active` 2 (no `probation` present). Fields are short (`text`, `triggerPattern`, `action`).

Read source: `loadLedger(stateDir)` (core-exported). Note `LedgerAdapter` exposes only `writeProbationEntry` + `existsForCandidate`; `PrincipleTreeLedgerAdapter` adds `listForCandidate` / `hasPrinciple` / `activatePrinciple` but **no list-all**. A read-all capability is required; it is a thin addition over `loadLedger`, not a new repository.

Options compared:

| Option | Assessment |
|---|---|
| 1. Deterministic shortlist (token overlap over `text`/`triggerPattern`/`action`) | **Recommended.** Corpus is 122 short entries; pure, free, deterministic, testable, no new dependency. Yields Top-K for LLM adjudication. |
| 2. Hand the full set to the LLM each time | Rejected — 122 entries per proposal is needless context; also makes the proposal non-deterministic at the retrieval layer. |
| 3. Reuse an existing semantic-comparison capability | **Not available.** `owner-decision/semantic-selector.ts` selects which *text source* forms a principle (whole-field vs extracted sentence, tier priority); it performs no candidate↔existing similarity. |

**Recommended Phase-1 path:** deterministic shortlist (Option 1) → LLM adjudication over the shortlist only. Retrieval stays deterministic and auditable; the model is used for semantics, not recall.

## 10. Reuse Proposal Contract

```ts
interface PrincipleReuseProposal {
  candidateId: string;
  painId?: string;
  proposedDecision: 'reuse' | 'create';
  candidates: Array<{          // Top-3 max
    principleId: string;       // canonical UUID
    principleText: string;
    reason: string;            // why this looks like the same learning
    evidence: ReuseEvidence[];
  }>;
}
```

Top-3 cap: the Owner must not be shown a wall of Principles.

## 11. Owner Decision Contract

```ts
interface PrincipleReuseDecision {
  candidateId: string;
  decision: 'reuse' | 'create';
  selectedPrincipleId?: string; // REQUIRED iff decision === 'reuse'
  actor: { kind: 'owner' | 'ai_owner'; id: string };
  reason: string;
  decidedAt: string;
}
```

`decision='reuse'` with a `selectedPrincipleId` absent from the canonical Ledger ⇒ **fail closed**, never fall back to Create (INV-R08).

**This contract is invoked ONLY when a credible reuse proposal exists** (`proposalNeedsDecision === true`). If retrieval returns no credible candidate, **no Owner decision is created** — the intake flow proceeds directly through the existing CREATE path, and none of `actor` / `reason` / `decidedAt` is ever produced.

**This is the decision-EXCHANGE contract, not a standalone persisted entity.** Where each verdict becomes durable:

- **REUSE** is materialised into the existing Principle's `reuseEvidence[]` entry (§12) — the relation and the decision travel together, so nothing about the verdict can drift from the relation it created.
- **proposal → CREATE** receives **no** second standalone decision record in Phase 1. The newly created canonical Principle is the durable **RESULT** of that decision.

**A created Principle is NOT proof that an Owner reviewed a proposal.** The resulting artifact alone cannot distinguish these two cases:

```text
1. no credible reuse candidate  → automatic CREATE
2. credible proposal           → Owner explicitly chose CREATE
```

Both produce the same Principle. Phase 1 enforces Owner authorization for case 2 **at runtime** (no valid verdict ⇒ fail closed, never CREATE), but does not persist a record that would let the distinction be reconstructed after the fact.

The asymmetry is deliberate. REUSE resolves a Candidate into an **already-existing** Principle, so without an explicit record the knowledge relation would be invisible — and reusing a Principle that nobody decided to reuse is exactly the silent behaviour this feature must not have. CREATE needs no second copy of that fact.

**Phase-1 limitation:** explicit CREATE authorization is **runtime-enforced but not durably auditable as a standalone decision fact.** If future governance requires proving after the fact that an Owner reviewed a reuse proposal and chose CREATE, that is a separate persistence design decision and is **outside Phase 1**. Stating the limitation here is deliberate — designing that store now would pre-commit a later phase to a shape nobody has audited.

## 12. Persistence / Relationship Model

**Route Selected: `reuseEvidence[]` on the existing Principle** (OD-PRI917-02, 2026-09-28). This supersedes R1 (OD-PRI917-01), which a pre-implementation reality check refuted.

#### Why R1 failed

R1 assumed `Principle.derivedFromPainIds` holds supporting Pain ids and is a safe append target. Against live production data and code, it is neither:

- **It holds source Candidate ids.** `principle-tree-ledger-adapter.ts:40` writes `derivedFromPainIds: [candidateId]`. Live ledger: 128/128 occurrences resolve in `principle_candidates`; Pain-id occurrences: **0**. The field name is a misnomer the codebase already acknowledges — `owner-decision-view.ts` describes it as "当前指向诊断候选记录，非行为证据行数".
- **It is the intake idempotency index.** `existsForCandidate` matches on `derivedFromPainIds.includes(candidateId)`, and `pain-chain-read-model` builds its `candidateToLedgerEntry` map from it (with a self-check that a `consumed` candidate is never missing). Appending a Candidate id would change what `existsForCandidate` returns — silently altering INV-R07 replay semantics and `listForCandidate` mapping.
- **It is the Console evidence-presence signal.** `PainEvidenceValidators` treats a non-empty array as "evidence captured and internalized"; `PrincipleDetailPage` renders each entry under the variable name `painId`.
- **Its contract is already mixed.** A second writer, `evolution-reducer.ts:423`, writes `[params.painId]` — a real Pain id — into the same field, while `init.ts:218` writes `[]`. So the field has never had one meaning.

Appending therefore either corrupts the idempotency index (candidate id) or launders a Pain id into a field four consumers read as candidate ids (pain id). Neither is evidence accumulation; both are semantic pollution.

#### Reality Correction — `activation_decisions` rejected as the reuse sink (OD-PRI917-03)

PR3A investigated `activation_decisions` as the governance audit sink for the Owner's reuse decision, and **rejected it**. It models **activation lifecycle** decisions, not **knowledge reuse** decisions:

- `subject_kind` is closed by a CHECK constraint to `('activation','all_live_rulecode')`;
- `decision` is closed by a CHECK constraint to the nine activation-governance values (`continue_observing`, `promote_live`, `recover_to_shadow`, `supersede`, …);
- a compound CHECK further pins which of `activation_id / artifact_id / artifact_digest` must be non-null per subject kind;
- there is **no typed column** for a Candidate→Principle relation.

Reusing `activation` or `all_live_rulecode` to record a reuse decision would be a **false record in the audit ledger** — worse than no record — and widening those CHECKs would require rebuilding a live production table (a migration).

**Architecture boundary (binding):**

| Store | MUST | MUST NOT |
|---|---|---|
| `activation_decisions` | record activation governance decisions | store the Candidate → Principle reuse **relationship**; store reuse **decision semantics** |
| `Principle.reuseEvidence[]` | record reuse relations **and** their decision/evidence | encode anything about Principle semantics (see INV-R05) |

#### Selected model

Reuse evidence is carried by a **new additive optional array on the existing Principle**, leaving every existing field and consumer untouched:

```ts
// additive; absent on all pre-existing entries, read as []
// relation target = the ENCLOSING Principle (this array is appended to it)
reuseEvidence?: Array<{
  painId: string;        // the Pain that re-validated this Principle
  candidateId: string;   // the Candidate that was resolved into this Principle
  decision: 'reuse';     // only REUSE is ever materialised here (see §11)
  actor: { kind: 'owner' | 'ai_owner'; id: string };
  reason: string;        // why the Owner judged this Principle to already cover it
  decidedAt: string;     // when the decision was taken
  decisionId?: string;   // OPTIONAL CORRELATION ID ONLY — see the note below
}>;
```

**The relation target is the enclosing `Principle.id`.** It is therefore deliberately NOT repeated inside each entry: a second copy of the same id could drift from its parent, and this repository has already been burned once by a lineage field whose name and content disagreed. A reader that has the entry has the target by construction.

`decisionId` is an **optional correlation id only** — NOT an identity, NOT required in Phase 1, and **MUST NOT** introduce a new decision identity source (no new UUID space, no new SSOT). If no existing decision record is available, it is simply absent; the evidence entry is still complete without it, because `actor` + `reason` + `decidedAt` already make it auditable and self-contained.

`reuseEvidence[]` is the **authoritative and only** persistence for the REUSE relation **and** the REUSE decision that created it — which is why it carries the actor, the reason, the verdict, and the time, not just the provenance. There is no second copy of this fact anywhere: no new table, no new relationship entity, no parallel ledger, and **no reuse decision is written to `activation_decisions`**.

**Why this needs no migration:** the ledger is a JSON document (`principle_training_state.json`) and `loadLedger` performs no TypeBox validation on read. A new **optional** field is invisible to all existing entries (read as `[]`), and no existing writer, reader, or UI surface changes. `derivedFromPainIds` keeps its current content, meaning, and every consumer's behaviour.

**Bounded growth:** `reuseEvidence` only grows on an actual reuse decision (rare), unlike `derivedFromPainIds`, which is an index touched on every intake.

## 13. State Transitions

```text
candidate(pending) ──intake──▶ reuse_check
                                   │
             ┌─────────────────────┴─────────────────────┐
   no credible candidate                      credible candidate
             │                                           │
             ▼                                           ▼
   AUTOMATIC CREATE                             awaiting_decision
   (no Owner verdict)                        (explicit verdict required)
             │                              ┌────────────┴────────────┐
             ▼                             REUSE                 explicit CREATE
        consumed                              │                       │
                                    (never automatic)                ▼
                                              │                  consumed
                                              ▼
                                    existing Principle
                                    (no new Principle)
                                    + reuseEvidence entry
```

The two CREATE branches have **different provenance** and the diagram must not make them look alike: the left branch is an automatic gate outcome (nothing was ever put to an Owner), the right branch is an explicit verdict. They converge on the same artifact, which is why the outcome alone cannot prove a review happened (§11).

No new candidate status is invented. The candidate still reaches `consumed` (its knowledge was applied), and the reuse relation is recorded on the Principle side as a `reuseEvidence[]` entry (OD-PRI917-02).

## 14. Failure Semantics

Reuse is a knowledge-governance decision and must not fail silently. If retrieval or LLM adjudication is **unavailable**, the system must **not** silently CREATE — that is precisely the duplicate-manufacturing failure this project exists to prevent.

Phase 1 uses the existing candidate lifecycle: the candidate stays `pending`, an explicit structured reason is recorded (`reuse_check_unavailable`, plus nextAction), and the caller surfaces it. **No new status is introduced.** Rationale: `pending` already means "not yet turned into a Principle" and is exactly the correct resting state. Callers that today treat a non-`consumed` candidate as normal batch behaviour are unaffected; callers requiring an intake result receive an explicit `reuse_pending` disposition, mirroring how `refused` is already returned as a disposition rather than thrown (preserves EP-03/ERR-089 batch semantics).

## 15. Existing Principle Eligibility

Recommendation, evidence-based on live status distribution (109 candidate / 11 archived / 2 active):

| Status | Eligible as reuse target | Rationale |
|---|---|---|
| `active` | **Yes** | In force; reuse strengthens a working principle. |
| `candidate` | **Yes** | 109/122 live entries. Excluding them would leave almost nothing to reuse, since almost nothing has been promoted. |
| `probation` | Yes | In the enum; no live instances. Consistent with `candidate`. |
| `archived` | **No** | Explicitly retired by governance; reusing into an archived principle would revive withdrawn knowledge. |
| `deprecated` | **No** | Same intent as archived. |

`invalid` / `retired` are not in `PRINCIPLE_STATUSES`; any unrecognised status is excluded fail-closed.

## 16. Matching Is Advisory, Not Authority

```text
Retriever / LLM  → proposes
Owner / AI Owner (existing governance surface) → decides
```

Retrieval may never suppress Principle creation on its own. Only a durable Owner decision can. This is the load-bearing invariant of the whole feature.

## 17. Explainability Requirement

Every reuse candidate must carry *why*, never a bare similarity number. Minimum evidence, drawn from fields that genuinely exist:

```text
candidate.text / triggerPattern / action      (candidate semantic claim)
principle.text / triggerPattern / action      (existing semantic claim)
shared problem / trigger / action relationship (the actual reason string)
source Pain evidence where available           (painId via the bridge linkage)
```

An approval/proposal surface may carry this material as **presentation, explanation, and interaction payload** — `ApprovalRequest`'s `triggerReason`, `confidenceExplanation`, `effectDescription` and `summary` are the natural fields for it.

It **MUST NOT** be treated as durable authority for the reuse relation or the reuse decision. The only durable authority for a REUSE is `Principle.reuseEvidence[]` (§12). A rationale that lives only in a proposal or approval payload is lost the moment the decision is taken, and nothing in that payload can be joined back to the Principle it justified. The Owner should be able to read, in one line, why a new Pain was folded into an existing Principle — and that line must still be there months later, next to the Principle.

## 18. Production Wiring

Gate inside `CandidateIntakeService.intake()` between step 4c and step 5. All four production callers inherit it without modification.

The decision surface may reuse existing CLI/Console presentation and Owner-identity mechanisms where appropriate, but those surfaces are **interaction layers only** and **MUST NOT** become a second persistence authority. Phase 1's decision surface is `pd candidate review`; the authoritative REUSE fact is written only to `Principle.reuseEvidence[]`. For a **proposal-driven** CREATE the created Principle is the durable **outcome**, not a standalone audit record of the Owner's authorization (§11). No claim is made that `ApprovalQueue` or the approvals routes are suitable carriers — the Reality Audit has not established that, and if a later slice finds a CLI surface cannot present the proposal, the fix is a better surface, not a new durable store. AI Owner may act, but only through a formal surface that records the verdict as evidence, never by deciding silently.

## 19. Invariants

- **INV-R01 Reuse Before Create** — every `recommendation_kind=principle` candidate passes a reuse decision boundary before any new Ledger Principle is created.
- **INV-R02 Canonical Identity** — reuse targets are canonical Principle Ledger UUIDs.
- **INV-R03 No Silent Duplicate Creation** — an unresolved reuse decision never silently proceeds to Create.
- **INV-R04 Owner Authority** — *When a credible reuse proposal exists*, only an **explicit** Owner / AI Owner verdict may resolve it, to REUSE or to CREATE. *When no credible reuse candidate exists*, the gate may proceed through the existing CREATE path **without an Owner verdict**. REUSE may **never** be automatic, in either path.
- **INV-R05 No Semantic Mutation on Reuse** — reuse accumulates evidence; it never changes what the Principle means.

  Mutating `reuseEvidence[]` — **ALLOWED**:

  - append one evidence entry for a reuse decision

  Mutating the Principle — **FORBIDDEN**:

  - Principle `text`
  - Principle meaning / semantic claim
  - Principle identity (`id`)
  - Principle `version`
  - Principle activation state

  Mutating other lineage fields — **FORBIDDEN**:

  - `derivedFromPainIds` in any way (it is the candidate-provenance / idempotency index; see §12 "Why R1 failed")

  Rationale: a new Pain that resolves to an existing Principle is a *new occurrence validating that Principle again* — evidence accumulation, not semantic mutation. The Principle continues to say exactly what it said before.
- **INV-R06 Relationship Is Durable** — reuse leaves a traceable `Candidate/Pain → existing Principle` fact.
- **INV-R07 Idempotent Replay** — replaying the same candidate produces no new Principle and no new logical decision.
- **INV-R08 Fail Closed** — invalid target UUID, missing authority, or malformed decision ⇒ no Create, no Reuse, explicit failure.

## 20. Test Matrix

| ID | Scenario | Expectation |
|---|---|---|
| T1 | No credible Principle (no-match path) | **automatic** CREATE — no Owner verdict is requested and none is produced; exactly one new Ledger Principle |
| T2 | Matching existing Principle + explicit REUSE | no new UUID, no new Ledger entry; `reuseEvidence[]` appended |
| T3 | Reuse replay | same result; no duplicate relation, no new Principle |
| T4 | `selectedPrincipleId` not in the proposal | fail closed — never falls back to CREATE |
| T5 | Reuse evaluation unavailable | must **not** silently create |
| T6 | Non-principle kinds (#1851 behaviour) | reuse logic MUST NOT run; ledger write still refused |
| T7 | Credible proposal + explicit CREATE | creates **only** after a valid Owner / AI Owner verdict; a malformed or missing verdict fails closed and creates nothing |
| T8 | Production caller | at least one test through the real `Pain → Diagnostician Candidate → CandidateIntakeService → reuse decision` path |
| T9 | Retrieval determinism | same ledger + same candidate ⇒ same shortlist |
| T10 | Eligibility | archived/deprecated never proposed |

## 21. Rollback

Disable the gate at the single insertion point (route the candidate straight to the existing step 5). No data migration, no ledger rewrite, no flag required for rollback — the pre-existing behaviour is the default branch. Decisions already recorded remain valid and auditable.

## 22. Complexity Delta

```text
new DB:                      NO
new table:                   NO
new column:                  NO
new file-based state:        NO
new background process:      NO
new LLM subsystem:           NO (reuses the existing agent/LLM path)
new vector store:            NO
new identity source:         NO
new approval subsystem:      NO (interaction surfaces only; never a second persistence authority)
new relationship model:      NO (additive `reuseEvidence[]` on the existing Principle)
new field on existing entity: YES (one optional array on `Principle`)
new public SSOT:             NO
```

All-NO except one additive optional field on an existing entity. Under `reuseEvidence[]` (OD-PRI917-02/03) reuse writes a new optional array on the reused Principle in the existing JSON ledger document, and **nothing else**. No new table, no new database, no relational column, no edge type, no relationship entity, no second SSOT, and no schema migration: `loadLedger` performs no TypeBox validation on read, so all existing entries are unaffected and read the field as empty. `derivedFromPainIds` and every one of its consumers are untouched, and `activation_decisions` is **not written at all** for reuse (its CHECK constraints make reuse unrepresentable there — §12).

## 23. Open Questions

1. Should `archived` principles be reusable after explicit Owner reinstatement? Phase 1 says no.
2. Retrieval threshold and shortlist size — Phase 1 suggests Top-3; the exact cut is a tuning decision, not an architecture one.
3. Whether the proposal should also be surfaced for non-principle kinds later (Phase 1: no).
4. Whether a repeat reuse of the SAME Principle by a later Candidate needs any extra linkage beyond one evidence entry per (pain, candidate) pair. Phase 1 assumes it does not; if a later slice finds the per-entry record is insufficient, the answer is a decision about evidence shape — never a silent new field guessed at write time.

## 24. Implementation Plan (slices — Slice 3B is the next step)

Implemented on development branches, **pending merge to `main`** (neither slice is in `main` yet; do not read this as delivered):

- **Slice 1 (PR1, `ce854fcc`)** — reuse domain contract + deterministic shortlist + read-only retrieval over `loadLedger`.
- **Slice 2 (PR2, final `8249b9ff`)** — `CandidateIntakeService` reuse gate: proposal generation, opt-in decision injection, runtime decision validation, fail-closed semantics. Stacked on PR1; it needs a rebase onto `main` and an independent review once PR1 lands.

Remaining, **reordered by OD-PRI917-03**:

- **Slice 3B (next) — reuse evidence persistence** (`reuseEvidence[]`):
  - Append one entry to the reused Principle's new optional `reuseEvidence[]` (`painId`, `candidateId`, `decision`, `actor`, `reason`, `decidedAt`; `decisionId` only as an optional correlation id, §12).
  - **No relationship entity is created, and neither `derivedFromPainIds` nor `activation_decisions` is written** — no new table, no relational column, no edge type, no schema migration.
- **Slice 3A (after 3B) — Owner decision surface** (`pd candidate review`): show the proposal, record `reuse` (append evidence, write nothing else) or `create` (existing intake path, unchanged).
  - It follows 3B deliberately: a decision surface without an authoritative sink would either fail at write time or be tempted into a false record elsewhere.
- **Slice 4** — Console / governance presentation of reuse evidence (read-only over the same field).
- **Slice 5** — production E2E + telemetry.

No "Principle Knowledge Platform" groundwork.

## 25. Owner Review Card

1. **Problem** — every eligible candidate becomes a new Principle; cross-candidate semantic reuse does not exist.
2. **Existing mechanism reused** — `CandidateIntakeService`, Principle Ledger, `loadLedger`, the existing Owner-identity resolver for the decision surface, `derivedFromPainIds` (untouched), `principle_applications` (evidence only). `activation_decisions` is deliberately **not** used for reuse, and no approval/console surface is treated as a persistence authority.
3. **Minimal new mechanism** — a read-only retrieval + advisory proposal in front of the existing write, plus a `reuseEvidence[]` entry on the reused Principle.
4. **Complexity** — all NO except one additive optional field on an existing entity; no migration (OD-PRI917-02).
5. **Verification** — Audit A–E against live `1f5f8307`; no code written.
6. **Risk** — retrieval quality determines proposal quality; a weak shortlist degrades to CREATE, which is the status quo, so the failure mode is safe.
7. **Rollback** — remove the gate; pre-existing path is the default.
8. **Follow-ups deliberately excluded** — Phase 2 EXTEND/MERGE, Codex parity, budget fairness clock.

---

## 26. Owner Decisions

### OD-PRI917-01 — Persistence route for reuse (R1 approved) — **SUPERSEDED on the persistence carrier by OD-PRI917-02**

- **Date:** 2026-09-28
- **Decided by:** Owner
- **Decision:** R1 approved — reuse is recorded as **accumulation of supporting evidence** on the existing Principle, not as a mutation of Principle semantics.
- **Reasoning:** Reuse means the system recognized that an already-learned Principle covers a new Pain. The new Pain is a fresh real-world validation of that Principle, so it belongs in the Principle's supporting lineage. What the Principle *says* is unchanged — the Principle is not rewritten, re-versioned, or re-scoped. Therefore appending lineage evidence is evidence accumulation, not semantic mutation.
- **Still valid:** the *semantic* ruling — reuse is evidence accumulation, never semantic mutation — which is now carried by INV-R05. The "the Ledger owns the relation" half of OD-01's split also stands; the "`activation_decisions` owns the audit trail" half is **superseded by OD-03**, because that table cannot represent a reuse decision at all. The Ledger now carries the relation **and** the decision that made it.
- **Superseded:** the choice of `derivedFromPainIds` as the carrier. See OD-PRI917-02.
- **Effect on this SPEC (as originally written):**
  - §12 settled on R1; INV-R05 restated as **No Semantic Mutation on Reuse** (MUST-NOT: text / meaning / identity / version / activation state; MAY-APPEND: lineage evidence); Slice 3 became **reuse evidence persistence**.

---

### OD-PRI917-02 — Persistence carrier for reuse (`reuseEvidence[]` on the Principle)

- **Date:** 2026-09-28
- **Decided by:** Owner (on the recommendation of a pre-implementation reality audit)
- **Decision:** Reuse evidence is stored in a **new additive optional `reuseEvidence[]` array on the reused Principle**. `derivedFromPainIds` is **not** used and **not** modified.
- **Reasoning:** The pre-implementation audit refuted R1's premise. `derivedFromPainIds` holds **source Candidate ids**, not supporting Pain ids (live ledger: 128/128 occurrences resolve in `principle_candidates`; Pain-id occurrences: 0), and it is simultaneously (a) the `existsForCandidate` idempotency index, (b) the `candidateToLedgerEntry` join key in `pain-chain-read-model`, and (c) the Console's evidence-presence signal. It is also already contract-mixed: `evolution-reducer.ts:423` writes a real `painId` into it while the adapter writes a `candidateId`. Appending to it would either corrupt the idempotency index (Candidate id) or launder a Pain id into a field four consumers read as candidate ids. A dedicated field preserves the correct semantic (supporting Pain lineage) without touching an index, without an ambiguous legacy field, and without a relation entity.
- **Effect on this SPEC:**
  - §12 rewritten: the R1 append is removed and replaced by `reuseEvidence[]`; the "Why R1 failed" evidence chain is recorded in the SPEC so the refutation is not silently forgotten.
  - INV-R05 unchanged (No Semantic Mutation) — it was never the problem and remains correct.
  - Slice 3 rewritten; §22 Complexity Delta updated to "all NO except one additive optional field on an existing entity".
- **Impact:** No schema migration, no new table, no relational column, no relationship entity, no new SSOT, no change to any existing `derivedFromPainIds` writer or consumer. Implementation remains ready for PR1.

---

### Follow-up recorded by the audit (not in scope for PR1)

`derivedFromPainIds` carries two incompatible contracts today (adapter writes `candidateId`; `evolution-reducer` writes `painId`), and `PainEvidenceValidators` / `PrincipleDetailPage` treat its contents as Pain ids. In the live workspace the evolution path has not been exercised (0 Pain-id occurrences), so no live data is corrupted today — but the latent mismatch is real and pre-dates PRI-917. Cleaning it up (rename/split, or correcting the Console labels and validators) is a **separate change** with its own migration and risk surface, and is deliberately **excluded** from PRI-917 Phase 1.

---

### OD-PRI917-03 — Persistence boundary correction: `reuseEvidence[]` is the only reuse sink

- **Date:** 2026-09-28
- **Decided by:** Owner
- **Trigger:** PR3A (Owner decision surface) stopped during implementation. A decision surface without an authoritative sink would either fail at write time or be tempted into a false record elsewhere.
- **Finding:** `activation_decisions` was investigated as the governance audit sink and **rejected**. Its `subject_kind` and `decision` are closed by CHECK constraints to the activation lifecycle (`subject_kind IN ('activation','all_live_rulecode')`, nine `decision` values, plus a compound CHECK pinning `activation_id`/`artifact_id`/`artifact_digest` per subject). It models activation governance, not knowledge reuse, and holds no typed Candidate→Principle relation. Recording reuse under either existing subject kind would be a false record in the audit ledger; widening the constraints would require rebuilding a live production table (a migration).
- **Decision:**
  1. `activation_decisions` **MUST** record activation governance, and **MUST NOT** store the Candidate→Principle reuse relationship or reuse decision semantics.
  2. `Principle.reuseEvidence[]` is the **authoritative and only** persistence for the reuse relation and the decision that created it — including the deciding owner (`decidedBy`), so auditability is carried by the record itself.
  3. **PR3B (persistence) precedes PR3A (decision surface).**
- **Effect on this SPEC:** §12 gained the Reality Correction and the binding store boundary; INV-R05 restated as explicit ALLOWED (append `reuseEvidence`) / FORBIDDEN (text, meaning, id, version, activation state, and any `derivedFromPainIds` mutation); §24 reordered; §22 complexity re-evaluated.
- **Impact:** Still zero new tables, zero migrations, zero `activation_decisions` schema change, zero `derivedFromPainIds` change. The single YES remains one additive optional field on an existing entity.
