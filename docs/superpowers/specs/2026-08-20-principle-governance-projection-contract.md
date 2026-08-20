# Principle Governance Projection Contract

> **Version:** 1.0 (design-frozen successor to review drafts v1.0-v1.3.2)
> **Date:** 2026-08-20
> **Status:** Phase 0 Design Frozen; implementation proceeds in the order defined in §18
> **Scope:** `packages/pd-console`
> **Product boundary:** Owner-facing interpretation of existing Runtime v2 durable facts

## 1. Decision

PD Console will expose one deterministic, per-principle governance view derived from existing durable Runtime v2 records.

The view answers:

1. What is happening?
2. Why is it happening?
3. Does the Owner need to act?

This work converges existing Console projections. It does not add a Runtime state, a governance database, an activation channel, or an autonomous decision path.

Implementation starts with the Phase 0 contracts, collector, derivation matrix, and production-path tests. UI and API work start only after the Phase 0 exit gate passes.

## 2. Product and MVP alignment

This contract improves the Owner Review step of the MVP loop:

```text
behavior evidence -> principle proposal -> owner review
-> reversible activation -> observable later behavior
```

It does not claim statistical attribution. An active principle may display its activation channel and later observed evidence, but it must not claim that it reduced errors by a percentage.

### 2.1 MVP gate

| Gate | Answer |
| --- | --- |
| `mvp-q-1-what-if-skip` | Owner continues to see candidate principles with no approval and no explanation. This blocks the existing Story A' review journey and will recur whenever internalization is still running, revising, or degraded. |
| `mvp-q-2-how-observed` | A fixed workspace fixture and Principle Detail E2E test verify the headline, reason, next action, action visibility, timeline, and degraded state. |
| `mvp-q-3-how-disabled` | `features.principle_governance_projection_v2.enabled: false` restores the existing Principle Detail, timeline, and approval experience without changing Runtime, ledger, approval, or activation records. |
| `mvp-q-4-emotional-value` | The view reduces 失控感、疲惫感、不信任感和信息过载，and creates 安心感、掌控感和清醒感. |

### 2.2 Non-goals

- No Runtime state-machine or `TransitionDecision` change.
- No governance state store, table, or persisted cache.
- No retry, restart, force activation, notification, or analytics.
- No automatic approval or activation.
- No parsing of telemetry or process logs as historical truth.
- No `derivedFromPainIds[0]` lineage fallback.
- No raw task ID, path, stack, diagnostic JSON, or LLM output in the default UI.

## 3. Existing authority boundaries

| Information | Durable authority | Console responsibility |
| --- | --- | --- |
| Principle state | Principle ledger | Validate and expose the ledger value. |
| Artifact relationship | `pi_artifacts` | Resolve the principle roots and artifact lineage. |
| Task execution | `tasks` plus validated PI metadata in `diagnostic_json` | Build the connected task graph and current frontiers. |
| Runner verdict | Validated `PITaskMetadata.runnerDecision`, with the existing validated run-output compatibility path where applicable | Normalize the durable verdict; never infer a verdict from absence alone. |
| Approval | `approvals` | Fold current approvals by artifact and channel. |
| Activation | `activations` | Fold current and historical activation records without changing ledger state. |
| Historical trajectory | Underlying ledger, task, artifact, approval, and activation records | `PrincipleTrajectoryModel` assembles timeline presentation; it is not an original fact source. |
| Owner view | `deriveOwnerGovernanceView()` | Deterministically derive presentation from validated facts. |

Runtime method return values such as `successor_created` and `blocked_missing_verdict` are not durable events. They must not be presented as historical facts.

The current `reconciliation_cursor` is only a scan cursor. It is not a per-task reconciliation history and is outside this contract.

## 4. Architecture

```text
Runtime v2 durable storage
  -> existing Console readers
  -> collectGovernanceFacts()
  -> GovernanceFactsSchema validation
  -> deriveOwnerGovernanceView()    [pure]
  -> OwnerGovernanceViewSchema validation
  -> governance API
  -> Principle Detail UI
```

There is one state-derivation function. Route handlers and React components render its result and do not reimplement state priority rules.

The collector may query existing stores and validate persisted metadata. It does not persist data, read telemetry, or call the clock after `asOf` has been supplied.

## 5. Contract vocabulary

The implementation must provide TypeBox schemas and corresponding static types for every contract below. Parsed JSON, SQLite rows, and ledger content enter as `unknown` and pass runtime validation before use.

