# PRI-917 Reuse Before Create — SPEC v0.1

> **Status:** Proposed — Reality Audit PASS, pending Owner Review
> **Scope:** Principle Reuse Decision Loop Phase 1
> **Change type:** Runtime behavior correction (knowledge governance)
> **Historical migration:** None
> **New SSOT:** None
> **Implementation:** NOT authorized by this SPEC

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

**Audit E — the one genuine architectural fork.** No existing durable model has a typed, queryable home for "Candidate C resolved by existing Principle P":

- `activation_decisions` is a general governance table (`subject_kind` discriminator, `decision`, `reason_code`, `note`, `principal_kind`, `operator_*`, `authentication_method`, `evidence_snapshot_id`, `decided_at`) — but has **no `candidate_id` and no `principle_id` column**.
- `principle_applications` carries `principle_id` but is *effect* semantics (a principle was applied), and is explicitly not an identity source.
- `principle_candidates` has no resolved-principle column (`status` ∈ {pending, consumed}).
- Ledger `Principle.derivedFromPainIds` is an existing, populated lineage field meaning "this Principle is supported by these Pains".

Two viable routes, differing **only** in whether existing schema is touched:

| Route | Mechanism | New schema | Cost |
|---|---|---|---|
| **R1 (zero schema)** | Append the Pain to the reused Principle's existing `derivedFromPainIds`; candidate reaches the Principle through the bridge's `painId` ↔ `candidateIds` linkage. Governance trail additionally written to `activation_decisions` with `subject_kind='principle_reuse'` and the principle id in `note`. | **NO** | Mutates the reused Principle's lineage array. |
| **R2 (schema change)** | Add a typed relation (e.g. `principle_candidates.resolved_principle_id` or a dedicated table) holding `candidateId → principleId` canonically. | **YES** (new column or table) | Migration + new durable model to govern. |

**R1 is recommended** (zero new schema, reuses an existing lineage field whose semantics already mean exactly this), **but it requires an Owner ruling** on whether appending to `derivedFromPainIds` counts as "modification of the existing Principle" under INV-R05. This SPEC does not decide that. If the Owner rules that R1 violates INV-R05, R2 applies and the task's **S4 stop condition is triggered** (new persisted schema required) — the decision then returns to the Owner rather than being made here.

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
```

No new candidate status is invented. Under R1 the candidate still reaches `consumed` (its knowledge was applied), and the relation lives on the Principle side.

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
- **INV-R05 No Mutation on Reuse** — reuse does not modify Principle text, version, identity, or activation. *(Whether lineage append counts as mutation is the Owner ruling in §12.)*
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
new table:                   NO (R1) / OWNER DECISION (R2)
new column:                  NO (R1) / OWNER DECISION (R2)
new file-based state:        NO
new background process:      NO
new LLM subsystem:           NO (reuses the existing agent/LLM path)
new vector store:            NO
new identity source:         NO
new approval subsystem:      NO (extends ApprovalRequest + existing Console routes)
new public SSOT:             NO
```

Two items are conditional on the §12 ruling and are the only possible YES.

## 23. Open Questions

1. **Does appending to `derivedFromPainIds` violate INV-R05?** (R1 vs R2; decides whether this is schema-free or S4-blocked.)
2. Should `archived` principles be reusable after explicit Owner reinstatement? Phase 1 says no.
3. Retrieval threshold and shortlist size — Phase 1 suggests Top-3; the exact cut is a tuning decision, not an architecture one.
4. Whether the proposal should also be surfaced for non-principle kinds later (Phase 1: no).

## 24. Implementation Plan (slices, not authorized)

- **Slice 1** — reuse domain contract + read-only retrieval over `loadLedger` (add a list-all read to the adapter; no new repository).
- **Slice 2** — `CandidateIntakeService` reuse gate (single insertion point).
- **Slice 3** — durable reuse relation (R1 lineage append + `activation_decisions` governance row).
- **Slice 4** — Console / governance decision surface (proposal display + reuse|create decision).
- **Slice 5** — production E2E + telemetry.

No "Principle Knowledge Platform" groundwork.

## 25. Owner Review Card

1. **Problem** — every eligible candidate becomes a new Principle; cross-candidate semantic reuse does not exist.
2. **Existing mechanism reused** — `CandidateIntakeService`, Principle Ledger, `loadLedger`, `ApprovalQueue` + Console governance routes, `activation_decisions`, `derivedFromPainIds`, `principle_applications` (evidence only).
3. **Minimal new mechanism** — a read-only retrieval + advisory proposal in front of the existing write, plus one durable relation.
4. **Complexity** — all NO except the §12-conditional table/column.
5. **Verification** — Audit A–E against live `1f5f8307`; no code written.
6. **Risk** — retrieval quality determines proposal quality; a weak shortlist degrades to CREATE, which is the status quo, so the failure mode is safe.
7. **Rollback** — remove the gate; pre-existing path is the default.
8. **Follow-ups deliberately excluded** — Phase 2 EXTEND/MERGE, Codex parity, budget fairness clock.
