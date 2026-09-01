# Pain Evidence Ingress Contract SPEC

**Status:** Draft rev 2 — Owner review and implementation authorization required  
**Date:** 2026-09-01  
**Issue:** PRI-642  
**Base evidence:** `8a5001eb`  
**Extends without replacing:** `2026-08-28-codex-governance-closure-spec.md`

## 1. Review corrections in rev 2

Independent Standards and Specification reviews found that rev 1 was directionally
correct but not implementation-safe. Rev 2 corrects the following:

1. separates the bounded PRI-642 closure from later cross-emitter convergence;
2. preserves canonical pain identity ownership instead of accepting a caller-made
   canonical ID at the shared boundary;
3. preserves Codex root-session, rollout, observation and turn lineage instead of
   reducing it to one session ID;
4. keeps an Owner report as report context, not fabricated trajectory evidence;
5. preserves legacy top-level `diagnosticJson` fields while adding a versioned
   namespace for re-entry;
6. models execution status, aggregate progress and per-candidate outcomes
   independently;
7. reports the new persisted payload contract honestly in Complexity Delta.

## 2. Decision

Implementation SHALL proceed in two independently reviewable scopes.

### 2.1 Scope A — PRI-642 closure, mandatory

Close the verified production defect with the smallest coherent change:

1. establish one authenticated OpenClaw session transport for the installed
   `pd-pain-signal` workflow;
2. make the existing `/pd-pain` host command attach validated evidence from its
   current session;
3. make `pd pain record --session <id>` validate the requested session and derive
   host binding consistently;
4. make external CLI use without a session explicitly unbound, remove placeholder
   trajectory evidence, and return a structured warning and next action;
5. make operator success depend on admitted/ledgered progress, not merely generated
   candidates.

Scope A SHALL NOT wait for Codex or every automatic OpenClaw emitter to migrate.

### 2.2 Scope B — systemic convergence, separately gated

After Scope A is verified, deepen the existing host-runtime governance admission
into one shared **Pain Evidence Ingress** contract. OpenClaw, Codex and CLI are
real adapters, but Codex migration is allowed only after parity tests prove that
its frozen rollout and observation lineage is preserved.

The shared ingress SHALL validate origin, host-context correlation and evidence;
delegate canonical identity and write-side orchestration to existing authorities;
persist re-entry facts; fail or degrade before LLM execution when required; and
return unambiguous progress.

Scope B is a correctness convergence, not a new pipeline, store, lifecycle,
scheduler or general-purpose memory system.

## 3. Verified current state

### 3.1 PRI-642 is reproduced

The published OpenClaw skill invokes `pd pain record` without `--session`. The CLI
substitutes `cli` and the evidence builder returns a non-empty “No session context
available” placeholder. Diagnosis therefore runs without the real trajectory.

Read-only production database verification on 2026-09-01 showed:

- the unbound pain is persisted against session `cli`, whose trajectory contains
  zero user turns, zero assistant turns and zero tool calls;
- its four linked candidates remain `pending`, all at confidence `0.45`;
- the same report bound to the real OpenClaw session produced four consumed
  candidates at confidence `0.62` and downstream internalization tasks.

The live database continues to receive events, so exact turn/tool counts are not
a stable contract. The causal contrast is session/evidence binding, not a fixed
count.

### 3.2 Precise failure semantics

The pain is not physically deleted: it is persisted and diagnosis completes, but
candidate admission stalls. This is an automatic-workflow loss, not raw-data loss.

The current skill checks candidate and ledger IDs, not an explicit `succeeded`
field. The CLI degraded path also exits non-zero. Rev 2 therefore does not repeat
the stronger claim that candidate IDs alone always produce a false success. The
verified usability defect is that the official default path omits session evidence
and does not explain the resulting degradation early enough.

### 3.3 Existing mechanisms that must be reused

- `/pd-pain` already receives `SessionAwareCommandContext.sessionId` and rejects a
  missing session, but currently submits no trajectory evidence.
