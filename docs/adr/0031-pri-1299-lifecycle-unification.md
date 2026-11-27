# ADR-0031: PRI-1299 Lifecycle Unification

| Field | Value |
| --- | --- |
| Status | **Proposed — PENDING_OWNER_DECISION** |
| Date | 2026-11-27 |
| Supersedes | 无 |
| Superseded by | 无 |
| Related | PR #2805（merged as `e3ddf901d0be93b10713beff8165c7008e64d2d6`）、PR #2803、`docs/specs/PRI-1299-ROOT-CAUSE-ANALYSIS-LIFECYCLE-UNIFICATION-SPEC-v1.1.md`、ADR-0012、ADR-0024 |
| Decision evidence | Phase 0 read-only investigation of `origin/main` `e3ddf901d0be93b10713beff8165c7008e64d2d6`; four independent evidence reports A-D; limited repository-pinned better-sqlite3 13.0.3 in-memory transaction probe |
| Approval state | **Owner has not approved these decisions.** Every decision in §14 is `PENDING_OWNER_DECISION` unless explicitly marked as a restatement of existing code fact. |

---

## 1. Context

PRI-1299 began as a successor-lookup correctness effort. PR #2805 fixed important scoped defects and has been merged, but the Phase 0 investigation confirmed that the remaining difficulty is architectural rather than a collection of independent review comments:

- task identity is not one concept: `taskId`, logical successor identity, repair round identity, revision epoch, run identity, artifact identity, and evaluator evidence identity have different semantics;
- ordinary successor creation has converged, but repair creation still uses two direct seeding implementations;
- lifecycle correctness depends on multiple separately persisted evidence writes rather than one large transaction;
- SQLite write admission is currently scoped to `SqliteTaskStore`, while many writers share the same connection outside that authority;
- Memory store tests cannot prove SQLite transaction behavior;
- legacy rows require proof-bound lineage recovery rather than inference-by-guessing.

PR #2803 already tightened single-step execution and parent-chain lineage. PR #2805 merged the successor-lookup authority work. Neither closed the repair identity/creation-authority or connection-level transaction questions.

## 2. Problem Statement

The decision problem is not “which small bug should be patched next”. It is:

> Which lifecycle identity, creation authority, transition authority, evidence-validity, and persistence contracts should be frozen so Phase 1-7 can fix the remaining root causes without creating a parallel task framework or mixing unrelated transaction redesign into identity work?

Success means:

1. Phase 1 can implement repair identity/creation without re-litigating basic definitions;
2. transaction redesign remains isolated in Phase 4;
3. legacy data remains fail-closed and auditable;
4. every unresolved Owner/product decision is explicit rather than silently assumed;
5. no second task state machine or parallel persistence architecture is introduced.

## 3. Investigation Baseline

| Item | Value |
| --- | --- |
| Current `origin/main` | `e3ddf901d0be93b10713beff8165c7008e64d2d6` |
| PR #2805 state | MERGED at 2026-11-27T05:28:48Z |
| PR #2805 head before merge | `aaccb6b4a9b6b3fdee17514b39f01354a825412a` |
| Tree comparison | `aaccb6b4^{tree}` equals `e3ddf901^{tree}` (`0145ccc594941ffcdb0d1c80be8c52c914d9d51e`) |
| Consequence | The v1.0 source investigation remains accurate for production code; line numbers did not drift because of the merge. |
| Phase 0 worktree HEAD before this ADR | `33293368df9beea3ebcdd7c7a3302389a5262c04` |
| That HEAD delta | only the cherry-picked v1.0 SPEC document; no production change |

The merge commit is a squash commit with one parent, not a two-parent merge. PRI-1300/PRI-1301/PRI-1294 materials were already inside the `aaccb6b4` investigation baseline through `1ce190d85`; they are not post-SPEC surprises.

## 4. Confirmed Root Causes

### PRC-1 — Logical identity contract incomplete — CONFIRMED

Evidence:

- ordinary identity is exactly `(parentTaskId, successorKind, channel)` in `successor-lookup.ts:1-25`;
- repair identity requires `repairPayload.repairIteration` and source evaluator proof in `repair-task-identity.ts:50-140`;
- deterministic repair id is `artificer-repair-<sourceEvaluatorTaskId>-r<iteration>` in `pitask-metadata.ts:155-157`;
- schema only enforces `task_id` uniqueness in `sqlite-connection.ts:306-325`.

