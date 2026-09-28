# PRI-917 Reuse Before Create — SPEC v0.2

> **Status:** Implementation Ready — Reality Audit PASS, Owner Decisions OD-PRI917-01 + OD-PRI917-02 recorded
> **Scope:** Principle Reuse Decision Loop Phase 1
> **Change type:** Runtime behavior correction (knowledge governance)
> **Historical migration:** None
> **New SSOT:** None
> **Persistence route:** additive `reuseEvidence[]` on the existing Principle (OD-PRI917-02) — no migration
> **Implementation:** NOT started by this SPEC revision; PR1 is the next step
>
> **Revision v0.1.1 (2026-09-28):** recorded OD-PRI917-01 (R1 approved). Superseded on the persistence question by v0.2.
>
> **Revision v0.2 (2026-09-28):** a pre-implementation reality check against live production data **refuted R1**. `Principle.derivedFromPainIds` does not hold supporting Pain ids — it holds **source Candidate ids**, and it is simultaneously the intake idempotency index, the candidate→principle join key, and the Console evidence-presence signal. §12 is rewritten around a new additive `reuseEvidence[]` field; OD-PRI917-02 records the correction. INV-R05 (No Semantic Mutation) is unchanged and remains correct. Retrieval design, Top-3 proposal, Owner review flow, failure semantics, test matrix, and rollback are unchanged.

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
- Owner/AI-Owner decision recorded in the existing governance store.
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
| Decision | Owner's recorded `reuse` \| `create` verdict |

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

## 12. Persistence / Relationship Model

**Route Selected: `reuseEvidence[]` on the existing Principle** (OD-PRI917-02, 2026-09-28). This supersedes R1 (OD-PRI917-01), which a pre-implementation reality check refuted.

#### Why R1 failed

R1 assumed `Principle.derivedFromPainIds` holds supporting Pain ids and is a safe append target. Against live production data and code, it is neither:

- **It holds source Candidate ids.** `principle-tree-ledger-adapter.ts:40` writes `derivedFromPainIds: [candidateId]`. Live ledger: 128/128 occurrences resolve in `principle_candidates`; Pain-id occurrences: **0**. The field name is a misnomer the codebase already acknowledges — `owner-decision-view.ts` describes it as "当前指向诊断候选记录，非行为证据行数".
- **It is the intake idempotency index.** `existsForCandidate` matches on `derivedFromPainIds.includes(candidateId)`, and `pain-chain-read-model` builds its `candidateToLedgerEntry` map from it (with a self-check that a `consumed` candidate is never missing). Appending a Candidate id would change what `existsForCandidate` returns — silently altering INV-R07 replay semantics and `listForCandidate` mapping.
- **It is the Console evidence-presence signal.** `PainEvidenceValidators` treats a non-empty array as "evidence captured and internalized"; `PrincipleDetailPage` renders each entry under the variable name `painId`.
- **Its contract is already mixed.** A second writer, `evolution-reducer.ts:423`, writes `[params.painId]` — a real Pain id — into the same field, while `init.ts:218` writes `[]`. So the field has never had one meaning.

Appending therefore either corrupts the idempotency index (candidate id) or launders a Pain id into a field four consumers read as candidate ids (pain id). Neither is evidence accumulation; both are semantic pollution.

#### Selected model

Reuse evidence is carried by a **new additive optional array on the existing Principle**, leaving every existing field and consumer untouched:

```ts
// additive; absent on all pre-existing entries, read as []
reuseEvidence?: Array<{
  painId: string;
  candidateId: string;
  decisionId: string;   // → activation_decisions.decision_id
  createdAt: string;
}>;
```

Responsibility split is unchanged from OD-PRI917-01 and remains correct:

| Concern | Owner | What is written |
|---|---|---|
| **Reuse relation + its evidence** | Principle Ledger (`_tree.principles`) | Append one `reuseEvidence` entry to the reused Principle. Purely additive: the Principle still says exactly what it said, and its version, identity, and activation state are untouched. |
| **Governance process audit** | `activation_decisions` | Who decided reuse (`principal_kind` / `operator_kind` / `operator_id`), why (`reason_code` / `note`), when (`decided_at`), evidence (`evidence_snapshot_id`). Referenced by `decisionId`. |

`activation_decisions` remains the audit trail, not the relation source: it has no typed key for either side, and a relation reconstructed from free text is not a relation.

**Why this needs no migration:** the ledger is a JSON document (`principle_training_state.json`) and `loadLedger` performs no TypeBox validation on read. A new **optional** field is invisible to all 127 existing entries (read as `[]`), and no existing writer, reader, or UI surface changes. `derivedFromPainIds` keeps its current content, meaning, and every consumer's behaviour.

**Bounded growth:** `reuseEvidence` only grows on an actual reuse decision (rare), unlike `derivedFromPainIds`, which is an index touched on every intake.

## 13. State Transitions

```text
candidate(pending) ──intake──▶ reuse_check
      │  no credible candidate          │  credible candidate
      ▼                                 ▼
   CREATE                    awaiting_decision (proposal surfaced)
      │                                 │
      ▼                    ┌────────────┴────────────┐
  consumed                        REUSE               CREATE
                                   │                    │
                                   ▼                    ▼
                          existing Principle      consumed
                          (no new Principle)
                          + reuseEvidence entry
```

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