- `PainToPrincipleService` is the existing core-owned write-side facade.
- `PainSignalBridge` already persists top-level `sourcePainId`, `sessionIdHint`,
  `provenance` and `evidence` in `diagnosticJson`.
- current context assemblers and trajectory locators read those top-level fields.
- `@principles/host-runtime` already owns Codex governance admission and production
  evidence normalization, including canonical identity and reconciliation.
- candidate admission already returns per-candidate `admissionResults`.

## 4. Goals

1. Make the official OpenClaw manual-pain path default-correct and test it from the
   installed skill boundary to the diagnostic task.
2. Make unavailable context explicit before expensive or misleading work.
3. Prevent origin, binding, lineage and evidence facts from contradicting each
   other at runtime.
4. Preserve authority through retry/re-entry without sentinel defaults.
5. Tell the Owner where each candidate stopped.
6. Converge duplicated emitter coordination only after the bounded fix is green.

## 5. Non-goals

- No general session-memory or transcript duplication.
- No new database, table, background worker, task lifecycle or durable authority.
- No admission-threshold reduction.
- No autonomous Principle approval or activation.
- No broad Gate A/Gate B retirement.
- No destructive rewrite or automatic repair of historical pending records.
- No new runtime feature flag solely for this correction.
- No guarantee that an unbound Owner report produces admitted candidates.

Historical data repair requires a separate issue and the data-cleanup process.

## 6. Authority and ownership

| Fact or behavior | Authoritative owner |
|---|---|
| Manual pain identity | existing OpenClaw/CLI `manual_*` ID generator; currently also the canonical pain ID |
| Automatic observation identity | originating host adapter/observation store |
| Automatic canonical pain identity and reconciliation | existing production identity/admission owner |
| Pure candidate admission | `@principles/core` existing admission gate |
| Pain write-side orchestration and diagnostic task creation | existing `PainToPrincipleService` / `PainSignalBridge` |
| Host correlation and evidence normalization | host adapter, validated by host-runtime ingress |
| OpenClaw session/trajectory acquisition | OpenClaw adapter |
| Codex rollout/observation acquisition | Codex adapter and existing observation store |
| Diagnostic retry facts | existing task payload/store |
| Candidate, ledger and internalization lifecycle | existing core services and stores |

The ingress SHALL NOT mint a second canonical ID or own task persistence. For a
manual report it validates and passes through the current manual pain ID; for an
automatic observation it delegates derivation/reconciliation to the existing
identity owner. `@principles/core` SHALL gain no unregistered I/O.

## 7. Scope A contract — PRI-642 closure

### 7.1 G0: prove the OpenClaw session transport

Before implementation, record which authenticated mechanism carries the current
OpenClaw session into the official installed skill path.

Accepted mechanisms, in preference order:

1. reuse the existing `/pd-pain` host command for Owner-direct invocation;
2. pass the host-provided session through an existing trusted command/tool context;
3. add one bounded host-to-command transport only if repository and OpenClaw
   runtime evidence show no existing mechanism is available.

The skill SHALL NOT invent, search heuristically for, or ask the model to guess a
session ID. If an agent-invoked skill cannot obtain authenticated session context,
it SHALL refuse the host-bound claim and direct the Owner to `/pd-pain` or to an
explicit `pd pain record --session <id>` invocation.

G0 completes only when an install-layout test proves the published skill follows
the chosen transport and a real OpenClaw test proves the submitted task contains
the same session.

### 7.2 Existing `/pd-pain` command

`handlePainReportCommand` SHALL reuse its validated `sessionId` and the existing
OpenClaw trajectory readers. The current `buildTrajectoryEvidence` array API is
already consumed by automatic emitters and encodes unavailable/empty states as
sentinel entries. Scope A SHALL add a typed acquisition API that returns the
discriminated available/unavailable result and use it from `/pd-pain`.

The existing array API remains a compatibility wrapper during Scope A so automatic
emitters do not change accidentally. Scope B migrates those consumers one family
at a time and removes the wrapper only when searches and tests prove it unused.
The command submits consistent provenance, host kind and validated evidence;
missing or empty evidence is surfaced rather than counted as trajectory evidence.

