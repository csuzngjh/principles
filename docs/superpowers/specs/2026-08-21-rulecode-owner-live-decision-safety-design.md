# RuleCode Owner Live Decision and Host-Liveness Safety SPEC

> **Version:** 1.0
> **Date:** 2026-08-21
> **Status:** Owner design approved; implementation requires maintainer approval for the MVP-Core surface change
> **Scope:** `principles-core`, `openclaw-plugin`, `host-runtime`, `pd-console`, and CLI parity
> **Product boundary:** Owner-reviewed, reversible `code_tool_hook` behavior internalization

## 1. Decision

PD will add a Console-first Owner decision flow for promoting a specific RuleCode artifact from Shadow Observation to Live Enforcement.

The system may decide whether a RuleCode is safe and ready to present for review. It may never decide that the RuleCode should become live. Every shadow-to-live transition requires an explicit, authenticated, per-artifact Owner Live Decision.

This design also establishes a stronger invariant:

> One malformed, incompatible, over-broad, or failing RuleCode must not make the host's tool surface unavailable.

PD cannot guarantee that generative code will never be wrong. It must prevent known-dangerous code from entering live, make the likely impact legible to the Owner, fail open when RuleCode execution is unhealthy, and automatically isolate a live rule that threatens host liveness.

## 2. Why this is MVP-Core work

`code_tool_hook` / RuleHost is already one of the three MVP activation paths. The current lifecycle is incomplete:

```text
Owner approves generated RuleCode
  -> shadow activation exists
  -> only CLI can promote it
  -> final promotion has no Owner identity or evidence snapshot
  -> Console cannot promote, reject-after-shadow, or reliably deactivate RuleCode
```

The product identity promises Owner approval, rejection, channel selection, reversible activation, and observable later behavior. Completing that loop is not a new activation channel or a general execution subsystem.

This SPEC supersedes the earlier assumption in ADR-0014 that no additional Owner approval UI was required for shadow-to-enforce. Implementation must record that amendment through the repository's ADR process before shipping.

## 3. Incident and root cause

The motivating incident involved a live RuleCode whose executable logic did not use `recentThinking`, but whose comment mentioned `session.recentThinking`. A conservative compatibility scanner matched the comment. The production compatibility guard then returned a global deny before the RuleCode's own `evaluate()` ran, blocking the host's productive tool calls.

The rule was recoverable only after the Owner used CLI deactivation. The Console neither explained the actual blast radius nor offered the required control.

This is a runtime safety failure, not merely an Owner review failure. Owner review is the final governance gate; it must not be the only static analyzer, compatibility checker, or liveness safeguard.

## 4. Goals

1. Prevent known global-deny, wildcard-scope, incompatible, invalid, or host-liveness-breaking RuleCode from entering live.
2. Give a non-technical Owner sufficient information to approve, continue observing, or reject a shadow rule without reading TypeScript or using CLI.
3. Record the final live decision independently from the first approval that admitted the artifact into shadow.
4. Make single-rule deactivation and global emergency pause immediately available outside RuleHost.
5. Fail open and isolate the offending RuleCode on load, compatibility, timeout, exception, invalid-result, or liveness failures.
6. Preserve Console and CLI parity by routing both through the same application service and pure safety policy.
7. Preserve history, evidence, and reversibility for rejection, replacement, isolation, and deactivation.

## 5. Non-goals

- No autonomous or scheduled shadow-to-live promotion.
- No automatic restoration from Safety Isolation to Live Enforcement.
- No general account, organization, RBAC, email, SMS, or third-party notification system.
- No new activation channel or general task-execution capability.
- No claim that shadow telemetry covers all host tool calls.
- No deletion of rejected or superseded artifacts.
- No model training, probabilistic attribution, BALM, LRAS, GAP, Trainer, or MissionScheduler work.
- No support for the quiet shared runtime until it can satisfy the same shadow evidence and safety contract.

## 6. Domain vocabulary

The canonical glossary is in `packages/principles-core/CONTEXT.md`. UI and API copy must use these distinctions:

| Term | Meaning |
| --- | --- |
| Shadow Observation | Non-enforcing evidence collection. |
| Evidence Readiness | Advisory sufficiency assessment; Owner-overridable with a reason. |
| Promotion Safety Gate | Non-bypassable runtime, compatibility, scope, lineage, trace, and liveness checks. |
| Owner Live Decision | Explicit, immutable decision for one RuleCode artifact/version. |
| Live Enforcement | Reversible enforcement by an Owner-approved RuleCode. |
| Safety Isolation | Non-enforcing state after automatic circuit breaking. |
| Emergency Deactivation | Per-rule control-plane stop outside RuleHost. |
| Global Emergency Pause | Immediate suspension of all live RuleCode enforcement outside RuleHost. |

The UI must not use `active` as the primary lifecycle label because the current persistence model calls both shadow and live records active.

## 7. Lifecycle model

The durable activation record remains the activation authority. The Console derives a more precise lifecycle from activation action, deactivation, decisions, runtime support, and safety results:

```text
generated
  -> first Owner approval
  -> shadow_observing
       -> awaiting_owner_live_decision
            -> continue_observing -> shadow_observing
            -> rejected_after_shadow -> deactivated
            -> Owner Live Decision -> live_enforcing
  -> safety circuit breaker -> safety_isolated
  -> Owner deactivation -> deactivated

new artifact version
  -> shadow_observing
  -> Owner approves replacement
  -> atomically deactivate old live + activate new live
  -> old version superseded
```

Invariants:

- One Principle has at most one live RuleCode.
- A decision binds an immutable artifact/version and evidence snapshot.
- New code always requires new shadow evidence and a new Owner Live Decision.
- `continue_observing` does not change the activation mode; it records Owner, note, and optional review date.
- `rejected_after_shadow`, `superseded`, `safety_isolated`, and `deactivated` preserve history.
- Safety Isolation can only return to live through a new Owner Live Decision.

## 8. Four-layer safety model

### 8.1 Generation constraints

Generated RuleCode must declare a bounded `RuleCode Scope` containing explicit tool/action/path categories. Generated rules may not use wildcard or implicit global blocking scope. Empty scope must not degrade to match-all.

RuleCode cannot change the Host Liveness Contract or govern PD's out-of-band Console, HTTP control plane, or recovery interface.

### 8.2 Pre-shadow validation

Before an artifact can enter shadow:

- validate artifact schema and lineage as unknown data;
- compile and load in the production-equivalent sandbox;
- execute positive, negative, adversarial, unavailable-context, and neutral-control GoldenTrace cases;
- statically reject global deny, wildcard scope, empty-scope match-all, retired context symbols, forbidden APIs, and unbounded execution;
- scan executable syntax separately from comments and literals when the policy concerns executable references;
- confirm the selected host runtime can provide the declared context and shadow telemetry.

Failure is loud, produces a structured reason and next action, and creates no shadow activation.

### 8.3 Shadow recognition

For every `Eligible RuleHost Evaluation`, retain enough bounded, redacted evidence to derive:

- observed count;
- matched count;
- would-allow / would-block / require-approval / auto-correct counts;
- tool and declared-scope distribution;
- unhealthy count and reason;
- representative matched, blocked, allowed, and neutral-control examples.

The UI must say `eligible RuleHost evaluations`, never `all tool calls`.

MVP default Evidence Readiness is:

- at least 24 hours in shadow;
- at least 20 eligible evaluations;
- at least 3 matches, or an explicit explanation that the behavior is rare;
- at least one non-matching neutral-control sample;
- no unresolved unhealthy, compatibility, lineage, or liveness issue.

Time and sample thresholds are configurable advisories. The Owner may override insufficient evidence with a predefined reason and note. Safety failures are never overridable.

### 8.4 Live containment

RuleCode load failure, incompatibility, timeout, exception, invalid output, missing required context, or batch/runtime failure must fail open for the host call and emit structured unhealthy evidence.

The special retired-symbol compatibility path must not return a global deny. It isolates the incompatible RuleCode and allows the host call.

The Safety Circuit Breaker isolates a live RuleCode when any of these defaults occur:

- protected control or recovery surface is matched;
- load, compatibility, context, or result validation fails;
- three consecutive evaluation errors;
- five consecutive blocked eligible calls across at least three tools;
- more than 80% of the latest 20 eligible calls are blocked outside the Owner-approved scope;
- a neutral host-liveness probe fails.

Thresholds are versioned configuration. Circuit breaking is a safety rollback, not an autonomous value decision. It may reduce harm automatically; it may not automatically restore live.

## 9. Promotion Safety Gate

Promotion is allowed only when all hard checks pass:

1. Activation exists uniquely, is `code_tool_hook`, is shadow, and is not deactivated or superseded.
2. Artifact and activation lineage are valid and refer to the same immutable RuleCode version.
3. Declared scope is bounded and does not cover protected control/recovery surfaces.
4. Production-equivalent compile/load succeeds.
5. GoldenTrace positive, negative, adversarial, unavailable-context, and neutral-control cases pass.
6. Compatibility checks pass against the actual selected host runtime and context version.
7. Single-rule and current-live-set composition checks preserve the Host Liveness Contract.
8. Out-of-band single-rule deactivation and global pause are healthy.
9. Runtime supports shadow evidence; an unsupported shared runtime must block promotion rather than present empty evidence as safe.
10. The server has authenticated Owner identity configured.

The result is one of:

```ts
type PromotionReadiness =
  | { status: 'blocked'; hardFailures: SafetyFinding[] }
  | { status: 'insufficient_evidence'; advisories: EvidenceAdvisory[] }
  | { status: 'ready' };
```

The pure evaluator lives in `principles-core`. Data collection and host checks live at I/O boundaries.

## 10. Owner experience

### 10.1 Focus page

Add two queues:

- **待上线规则**: shadow rules ready or insufficient-but-reviewable;
- **安全告警**: safety-isolated rules, hard failures, global pause, and legacy review warnings.

Each rule card shows lifecycle, risk, evidence readiness, eligible/matched/would-block counts, hard-gate summary, and one clear next action.

### 10.2 RuleCode decision detail

The page must show:

- plain-language behavior and explicit scope;
- tools/actions that may be blocked and those guaranteed unaffected;
- eligible, matched, would-block, would-allow, unhealthy, and tool-distribution evidence;
- redacted representative samples;
- worst plausible impact;
- every hard safety check and its evidence time/version;
- evidence-readiness gaps;
- circuit-breaker conditions and emergency control status;
- exact artifact/version and lineage;
- implementation code and GoldenTrace behind progressive disclosure.

Actions:

- **继续观察**: record review note/date, stay shadow;
- **拒绝并停用**: record `rejected_after_shadow`, preserve artifact/evidence;
- **确认上线**: enabled only when hard gates pass. Evidence-insufficient promotion requires a reason and short note.

### 10.3 Live detail

Show 24-hour and 7-day eligible/matched/blocked/unhealthy/circuit-breaker metrics, tool distribution, behavior drift from the approved evidence snapshot, latest safety check, Owner Decision, and permanent emergency-deactivate placement.

Unavailable metrics must display `未采集`, never zero.

### 10.4 Global emergency control

Every authenticated Console view exposes **暂停全部 Live RuleCode** when any live rule exists. It uses a normal confirmation dialog without typed-name friction. Per-rule emergency deactivation is equally visible.

Both operations:

- execute outside RuleHost;
- take effect without host restart;
- fail open subsequent host calls;
- preserve audit and evidence;
- never bulk-resume automatically.

## 11. Authentication and authorization

MVP does not add multi-user accounts. Promotion requires existing Console token authentication plus a server-configured single Owner identity. The actor is bound by the server, never accepted from the request body.

- Authenticated Console: review, promote, reject, continue observing, deactivate, pause.
- Local no-auth Console: read, reject/deactivate, and emergency pause are allowed; promotion is disabled.
- CLI promotion: requires the configured Owner credential, records the local operator identity plus a required note, and uses the same application service and safety gate. An unauthenticated local operator may emergency-deactivate or pause but may not promote.

Audit must distinguish `configured_owner`, `console_token`, `local_no_auth_emergency`, and `cli_operator`; it must not fabricate a user ID.

## 12. Persistence

Keep activation timestamps for compatibility. Add an immutable decision log rather than overloading first-stage approvals:

```ts
interface ActivationDecisionRecord {
  decisionId: string;
  subject:
    | {
        kind: 'activation';
        activationId: string;
        artifactId: string;
        artifactDigest: string;
      }
    | { kind: 'all_live_rulecode' };
  decision:
    | 'continue_observing'
    | 'promote_live'
    | 'reject_after_shadow'
    | 'emergency_deactivate'
    | 'global_emergency_pause'
    | 'safety_isolate'
    | 'supersede';
  actorKind: 'configured_owner' | 'console_token' | 'local_no_auth_emergency' | 'cli_operator' | 'system_safety';
  actorId?: string;
  reasonCode: string;
  note?: string;
  evidenceSnapshotId?: string;
  decidedAt: string;
}
```