```ts
type SchemaVersion = '1';

type GovernanceChannel =
  | 'prompt'
  | 'code_tool_hook'
  | 'defer_archive';

type LineageConfidence = 'strong' | 'weak' | 'unknown';

type SourceRefType =
  | 'principle'
  | 'artifact'
  | 'task'
  | 'run'
  | 'approval'
  | 'activation'
  | 'trajectory';

interface SourceRef {
  type: SourceRefType;
  id: string;
}

interface GovernanceFactBase {
  schemaVersion: SchemaVersion;
  family: string;
  sourceRef: SourceRef;
  principleId: string;
  artifactId?: string;
  taskId?: string;
  lineageKey?: string;
  lineageConfidence: LineageConfidence;
  revisionIdentity?: RevisionIdentity;
  occurredAt?: string;
  recordedAt: string;
}
```

All IDs are non-empty strings. All timestamps are validated ISO timestamps. Missing or invalid required timestamps reject the fact and add a collection issue.

An invalid optional `occurredAt` is omitted and reported as degraded. It is never replaced with the current time.

## 6. Durable facts

### 6.1 Principle fact

```ts
type PrincipleStatus =
  | 'candidate'
  | 'active'
  | 'archived'
  | 'deprecated'
  | 'probation';

interface PrincipleFact extends GovernanceFactBase {
  family: 'principle';
  state: PrincipleStatus;
}
```

The source reference is `{ type: 'principle', id: principleId }`. `recordedAt` comes from the validated ledger `updatedAt`; `createdAt` is allowed only as an explicit compatibility fallback and adds a data-quality issue.

### 6.2 Task fact

```ts
type GovernanceTaskKind =
  | 'dreamer'
  | 'philosopher'
  | 'scribe'
  | 'artificer'
  | 'evaluator'
  | 'rollout_reviewer';

type GovernanceTaskStatus =
  | 'pending'
  | 'leased'
  | 'succeeded'
  | 'retry_wait'
  | 'failed'
  | 'needs_human_review';

interface CompletionIntentFact {
  status: 'pending' | 'applied';
  revisionEpoch: number;
  effect: 'governance_transition' | 'needs_human_review';
}

interface TaskFact extends GovernanceFactBase {
  family: 'task';
  taskKind: GovernanceTaskKind;
  channel: GovernanceChannel;
  status: GovernanceTaskStatus;
  leaseExpiresAt?: string;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCategory?: PDErrorCategory;
  completionIntent?: CompletionIntentFact;
}
```

`PDErrorCategory` and its TypeBox schema are imported from the canonical Runtime v2 error-category contract. Raw `last_error` text is not copied into Owner-facing fields.

When persisted `completionIntent.effect` is absent, the collector normalizes it to `governance_transition`. If a completion intent exists, `revisionEpoch` must be a non-negative integer.

### 6.3 Runner verdict fact

```ts
interface RunnerVerdictFact extends GovernanceFactBase {
  family: 'runner_verdict';
  runnerKind: 'evaluator' | 'rollout_reviewer';
  outcome:
    | 'approved'
    | 'approve_rollout'
    | 'needs_revision'
    | 'rejected'
    | 'reject';
}
```

The runner verdict must come from a validated durable source associated with the same task. LLM-produced lineage fields are never authoritative.

### 6.4 Approval fact

```ts
interface ApprovalFact extends GovernanceFactBase {
  family: 'approval';
  approvalId: string;
  artifactId: string;
  channel: GovernanceChannel;
  outcome: 'pending' | 'approved' | 'rejected' | 'cancelled';
}
```

The fact is strong only when its artifact belongs to strong artifact lineage for this principle.

### 6.5 Activation fact

```ts
interface ActivationFact extends GovernanceFactBase {
  family: 'activation';
  artifactId: string;
  activationId: string;
  channel: GovernanceChannel;
  outcome: 'active' | 'deactivated';
  activatedAt: string;
  deactivatedAt?: string;
}
```

`outcome` is `active` when the persisted `deactivated_at` is null. It is `deactivated` when a valid `deactivated_at` exists.

Activation refusal or failure is not persisted in the activation table and therefore is not an `ActivationFact`.

### 6.6 Revision identity