### 7.3 CLI with explicit session

`pd pain record --session <id>` SHALL query the selected workspace trajectory
database before LLM execution:

- nonexistent session → fail with `session_not_found`, no task/candidate mutation;
- database unavailable or unreadable → fail/degrade with a structured reason and
  next action, no placeholder;
- session exists but has no usable evidence → explicit `empty_trajectory` result;
- usable session evidence → submit as bound to that session.

The CLI SHALL derive provenance from the validated result; it SHALL not always
write `owner_reported_no_host_trace` when a real session was supplied.

### 7.4 External CLI without session

An explicit external Owner report without `--session` remains allowed. Its reason
is report context, not trajectory/root-cause evidence. The call SHALL:

- omit the sentinel session `cli` from new writes;
- persist explicit unbound provenance in the diagnostic task compatibility fields;
- skip the trajectory `sessions`/`pain_events` write because that schema requires a
  real non-null session; surface the skipped projection as an observability warning;
- pass no fabricated evidence entry;
- disclose `context_unbound` and recommend `--session` for trace-backed diagnosis;
- allow the existing Owner-manual exception to run diagnosis, while making clear
  that admission may still require evidence.

## 8. Scope B contract — shared ingress

### 8.1 Correlation is a discriminated union

The semantic shape below is normative; final names may follow repository
conventions. Runtime validation is mandatory.

```ts
type PainOrigin =
  | {
      kind: 'owner_manual';
      channel: 'openclaw_command' | 'cli_explicit_session' | 'external_cli_unbound';
    }
  | { kind: 'automatic_hook'; source: string };

type PainCorrelation =
  | {
      status: 'bound';
      hostKind: 'openclaw';
      sessionId: string;
      traceId?: string;
    }
  | {
      status: 'bound';
      hostKind: 'codex';
      rootSessionId: string;
      rolloutIdentity: string;
      logicalObservationKey: string;
      hostTurnId: string;
      traceId?: string;
    }
  | {
      status: 'unbound';
      reason: 'external_cli' | 'missing_host_session';
    };

type IngressEvidenceEntry = {
  kind: 'behavior_trace' | 'system_event';
  sourceRef: string;
  note: string;
};

type PainEvidenceBundle =
  | { status: 'available'; entries: readonly [IngressEvidenceEntry, ...IngressEvidenceEntry[]] }
  | {
      status: 'unavailable';
      reason:
        | 'trajectory_unavailable'
        | 'session_not_found'
        | 'empty_trajectory'
        | 'evidence_read_failed'
        | 'evidence_invalid';
    };

interface PainIngressReport {
  identity:
    | { kind: 'manual_pain_id'; painId: string }
    | { kind: 'host_observation'; observationId: string };
  painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
  source: string;
  reason: string;
  score?: number;
  origin: PainOrigin;
  correlation: PainCorrelation;
  evidence: PainEvidenceBundle;
}
```

For manual paths, the current adapter-generated `manual_*` ID remains the canonical
pain ID and is validated/passed through. For automatic paths, `observationId` is a
physical identity and the existing identity owner derives or reconciles
`canonicalPainId`. Codex correlation SHALL not be flattened to `sessionId`.

Owner report text remains `reason`. It SHALL not be inserted into `entries` merely
to make evidence non-empty. Only validated trace/system-event entries contribute
to input evidence count.

### 8.2 Valid-combination matrix