### PRC-2 — Creation authority not fully converged — CONFIRMED

Evidence:

- ordinary creation authority is `createLogicalSuccessorTask` (`successor-create.ts:108-207`);
- host repair seeder still directly calls `stateManager.createTask` (`internalization-consumer-governance.ts:268-288`);
- pd-cli repair seeder also directly calls `stateManager.createTask` (`rulehost-pipeline-runner.ts:1078-1109`).

The shared repair lineage verifier/backfill has been uplifted to core; the remaining duplication is creation arbitration, not lineage validation.

### PRC-3 — Multi-stage persistence lacks one universal recovery contract — CONFIRMED

Evaluator/artificer output, artifact, terminal state, completion intent, repair seeding, successor creation, reopen, and lineage backfill are separately durable. The system correctly uses fencing, CAS, causes, and exact-input validation as a recovery protocol, but that protocol is distributed across runners and orchestrator paths rather than expressed as one contract.

### PRC-4 — Transaction ownership and connection ownership are misaligned — CONFIRMED

Evidence:

- `SqliteTaskStore` FIFO/admission is at `sqlite-task-store.ts:63-113`;
- `RuntimeStateManager.withWriteTransaction` delegates only to the task store (`runtime-state-manager.ts:232-235`);
- run, artifact, candidate, approval, activation, cursor, lease/fenced, and raw-connection writers do not share one transaction identity;
- raw connection access remains available (`runtime-state-manager.ts:181-184`).

A limited probe using the repository-pinned `better-sqlite3` 13.0.3 and an in-memory database confirmed the underlying capture mechanism: when a synchronous `db.transaction()` write runs while an outer raw `BEGIN IMMEDIATE` transaction is open, it becomes savepoint-scoped work and disappears after outer `ROLLBACK`. This proves mechanism, not production frequency.

### PRC-5 — Downstream invalidation is not one explicit cross-module evidence contract — CONFIRMED

The formal evaluator path already has strong exact-input defenses (`evaluator-runner.ts:940-1004`, `1085-1167`, `2169-2202`). The root cause is not absence of all validation. It is that validity depends on formal reopen/cascade plus several runner-local validators, rather than a single cross-module contract covering recovery, Owner resolution, repair, and downstream evidence consumption.

## 5. Architectural Constraints

1. Reuse `InternalizationOrchestrator`, `createLogicalSuccessorTask`, `reopenTaskForRevision`, lease/CAS, run store, and artifact store.
2. Do not create a second task state machine or parallel task framework.
3. Do not rewrite all direct SQL writers in Phase 1.
4. Do not copy the TaskStore FIFO mechanically into every store and call that a transaction architecture.
5. Do not use Memory store results as evidence for SQLite transaction correctness.
6. Do not infer parentage from `dependencyTaskIds` as a general rule.
7. Do not rename existing repair task ids without a separately approved migration.
8. Do not claim Owner approval until explicitly granted.

## 6. Identity Contract

### Terms

These are proposed ADR-local contract terms. They must not be treated as additions to the repository's locked ontology unless and until the Owner approves the corresponding decisions.

```text
TaskRecordId = tasks.task_id

OrdinarySuccessorIdentity =
  (parentTaskId, taskKind, channel)

RepairSuccessorIdentity =
  (sourceEvaluatorTaskId,
   taskKind = 'artificer',
   channel,
   repairIteration)

RevisionEpoch =
  (taskId, revisionCount, revisionCauseId/consumedRevisionCauseIds)

RunIdentity = runs.run_id

ArtifactVersion =
  (artifactId, sourceTaskId, artifactKind, revisionEpoch, contentHash)

EvaluatorEvidenceKey =
  (evaluatorTaskId, evaluatorRunId, decisionArtifactId,
   sourceArtificerArtifactId, evaluatorRevisionEpoch)
```

### Required interpretation

- `taskId` is a physical row identity/allocation result, not the whole logical identity.
- `dependencyTaskIds` are execution dependencies, not general causal-parent proof.
- Different `repairIteration` values are different logical repair rounds and may legally coexist.
- The same repair identity must not be created twice as a valid active task.
- Unprovable identity or lineage must fail closed.

### Authority and persistence terms