The existing `ApprovalRequest` already provides the right persistence slots — `triggerReason`, `confidenceExplanation`, `effectDescription`, `summary` — so no new explainability schema is needed. The Owner should be able to read, in one line, why a new Pain was folded into an existing Principle.

## 18. Production Wiring

Gate inside `CandidateIntakeService.intake()` between step 4c and step 5. All four production callers inherit it without modification. Proposal + decision surface reuses `ApprovalQueue` and the Console approvals/owner-decision routes — no second approval subsystem. AI Owner may act, but only through that same formal surface.

## 19. Invariants

- **INV-R01 Reuse Before Create** — every `recommendation_kind=principle` candidate passes a reuse decision boundary before any new Ledger Principle is created.
- **INV-R02 Canonical Identity** — reuse targets are canonical Principle Ledger UUIDs.
- **INV-R03 No Silent Duplicate Creation** — an unresolved reuse decision never silently proceeds to Create.
- **INV-R04 Owner Authority** — the final verdict goes through the existing governance authority.
- **INV-R05 No Semantic Mutation on Reuse** — reuse accumulates evidence; it never changes what the Principle means.

  Reuse **MUST NOT** modify:

  - Principle `text`
  - Principle meaning / semantic claim
  - Principle identity (`id`)
  - Principle `version`
  - Principle activation state

  Reuse **MAY** append:

  - `derivedFromPainIds` (supporting lineage evidence)
  - supporting lineage evidence generally

  Rationale: a new Pain that resolves to an existing Principle is a *new occurrence validating that Principle again* — evidence accumulation, not semantic mutation. The Principle continues to say exactly what it said before.
- **INV-R06 Relationship Is Durable** — reuse leaves a traceable `Candidate/Pain → existing Principle` fact.
- **INV-R07 Idempotent Replay** — replaying the same candidate produces no new Principle and no new logical decision.
- **INV-R08 Fail Closed** — invalid target UUID, missing authority, or malformed decision ⇒ no Create, no Reuse, explicit failure.

## 20. Test Matrix

| ID | Scenario | Expectation |
|---|---|---|
| T1 | No matching Principle | CREATE; exactly one new Ledger Principle |
| T2 | Matching existing Principle + REUSE | no new UUID, no new Ledger entry |
| T3 | Reuse replay | same result; no duplicate relation, no new Principle |
| T4 | `selectedPrincipleId` nonexistent | fail closed |
| T5 | Reuse evaluation unavailable | must **not** silently create |
| T6 | Non-principle kinds (#1851 behaviour) | reuse logic MUST NOT run; ledger write still refused |
| T7 | Existing create path | canonical UUID / ledger semantics unchanged |
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
new approval subsystem:      NO (extends ApprovalRequest + existing Console routes)
new relationship model:      NO (additive `reuseEvidence[]` on the existing Principle)
new field on existing entity: YES (one optional array on `Principle`)
new public SSOT:             NO
```

All-NO except one additive optional field on an existing entity. Under `reuseEvidence[]` (OD-PRI917-02) reuse writes a new optional array on the reused Principle in the existing JSON ledger document, and reuses the existing `activation_decisions` governance table. No new table, no relational column, no edge type, no relationship entity, and no schema migration: `loadLedger` performs no TypeBox validation on read, so all 127 existing entries are unaffected and read the field as empty. `derivedFromPainIds` and every one of its consumers are untouched.

## 23. Open Questions

1. Should `archived` principles be reusable after explicit Owner reinstatement? Phase 1 says no.
2. Retrieval threshold and shortlist size — Phase 1 suggests Top-3; the exact cut is a tuning decision, not an architecture one.
3. Whether the proposal should also be surfaced for non-principle kinds later (Phase 1: no).

## 24. Implementation Plan (slices — PR1 is the next step)

- **Slice 1** — reuse domain contract + read-only retrieval over `loadLedger` (add a list-all read to the adapter; no new repository).
- **Slice 2** — `CandidateIntakeService` reuse gate (single insertion point).
- **Slice 3** — reuse evidence persistence (`reuseEvidence[]`, OD-PRI917-02):
  - Append one entry to the reused Principle's new optional `reuseEvidence[]` (`painId`, `candidateId`, `decisionId`, `createdAt`).
  - Record the governance decision in `activation_decisions` (who / why / when / evidence), referenced by `decisionId`.
  - **No relationship entity is created, and `derivedFromPainIds` is not touched** — no new table, no relational column, no edge type, no schema migration.
- **Slice 4** — Console / governance decision surface (proposal display + reuse|create decision).
- **Slice 5** — production E2E + telemetry.

No "Principle Knowledge Platform" groundwork.

## 25. Owner Review Card

1. **Problem** — every eligible candidate becomes a new Principle; cross-candidate semantic reuse does not exist.
2. **Existing mechanism reused** — `CandidateIntakeService`, Principle Ledger, `loadLedger`, `ApprovalQueue` + Console governance routes, `activation_decisions`, `derivedFromPainIds`, `principle_applications` (evidence only).
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
- **Still valid:** the *semantic* ruling — reuse is evidence accumulation, never semantic mutation — which is now carried by INV-R05. The Ledger-owns-the-relation / `activation_decisions`-owns-the-audit-trail split also stands.
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
