# RuleCode Owner Live Decision and Host-Liveness Safety SPEC

> **Version:** 1.0
> **Date:** 2026-08-21
> **Status:** Owner and maintainer approved; ADR-0014 amendment is the implementation authorization
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

This SPEC supersedes the earlier assumption in ADR-0014 that no additional Owner approval UI was required for shadow-to-enforce. The 2026-08-21 ADR-0014 amendment records that authorization and the bounded MVP-Core scope.

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

The host adapter must provide this minimum contract before promotion is available:

```ts
interface HostLivenessContract {
  version: string;
  outOfBandControls: ReadonlyArray<
    'activation_deactivate' | 'global_rulecode_pause' | 'owner_review_console'
  >;
  protectedCapabilities: ReadonlyArray<{
    capabilityId: string;
    hostToolAliases: ReadonlyArray<string>;
  }>;
  neutralProbes: ReadonlyArray<{
    probeId: string;
    capabilityId: string;
    expectedDecision: 'allow';
  }>;
}
```

The minimum protected capabilities are `pd_status`, `rulecode_deactivate`, `rulecode_global_pause`, and `owner_review_access`. Tool aliases are adapter facts, not generated RuleCode input. Every neutral probe must run through the production-equivalent composition evaluator and return allow.

Missing, invalid, stale, or unsupported Host Liveness Contract is a hard promotion failure. The system must not infer safety from an empty tool list.

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
- Local no-auth Console: read, emergency deactivate, and emergency pause are allowed. It cannot promote, reject-after-shadow, continue-observing, supersede, or write any other Owner governance decision.
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
    | 'global_emergency_pause_release'
    | 'safety_isolate'
    | 'recover_to_shadow'
    | 'supersede';
  principal:
    | { kind: 'configured_owner'; ownerId: string }
    | { kind: 'system_safety'; policyVersion: string }
    | { kind: 'break_glass'; reason: 'local_no_auth_emergency' };
  authentication:
    | { method: 'console_token'; credentialId: string }
    | { method: 'cli_owner_credential'; credentialId: string }
    | { method: 'system' }
    | { method: 'local_break_glass' };
  operator?: { kind: 'local_user'; operatorId: string };
  reasonCode: string;
  note?: string;
  evidenceSnapshotId?: string;
  decidedAt: string;
}
```

`promote_live` requires an immutable evidence snapshot containing artifact digest, lineage refs, host/runtime version, safety-gate results, shadow summary, configuration version, and redaction metadata.

`global_emergency_pause` and `global_emergency_pause_release` require the global subject. Every other decision requires an activation subject. Runtime validation rejects invalid decision/subject combinations.

Owner governance decisions, including pause release and recovery-to-shadow, require `configured_owner` plus an authenticated Owner credential. `system_safety` is valid only for `safety_isolate`; `break_glass` is valid only for emergency deactivation or global pause. An unauthenticated actor can stop enforcement but cannot release or restore it.

### 12.1 Durable runtime control authority

Audit events alone are not runtime state. Add two durable control records at the I/O boundary:

```ts
interface ActivationControlState {
  activationId: string;
  enforcement: 'eligible' | 'safety_isolated';
  isolationDecisionId?: string;
  version: number;
  updatedAt: string;
}

interface GlobalRuleCodePause {
  pauseId: string;
  status: 'paused' | 'released';
  incidentDecisionId: string;
  releaseDecisionId?: string;
  affectedActivationIds: string[];
  pausedAt: string;
  releasedAt?: string;
  version: number;
}
```

Effective enforcement requires all of: live activation action, no deactivation timestamp, activation control `eligible`, and no active global pause. Runtime reads these durable facts on every refresh path; process restart cannot clear them.

Global pause atomically isolates every currently live activation and writes the affected-ID snapshot before acknowledging success. Releasing the global latch requires an authenticated Owner, atomically records `global_emergency_pause_release`, and does not restore those activations. Recovery atomically records `recover_to_shadow` and creates a new shadow activation linked to the isolated activation; it must collect/revalidate evidence and receive a new Owner Live Decision. There is no bulk-resume transaction.

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
POST /api/v1/activations/emergency-pause/:pauseId/release
POST /api/v1/activations/:id/recover-to-shadow
```