```text
RepairCreationAuthority =
  the single lifecycle authority that adjudicates repair identity,
  verifies strict lineage/payload evidence, allocates/inserts the row,
  resolves UNIQUE races, and returns structured creation outcomes.

LifecycleTransitionAuthority =
  the semantic owner for one mutation family (for example commit/reopen,
  lease fencing, or Owner resolution). The target is one authority per
  family, not one impossible global authority for every status write.

TransactionOwner =
  the scope that owns the open transaction boundary for a SQLite connection
  and is responsible for commit/rollback outcome and connection health.

WriteAdmission =
  the connection/database-level policy that decides whether a writer may
  write outside, inside, or across an active transaction boundary.

LegacyLineageProof =
  the minimum durable evidence required to classify or backfill historical
  parent/correlation lineage without guessing: deterministic identity or
  producer-specific proof, valid target existence/kind, compatible payload,
  and no contradictory lineage evidence.
```

### Channel clarification

Channel must remain part of the written repair identity contract because it is already a consistency invariant (`repair-task-identity.ts:127-133`) and because ordinary successor identity uses it. However, channel is **not an independent degree of freedom** for repair uniqueness: a valid source evaluator has one authoritative channel. Therefore:

- `(sourceEvaluatorTaskId, repairIteration)` is the effective allocation scope;
- `channel` is a mandatory consistency dimension;
- channel mismatch is corruption/conflict and must fail closed;
- channel mismatch must never license creation of a second repair row;
- the deterministic id should remain evaluator+iteration for backward compatibility.

## 7. Repair Lifecycle Contract

Current valid lifecycle:

```text
Evaluator E evaluates Artificer A0
→ needs_revision
→ seed Repair R1
→ R1 succeeds
→ orchestrator commit REOPEN_SOURCE_EVALUATOR
→ E revisionCount increments and dependency switches A0 → R1
→ E reevaluates
→ optional second needs_revision
→ seed Repair R2
→ R2 succeeds
→ E reopens and dependency switches R1 → R2
→ further automatic repair stops under current two-round policy
```

Required invariants:

1. repair completion is orchestrated by `commitNextTaskProposal`, not by the Artificer runner;
2. evaluator reopen uses a unique repair cause and is same-cause idempotent;
3. stale older repair completion must not downgrade evaluator dependency to an older round;
4. R1/R2 may coexist physically as separate rounds;
5. repair seed replay for the same evaluator run must reuse the already-seeded round;
6. duplicate creation races must resolve to structured reuse/adopt/conflict outcomes, not generic seed failure.

## 8. Task Creation Authority

Target authority split:

| Creation class | Target owner | Notes |
| --- | --- | --- |
| Root / intake task | intake/root-specific authority | not an ordinary successor |
| Fixed diagnostician subtask | diagnostician-specific deterministic authority | not an ordinary successor |
| Ordinary logical successor | `createLogicalSuccessorTask` | already converged |
| Repair logical successor | dedicated `RepairCreationAuthority` | Phase 1 target |
| Operator remediation/backfill | operator/remediation workflow applying the identity class of the object it creates | provenance class, not a new logical key |

Phase 1 should introduce or converge to a dedicated atomic repair creation authority. It must own lookup, identity adjudication, legacy backfill orchestration, insert, UNIQUE-conflict re-arbitration, and structured outcomes. Host-runtime and pd-cli seeders must become callers, not competing implementations.

## 9. State Transition Authority

Confirmed current authorities:

- semantic transition decision: `decideInternalizationTransition` (`internalization-transition-decision.ts:76-137`);
- commit arbitration: `commitNextTaskProposal` (`internalization-orchestrator.ts:883-1462`);
- reopen primitive: `reopenTaskForRevision` (`revision-reopen.ts:154-345`);
- ordinary successor creation: `createLogicalSuccessorTask` (`successor-create.ts:108-207`);
- lease ownership/fencing: lease/fenced lifecycle modules;
- Owner resolution status flips: owner-resolution service as a distinct governance authority.

The correct target is **one authority per semantic mutation family**, not one impossible global authority for every status write. The current gap is not that owner-resolution or leasing exist; it is that repair creation and physical write admission are not aligned with their semantic contracts.

## 10. Evidence Validity Contract

Evidence may be consumed only when the relevant validator proves:

1. durable run/output/artifact consistency;
2. correct revision epoch;
3. exact current input artifact binding;
4. completion-intent consistency;
5. Owner-resolution freshness;
6. formal cause/reopen state where applicable.