| Origin | Correlation | Evidence | Decision before LLM |
|---|---|---|---|
| Owner manual / OpenClaw command | matching OpenClaw bound | available | submit |
| Owner manual / OpenClaw command | bound | unavailable | explicit degrade/refuse; no false context-bound success |
| Owner manual / CLI explicit session | matching OpenClaw bound | available | submit |
| Owner manual / CLI explicit session | matching OpenClaw bound | unavailable | fail/degrade; do not silently downgrade |
| Owner manual / CLI explicit session | unbound | any | fail; do not silently downgrade |
| Owner manual / external CLI unbound | unbound/external_cli | unavailable | diagnosis allowed under existing manual exception; warn |
| Owner manual / external CLI unbound | any host-bound value | any | invalid origin/correlation combination |
| Automatic OpenClaw hook | matching OpenClaw bound | available | apply existing trigger/admission, then submit if admitted |
| Automatic OpenClaw hook | matching OpenClaw bound | unavailable | observation-only; no LLM |
| Automatic OpenClaw hook | unbound | any | observation-only; no LLM |
| Automatic Codex hook | complete Codex bound | available | preserve existing Codex admission contract |
| Automatic Codex hook | incomplete/mismatched lineage | any | fail/degrade before persistence or LLM |
| Any | lineage identifiers from mixed events | any | fail `lineage_mismatch` |

Binding failure and evidence failure are separate axes. For example, a real session
with an unreadable trajectory is `bound + unavailable/trajectory_unavailable`, not
`unbound`.

### 8.3 Legacy provenance

Adapters SHALL not supply provenance independently. The ingress derives legacy
values for compatibility:

- valid host-bound report → `host_context_bound` plus `hostKind`;
- external Owner report → `owner_reported_no_host_trace`;
- automatic hook → `automatic_hook`, with correlation retained separately.

Legacy `openclaw_context_bound` remains read-compatible according to the current
core normalization contract.

## 9. Persisted re-entry contract

The validated rev-2 facts SHALL be written under one versioned namespace in the
existing diagnostic task payload, for example `painIngress.v1`.

During the compatibility window, writers SHALL also preserve the existing
top-level fields consumed by production code:

- `sourcePainId`;
- `sessionIdHint`;
- `provenance` and `provenanceReason`;
- `hostKind`;
- `evidence`;
- `workspaceDir`.

The nested and top-level values SHALL be generated in one function and tested for
consistency. No consumer migration may remove a top-level field until searches,
consumer tests and a compatibility decision prove it is unused.

`executePendingDiagnosis` and retry paths SHALL parse persisted JSON as `unknown`,
validate the version, use the persisted correlation, and reject mismatches. They
SHALL NOT default missing provenance to `host_context_bound`.

Legacy tasks may use one explicit normalization branch. It SHALL not fabricate
host binding, and no bulk rewrite is required.

## 10. Result semantics

Execution state, aggregate progress and per-candidate disposition are independent:

```ts
interface PainIngressResult {
  status: 'succeeded' | 'submitted' | 'degraded' | 'failed' | 'skipped' | 'retried';
  sourceIdentity: { kind: 'manual_pain_id'; value: string } | { kind: 'host_observation'; value: string };
  canonicalPainId?: string;
  progress: {
    furthestStage:
      | 'observed'
      | 'diagnosis_submitted'
      | 'diagnosis_completed'
      | 'candidate_processing'
      | 'internalization_seeded';
    generatedCandidateIds: string[];
    admittedCandidateIds: string[];
    ledgerEntryIds: string[];
    seededTaskIds: string[];
  };
  candidateOutcomes: Array<{
    candidateId: string;
    decision: 'admitted' | 'needs_evidence' | 'deferred';
    ledgerEntryId?: string;
    seededTaskId?: string;
    reason: string;
    nextAction: string;
  }>;
  warnings: string[];
  reasonCode?: string;
  nextAction?: string;
}
```

`furthestStage` means at least one item reached that stage; it never means all
candidates did. `candidateOutcomes` is the authority for mixed results. Existing
`candidateIds`, `ledgerEntryIds`, `admissionResults` and status values may remain
as derived compatibility fields for one migration window.

CLI `--json` stdout SHALL contain exactly one documented object. Exit paths SHALL
stop mutation even when `process.exit` is stubbed.

## 11. Module boundary and migration inventory

The host-runtime ingress SHALL hide validation, correlation checks, evidence
classification, legacy-payload shaping and result shaping. It SHALL delegate
identity, task creation, candidate admission and persistence to current owners.