```ts
type RevisionIdentity =
  | {
      kind: 'evaluator_repair';
      sourceEvaluatorTaskId: string;
      sourceArtificerArtifactId: string;
      repairIteration: number;
    }
  | {
      kind: 'rollout_reopen';
      causeId: string;
      sourceRolloutTaskId: string;
      sourceArtifactId: string;
      revisionIteration: number;
      taskRevisionEpoch?: number;
    }
  | { kind: 'none' };
```

Evaluator repair identity is the tuple `(sourceEvaluatorTaskId, sourceArtificerArtifactId, repairIteration)`. No synthetic persisted `causeId` is claimed.

Rollout reopen uses the persisted revision cause and rollout payload. Missing required identity fields downgrades or rejects the related task fact; it never creates a guessed revision.

### 6.7 Derived relationship fact

```ts
interface DerivedRelationFact extends GovernanceFactBase {
  family: 'derived_relation';
  relation:
    | 'successor_present'
    | 'revision_materialized'
    | 'revision_pending'
    | 'verdict_missing';
  evidenceRefs: SourceRef[];
}
```

A derived relationship is not a Runtime event. It is a deterministic relationship reconstructed from durable evidence:

| Relation | Required evidence |
| --- | --- |
| `successor_present` | A strong dependency-graph edge from a strong source task to a strong successor task. |
| `revision_materialized` | A validated evaluator repair payload identifying an existing repair task, or a rollout revision identity identifying an existing reopened task. |
| `revision_pending` | A durable pending completion intent with no matching materialized revision relationship. |
| `verdict_missing` | A succeeded evaluator or rollout-reviewer task with neither a durable validated `runnerDecision` nor a verdict from the existing validated run-output compatibility path. |

Absence of a successor alone does not prove `verdict_missing`.

## 7. Governance facts aggregate

```ts
interface GovernanceFacts {
  schemaVersion: SchemaVersion;
  principleId: string;
  asOf: string;
  lineage: LineageContext;
  principle: PrincipleFact;
  tasks: TaskFact[];
  runnerVerdicts: RunnerVerdictFact[];
  derivedRelations: DerivedRelationFact[];
  approvals: ApprovalFact[];
  activations: ActivationFact[];
  timelineEvents: TimelineEvent[];
  collectionIssues: DataQualityIssue[];
}
```

`asOf` is supplied once by the request boundary and validated. The collector and derivation function use the same value.

## 8. Canonical lineage

### 8.1 Root and graph construction

1. Query `pi_artifacts` where `source_principle_id = principleId`.
2. Treat those artifacts as strong roots after validating every row and `lineage_artifact_ids` element.
3. Enter the task graph through each root artifact's `source_task_id`.
4. Parse PI metadata as `unknown` and validate it before reading `dependencyTaskIds`, `channel`, or revision fields.
5. Build forward and reverse adjacency maps from validated dependency edges.
6. Traverse only the connected component rooted at the confirmed artifact tasks.
7. Use a visited set, deduplicate IDs, reject self-edges, report cycles, and enforce a bounded node count.
8. Use `correlationId` only as a consistency check. It is never a global root or a fallback search key.

The Phase 0 implementation sets the node bound using the existing internalization-chain limit or, if none exists, a local defensive limit covered by an overflow test. The bound does not change Runtime behavior.

### 8.2 Pre-artifact principles

When no `PIArtifact.sourcePrincipleId` root exists:

- `LineageContext.confidence` is `unknown`.
- Only the validated ledger state is current.
- Process, automation, approval action, and activation conclusions are withheld.
- Data quality includes `lineage_not_available`.
- The collector does not use `derivedFromPainIds[0]` as a fallback.

### 8.3 Fact-level confidence

| Fact | Strong condition |
| --- | --- |
| Principle | Validated ledger record for the requested principle. |
| Artifact | `sourcePrincipleId` exactly matches the requested principle, or validated artifact lineage connects it to a strong root. |
| Task | The task is connected to a strong root through validated task or artifact edges. A revision task must also pass its revision-identity validation. |
| Runner verdict | Its source task is strong and the durable verdict is valid for that task kind. |
| Approval | Its artifact is strong. |
| Activation | Its artifact is strong. |
| Derived relationship | Every identity-bearing evidence reference required by the relationship is strong. |

Weak facts may appear in the timeline and must add a data-quality issue. They cannot change current process, automation, attention, summary, activation, or action visibility.

Unknown facts are excluded from current-state derivation. They may be counted only in data-quality diagnostics.