Artifact writes alone do not invalidate old verdicts. Formal reopen/cascade is the invalidation event; exact-input validation is defense in depth.

## 11. Persistence & Transaction Contract

Phase 4 must define, before implementation:

- `TransactionOwner`;
- connection-level `WriteAdmission`;
- nested transaction policy;
- cross-instance policy;
- rollback failure policy;
- dirty-read policy;
- raw connection access policy;
- writer registration/audit policy;
- multi-process behavior under `SQLITE_BUSY`.

Current confirmed facts:

- TaskStore write admission is scoped to task-store methods;
- direct writers can still be captured by a connection-wide outer transaction;
- rollback failure is best-effort swallowed (`sqlite-task-store.ts:99-103`);
- the module-global FIFO and per-instance ALS scopes do not match;
- true multi-process behavior remains unverified.

Phase 1 must not absorb this work.

## 12. Memory Store Contract

Recommended classification:

```text
MemoryTaskStore = Non-Transactional Test Double
```

Rules:

- it may test business branching, filters, and non-transactional logic;
- it must not be used as proof of SQLite atomicity, rollback, locking, dirty-read, trigger, foreign-key, or multi-connection behavior;
- SQLite-only invariants require real SQLite tests;
- no copy-on-write memory transaction engine should be built unless a later concrete business/test need justifies it.

## 13. Historical Compatibility

Rules:

1. `dependencyTaskIds` must not be used as generic parent proof.
2. Unknown parentage must not be guessed.
3. Unprovable lineage must fail closed.
4. Existing rows and runs must not be deleted or merged for convenience.
5. Backfill must be idempotent, proof-bound, observable, and concurrency-aware.
6. Deterministic-id legacy repair rows missing parent/correlation can be repaired through the existing strict proof path.
7. Arbitrary UUID-shaped historical repair rows are not currently recognized as valid repair identity; their existence in production is `UNVERIFIED` and requires audit before any migration decision.

## 14. Architecture Decisions

### D1 — Logical Identity Contract — PENDING_OWNER_DECISION

**Recommendation:** adopt the identity contract in §6, including the channel clarification.

Evidence: `successor-lookup.ts:1-25`, `repair-task-identity.ts:50-140`, `pitask-metadata.ts:155-157`, `sqlite-connection.ts:306-325`.

Consequences:

- repair lookup/creation cannot reuse the ordinary triple unchanged;
- channel mismatch is conflict, not a new valid identity;
- deterministic repair id remains unchanged for compatibility.

Confidence: High. Open Owner decision: approve this exact written contract.

### D2 — Repair Round Policy — PENDING_OWNER_DECISION

**Recommendation:** keep the current two-automatic-repair-round product policy for now, but do not encode “2” as a permanent identity-model invariant.

Evidence:

- metadata validation currently rejects `repairIteration > 2` (`pitask-metadata.ts:947-976`);
- evaluator seeding stops at `priorRepairIteration >= 2` (`evaluator-runner.ts:2770-2783`).

Important distinction:

- two rounds is current product governance;
- the implementation currently also hard-enforces it at the trust boundary;
- logical identity should support positive-integer iterations conceptually.

Future R3+ path, only if Owner approves: change the governance policy and validator/seed budget together, add R3 lifecycle tests, preserve existing R1/R2 ids and rows unchanged, and do not rename or rewrite history.

Confidence: High for retaining two rounds now; Medium for the future extension shape until Owner chooses product policy.

### D3 — Task Identity Classes — PENDING_OWNER_DECISION

**Recommendation:** freeze five creation/identity classes: root/intake, fixed diagnostician subtask, ordinary logical successor, repair logical successor, and operator remediation/backfill provenance. Do not force root or fixed-subtask identity into `OrdinarySuccessorIdentity`.

Evidence: creation inventory in SPEC v1.1 §5 and direct production call sites.

Reason: `parentTaskId` denotes causal lineage only where the producer contract proves it; `dependencyTaskIds` denotes execution ordering/input dependencies. These meanings are not interchangeable across all task classes.

Confidence: High.

### D4 — Memory Store Contract — PENDING_OWNER_DECISION

**Recommendation:** formally classify Memory store as a non-transactional test double and prohibit using it as SQLite transaction evidence.