Mutating requests use idempotency keys and subject-appropriate optimistic preconditions. Activation decisions bind activation ID, artifact digest, readiness-evaluation ID, and evidence snapshot digest. Global pause release binds pause ID and pause-record version. A stale activation or pause snapshot returns a conflict and requires refresh.

`promote` accepts only reason/note and confirmation metadata; actor identity comes from server context. It re-runs hard gates immediately before an atomic decision-write and state transition.

Every refused/degraded response returns structured `reasonCode`, safe summary, failed checks, and `nextAction`.

Releasing a global pause only releases the global latch and writes its immutable release decision. `recover-to-shadow` writes its immutable recovery decision and creates the linked shadow recovery activation; neither endpoint restores live enforcement.

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

The maintainer approves two bounded MVP-Core controls:

```yaml
rulecode_owner_live_decision:
  category: core
  enabled: false
  since: 2026-08-21

rulecode_safety_controls:
  category: core
  enabled: true
  since: 2026-08-21
```

`rulecode_owner_live_decision` controls the new shadow evidence reader, decision API, decision writer, and Console review UI. While false, shadow observation may continue but promotion is refused across Console and CLI with `feature_not_enabled`; the system must never fall back to the legacy unchecked CLI promotion path. It becomes true only after the rollout gate in §22.

`rulecode_safety_controls` controls the durable isolation, circuit breaker, and global pause subsystem. It is enabled as a correctness and recovery control for the existing MVP-Core RuleHost channel. If it cannot operate, promotion is refused. Its emergency disable path is to set the existing `code_tool_hook` capability false and fail open all RuleCode enforcement; disabling safety controls alone while leaving live enforcement active is forbidden.

The comment-only compatibility correction and RuleCode execution fail-open behavior are bug fixes to existing RuleHost invariants, not flag-gated optional behavior.

Both registered flags count only after production loaders and tests consume them. Flag-off never deletes decisions or activations and never removes emergency deactivation.

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
- Static queue prototype: [queue](./assets/rulecode-owner-live-decision/01-queue.svg)
- Static decision prototype: [decision](./assets/rulecode-owner-live-decision/02-decision.svg)
- Static live prototype: [live monitoring](./assets/rulecode-owner-live-decision/03-live.svg)

The Figma Starter plan hit its MCP write-call limit after the three screen wrappers were created. The static prototypes are the current visual authority until the editable Figma screens are completed.

## 24. Approval record

The Owner product decisions in this SPEC are settled. No silent product decision remains. On 2026-08-21 the authenticated repository administrator `csuzngjh` explicitly instructed the assistant to complete the formal MVP-Core gate after review. GitHub reported `viewerPermission=ADMIN` for `csuzngjh/principles`; this is the maintainer authority evidence recorded by the ADR amendment.

The maintainer approves:

1. the `rulecode_owner_live_decision` evidence reader, application service, immutable decision/evidence writer, and Console UI as bounded MVP-Core;
2. the `rulecode_safety_controls` durable isolation, circuit breaker, global pause, and recovery-to-shadow controls as bounded MVP-Core safety infrastructure;
3. the fail-open compatibility correction as an existing RuleHost bug fix;
4. amending the conflicting ADR-0014 UI assumption;
5. the bounded single-Owner token identity model;
6. the implementation slices and rollout order above.

## 25. Formal review closure and relevant ERR checklist

The 2026-08-21 formal review ran two independent axes against the pre-review commit: repository/ADR standards and product/safety requirements. All reported P1/P2 findings were corrected before this approval record was finalized.

- **ERR-024 — defense exists but is not wired into the production path.** Avoided by requiring Console and CLI promotion to use the same application service and Promotion Safety Gate, and by making production-equivalent Host Liveness probes a hard prerequisite rather than a standalone validator.
- **ERR-097 — host contract assumed from PD's side.** Avoided by making the host adapter declare tool aliases, protected capabilities, out-of-band controls, and neutral probes. Missing, stale, or unsupported Host Liveness Contract blocks promotion.
- **ERR-102 — optional governance authority fails open to legacy mutation authority.** Avoided by distinguishing feature-disabled/unavailable from authenticated allow: both disabled and unavailable refuse promotion across all entry points, while local break-glass may stop harm but cannot write Owner governance decisions.

Implementation review must cite production-path tests for these three contracts. A leaf-helper test, a UI-only disabled state, or a CLI-only gate is insufficient evidence.