Scope A migration inventory:

- `templates/**/skills/pd-pain-signal/SKILL.md` and generated/published copies;
- `packages/openclaw-plugin/src/commands/pain.ts`;
- `packages/openclaw-plugin/src/hooks/trajectory-evidence.ts`;
- `packages/pd-cli/src/commands/pain-record.ts`;
- `packages/pd-cli/src/commands/build-trajectory-evidence.ts`.

Scope B SHALL inventory and characterize before migration, at minimum:

- `hooks/pain.ts`;
- `hooks/llm.ts`;
- `hooks/lifecycle.ts`;
- `hooks/gate-block-helper.ts`;
- `hooks/after-tool-call-helpers.ts`;
- `core/signal-collector-host.ts`;
- `commands/samples.ts`;
- Codex `governance-signal-admission.ts` and its observation consumers.

The ingress does not freeze a new exhaustive hook-source enum before this
inventory. No production emitter may be declared migrated solely through a
source-text assertion.

## 12. Behavioral acceptance

### 12.1 Scope A must pass

1. Installed `pd-pain-signal` workflow in a real OpenClaw session submits the exact
   current session and non-placeholder evidence into the diagnostic task.
2. `/pd-pain` passes its session and validated evidence together.
3. `pd pain record --session <real>` writes consistent bound provenance and
   evidence.
4. `--session <missing>` fails before LLM/task/candidate mutation.
5. external CLI without a session writes no `cli` trajectory session/pain row and
   no placeholder evidence; the diagnostic task remains durable and the skipped
   trajectory projection is returned with a warning/next action.
6. four generated but zero admitted candidates cannot be reported as completed
   internalization.
7. `--json` emits exactly one object and failure exits stop control flow.

### 12.2 Scope B must pass before each adapter migrates

1. automatic OpenClaw signal without evidence is observation-only with a reason;
2. gate-block with evidence submits, while gate-block without evidence does not
   silently disappear;
3. LLM signal without a session is never host-context-bound;
4. retry preserves correlation and rejects nested/top-level mismatch;
5. mixed candidate decisions remain individually observable;
6. Codex preserves root session, rollout identity, logical observation key and
   host turn through admission, retry and deduplication;
7. legacy `cli`, `unknown` and `openclaw_context_bound` reads do not fabricate new
   host-bound writes.

## 13. Verification strategy

- Negative-first regression tests for every Scope A scenario.
- Real Commander parser/registration tests for `--session` and `--json`.
- SQLite round trips for bound, unbound, missing and unreadable trajectory cases.
- Install-layout/package test for the published OpenClaw skill, not only source.
- One real OpenClaw dogfood trace from installed skill to diagnostic task and
  candidate outcomes.
- Contract tests for every row in the valid-combination matrix.
- Nested/top-level diagnostic payload consistency and retry tests.
- Per-emitter production consumer tests before Scope B migration.
- Codex frozen-fixture and consumer parity tests before any Codex change.

Temporary source-shape characterization may guard migration, but SHALL be removed
after equivalent public-boundary coverage exists. Completion requires targeted
tests and `npm run verify:merge`.

## 14. Implementation slices and gates

1. **A0 — session transport proof:** close G0; no inferred session mechanism.
2. **A1 — regression tests:** installed skill, `/pd-pain`, CLI explicit/unbound and
   result-semantics negative tests fail on current code.
3. **A2 — bounded repair:** reuse existing command/evidence/service mechanisms;
   remove sentinel and placeholder writes; update docs and published artifacts.
4. **A3 — production verification:** SQLite round trip, package smoke and dogfood.
   PRI-642 may close when A0–A3 pass.
5. **B0 — emitter inventory:** record every producer, current source, correlation,
   evidence, identity owner and production consumer.
6. **B1 — validated ingress:** add the smallest shared interface and versioned
   payload, retaining legacy fields.