Evidence: `memory-task-store.ts:67-190`, `sqlite-task-store.ts:63-113`, artifact-store epoch differences, Agent C/D test audits.

Confidence: High.

### D5 — Transaction Architecture — PENDING_OWNER_DECISION

**Recommendation:** defer all connection-level transaction redesign to Phase 4. Phase 4 must first produce an architecture covering transaction owner, write admission, nesting, cross-instance behavior, rollback failure, dirty reads, raw connection access, and multi-process behavior.

Evidence: Agent C report; `sqlite-task-store.ts:63-113`; `runtime-state-manager.ts:181-184,232-235`; direct writer inventory in SPEC v1.1 §7.1.

Explicitly rejected for Phase 1: copying the TaskStore FIFO into every store or rewriting all writers at once.

Confidence: High.

### D6 — Owner Stale Resolution — PENDING_OWNER_DECISION

**Recommendation:** adopt the current two-layer defense as the baseline and close the remaining submission-time exact-input gap in Phase 3.

Evidence:

- submission-time reviewKey/revision/run/artifact/hash validation exists (`owner-resolution-service.ts:323-445`);
- runner application-time exact-input validation and supersede fallback exists (`evaluator-runner.ts:1006-1059`, `2155-2166`, `2385-2397`);
- the missing piece is direct submission-time proof that the resolution evidence input artifact is still the evaluator's current input artifact.

Rules:

- Owner decisions must be validated against current evidence when submitted;
- stale input must not trigger evaluator reopen or verdict application;
- runner supersede fallback remains as defense in depth;
- implementation should reuse existing current-input validation rather than duplicate it.

Confidence: High.

## 15. Rejected Alternatives

| Alternative | Why rejected |
| --- | --- |
| Continue patching individual review comments | Does not remove the identity/authority/transaction root causes; repeats the whack-a-mole cycle. |
| Force all tasks into the ordinary successor triple | Makes legal R1/R2 coexistence look like a conflict and distorts root/subtask semantics. |
| Add channel to deterministic repair id | Renames existing repair identity, breaks legacy id inference and durable probes, high migration risk. |
| Treat artifact mutation as invalidation | Confuses evidence storage with formal lifecycle invalidation; reopen/cause is the real event. |
| Build a parallel task framework/state machine | Violates minimal-change and one-source-of-truth constraints. |
| Copy TaskStore FIFO everywhere | Does not define transaction identity, connection ownership, cross-instance behavior, rollback, or dirty-read policy. |
| Build a complex Memory transaction engine now | Speculative; Memory only needs a clear contract, not artificial parity. |
| Infer parentage from dependencies for legacy rows | Unsafe; dependencies are not causal parent proof. |

## 16. Implementation Boundaries

### Phase 1 — Logical Identity & Repair Creation Authority

Allowed target areas:

- `successor-lookup.ts` / `successor-create.ts` or a new adjacent repair-creation module;
- `repair-task-identity.ts` and `repair-lineage-backfill.ts` only for creation-authority integration;
- host-runtime and pd-cli repair seeders;
- type definitions needed for structured repair creation outcomes;
- corresponding tests.

Forbidden in Phase 1:

- SQLite transaction architecture redesign;
- schema/migration changes;
- run/artifact/approval/candidate store redesign;
- owner-resolution redesign;
- repair-round policy expansion beyond two rounds;
- broad evaluator/artificer runner refactoring.

### Phases 2-7

See SPEC v1.1 §21. The critical freeze is: transaction work stays in Phase 4; evidence/Owner stale work stays in Phase 3; no production implementation begins before Owner ratifies the required decisions.

## 17. Migration Strategy

No blanket migration is approved or required by this ADR.

Allowed future approach:

1. audit first;
2. classify rows by proof level;
3. backfill only strict deterministic/provable lineage;
4. fail closed for ambiguous rows;
5. preserve original evidence;
6. add operator remediation rather than silent deletion or merging.

Valid existing R1/R2 rows require no rename or rewrite if the recommended identity contract is approved.

## 18. Test Strategy

Phase-specific requirements are in SPEC v1.1 §20. Minimum principles:

- repair identity/adjudication unit tests;
- host/pd-cli shared repair creation contract tests;
- real SQLite duplicate/race/lineage tests;
- true multi-process tests for cross-process claims;
- dynamic fault injection only after contracts are frozen;
- Memory tests labeled non-transactional.