The aggregate `LineageContext.confidence` summarizes the graph and never grants authority to an individual fact.

```ts
interface LineageContext {
  principleId: string;
  artifactIds: string[];
  taskIds: string[];
  revisionIdentities: RevisionIdentity[];
  confidence: LineageConfidence;
  sourceRefs: SourceRef[];
}
```

## 9. Current task frontiers

Current automation is derived from graph frontiers rather than every historical task.

1. Partition strong task facts by `(lineage root, channel)`.
2. A frontier task has no strong, non-stale successor in its partition.
3. Tasks behind a frontier are historical and affect only the timeline.
4. A newer strong successor makes an older failure stale.
5. Multiple frontier tasks are allowed for independent channels or artifact branches.
6. Cycles or ambiguous maximal nodes degrade the affected partition and cannot create Owner actions.

Task freshness follows graph authority first, then revision identity, then validated `recordedAt`. Timestamp order alone never crosses unrelated branches.

## 10. Owner governance view

```ts
interface PrincipleState {
  value: PrincipleStatus;
  sourceRefs: SourceRef[];
}

interface ProcessView {
  stage?:
    | 'generating'
    | 'reviewing'
    | 'revising'
    | 'approval'
    | 'activation';
  currentTaskKind?: GovernanceTaskKind;
  sourceRefs: SourceRef[];
}

interface AutomationView {
  state: 'idle' | 'queued' | 'running' | 'retry_scheduled' | 'stalled';
  sourceRefs: SourceRef[];
}

interface AttentionItem {
  kind: 'owner_decision' | 'recovery';
  reasonCode: string;
  sourceRef: SourceRef;
}

interface AttentionView {
  primary: 'none' | 'owner_required' | 'recovery_required';
  items: AttentionItem[];
}

interface ActivationSummary {
  state: 'none' | 'active' | 'partially_active' | 'deactivated';
  channels: GovernanceChannel[];
  observedChannels: GovernanceChannel[];
  sourceRefs: SourceRef[];
}

interface OwnerGovernanceSummary {
  headlineCode: string;
  reasonCode: string;
  nextActionCode: string;
  ownerActionRequired: boolean;
  safeReasonSummary?: string;
  sourceRefs: SourceRef[];
}

interface OwnerGovernanceView {
  schemaVersion: SchemaVersion;
  principleId: string;
  asOf: string;
  summary: OwnerGovernanceSummary;
  principleState: PrincipleState;
  process: ProcessView;
  automation: AutomationView;
  attention: AttentionView;
  activationSummary: ActivationSummary;
  timeline: TimelineEvent[];
  sourceRefs: SourceRef[];
  dataQuality: DataQuality;
}
```

Every derived section carries the exact supporting references. Top-level `sourceRefs` is the stable, deduplicated union.

## 11. Deterministic state derivation

### 11.1 Per-frontier automation

Only strong frontier tasks enter this matrix.

| Frontier condition | Automation | Attention |
| --- | --- | --- |
| No frontier task | `idle` | none |
| `pending` | `queued` | none |
| `leased` and `leaseExpiresAt > asOf` | `running` | none |
| `leased` with missing, invalid, or expired lease | `stalled` | no Owner action; add data-quality issue |
| `retry_wait` | `retry_scheduled` | none |
| `succeeded` with pending completion intent | `running` | none |
| `succeeded` with a strong successor | Derive from the successor frontier | none from this predecessor |
| `succeeded` with expected revision and no pending intent or materialized revision | `stalled` | recovery required |
| `failed` with a newer strong successor | Historical only | none |
| Current `failed` with no strong successor | `stalled` | recovery required |
| Current `needs_human_review` | `stalled` | recovery required |

A snapshot cannot contain the same task as both `leased` and `retry_wait`. After recovery persists `retry_wait`, the next request derives `retry_scheduled`.

### 11.2 Automation aggregation

For multiple current frontiers, choose the display automation in this order:

```text
running > retry_scheduled > queued > stalled > idle
```

This priority describes system activity, not attention severity. Recovery items from other branches remain visible in `attention.items`.

`AutomationView.sourceRefs` includes every frontier that contributes the selected state and every frontier that contributes a retained recovery item.

### 11.3 Process stage

The process stage is selected from the highest-authority current fact:

| Evidence | Stage |
| --- | --- |
| Current dreamer/philosopher/scribe/artificer task without revision identity | `generating` |
| Current evaluator/rollout-reviewer task without revision identity | `reviewing` |
| Current task with verified revision identity, or pending/materialized revision relationship | `revising` |
| Strong current pending approval | `approval` |
| Strong activation exists and no newer active internalization branch exists | `activation` |

When branches disagree, Owner attention determines the summary. `ProcessView.sourceRefs` retains all current branch evidence.

### 11.4 Approval and attention

Approvals are grouped by `(artifactId, channel)`. Only approvals attached to strong artifacts participate.

Within a group, choose the record with the latest valid `decidedAt ?? requestedAt`, with `approvalId` as the stable tie-breaker.

A strong current `pending` approval creates an `owner_decision` item. Rejected, cancelled, superseded, weak, and unknown approvals do not create an action.

Attention priority is:

```text
owner_required > recovery_required > none
```

Invariants:

- `primary = none` iff `items` is empty.
- `primary = owner_required` requires at least one strong `owner_decision` item.
- `primary = recovery_required` requires at least one strong `recovery` item and no Owner decision item.
- All items remain present even when only one determines `primary`.
- `summary.ownerActionRequired` is true iff `attention.primary` is not `none`.

### 11.5 Activation folding

Activation records are grouped by `(artifactId, channel)`. The active state of a record is determined by `deactivatedAt`, not by ledger status.

For each group:

1. Validate all timestamps.
2. Order by `activatedAt`, then `activationId`.
3. The latest legal record is current for the group.
4. A current record with no `deactivatedAt` is active.
5. A current record with `deactivatedAt` is deactivated.

Aggregate all strong artifacts belonging to the principle:

| Condition | Summary |
| --- | --- |
| No durable activation record | `none` |
| Every current observed group is active | `active` |
| Some current groups are active and some are deactivated | `partially_active` |
| Historical records exist and no current group is active | `deactivated` |

`channels` lists current active channels. `observedChannels` lists all validated historical channels.

Ledger state and activation state remain independent. `ledger=candidate` with an active activation adds `ledger_activation_mismatch`; it does not overwrite either value.

### 11.6 Owner summary

The summary is derived from the final view in this order:

1. Owner decision required.
2. Recovery required.
3. Automatic revision running or retry scheduled.
4. Other current processing.
5. Active activation.
6. Ledger-only or degraded state.

The implementation defines finite code registries for `headlineCode`, `reasonCode`, and `nextActionCode`. Every code must exist in all Console locale files and be covered by schema and UI tests.

The first Phase 0 implementation omits `safeReasonSummary` unless its source is one of the existing Owner-facing approval fields:

- `summary`
- `triggerReason`
- `effectDescription`

Any included summary is bounded and redacted. Raw diagnostic JSON, runner payloads, paths, stacks, and LLM text are not used.

## 12. Timeline

```ts
type TimelineEventCode =
  | 'pain_created'
  | 'candidate_generated'
  | 'review_started'
  | 'revision_requested'
  | 'revision_reopened'
  | 'approved'
  | 'rejected'
  | 'activated'
  | 'deactivated'
  | 'failed'
  | 'human_review';

interface TimelineEvent {
  code: TimelineEventCode;
  occurredAt?: string;
  recordedAt: string;
  summaryCode: string;
  sourceRef: SourceRef;
  lineageConfidence: LineageConfidence;
}
```

`PrincipleTrajectoryModel` is enhanced to assemble these events from durable sources. It does not parse its existing human-readable `summary` or `detail` strings back into facts.

Sort ascending by:

```text
effectiveTime = valid occurredAt ?? recordedAt
effectiveTime
sourceRef.type
sourceRef.id
code
```

Invalid optional `occurredAt` falls back to valid `recordedAt` and adds a data-quality issue. Invalid or missing `recordedAt` rejects the event.

Weak events may appear with a degraded marker. Unknown events are omitted from the Owner timeline and counted in data-quality diagnostics.

An activation row with `deactivatedAt` produces both an `activated` event at `activatedAt` and a `deactivated` event at `deactivatedAt`.

## 13. Data quality and trust boundary

```ts
type DataQualitySource =
  | 'ledger'
  | 'artifact'
  | 'task'
  | 'approval'
  | 'activation'
  | 'trajectory'
  | 'lineage';

interface DataQualityIssue {
  source: DataQualitySource;
  reasonCode: string;
  nextActionCode: string;
  sourceRef?: SourceRef;
}

interface DataQuality {
  degraded: boolean;
  issues: DataQualityIssue[];
}
```

