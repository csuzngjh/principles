# PRI-588 — Provenance Migration Research (Deliverable: research only, no implementation)

> Date: 2026-08-24 · Status: Research complete · Scope: assess what a future
> provenance migration would require, per Governance Experience Snapshot
> v1.5.1 Task 5. Nothing in this document has been implemented; per
> `docs/plans/post-mvp-conditional-roadmap.md` the restart conditions are NOT
> met, so any implementation stays deferred (post-MVP).

## 1. Question

Should governance records (approvals, activations, principles, artifacts) carry
end-to-end provenance (origin environment + originating pain/candidate chain)
so the Experience layer can answer "这个判断是在哪个环境、从哪条证据链产生的？"
without inference — and what would migrating to that model cost?

## 2. Current provenance model (facts)

Collected from the code as of 2026-08-24 (branch `feat/pri-584-governance-experience-snapshot`):

| Layer | Mechanism | Location |
|---|---|---|
| Per-fact lineage confidence | `lineageConfidence: strong/weak/unknown` on every GovernanceFacts row | `principles-core/src/runtime-v2/governance-projection-contract.ts:29-34` |
| Workspace→principle linkage | `pi_artifacts.source_principle_id` + transitive closure over `lineage_artifact_ids` | `GovernanceProjectionCollector.buildFacts` (pd-console) |
| Task→task linkage | `dependencyTaskIds` in task `diagnostic_json` (BFS, cap 500 nodes) | `GovernanceProjectionCollector.connectedTaskIds` |
| Origin events | timeline events (`pain_created` → `candidate_generated` → … → `activated`) reconstructed per principle | projection derive |
| Effect ledger | `principle_applications` receipts (state.db), keyed by principle/channel | `openclaw-plugin/src/core/principle-application-ledger.ts` |
| Pain attribution | ledger rows store `derivedFromPainIds` which actually contain **candidateId** values; there is **no `environment` column** anywhere in the chain | state.db ledger + 2026-08-24 feasibility review |

Known gaps (already documented in prior audits, reconfirmed):

- **G1** `derivedFromPainIds` holds candidate ids — the name promises pain ids.
  Traceability pain→candidate→approval currently relies on timeline
  reconstruction, not a durable foreign key.
- **G2** No environment/dimension is recorded at decision time. After a
  workspace is copied or renamed, nothing distinguishes "decided in demo" from
  "decided in production".
- **G3** Lineage confidence is derivational (computed from issues at read
  time), not durable — it is honest but not reproducible across collector
  versions.

## 3. What the Experience layer actually needs vs. what migration would add

The v1.5.1 experience snapshot needs exactly three provenance-adjacent facts,
all already available without migration:

1. per-view lineage confidence — from `GovernanceFacts.lineage.confidence` (input `governanceViews[].lineageConfidence`);
2. source availability — from collector I/O attempts;
3. environment — from `.pd/config.yaml workspace.environment` (PRI-587, workspace config domain).

So **the experience layer does NOT require the provenance migration**. Migration
only becomes valuable when owners must audit decisions ACROSS workspace copies
(e.g. promote a demo-validated rule into production with its evidence chain).

## 4. Migration sketch (deferred, cost estimate)

If/when restart conditions are met, the minimal migration is:

1. **New columns, not new tables** (avoid a second state source):
   - `approvals.environment TEXT` + `activations.environment TEXT` — stamped
     from the workspace config at decision time (write path only; readers
     treat NULL as `unknown` — consistent with PRI-587 "missing is legal").
   - `principle_applications.origin_candidate_id TEXT` — fix G1 without
     renaming the existing column (readers accept both for one release).
2. **Write-path stamping**: the activation/approval services resolve
   `workspace.environment` once per mutation (same loader as PRI-587) and
   persist it; unknown is stamped as NULL, never guessed.
3. **Read-path exposure**: extend GovernanceFacts with optional
   `environment` on approval/activation facts (additive, `additionalProperties: false`
   schemas bumped via schemaVersion negotiation already in place).
4. **Backfill**: none required (NULL = unknown is the correct interpretation
   of history). A one-shot optional backfill could mark pre-migration rows
   `environment = 'legacy'` — NOT recommended; unknown is more honest.
5. **Experience surface**: `trustContext.environmentContext` already carries
   the workspace-level environment; per-decision environment would surface as
   a data-quality/attention fact only when a decision's stamped environment
   mismatches the current workspace (a demo decision sitting in a production
   workspace).

Cost: ~2 schema columns + 2 write-path stamps + schema additive fields +
tests. Risk: LOW-MEDIUM — additive columns with NULL-as-unknown cannot break
existing readers; the main risk is ERR-083-class contract drift across the 5
independently versioned packages (coordinate a single release).

## 5. Recommendation

**Defer (default)**. The restart condition should be: an owner actually needs
to move governance decisions between workspace copies (demo→production
promotion) and asks "这条是在哪决定的". Until then:

- the experience layer consumes PRI-587 config environment only;
- G1 (`derivedFromPainIds` naming) is a P3 data-hygiene fix, not a migration;
- any implementation must NOT ride along with an experience-layer PR
  (antipattern-prep-next-phase / scope discipline).

## 6. Red lines (unchanged from SPEC v1.5.1)

- The experience projection stays read-only; provenance columns would feed
  explanation, never authorization (ERR-102).
- No second governance state source: columns extend existing tables; no
  `governance_experience_state.db`.