## 19. Risks

| Risk | Status | Mitigation |
| --- | --- | --- |
| Owner rejects or modifies D1 | PENDING_OWNER_DECISION | keep Phase 1 blocked until decision |
| R1/R2 synchronous dual-role semantics complicate unified lookup | CONFIRMED design tension | decide explicit repair lookup/dual-role binding in Phase 1 design |
| Global repair candidate scan exposes malformed historical rows | PARTIALLY_CONFIRMED operational risk | audit + strict error classification + operator remediation |
| pd-cli `pipelineMode` inheritance gap | CONFIRMED code gap | include in Phase 1 repair creation authority tests/fix |
| direct writer capture | CONFIRMED mechanism, production frequency UNVERIFIED | Phase 4 |
| cross-instance FIFO/ALS deadlock | UNVERIFIED static high risk | Phase 4 dynamic proof required |
| true multi-process creation behavior | UNVERIFIED | Phase 4/6 true multi-process tests |
| non-deterministic legacy repair ids | UNVERIFIED | audit before migration decision |

## 20. Acceptance Criteria

This ADR is ready for Owner review when:

1. all six decisions have evidence and explicit status;
2. no decision claims Owner approval;
3. Phase 1 boundary excludes transaction redesign;
4. SPEC v1.1 and this ADR use the same identity terminology;
5. v1.0 SPEC remains unchanged as historical snapshot;
6. no production or test files are modified in Phase 0.

Future implementation acceptance is defined in SPEC v1.1 §24.

## 21. Unresolved Owner Decisions

| ID | Decision needed | Recommendation |
| --- | --- | --- |
| OD-1 | Approve exact logical identity contract and channel interpretation? | Approve §6 as written |
| OD-2 | Keep two automatic repair rounds as product policy for now? | Yes; do not make “2” an identity invariant |
| OD-3 | Approve five task identity classes? | Yes |
| OD-4 | Approve Memory store as non-transactional test double? | Yes |
| OD-5 | Approve deferring transaction architecture to Phase 4 with the listed design inputs? | Yes |
| OD-6 | Approve Phase 3 owner stale-resolution direction? | Yes, with reused exact-input validation |
| OD-7 | Approve start of Phase 1 implementation after these decisions? | Yes only if OD-1/OD-3/OD-8 are approved |
| OD-8 | Preserve but explicitly contract the synchronous RuleHost dual-role repair compatibility semantics? | Yes; do not keep it as an implicit lookup exception |

## 22. References

### Source evidence

- `packages/principles-core/src/runtime/internalization/successor-lookup.ts:1-261`
- `packages/principles-core/src/runtime/internalization/successor-create.ts:25-207`
- `packages/principles-core/src/runtime/internalization/internalization-orchestrator.ts:883-1462`
- `packages/principles-core/src/runtime/internalization/revision-reopen.ts:34-345`
- `packages/principles-core/src/runtime/internalization/repair-task-identity.ts:50-140`
- `packages/principles-core/src/runtime/internalization/repair-lineage-backfill.ts:135-205`
- `packages/principles-core/src/runtime/internalization/pitask-metadata.ts:155-157,947-1002`
- `packages/principles-core/src/runtime/internalization/evaluator-runner.ts:940-1059,2155-2202,2654-2899`
- `packages/principles-core/src/runtime/internalization/owner-resolution-service.ts:323-527`
- `packages/host-runtime/src/internalization-consumer-governance.ts:194-290`
- `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:848-934,1017-1110`
- `packages/principles-core/src/runtime/store/task/sqlite-task-store.ts:63-113`
- `packages/principles-core/src/runtime/store/task/memory-task-store.ts:67-190`
- `packages/principles-core/src/runtime/store/runtime-state-manager.ts:181-184,232-235`

### Documents

- `docs/specs/PRI-1299-ROOT-CAUSE-ANALYSIS-LIFECYCLE-UNIFICATION-SPEC-v1.0.md` — historical investigation snapshot
- `docs/specs/PRI-1299-ROOT-CAUSE-ANALYSIS-LIFECYCLE-UNIFICATION-SPEC-v1.1.md` — current decision-ready revision
- `docs/specs/PRI-1299-PHASE0-SUBAGENT-INVESTIGATION-SUMMARY-v1.0.md` — evidence integration report