`promote_live` requires an immutable evidence snapshot containing artifact digest, lineage refs, host/runtime version, safety-gate results, shadow summary, configuration version, and redaction metadata.

`global_emergency_pause` requires the global subject. Every other decision requires an activation subject. Runtime validation rejects invalid decision/subject combinations.

All parsed JSON, DB rows, artifact metadata, and telemetry enter validators as `unknown`. Required malformed fields fail loud. Optional degradation emits a reason and next action.

## 13. API and application service

Console and CLI call one application service; route handlers and commands do not reproduce eligibility logic.

```text
GET  /api/v1/activations/:id/owner-review
POST /api/v1/activations/:id/continue-observing
POST /api/v1/activations/:id/promote
POST /api/v1/activations/:id/reject-after-shadow
POST /api/v1/activations/:id/emergency-deactivate
POST /api/v1/activations/emergency-pause
```

Mutating requests use idempotency keys and optimistic preconditions containing activation ID, artifact digest, readiness-evaluation ID, and evidence snapshot digest. A stale snapshot returns a conflict and requires refresh.

`promote` accepts only reason/note and confirmation metadata; actor identity comes from server context. It re-runs hard gates immediately before an atomic decision-write and state transition.

Every refused/degraded response returns structured `reasonCode`, safe summary, failed checks, and `nextAction`.

CLI JSON mode remains exactly one JSON object on stdout. The existing deactivate help contract must be authoritative; Console next-action strings must not invent unsupported `--confirm` flags.

## 14. Telemetry and privacy

MVP reuses existing `rulehost_evaluated` and unhealthy events for observed, matched, would-block, decision, tool, activation, and time-window aggregation. Add bounded fields only where required for accurate health and sample correlation:

- evaluation correlation ID;
- bounded duration;
- structured outcome/error category;
- bounded reason code;
- input/sample digest and redaction version.

Default evidence stores tool name, path category, hashes, structured summaries, and short redacted excerpts. Raw parameters do not enter general telemetry or promotion audit snapshots. A local Owner-only reveal may inspect source data without copying it into the durable decision record.

## 15. Runtime parity

The default legacy OpenClaw path is the MVP production target because it currently emits per-activation shadow decisions. The quiet shared runtime does not yet provide equivalent shadow evidence.

The review API must expose runtime capability explicitly. If `shadowEvidence=false`, promotion is hard-blocked with a next action. Shared runtime support is a separate parity slice, not an excuse to weaken the contract.

## 16. Version replacement

One Principle may have multiple historical RuleCode artifacts but at most one live version.

Approving a new version performs one transaction:

1. verify new artifact and fresh readiness snapshot;
2. append new Owner Live Decision;
3. deactivate/supersede the old live activation;
4. promote the new activation;
5. preserve both histories.

If any step fails, neither activation changes.

## 17. Legacy migration

Existing live records without actor/evidence metadata remain live and display `历史上线 / 决策人未知`. They receive a seven-day review reminder; expiry escalates the warning but does not deactivate solely for missing metadata.

Legacy rules that actually fail compatibility, global-scope, composition, or Host Liveness checks enter Safety Isolation immediately and fail open. This newer safety principle supersedes the earlier proposal to leave known-dangerous legacy rules live.

No migration fabricates Owner identity or evidence.

## 18. Feature flags and disable paths

This surfaced MVP-Core change requires maintainer approval and a registered, production-consumed flag, proposed as:

```yaml
rulecode_owner_live_decision:
  category: core
  enabled: false
  since: 2026-08-21
```

Flag off restores the existing Console presentation and does not delete decisions or activations. It must not disable emergency deactivation or global pause.

Runtime emergency controls are separate from startup-cached feature flags. Disabling a dangerous rule must not require config reload, host restart, PR revert, or a functioning host Agent.

## 19. BDD contract

Add an Owner-visible Story A feature covering real UI, API, store, and runtime wiring. Required scenarios:

1. First approval creates shadow and cannot create live.
2. Ready shadow rule is visible in Focus and decision detail.
3. Evidence-insufficient rule requires reason but may be promoted.
4. Hard safety failure disables promotion in Console and refuses CLI promotion.
5. Comment-only retired-symbol text does not create a global deny.
6. Actual incompatible executable reference isolates the rule and host calls continue.
7. Wildcard, empty-scope match-all, and global-deny artifacts cannot enter live.
8. GoldenTrace, lineage, host capability, neutral-control, and composition failures block promotion.
9. Promotion persists an independent Owner decision and evidence snapshot.
10. Reject-after-shadow deactivates without deleting evidence.
11. Continue-observing records review intent without leaving shadow.
12. New version atomically replaces the old live version.
13. Per-rule emergency deactivation and global pause work without RuleHost or restart.
14. Circuit breaking isolates one rule, fails open, and never auto-reactivates.
15. Shared runtime without shadow telemetry cannot promote.
16. Legacy unknown-actor rules are reviewable; known liveness failures isolate.
17. Console and CLI use identical safety results and cannot bypass one another.

## 20. Acceptance criteria

- Replaying the reported `recentThinking` comment incident cannot block a host call.
- Any RuleCode load, timeout, exception, invalid result, or compatibility failure fails open.
- A single or composed rule set cannot govern protected recovery/control surfaces.
- No RuleCode becomes live without an immutable Owner Live Decision for its exact artifact digest.
- Owner can complete review, promotion, rejection, and deactivation without CLI.
- Owner can understand scope, examples, worst impact, safety results, readiness gaps, and recovery path without reading code.
- Hard failures cannot be overridden by Console, CLI, direct route choice, or stale evidence.
- Emergency per-rule and global controls take effect without RuleHost and without restart.
- Decision, override, rejection, isolation, deactivation, replacement, and pause actions are auditable.
- Missing telemetry is shown as unavailable, not zero.

## 21. MVP four questions

| Gate | Answer |
| --- | --- |
| `mvp-q-1-what-if-skip` | A generated RuleCode can again disable the host's productive tool surface, and ordinary Owners remain dependent on CLI recovery. This is release-blocking trust damage and will recur within 30 days. |
| `mvp-q-2-how-observed` | Owner-visible Focus, decision, live-monitoring, isolation, and emergency-control BDD scenarios plus the incident regression demonstrate the behavior. |
| `mvp-q-3-how-disabled` | Surfaced review UI is flag-controlled; per-rule deactivation and global pause remain available; runtime containment is reversible without PR revert. |
| `mvp-q-4-emotional-value` | Reduces 失控感、不信任感、疲惫感和信息过载; creates 安心感、掌控感、清醒感 and 沉淀感 through legible evidence, explicit authority, fail-open containment, and immediate recovery. |

The repository's referenced `docs/product/emotional-value.md` is currently absent. This assessment uses the canonical emotional-value promise retained in `PRODUCT_IDENTITY.md`; the missing canonical document should be restored separately rather than silently invented here.

## 22. Delivery slices

1. **Contract and incident regression:** lifecycle/readiness/safety schemas, pure gate, compatibility fix, fail-open tests.
2. **Decision audit:** immutable decision and evidence-snapshot store, migrations, identity binding, atomic promotion/replacement.
3. **Runtime containment:** protected control plane, per-rule isolation, circuit breaker, immediate per-rule/global pause.
4. **Shadow read model:** validated aggregation, redaction, samples, readiness and runtime capability.
5. **Console flow:** Focus queues, decision detail, live monitoring, confirmations, emergency controls.
6. **CLI parity and legacy migration:** same service/gates, strict JSON, accurate next actions, legacy review/isolation.
7. **Production BDD and rollout:** default-runtime E2E, feature flag consumption, dogfood, rollback drill.

Each slice must ship with a user-visible observation path and a non-PR-revert disable path. The first deploy keeps promotion UI disabled until the incident regression, hard gates, emergency controls, and audit path all pass together.

## 23. Prototype references

- Figma skeleton: https://www.figma.com/design/2khF5MvuhVkZSZjSS5jjG1
- Static queue prototype: `01-queue.png`
- Static decision prototype: `02-decision.png`
- Static live prototype: `03-live.png`

The Figma Starter plan hit its MCP write-call limit after the three screen wrappers were created. The static prototypes are the current visual authority until the editable Figma screens are completed.

## 24. Remaining approval gate

The Owner product decisions in this SPEC are settled. No silent product decision remains.

Before implementation begins, the maintainer must explicitly approve:

1. surfacing `rulecode_owner_live_decision` as MVP-Core;
2. amending the conflicting ADR-0014 UI assumption;
3. the bounded single-Owner token identity model;
4. the implementation slices and rollout order above.