7. **B2 — OpenClaw convergence:** migrate one emitter family at a time with parity.
8. **B3 — outcome/re-entry convergence:** add per-candidate progress and remove
   provenance defaults.
9. **B4 — Codex decision gate:** migrate only if frozen lineage/dedup fixtures prove
   no semantic loss; otherwise keep its existing deep module as an adapter peer.
10. **B5 — cleanup:** delete only proven-unused duplicate builders and temporary
    characterization tests.

## 15. Rollout and recovery

No new feature flag is required for Scope A. Changes are adapter-local and can be
reverted without deleting durable records. Scope B rolls out one emitter family at
a time, retaining legacy payload reads throughout the migration window.

There is no verified independent runtime switch that disables only this path: the
current pain-admission flags select Gate A versus Gate B rather than turning pain
off. Operational rollback is therefore an adapter/package revert. Rollback SHALL
preserve pending pains, candidates and tasks.

## 16. MVP questions

### `mvp-q-1-what-if-skip`

Owner corrections can be persisted but fail to enter internalization, recreating
PRI-642 and undermining PD's central product promise.

### `mvp-q-2-how-observed`

The Owner sees status, binding, candidate-level decisions, structured stop reason
and next action. SQLite evidence traces one report through existing task,
candidate, ledger and internalization records.

### `mvp-q-3-how-disabled`

No new flag. Revert the affected adapter/package version; preserve all durable
records. The SPEC does not claim that existing Gate A/B selection flags disable
pain processing.

### `mvp-q-4-emotional-value`

Reduce “my correction disappeared” and “PD claimed progress it did not make”.
Create reassurance, clarity and control by showing what was captured, what evidence
supports it and where each candidate stopped.

## 17. Complexity Delta

| Dimension | Delta | Reason |
|---|---:|---|
| New durable source of truth | NO | existing identity, task and lifecycle authorities remain canonical |
| New persisted schema/state | YES | versioned `painIngress.v1` is a new durable payload contract, though no table changes |
| New subsystem/service/background process | NO | deepen existing host-runtime admission |
| New public abstraction/interface | YES | one real seam serves three materially different adapters after Scope B gate |
| New runtime feature flag | NO | adapter-local rollout and package rollback suffice |
| New cross-package dependency | NO | affected packages already consume host-runtime |
| New host/platform-specific behavior | YES | OpenClaw session transport/evidence behavior becomes default-correct |
| New external/network capability | NO | existing local/runtime capabilities only |

For the persisted contract and public interface:

1. existing optional fields cannot enforce correlation or safe re-entry;
2. the addition hides validation, compatibility shaping and mixed-outcome logic;
3. a smaller documentation-only fix would leave every other emitter vulnerable;
4. validation, SQLite round trips, adapter parity and dogfood verify it;
5. it can be removed after reverting adapter migrations; it owns no independent
   database or canonical identity.

Host-specific behavior is bounded to using authenticated context already owned by
the host. It is verified by installed-skill and real-session tests and rolled back
per adapter.

## 18. Definition of Done

PRI-642 is complete when Scope A acceptance and A0–A3 verification pass, the
published skill is default-correct, no new `cli` sentinel/placeholder evidence is
written, and the real OpenClaw trace proves correlation.

Systemic convergence is complete only when:

- every production emitter has an explicit migration decision;
- no migrated caller can state provenance inconsistent with correlation/evidence;
- canonical identity and Codex lineage remain owned by their existing authorities;
- retry uses validated persisted facts without host-binding defaults;
- mixed candidate outcomes cannot be mistaken for completed internalization;
- targeted tests, package/install smoke, dogfood and `npm run verify:merge` pass;
- no historical governance/user data is silently deleted or rewritten.

## 19. Owner decisions

Approval authorizes Scope A implementation and its production verification.
Scope B begins with inventory and contract tests, but Codex migration requires the
B4 parity decision. Historical data repair and broad gate consolidation remain
separately authorized work.

The recommended external CLI policy is retained: unbound Owner reports are
allowed, but they are not trajectory evidence and must disclose their limitations.