Invariant:

```text
dataQuality.degraded === (dataQuality.issues.length > 0)
```

Required minimum reason codes include:

- `lineage_not_available`
- `lineage_conflict`
- `lineage_cycle`
- `lineage_limit_exceeded`
- `metadata_malformed`
- `timestamp_invalid`
- `ledger_activation_mismatch`
- `lease_expired_unrecovered`
- `source_unavailable`

Every degradation includes a next-action code. No catch block converts source failure into a valid empty state without recording an issue.

Runtime-contract application:

| Rule | Requirement |
| --- | --- |
| `rc-1-treat-as-unknown` | JSON, ledger records, SQLite values, and artifact metadata enter validators as `unknown`. |
| `rc-2-no-as-bypass` | No `as` cast substitutes for runtime validation. |
| `rc-3-fail-loud-missing` | Missing required IDs, statuses, and timestamps reject the fact and create an issue. |
| `rc-4-validate-array-elements` | Every dependency ID, artifact lineage ID, and source reference is element-validated. |
| `rc-5-object-hasown-not-in` | Metadata readers use `Object.hasOwn()` for untrusted keys. |
| `rc-6-lineage-consistency` | Identity-bearing fields come from the same connected source graph; mismatch tests are mandatory. |
| `rc-7-loop-state-freshness` | Only current graph frontiers and verified revision identities affect current state. |
| `rc-8-safe-serialization` | Owner summaries are bounded and redacted; raw unknown values are never stringified for UI. |
| `rc-9-no-silent-fallback` | Every degraded source produces a reason and next action. |

Relevant Error Handbook controls:

- **ERR-001 — untrusted JSON cast bypasses runtime validation:** all collector boundaries use runtime schemas.
- **ERR-002 — silent catch-and-degrade:** all degradation enters `DataQualityIssue` with a next action.
- **ERR-004 — lineage fields sourced from different tasks:** graph facts retain paired source references.
- **ERR-008 — lineage fields not checked against deterministic input:** fact-level confidence requires source equality and graph connectivity.
- **ERR-015 — stale repair state reused:** current state uses verified revision identities and current graph frontiers.
- **ERR-025 — isolated helper tests do not prove production defense:** route and UI tests exercise the real collector and derivation wiring.

## 14. API contract

When the feature is enabled:

```http
GET /api/v1/principles/:id/governance
```

Success returns the standard Console success envelope containing one validated `OwnerGovernanceView`.

Errors use the existing structured Console error envelope. At minimum:

- `principle_not_found`
- `governance_projection_error`
- `feature_disabled`

When the feature is disabled, the route returns the structured `feature_disabled` response. It does not return an empty view or a false zero state.

The route validates the requested principle ID, resolves the selected workspace through existing request handling, supplies one `asOf`, calls the collector, calls the pure derivation function, validates the output, and sends the response.

## 15. Feature flag and rollback

Register and consume:

```yaml
features:
  principle_governance_projection_v2:
    category: quiet
    enabled: false
    since: 2026-08-20
```

The unified `.pd/config.yaml` loader is authoritative. Registration is complete only when:

- the registry declares the flag;
- the production loader reads it;
- the API route consumes it;
- Principle Detail consumes it;
- loader, route, and UI tests exercise both values.

Flag-off restores the existing Principle Detail, timeline, and approval experience. Toggling the flag does not write or migrate Runtime, ledger, approval, or activation data.

Promotion from quiet/default-off requires explicit maintainer approval and dogfood evidence from the fixed fixture.

## 16. UI contract

Phase 1 adds one Governance Status Card to Principle Detail and enhances the existing timeline.

The card renders:

- one headline;
- one reason;
- one next action;
- whether Owner action is required;
- the current process stage when known;
- a degraded-data indication when applicable.

Approval controls are visible only for a strong current pending approval. Existing approval mutations are reused unchanged.

The default card does not expose task IDs or source references. Source references remain available to diagnostics and tests, and may later be shown behind an explicit technical-details affordance outside Phase 1.

All visible and accessibility strings use i18n keys in every supported locale.

## 17. Verification matrix

### 17.1 Table-driven derivation tests

The pure derivation suite covers at least:

| Scenario | Required result |
| --- | --- |
| Ledger only, no artifact root | Ledger state shown; lineage unknown; no action; degraded. |
| Current pending task | queued; no action. |
| Current leased task, valid lease | running; no action. |
| Current leased task, expired lease | stalled; degraded; no immediate Owner action. |
| Current retry-wait task | retry scheduled; no action. |
| Succeeded task with pending intent | running. |
| Needs revision with materialized revision task | revising; automatic processing; no recovery action. |
| Needs revision with no intent or revision task | stalled; recovery required. |
| Current failed task, no successor | stalled; recovery required. |
| Old failed task, newer strong success | old failure is timeline-only. |
| Current needs-human-review task | stalled; recovery required. |
| Strong current pending approval | Owner action required; approval stage. |
| Weak or unknown pending approval | no action; degraded. |
| Approved, rejected, and cancelled approvals | no pending action. |
| Prompt active while RuleHost revises | activation remains active; revision remains visible. |
| Active and deactivated groups | partially active. |
| Historical activation only | deactivated. |
| Ledger candidate with active activation | both values preserved; mismatch degraded. |
| Multiple branches: one running, one stalled | automation running; recovery item retained. |
| Invalid JSON, enum, ID, timestamp, or array element | invalid fact rejected; degraded with next action. |
| Lineage cycle, overflow, or conflicting identity | affected facts cannot create actions. |

Every new conditional in derivation has a case that makes each side true.

### 17.2 Collector and production-path tests

Tests must also exercise:

1. Real SQLite schemas for tasks, artifacts, approvals, and activations.
2. Valid and malformed persisted PI metadata.
3. Artifact and task graph construction in both directions.
4. The real API route with flag on and off.
5. The real Principle Detail data fetch and validator.
6. UI headline, next action, degraded state, and action visibility.
7. Existing approval wiring after projection is enabled.
8. The affected Story A BDD scenario and a new degraded/revision scenario.

Pure-function tests alone do not satisfy the merge gate.

### 17.3 Output invariants

- `attention.primary === 'none'` iff `attention.items.length === 0`.
- `ownerActionRequired === true` only when at least one strong attention item exists.
- `dataQuality.degraded === (dataQuality.issues.length > 0)`.
- Every current-state section and summary has at least one supporting source reference, except an explicitly degraded unknown state whose reference is the ledger principle.
- Top-level source references are stable and deduplicated.
- Weak and unknown facts cannot create Owner actions.
- Timeline ordering is deterministic across repeated calls with identical facts.
- `deriveOwnerGovernanceView()` performs no I/O, JSON parsing, logging, or clock access.

## 18. Implementation order and gates

### Phase 0 — contract and projection core

Deliver:

1. TypeBox schemas and static types.
2. DB-to-facts collector with runtime validation.
3. Canonical lineage graph and confidence assignment.
4. Derived relationship construction.
5. Pure `deriveOwnerGovernanceView()` implementation.
6. Exhaustive table-driven tests.
7. Collector tests against the real database schema.
8. Feature-flag registry and loader tests.

Phase 0 is complete only when every item passes. If current durable records cannot establish required strong lineage, stop and report the limitation. Do not add a Runtime store or guessed fallback under this SPEC.

### Phase 1 — Owner experience

After the Phase 0 gate passes, deliver:

1. `GET /api/v1/principles/:id/governance`.
2. Frontend response validator.
3. Governance Status Card.
4. Existing timeline enhancement.
5. i18n and accessibility strings.
6. API, UI, E2E, and affected BDD tests.

Phase 1 does not add mutations. Retry or recovery controls require a separate Owner-approved specification.

## 19. Completion criteria

The implementation is complete when:

- the feature remains quiet/default-off;
- flag-on gives a deterministic Owner view for the fixed fixture;
- the Owner can identify state, reason, next step, and required action from Principle Detail;
- no second fact source or Runtime state was added;
- current state is reproducible from durable records after process restart;
- all degraded paths include reason and next action;
- all current conclusions are traceable to source references;
- weak or unknown lineage never exposes an action;
- required package, BDD, E2E, lint, and merge verification commands pass without skipped tests.

## 20. Development handoff

This document is the single design authority for Principle Governance Projection implementation.

Earlier pasted drafts and review responses are superseded. Further design review is required only if implementation proves that a required durable fact cannot be constructed from existing storage, or if the requested solution would cross a non-goal in §2.2.

The next development artifact is an implementation plan that decomposes Phase 0 and Phase 1 into small, verifiable changes. It must not reopen settled product or architecture decisions.
