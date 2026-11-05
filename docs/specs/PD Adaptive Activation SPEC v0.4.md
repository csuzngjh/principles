# PD Adaptive Activation SPEC v0.4

**Evidence-driven Host-aware Adaptive Activation — Architecture &
Engineering Specification**

| Metadata                   | Value                                                                                             |
|:---------------------------|:--------------------------------------------------------------------------------------------------|
| Version                    | v0.4                                                                                              |
| Date                       | 2026-11-04                                                                                        |
| Status                     | Proposed — Evidence-driven Engineering Baseline                                                   |
| Owner                      | PD Owner                                                                                          |
| Repository                 | `csuzngjh/principles`                                                                             |
| Code audit baseline        | `49a91651ab6c755f9074a653998951f4f88c0f43`                                                        |
| Host evidence baseline     | `PD Host Event Capability Matrix v0.1 — Live Runtime Verification`                                |
| Host probe baseline commit | `5c3371c3935192081585d741f50a899bc4445b0e`                                                        |
| Host probe observed HEAD   | `2f2bdf101955a807b8c041fca5a162174b9b494e`                                                        |
| Supersedes                 | PD Adaptive Activation SPEC v0.3                                                                  |
| Original design lineage    | Working Set Selector SPEC v0.2 (Proposal — Hold; not promoted by this SPEC)                       |
| Target hosts               | OpenClaw / Codex / WorkBuddy                                                                      |
| Verified runtime scope     | OpenClaw embedded; OpenClaw Gateway `sessions.reset`; Codex headless CLI; WorkBuddy `lite-wb` CLI |
| Primary architecture       | Native + Model-assisted, with host-specific adapters                                              |
| Implementation principle   | Reuse First, Evidence Before Activation, Minimal New Components                                   |

> **Status and authority.** This document is an engineering
> specification, not implementation authorization. All feature flags
> remain OFF by default. No host enters Model-assisted Live solely
> because another mode or host passed a probe. Owner authorization and
> the gates in this document remain mandatory.

------------------------------------------------------------------------

# 0. Executive Summary

## 0.1 Problem

PD already has principle governance, Runtime V2 activation, prompt
selection, budget control, prompt rendering, and runtime evidence
infrastructure.

The remaining capability gap is task-aware selection: PD can determine
which principles are authorized for runtime use, but it does not yet
reliably determine which authorized principles are most relevant to the
task and execution phase currently handled by an Agent Host.

Adaptive Activation adds task-aware selection and refresh to the
existing activation path. It does not create a second governance system,
a general task manager, or a replacement prompt-injection runtime.

The v0.3 design was based on a partially abstract view of the host
environment. The Host Event Capability Matrix v0.1 now supplies real
runtime evidence for three specific host/runtime combinations. It
establishes that event dispatch, injection channels, execution budgets,
and failure consequences differ materially.

**The v0.4 change is therefore an evidence-driven integration revision:
one shared decision core, host-specific execution contracts, and
independently verifiable delivery evidence.**

## 0.2 Core Design Decisions

1.  **Runtime V2 remains the sole authority for principle activation
    eligibility.** Adaptive Activation cannot grant, revoke, approve, or
    mutate governance activation.
2.  **Native Selection remains independently operational.** No external
    model is required for baseline PD behavior.
3.  **Model-assisted Selection remains optional and two-stage.**
    - `principle_decision`: detects `SAME_TASK`, `NEW_TASK`,
      `GOAL_SHIFT`, `PHASE_SHIFT`, or `UNCERTAIN`.
    - `principle_selector`: performs abstract, multi-label principle
      selection.
4.  **Model inference is removed from the synchronous prompt-hook
    critical path by default.** The hook uses a valid cached Working Set
    or Native Selection. Model-assisted refresh is deferred and can
    affect a later prompt only.
5.  **The context model remains three-layered.**
    - `INTENT`: long-term goals and non-negotiable constraints.
    - `Workspace Focus`: workspace-level current priorities; the
      existing `memory/okr/CURRENT_FOCUS.md` remains the compatible
      artifact path.
    - `Session Working Set`: session-scoped task state and selected
      principles.
6.  **A shared decision core does not imply a shared host execution
    policy.** Each adapter must bind to a verified host version, runtime
    mode, event, timeout contract, injection channel, and evidence
    level.
7.  **The internal canonical event `BEFORE_MODEL_TURN` is a
    normalization abstraction, not a claim that hosts expose an
    identically named or semantically identical event.**
8.  **Existing Prompt Capacity Budget, Packer, Renderer, Receipt,
    Evidence, and Examiner infrastructure is reused.** Hook execution
    time and prompt capacity are separate budgets.
9.  **Delivery is not behavior.** Selection, rendering, adapter return,
    confirmed model-request delivery, and behavioral effect remain
    distinct evidence stages.
10. **Shadow never automatically upgrades to Live.** Live requires
    explicit Owner authorization and host-specific gates.

## 0.3 Evidence-Driven Host Findings

The Host Event Capability Matrix v0.1 reports real runtime samples:

- Codex `0.166.0`, headless CLI: `UserPromptSubmit`, `SessionStart`, and
  `Stop` observed 8/8. The interactive TUI was `NOT_RUN`.
- WorkBuddy `5.9.2`, `lite-wb` CLI: `UserPromptSubmit` and
  `SessionStart` observed 3/3. Desktop was `NOT_RUN` because isolation
  could not be proven. `UserPromptSubmit` and `SessionStart` were
  concurrent; ordering is not guaranteed.
- OpenClaw `2026.10.10`, embedded runtime: seven event types were
  observed. Gateway `sessions.reset` lifecycle events `before_reset`,
  `session_end`, and `session_start` were observed 4/4/4. Reply `/reset`
  and ordinary Gateway turns were `NOT_RUN`.

The evidence also confirms:

- Injection channel: OpenClaw `system` + `user` prefix; Codex
  `developer`; WorkBuddy injection occurred but its message role/channel
  remains unknown.
- Host timeout behavior: OpenClaw fail-open; WorkBuddy timeout blocks
  the submission; Codex marks the hook failed while the turn continues.
- Host-level timeout values are not interchangeable: OpenClaw
  `before_prompt_build` 15 s; WorkBuddy CLI hook 30 s in the tested
  configuration; Codex host hook default 600 s.
- PD’s own configured hook budgets are separate: Codex
  `UserPromptSubmit` 5 s; WorkBuddy canonical runtime 15 s, while the
  locally installed marketplace cache version 0.2.0 uses 30 s.
  OpenClaw’s PD-specific internal budget is not established by the probe
  and must be measured.
- Probe callback latency is not PD plugin latency. The actual PD DB,
  selection, rendering, and adapter path has not yet been measured.

## 0.4 Expected Benefits

1.  Reduce irrelevant principle injection.
2.  Refresh principle selection when task goals or execution phases
    materially change.
3.  Reduce principle accumulation and conflict in long-running work.
4.  Preserve useful baseline behavior when external models are
    unavailable.
5.  Prevent host-specific behavior from leaking into the shared
    Selector.
6.  Give Examiner a traceable evidence chain from governance eligibility
    to behavioral effect.
7.  Avoid message loss and prompt blockage caused by synchronous model
    inference.

------------------------------------------------------------------------

# 1. Goals and Non-Goals

## 1.1 Goals

### G1 — Task-aware Principle Selection

Select relevant principles from the set already authorized by Runtime
V2.

### G2 — Adaptive Refresh

Detect and respond to:

- New task.
- Material goal change.
- Important phase change.
- Material workspace-context change.
- Expired or invalid Working Set.
- Loss of validity of one or more previously selected principles.

### G3 — Dual Selection Modes

Support:

- `native`
- `model-assisted` (operated through `shadow` or explicitly authorized
  `live` rollout modes)

Native does not depend on external models.

### G4 — Multi-label Selection

Permit multiple complementary principles. Do not force a single winner.

### G5 — Context Continuity

Maintain workspace context across sessions where identity and ownership
are reliable, while strictly isolating session execution state.

### G6 — Reuse Existing Infrastructure

Prefer reuse of:

- Runtime V2 Activation.
- Prompt Activation Reader.
- Prompt Budget Policy / Model-aware Prompt Budget.
- Existing Prompt Packer.
- Existing Prompt Renderer.
- Pi AI Runtime.
- Runtime Profiles and Agent Registry.
- Existing Receipt / Evidence.
- Current Focus reader and maintainer, after separation.
- Intent Reader.
- Existing Examiner infrastructure.

### G7 — Safe Degradation

Any unavailable enhancement returns to a valid existing Working Set or
Native path. Host-specific fail-open/fail-fast behavior must be
respected.

### G8 — Host-aware Runtime Delivery

Normalize supported host events into an internal contract while
preserving original event identity, runtime mode, evidence grade, and
host-specific delivery semantics.

### G9 — Evidence Separation

Distinguish governance eligibility, runtime selection, prompt rendering,
adapter delivery, confirmed model-request delivery, and behavioral
effect.

## 1.2 Non-Goals

This SPEC does not:

1.  Redesign principle governance, Owner approval, or activation
    permissions.
2.  Rebuild Principle Artifact management.
3.  Build a general task-management platform.
4.  Build a second model-provider or model-client framework.
5.  Let Selector modify principles or execute principle actions.
6.  Let a model directly modify the host’s current task.
7.  Treat keywords or regex as the main abstract semantic selector.
8.  Train a dedicated decision model in this version.
9.  Treat prompt delivery as proof of behavioral improvement.
10. Enable unverified Desktop/TUI/runtime modes by extrapolation.
11. Replace the Working Set Selector v0.2 proposal’s governance status
    or bypass its Hold gates.
12. Introduce a new independent Prompt Injection, Governance Activation,
    Model Runtime, or evidence platform.

------------------------------------------------------------------------

# 2. Existing System Audit

## 2.1 Audit Baselines and Evidence Labels

The original code audit baseline remains:

`49a91651ab6c755f9074a653998951f4f88c0f43`

The Host Event Capability Matrix was run against baseline commit:

`5c3371c3935192081585d741f50a899bc4445b0e`

The report records the actual read HEAD as:

`2f2bdf101955a807b8c041fca5a162174b9b494e`

The two baselines serve different purposes and must not be conflated.

Use these labels throughout implementation and reports:

- **VERIFIED-CODE**: confirmed in the stated code audit baseline.
- **VERIFIED-E3**: observed in a real isolated runtime probe with
  evidence artifacts.
- **SOURCE-CONFIRMED**: established by source inspection; does not alone
  prove runtime behavior.
- **PROPOSED**: design introduced by this SPEC, not yet implemented.
- **NOT_RUN**: the test was not performed; it is not a failure and not
  proof of unsupported capability.
- **INFERRED**: an explicit inference, not a measured result.
- **OWNER-GATED**: requires explicit Owner authorization.

## 2.2 Existing Capabilities

| Component                        | Existing capability                                | Status at v0.3 audit         |
|:---------------------------------|:---------------------------------------------------|:-----------------------------|
| Runtime V2 Activation            | Principle activation eligibility and authorization | VERIFIED-CODE                |
| Activation State Store           | SQLite activation persistence                      | VERIFIED-CODE                |
| Prompt Activation Reader         | Read valid activated principles                    | VERIFIED-CODE                |
| Principle Artifact Validation    | Validate Principle Artifact                        | VERIFIED-CODE                |
| Prompt Budget Policy             | Model-aware prompt capacity calculation            | VERIFIED-CODE                |
| Fair Rotation                    | OpenClaw-path fairness mechanism                   | VERIFIED-CODE, scope-limited |
| Shared Host Runtime              | Shared cross-host runtime components               | VERIFIED-CODE                |
| Pi AI Runtime                    | Internal model invocation infrastructure           | VERIFIED-CODE                |
| Runtime Profiles                 | Model binding for internal Agents                  | VERIFIED-CODE                |
| SignalCollector                  | Keyword + optional LLM two-stage recognition       | VERIFIED-CODE                |
| Current Focus                    | Workspace focus and working-memory maintenance     | VERIFIED-CODE, INCOMPLETE    |
| Intent Reader                    | `INTENT.md` reader interface and Feature Flag      | VERIFIED-CODE                |
| Working Set Selector v0.2        | Earlier design proposal                            | PROPOSAL ONLY / HOLD         |
| `principle_working_sets`         | Earlier proposed data structure                    | NOT VERIFIED IN PRODUCTION   |
| Adaptive Task Change Detection   | Task-change recognition                            | NOT IMPLEMENTED              |
| General Principle Selector       | Semantic multi-label selection                     | NOT IMPLEMENTED              |
| Host Runtime Capability Profiles | Version/mode-bound execution profiles              | PROPOSED                     |
| Canonical Event Normalizer       | Internal semantic event envelope                   | PROPOSED                     |
| PD Hook Performance Probe        | Actual PD callback cost by host                    | PENDING                      |

## 2.3 Governance Activation — Immutable Boundary

The existing authorization chain remains authoritative:

``` text
Principle Artifact
       |
       v
Artifact Validation
       |
       v
Owner Approval / Authorized Policy
       |
       v
ActivationDispatcher
       |
       v
SQLite Activation State
       |
       v
Runtime V2 Prompt Activation Reader
       |
       v
Eligible Activated Principles
```

Selector may only read principles that are currently authorized and
valid.

Selector and Host Adapter MUST NOT:

- Create or approve Activation.
- Modify or revoke Activation.
- Change Principle lifecycle state.
- Bypass Artifact Validation.
- Promote a draft or historical artifact.
- Interpret a model recommendation as governance authorization.

Primary code references from v0.3:

- `packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts`
- `packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts`
- `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`
- `packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts`

## 2.4 Existing Native Prompt Selection

Native Selection already provides:

- Valid principle retrieval.
- Prompt capacity calculation.
- `fair_rotation_v1` on the supported OpenClaw path.
- Over-budget principle handling.
- Deterministic selection.

Its host-specific reality must remain explicit:

| Host path           | Existing behavior / limitation                                                                                                               |
|:--------------------|:---------------------------------------------------------------------------------------------------------------------------------------------|
| OpenClaw Plugin     | `fair_rotation_v1` is available on the verified supported path; its fairness claim remains scoped to that path and its valid round identity. |
| Shared Host Runtime | Uses legacy FIFO behavior when reliable turn ordinal is unavailable.                                                                         |
| Codex               | Must not fabricate `user-turn ordinal`; no claim of cross-turn fair rotation without an authoritative ordinal.                               |
| WorkBuddy           | Use only behavior verified for the installed runtime/profile; do not infer a turn ordinal or reuse another host’s fairness guarantee.        |

`fair_rotation_v1` is a budget-packing fairness policy, not the semantic
Adaptive Selector. The two responsibilities must not be conflated.

The v0.3 audit noted that the shared path may use
`legacy_fifo_prefix_v1` when no reliable incrementing round authority
exists. This fallback remains valid and must not be silently replaced.

Relevant code:

- `packages/principles-core/src/runtime-v2/activation/prompt-budget-policy.ts`
- `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`
- `packages/host-runtime/src/active-principle-prompt.ts`
- `packages/openclaw-plugin/src/hooks/prompt.ts`

## 2.5 Existing Model Infrastructure

Reuse the Pi AI Runtime and Runtime Profile configuration system:

- Provider.
- Model.
- API key environment variable.
- Base URL.
- Timeout.
- Retry.
- Max tokens.
- Reasoning configuration.
- Agent runtime binding.

Do not introduce another model client.

The two optional internal roles remain:

- `principle_decision`
- `principle_selector`

Registration must use the existing Agent Registry and Profile Binding
contracts.

Relevant code:

- `packages/principles-core/src/runtime-v2/config/pd-config-types.ts`
- `packages/principles-core/src/runtime-v2/config/pd-config-agent-binding.ts`
- `packages/pd-cli/src/services/runtime-adapter-resolver.ts`
- `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts`

## 2.6 Current Focus Reality and Terminology

The existing artifact remains:

`memory/okr/CURRENT_FOCUS.md`

In this SPEC, its semantic responsibility is named **Workspace Focus**.
The filename and existing user-facing Markdown workflow remain
backward-compatible unless a separate migration is approved.

Known v0.3 limitations remain:

1.  `currentTask` is defined but its extraction and restore path is
    incomplete.
2.  Working-memory extraction relies substantially on Assistant messages
    and regex.
3.  Long conversation reads risk taking the file head and omitting the
    latest content.
4.  Maintenance timing depends heavily on OpenClaw Compaction.
5.  Session state and Workspace Focus are not reliably isolated.
6.  Codex / WorkBuddy do not yet have proven identical Focus lifecycle
    integration.
7.  `safeReadCurrentFocus()` may perform recovery or initialization side
    effects and is not a pure Selector reader.

Decision: retain and repair; do not rebuild.

Relevant code:

- `packages/openclaw-plugin/src/core/focus-history.ts`
- `packages/openclaw-plugin/src/hooks/lifecycle.ts`
- `packages/openclaw-plugin/src/commands/focus.ts`
- `packages/principles-core/src/prompt-builder/focus-compression.ts`

## 2.7 Existing Intent

The existing Intent Reader remains a separate interface controlled by
`intent_engineering`.

Rules:

- When disabled, do not read `INTENT.md`.
- Do not bypass Owner configuration.
- Do not promote Intent content into principle activation.
- Do not let Selector modify long-term Intent.

Relevant code:

- `packages/openclaw-plugin/src/core/intent-doc-reader.ts`
- `packages/principles-core/src/runtime-v2/intent/intent-doc-reader-port.ts`
- `packages/principles-core/src/runtime-v2/config/pd-config-feature-flags.ts`

## 2.8 Components Not to Repurpose

| Component                        | Existing purpose                      | Restriction                                              |
|:---------------------------------|:--------------------------------------|:---------------------------------------------------------|
| Principle Reuse                  | Prevent duplicate principles          | Not a semantic task selector                             |
| Owner Decision Semantic Selector | Select Owner decision-card text       | Do not reuse its business decision logic                 |
| PrincipleClassifier              | Console principle classification      | Not a task selector                                      |
| Runtime V2 TaskStore             | Internal task queue                   | Not a user Task Manager                                  |
| SignalCollector                  | Correction/empathy signal recognition | Reuse only model infrastructure and engineering patterns |
| Context Intelligence             | Internal Agent diagnostic context     | Do not reuse wholesale as Selector                       |
| Working Set Selector v0.2        | Proposal/Hold design                  | Do not activate or bypass its gates through this SPEC    |

------------------------------------------------------------------------

# 3. Core Architecture

## 3.1 Architecture Overview

``` mermaid
flowchart TD
    A[Verified Host Event]
    B[Host Adapter + Capability Profile]
    C[Canonical Event Envelope]
    D[Read-only Context Snapshot]
    E[Adaptive Activation Core]
    F[Native Selection]
    G[Cached Model-assisted Working Set]
    H[Deferred Decision Model]
    I[Deferred General Reasoning Selector]
    J[Candidate + Governance Revalidation]
    K[Working Set Resolver]
    L[Existing Prompt Capacity Budget + Packer]
    M[Existing Prompt Renderer]
    N[Host-specific Injection Encoder]
    O[Activation / Delivery Receipt]
    P[Examiner]

    Q[Workspace Focus]
    R[Session Working Set]
    S[Optional INTENT Reader]

    A --> B --> C --> D --> E
    Q --> D
    R --> D
    S --> D
    E --> F
    E --> G
    D -. deferred refresh .-> H --> I --> J --> R
    F --> K
    G --> K
    K --> J
    J --> L --> M --> N --> O --> P
```

The model path is a deferred refresh path. It is not a synchronous
dependency of `BEFORE_MODEL_TURN`.

## 3.2 Responsibilities

The architecture retains the three v0.3 domain responsibilities and adds
a host integration boundary:

1.  **Adaptive Activation Core** — task-change policy, selection
    routing, Working Set resolution.
2.  **Decision Model Integration** — deferred task-change
    classification.
3.  **General Principle Selector Integration** — deferred semantic
    multi-label selection.
4.  **Host Adapter Layer** — host event normalization, capability
    profile enforcement, host-specific timeout/degradation, injection
    encoding, and delivery evidence.

The Host Adapter is an integration boundary, not a new governance or
selection authority.

Host Adapter MUST NOT change:

- Principle authorization.
- Principle lifecycle.
- Candidate eligibility.
- Selection semantics.
- Owner approval requirements.
- Prompt capacity policy.

Do not add a separate Prompt Injection system, Governance Activation
system, or Model Runtime system.

## 3.3 Two Operating Modes

### Native Mode

``` text
Verified Host Event
      |
      v
Read-only Context Snapshot (best effort)
      |
      v
Eligible Activated Principles
      |
      v
Existing Native Selection
      |
      v
Existing Prompt Capacity Budget + Packer
      |
      v
Existing Prompt Renderer
      |
      v
Host-specific Adapter
```

Properties:

- No external model.
- No Decision Model.
- No General Selector Model.
- Preserves existing governance and native compatibility.
- Uses existing budget and fairness behavior within its verified scope.
- Does not claim abstract semantic relevance equivalent to
  Model-assisted Selection.

### Model-assisted Mode

The model-assisted result is prepared outside the synchronous hook:

``` text
Context / Focus / Intent Revision / Bounded Checkpoint
      |
      v
Deferred Refresh Eligibility
      |
      v
Decision Model
      |
      +---- SAME_TASK ------> Retain valid Working Set
      |
      +---- UNCERTAIN ------> Retain valid set or Native
      |
      +---- NEW_TASK / GOAL_SHIFT / PHASE_SHIFT
                      |
                      v
             General Reasoning Selector
                      |
                      v
             Candidate + Activation Validation
                      |
                      v
             Persist versioned Working Set
                      |
                      v
             Apply only at a later prompt boundary
```

At the next verified `BEFORE_MODEL_TURN`, the hook reads the latest
valid Working Set. If it is missing, stale, invalid, or unavailable, it
uses Native.

No background result may mutate a prompt already submitted to the host.

------------------------------------------------------------------------

# 4. Context Model

## 4.1 Three Context Levels

The three levels are independent and have different owners and
lifecycles.

### A. INTENT — Strategic Context

Long-term intent:

- Why.
- Desired Outcome.
- Non-negotiables.
- Strategic Constraints.
- Long-term Direction.

Properties:

- Long lifecycle.
- Defined and controlled by Owner.
- Not overwritten by ordinary tasks.
- Read only when `intent_engineering` is enabled.

### B. Workspace Focus — Workspace Context

The existing `CURRENT_FOCUS.md` artifact represents the current
workspace focus:

- Current phase.
- Current priority tasks.
- P0/P1/P2.
- Important blockers.
- Next actions.
- Working-memory summary.
- Key artifacts and decisions.

Properties:

- Workspace-scoped.
- May be shared by multiple sessions in the same workspace.
- Represents the workspace’s current direction, not an individual
  Agent’s live task.
- Owner-controlled; automatic maintenance is restricted to explicitly
  authorized working-memory regions.

### C. Session Working Set — Runtime Context

Session-scoped execution state:

- Current task summary.
- Current execution phase.
- Selected principle IDs.
- Last selection reason.
- Last task-change decision.
- Context fingerprint and revision.
- Host profile and source event.
- Expiry and validity metadata.

Properties:

- Session-scoped.
- Never shared with another Session.
- Must not overwrite Workspace Focus.
- May be refreshed when task context materially changes.
- Is a cache of selection state, not a governance record or full task
  history.

## 4.2 Context Priority and Provenance

Retain the v0.3 read priority:

1.  Current Session conversation context.
2.  Current Session Working Set.
3.  Workspace Focus.
4.  Optional INTENT.

These are not concatenated into an untyped string. Every input must
retain:

- Source.
- Scope.
- Revision or fingerprint.
- Capture time.
- Availability state.
- Feature-flag state where applicable.

A lower-level context must not silently override a higher-authority
Owner-defined constraint. In particular, ordinary session text cannot
mutate INTENT or Owner-authored Workspace Focus.

## 4.3 Read-only Context Snapshot Contract

``` typescript
interface AdaptiveContextSnapshot {
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  runtimeMode: string;
  hostProfileId: string;
  hostProfileRevision: string;

  workspaceId: string;
  sessionId: string;

  recentConversation: ConversationMessage[];

  sessionWorkingSet?: SessionWorkingSet;

  workspaceFocus?: {
    revision: string;
    content: string;
    updatedAt?: string;
    sourcePath?: string;
  };

  intent?: {
    enabled: boolean;
    revision?: string;
    content?: string;
  };

  hostEvent: CanonicalHostEvent;

  capturedAt: string;
}
```

Rules:

- No full host-history database scan.
- No default full-workspace directory scan.
- No bypass of Intent Feature Flag.
- No writes, repairs, or initialization during context read.
- No cross-Session context mixing.
- No use of `safeReadCurrentFocus()` as a pure reader until its side
  effects are removed or isolated.
- Missing, malformed, or untrusted Focus returns `unavailable`; the
  reader does not create a template.
- Missing reliable `workspaceId` or `sessionId` disables persisted
  Model-assisted Live for that host profile. Native remains available if
  the existing path can operate safely.

------------------------------------------------------------------------

# 5. Host Event Semantics and Task Change Detection

## 5.1 Canonical Event Is an Internal Abstraction

Define the internal semantic event:

`BEFORE_MODEL_TURN`

It means: **the adapter has received a verified host callback that
occurs before the host submits the current user turn to the model and
can still return the prompt contribution for that turn.**

It does not mean all hosts have identical lifecycle semantics. Every
normalized event must preserve the actual source event and evidence.

Current mappings supported by the Host Matrix:

| Host/runtime mode              | Source event          | Mapping                             | Evidence                                |
|--------------------------------|:----------------------|:------------------------------------|:----------------------------------------|
| Codex headless CLI             | `UserPromptSubmit`    | `BEFORE_MODEL_TURN`                 | VERIFIED-E3, 8/8                        |
| WorkBuddy `lite-wb` CLI        | `UserPromptSubmit`    | `BEFORE_MODEL_TURN`                 | VERIFIED-E3, 3/3                        |
| OpenClaw embedded              | `before_prompt_build` | `BEFORE_MODEL_TURN`                 | VERIFIED-E3, seven event types observed |
| Codex interactive TUI          | —                     | No mapping authorized               | NOT_RUN                                 |
| WorkBuddy Desktop/IDE          | —                     | No mapping authorized               | NOT_RUN / isolation unproven            |
| OpenClaw reply `/reset`        | —                     | No mapping authorized               | NOT_RUN                                 |
| OpenClaw ordinary Gateway turn | —                     | No mapping authorized by this probe | NOT_RUN                                 |

A mapping is permitted only for the exact host version/runtime mode for
which evidence exists. Version or mode changes invalidate the profile
until reverified.

## 5.2 Canonical Event Envelope

``` typescript
type CanonicalEventType =
  | "BEFORE_MODEL_TURN"
  | "WORKSPACE_FOCUS_REVISION_CHANGED"
  | "SESSION_CONTEXT_RESTORED"
  | "SESSION_RESET_CONFIRMED"
  | "PERIODIC_CHECKPOINT";

interface CanonicalHostEvent {
  canonicalType: CanonicalEventType;
  sourceEvent: string;
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  runtimeMode: string;
  hostProfileId: string;

  observedAt: string;
  eventId?: string;
  turnId?: string;
  sessionId?: string;
  workspaceId?: string;

  identityReliability: "verified" | "partial" | "unavailable";
  dispatchEvidence: "E3" | "SOURCE_CONFIRMED" | "NOT_RUN";
}
```

`eventId`, `turnId`, `sessionId`, and `workspaceId` are optional because
not every host/mode has verified values. Missing identity must remain
missing; adapters must not invent host IDs or ordinals.

## 5.3 SessionStart Is Not a Universal Session Boundary

Do not depend on `SessionStart` to:

- Count sessions.
- Infer a unique session start.
- Establish ordering before `UserPromptSubmit`.
- Determine that a session is new rather than resumed.
- Clear or overwrite the Working Set without a verified reset identity.

Evidence:

- Codex `SessionStart` can repeat on `resume`.
- WorkBuddy `SessionStart` and `UserPromptSubmit` were observed
  concurrently; ordering is not guaranteed.
- OpenClaw embedded mode has no verified `session_start` dispatch point
  in this probe.
- OpenClaw Gateway `sessions.reset` lifecycle events were verified only
  for that reset path; they do not prove reply `/reset` or ordinary
  Gateway turn behavior.

`SessionStart` may be used only as an ancillary hint inside a
host-specific adapter when its exact semantics are verified. It is not
the canonical initialization trigger.

## 5.4 Trigger Conditions

| Trigger                       | Description                                                      | Action                                                                           |
|:------------------------------|:-----------------------------------------------------------------|:---------------------------------------------------------------------------------|
| `INITIAL_SESSION`             | No valid Working Set exists when a verified prompt event arrives | Native immediately; enqueue deferred initialization only if a safe worker exists |
| `HOST_TASK_BOUNDARY`          | A host provides a verified task boundary                         | Enqueue Decision Model                                                           |
| `FOCUS_REVISION_CHANGED`      | Workspace Focus revision changes                                 | Enqueue Decision Model                                                           |
| `CONTEXT_FINGERPRINT_CHANGED` | Local context fingerprint changes materially                     | Consider bounded refresh                                                         |
| `PERIODIC_CHECKPOINT`         | A safe per-session checkpoint is reached                         | Enqueue Decision Model                                                           |
| `COMPACTION_RESUME`           | A verified compaction/resume signal is available                 | Revalidate cached state; do not assume all hosts support it                      |
| `WORKING_SET_EXPIRED`         | Working Set TTL or validity has expired                          | Native immediately; deferred refresh if safe                                     |
| `ACTIVATION_REVISION_CHANGED` | Relevant activation state changes                                | Revalidate selected IDs before delivery                                          |

A trigger can request a refresh; it cannot itself authorize a principle.

## 5.5 Incremental Checkpoint

The v0.3 initial experiment values are retained as provisional policy
values, not verified optima:

| Parameter                       | v0.3 initial value | v0.4 treatment                                                                                                                                       |
|:--------------------------------|-------------------:|:-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `maxUserTurnsWithoutReview`     |                  4 | Use only if a reliable, deduplicated PD-observed prompt sequence can be maintained for that profile; never substitute a fabricated host turn ordinal |
| `maxContextDeltaChars`          |               2500 | Retain as an experimental local fingerprint/delta threshold                                                                                          |
| `minReviewIntervalMs`           |              30000 | Retain as an experimental lower bound between model refreshes                                                                                        |
| `refreshOnFocusRevisionChange`  |               true | Retain                                                                                                                                               |
| `refreshOnReliableHostBoundary` |               true | Retain only for verified source events                                                                                                               |

Per-message behavior:

- Perform only bounded local work in the synchronous hook.
- Do not invoke an external model in the hook.
- Do not run a Decision Model on every message.
- Do not count duplicate/replayed callbacks as new turns unless
  idempotency is established.
- If no reliable per-turn counter exists, use local context
  fingerprint/time-based checks or verified host boundaries.
- A single-message semantic change may remain undetected until the next
  refresh checkpoint. The system must disclose this bounded detection
  delay rather than claim zero-delay semantic detection.

## 5.6 Decision Model Input

``` typescript
interface TaskChangeInput {
  recentConversation: ConversationMessage[];

  previousTask?: {
    description: string;
    phase?: string;
  };

  previousWorkingSet: {
    principleIds: string[];
    revision: number;
  };

  workspaceFocus?: {
    revision: string;
    content: string;
  };

  intent?: string;

  trigger: RefreshTrigger;
  contextFingerprint: string;
}
```

Input policy:

- Recent six effective messages as the initial context window.
- Prefer newest content.
- Initial maximum input length: 12,000 characters.
- On overflow, retain the newest complete message boundaries; do not
  truncate from the file head.
- Do not persist full raw conversation in Working Set storage.
- External context transmission remains explicit opt-in.

## 5.7 Decision Model Output

``` typescript
type TaskChangeType =
  | "SAME_TASK"
  | "NEW_TASK"
  | "GOAL_SHIFT"
  | "PHASE_SHIFT"
  | "UNCERTAIN";

interface TaskChangeDecision {
  changeType: TaskChangeType;
  confidence: number;
  previousTaskSummary?: string;
  currentTaskSummary?: string;
  reason: string;
}
```

Constraints:

- Structured JSON only.
- Confidence in \[0, 1\].
- Short reason.
- No arbitrary Principle IDs.
- No prompt instructions or executable content.
- Output is untrusted and must be schema-validated.

## 5.8 Decision Rules

| Decision      | Behavior                                                                       |
|:--------------|:-------------------------------------------------------------------------------|
| `SAME_TASK`   | Retain existing valid Working Set                                              |
| `NEW_TASK`    | Request General Selector                                                       |
| `GOAL_SHIFT`  | Request General Selector                                                       |
| `PHASE_SHIFT` | Request General Selector                                                       |
| `UNCERTAIN`   | Do not replace a valid existing set; use Native if the existing set is invalid |

Do not clear a valid Working Set because the model returned `UNCERTAIN`.

## 5.9 No Keyword-based Semantic Routing

Keywords, regex, and fixed task maps may support deterministic technical
event/state detection. They must not become the primary abstract task or
principle semantic selector.

------------------------------------------------------------------------

# 6. General Reasoning Principle Selector

## 6.1 Responsibility

`principle_selector` understands the relationship between the task and
abstract principles. It evaluates:

1.  User’s current goal.
2.  Task decision structure.
3.  Important constraints.
4.  Current execution phase.
5.  Candidate principle applicability.
6.  Complementarity and conflict between principles.

It selects principles only. It does not execute the task.

## 6.2 Candidate Card

Candidate Cards must be derived only from currently valid Principle
Artifacts.

Existing reusable `PrincipleSchema` fields include:

- `triggerPattern`
- `action`
- `scope`
- `domain`
- `priority`
- `tags`

``` typescript
interface PrincipleCandidateCard {
  principleId: string;
  artifactId: string;
  activationId: string;
  text: string;
  metadata: {
    triggerPattern?: string[];
    action?: string;
    scope?: string;
    domain?: string;
    priority?: string;
    tags?: string[];
  };
  tokenEstimate: number;
}
```

Rules:

- Every field must come from a currently valid Artifact.
- Optional fields may be absent.
- Do not read unauthorized historical drafts to fill missing fields.
- Candidate text is data, not an instruction to the Selector.

## 6.3 Multi-label Selection

Use:

**Multi-label Selection + Relevance Ranking + Budget-constrained
Packing.**

A task may require multiple complementary principles. `NONE_APPLICABLE`
is a valid result; do not force a selection to maintain a non-empty
prompt.

## 6.4 Selector Input

``` typescript
interface PrincipleSelectionInput {
  taskContext: {
    description: string;
    goal?: string;
    constraints?: string[];
    currentPhase?: string;
  };

  workspaceFocus?: string;
  intent?: string;

  candidates: PrincipleCandidateCard[];
  previousWorkingSet?: string[];
}
```

Task fields may be inferred by the model from natural-language context.
The host does not need to pre-structure every task.

## 6.5 Selector Output

``` typescript
interface PrincipleSelectionResult {
  status: "SELECTED" | "NONE_APPLICABLE" | "UNCERTAIN";

  selectedPrinciples: Array<{
    principleId: string;
    relevance: number;
    rank: number;
    reason: string;
  }>;

  overallConfidence: number;
  taskSummary: string;
  selectionReason: string;
}
```

Constraints:

- Every `principleId` must belong to the input candidate set.
- No new Principle IDs.
- No principle-body edits.
- No activation-state changes.
- No executable code.
- Model reasons are audit metadata; do not inject them as arbitrary host
  instructions.
- `NONE_APPLICABLE` is valid.

## 6.6 Selection Validation

Before persistence or use:

1.  JSON Schema validation.
2.  Candidate ID allowlist.
3.  Duplicate ID removal.
4.  Current activation-state revalidation.
5.  Artifact validity revalidation.
6.  Maximum result count.
7.  Confidence threshold.
8.  Rank/relevance validation.
9.  Context fingerprint and Working Set revision validation.
10. Host/workspace/session binding validation.

Any failure rejects the model result. The current valid Working Set may
be retained; otherwise use Native.

## 6.7 Candidate Pool Limits

Retain v0.3 initial experiment values:

| Parameter                   |          Initial value |
|:----------------------------|-----------------------:|
| Maximum candidates          |                     48 |
| Maximum selected principles |                     12 |
| Maximum reason length       |         160 characters |
| Minimum confidence          |                   0.70 |
| Candidate content           | Verified Artifact only |

These are experimental limits, not proven optima.

If eligible candidates exceed the maximum, do not silently truncate and
claim a complete selection. Record `candidate_pool_overflow` and use
Native. Do not introduce a multi-batch Selector protocol in v0.4.

------------------------------------------------------------------------

# 7. Unified Selection and Prompt Capacity Packing

## 7.1 Shared Final Pipeline

``` text
Native / Valid Model-assisted Working Set
              |
              v
       Validated Principle IDs
              |
              v
   Runtime V2 Activation Revalidation
              |
              v
 Existing Prompt Capacity Budget Policy
              |
              v
       Existing Prompt Packer
              |
              v
       Existing Prompt Renderer
              |
              v
       Host-specific Adapter
              |
              v
         Delivery Receipt
```

Only one Working Set Resolver may produce the final principle set for a
prompt. Native and Model-assisted results must never be double-injected.

## 7.2 Two Independent Budgets

The word “budget” refers to two different resource constraints. They
must not share a single resolver or global constant.

### A. Hook Execution Budget

Wall-clock budget for reading state, selecting/falling back, rendering,
encoding, and returning from a host hook.

It is host- and installed-version-specific. See Section 12.

### B. Prompt Capacity Budget

Capacity of the model prompt contribution, including:

- Model/context-window awareness.
- Existing character/token estimation rules.
- Minimum and maximum content budgets.
- Candidate ordering.
- Over-budget handling.
- Existing fairness behavior where valid.

Reuse the existing Model-aware Prompt Budget v0.3 and existing Packer.
Do not rebuild them as part of Adaptive Activation.

## 7.3 Native Packing

Native Mode retains the current Packer and its existing host-specific
fairness behavior.

If no authoritative round identity exists, do not invent `roundKey` or
user-turn ordinal. Keep the existing fallback, including
`legacy_fifo_prefix_v1`, where that is the current safe behavior.

## 7.4 Model-assisted Packing

1.  Order candidates by validated Selector relevance/rank.
2.  Revalidate activation and artifact state.
3.  Pass candidates into the existing Prompt Capacity Budget and Packer.
4.  Preserve higher-ranked candidates first.
5.  If an item exceeds capacity, continue evaluating later candidates if
    the existing Packer supports that behavior.
6.  Never exceed the actual prompt capacity.
7.  Do not bypass host-specific output constraints.

If the current Packer cannot represent the required ranking behavior, a
minimal strategy branch such as `model_ranked_v1` may be proposed. It
must reuse the existing packing implementation and be separately tested.
Do not create a second budget/packing subsystem.

## 7.5 Fair Rotation Scope

`fair_rotation_v1` is not a universal cross-host guarantee. Preserve the
verified scope. When no reliable turn ordinal exists, use the existing
deterministic fallback. Do not expand the fairness claim to Codex or
WorkBuddy without evidence and a valid identity source.

------------------------------------------------------------------------

# 8. Working Set Persistence

## 8.1 Purpose and Status

Working Set represents the selected principle set and task state for one
Session.

It is not:

- Principle activation state.
- Governance evidence.
- Full task history.
- Workspace Focus.
- A general task manager.

The v0.3 audit did not verify `principle_working_sets` in production.
The table remains a proposed logical storage concept, not an approved
production migration.

## 8.2 Proposed Logical Record

The following is a logical contract, not authorization to create a table
or select a database before ownership audit:

``` typescript
interface SessionWorkingSet {
  workspaceId: string;
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  runtimeMode: string;
  hostProfileId: string;
  sessionId: string;

  revision: number;
  status: "VALID" | "STALE" | "EXPIRED" | "INVALID";

  taskSummary?: string;
  selectedPrincipleIds: string[];
  selectionMode: "native" | "model-assisted";
  selectionTrigger?: string;

  decisionModel?: string;
  selectorModel?: string;
  confidence?: number;

  contextFingerprint: string;
  focusRevision?: string;
  activationRevision?: string;

  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
```

Rules:

- Do not save raw user conversation.
- Do not save API keys.
- Do not save full model chain-of-thought.
- No cross-workspace reads.
- No cross-session writes or reuse.
- Every update uses a revision check.
- Expired or stale state cannot be used as a Live selection.
- A change in host version/runtime mode/profile invalidates the
  profile-bound result until revalidated.
- Selected principle IDs must be revalidated against Runtime V2 before
  every delivery.

## 8.3 Concurrency

Use existing supported persistence mechanisms, subject to database
ownership audit:

- Transaction.
- Revision check.
- Optimistic lock.
- Deterministic upsert.

For concurrent refreshes, only a result matching the latest context
fingerprint and expected Working Set revision may commit. An older model
response must not overwrite a newer result.

## 8.4 Expiration

Retain v0.3 initial idle TTL of 24 hours as an experimental default:

- Extend only on verified activity for the same Session.
- Mark inactive Session state expired after TTL.
- Never use expired state as a Live selection.
- Re-select or fall back to Native.
- TTL does not mean the task is complete.

## 8.5 Storage Ownership Gate

Before implementation, establish:

- Which existing SQLite database owns this state.
- Whether the selected database is writable by each adapter.
- Migration and backup policy.
- Transaction/concurrency semantics.
- Workspace/session identity source.
- Whether cross-process access is supported.

Do not create a second database solely for Adaptive Activation without
an explicit architecture decision.

------------------------------------------------------------------------

# 9. Workspace Focus Upgrade

## 9.1 Decision

Retain `memory/okr/CURRENT_FOCUS.md`. Treat it semantically as Workspace
Focus. Do not build a Task Manager.

## 9.2 Responsibilities and Format

Workspace Focus remains human-readable Markdown:

``` markdown
# CURRENT_FOCUS

## Status Snapshot
Current Phase:
Overall Status:
Last Updated:

## Current Tasks
### P0
### P1
### P2

## Next Actions
## Active Blockers

## Working Memory
### Key Artifacts
### Active Problems
### Decisions
### Next Steps
```

Do not require Owner to maintain complex JSON/YAML.

## 9.3 Required Repairs

### F1 — Complete `currentTask` Production and Restore

- Extract current task from supported context.
- Write only to a clearly designated, authorized working-memory region.
- Support parsing and restore.
- Preserve human-edited content.
- Never overwrite Owner-authored strategic descriptions.

### F2 — Read Latest Conversation

- Ensure latest messages are not omitted by head truncation.
- Prefer recent context.
- Preserve message boundaries.
- Test truncation behavior.

### F3 — Host-aware Lifecycle Maintenance

Evaluate only verified events:

- Prompt build / user prompt submit.
- Compaction.
- Session resume.
- Session end.
- Workspace Focus update.

Do not assume each host exposes the same lifecycle.

### F4 — Separate Read from Maintenance

``` typescript
interface WorkspaceFocusReader {
  readSnapshot(workspaceId: string): Promise<WorkspaceFocusSnapshot | null>;
}

interface WorkspaceFocusMaintainer {
  ensureTemplate(workspaceId: string): Promise<void>;

  updateWorkingMemory(
    workspaceId: string,
    patch: WorkingMemoryPatch
  ): Promise<void>;
}
```

Selector and Context Snapshot Reader may call only the pure Reader. They
must not call Maintainer.

### F5 — Multi-session Isolation

Workspace Focus may be shared within the same workspace. Session Working
Sets remain isolated.

### F6 — Cross-host Consistency Without Capability Fabrication

Use a common internal reader contract, but do not invent lifecycle
events or identity values.

If a host/mode cannot supply reliable Workspace Identity or Session
Identity, Model-assisted persisted Live is disabled for that profile.
Native remains available where safe.

## 9.4 Ownership

Owner retains final control over Workspace Focus and INTENT.

Selector cannot automatically modify:

- INTENT.
- Owner’s strategic goals.
- Owner-authored P0/P1/P2 descriptions.

Automatic maintenance is limited to explicitly authorized working-memory
regions.

------------------------------------------------------------------------

# 10. Model Runtime Configuration

## 10.1 Reuse Existing Runtime

Use existing Pi AI Runtime, Agent Registry, and Runtime Profiles. Do not
add a second model client.

Proposed internal roles:

``` text
principle_decision
principle_selector
```

Registration and binding must use existing configuration contracts.

## 10.2 Proposed Configuration

The following is a target configuration sketch. It is not a claim that
every field is already accepted by the current config parser.

``` yaml
adaptiveActivation:
  mode: native

  refreshPolicy:
    maxUserTurnsWithoutReview: 4
    maxContextDeltaChars: 2500
    minReviewIntervalMs: 30000
    refreshOnFocusRevisionChange: true
    refreshOnReliableHostBoundary: true

  decision:
    enabled: false
    agent: principle_decision
    workerTimeoutMs: 1500
    minimumConfidence: 0.70

  selector:
    enabled: false
    agent: principle_selector
    workerTimeoutMs: 3000
    minimumConfidence: 0.70

  limits:
    maxCandidates: 48
    maxSelected: 12
    maxContextChars: 12000

  persistence:
    enabled: false
    idleTtlMs: 86400000

  hostProfiles:
    # Profile values are resolved from verified installed host/runtime data.
    # Never infer or hard-code a profile from hostKind alone.
    requireExactVersionMatch: true
```

Important:

- `workerTimeoutMs` applies to deferred model work, not the synchronous
  host hook.
- The v0.3 values 1.5 s and 3 s remain initial model-worker targets
  only. They are not host budgets and are not evidence-backed
  performance guarantees.
- Synchronous hook work must not wait for these calls.
- `persistence.enabled` remains OFF until database ownership and
  identity gates pass.
- Installed plugin/runtime version must be inspected; do not assume
  repository canonical configuration equals the installed cache.

## 10.3 Model Selection Policy

Decision Model priorities:

- Low latency.
- Low cost.
- Stable structured output.
- Adequate task-change understanding.

General Selector priorities:

- Abstract principle understanding.
- Long-context understanding.
- Multi-label judgment.
- Constraint reasoning.
- Stable structured output.

The Decision Model does not need to understand abstract principles. The
General Selector owns that task.

## 10.4 Deferred Execution Prerequisite

A deferred model path requires a safe execution mechanism that does not
block the host prompt hook.

Before enabling Shadow or Live, verify whether an existing PD
worker/Agent execution path can:

- Accept a refresh request without blocking the hook.
- Persist or safely cache the result.
- Enforce workspace/session/profile binding.
- Cancel or discard stale work.
- Avoid duplicate concurrent refreshes.
- Report failures and latency.

Reuse existing runtime infrastructure if it satisfies these
requirements. Do not assume a host supports background execution merely
because it supports prompt hooks. If no safe deferred execution
mechanism is proven, keep model-assisted modes OFF and use Native.

------------------------------------------------------------------------

# 11. Feature Flags and Rollout Modes

## 11.1 Mode Definitions

``` typescript
type AdaptiveActivationMode = "native" | "shadow" | "live";
```

### Native

Default mode:

- No external model calls.
- Existing selection behavior remains authoritative.
- No Model-assisted result changes the injected set.

### Shadow

- Native produces the actual prompt contribution.
- Deferred Model-assisted work computes a comparison result.
- Model result is not injected.
- Differences and evidence are recorded.
- Owner explicitly opts into external context transmission.
- Shadow does not imply Live readiness.

### Live

- Uses a valid Model-assisted Working Set at a later prompt boundary.
- Still passes Runtime V2 activation revalidation, existing
  budget/packer, and renderer.
- Requires explicit Owner authorization per host profile/workspace.
- Any stale result, worker failure, validation error, or missing profile
  falls back to Native.
- No automatic promotion from Shadow.

## 11.2 Default Flags

| Feature                               | Default                              |
|:--------------------------------------|:-------------------------------------|
| Adaptive Activation                   | OFF / Native                         |
| Decision Model                        | OFF                                  |
| General Selector Model                | OFF                                  |
| Shadow Mode                           | OFF                                  |
| Live Mode                             | OFF                                  |
| Working Set Persistence               | OFF until storage gate passes        |
| Host Adapter Model-assisted execution | OFF                                  |
| Current Focus Repair                  | Separate authorized maintenance task |
| Intent Engineering                    | Existing default OFF                 |
| External Context Transmission         | Explicit Opt-in                      |
| Codex TUI                             | Disabled / NOT_RUN                   |
| WorkBuddy Desktop/IDE                 | Disabled / NOT_RUN                   |
| OpenClaw reply `/reset`               | Not relied upon / NOT_RUN            |
| OpenClaw ordinary Gateway turn        | Not relied upon / NOT_RUN            |

------------------------------------------------------------------------

# 12. Host Runtime Capability Profiles

## 12.1 Host Profile Is a Hard Contract

A Host Runtime Capability Profile binds a specific combination of:

- Host kind.
- Host version.
- PD adapter/plugin version.
- Runtime mode.
- Source event.
- Hook timeout and failure semantics.
- PD’s own configured hook budget.
- Injection channel.
- Identity capabilities.
- Evidence references and verification date.

A host name alone is not a profile. `Codex headless CLI` and
`Codex interactive TUI` are different profiles. `WorkBuddy lite-wb CLI`
and `WorkBuddy Desktop` are different profiles.

## 12.2 Profile Contract

``` typescript
interface HostRuntimeCapabilityProfile {
  profileId: string;
  revision: string;

  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  pdAdapterVersion?: string;
  installedPluginVersion?: string;
  runtimeMode: string;

  beforeModelTurn: {
    sourceEvent: string;
    verified: boolean;
    evidenceGrade: "E3" | "SOURCE_CONFIRMED" | "NOT_RUN";
  };

  identity: {
    workspaceId: "verified" | "partial" | "unavailable";
    sessionId: "verified" | "partial" | "unavailable";
    turnId: "verified" | "partial" | "unavailable";
    deduplication: "verified" | "partial" | "unavailable";
  };

  timing: {
    hostHookTimeoutMs?: number;
    pdConfiguredHookBudgetMs?: number;
    pdMeasuredP95Ms?: number;
    pdMeasuredP99Ms?: number;
    softDeadlineMs?: number;
  };

  failureSemantics:
    | "fail_open"
    | "block_submission"
    | "hook_failed_turn_continues"
    | "unknown";

  injection: {
    channel: "system" | "developer" | "user_prefix" | "unknown";
    confirmed: boolean;
    encodingContract: string;
  };

  verifiedAt: string;
  evidenceReferences: string[];
  status: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "NOT_RUN" | "EXPIRED";
}
```

The profile is evidence-bound. A version change, runtime-mode change,
adapter change, or event-contract change invalidates the relevant
verification until rechecked.

## 12.3 Verified Host Matrix

The table below is scoped to the exact runtime modes tested by Host
Event Capability Matrix v0.1.

| Host/runtime profile              | Verified events                                                                                                                                      | Hook-to-request observation                                                                                | Host timeout / failure                                                                 | PD configured budget                                                       | Injection channel                                         | Status                                  |
|:----------------------------------|:-----------------------------------------------------------------------------------------------------------------------------------------------------|:-----------------------------------------------------------------------------------------------------------|:---------------------------------------------------------------------------------------|:---------------------------------------------------------------------------|:----------------------------------------------------------|:----------------------------------------|
| Codex 0.166.0 headless CLI        | `UserPromptSubmit` 8/8; `SessionStart` 8/8; `Stop` 8/8                                                                                               | UPS to model request: +58–68 ms; median 60 ms                                                              | Host default 600 s; timeout marks hook failed, turn continues                          | PD UPS 5 s                                                                 | `developer` via `additionalContext`                       | VERIFIED-E3                             |
| Codex interactive TUI             | Not run                                                                                                                                              | —                                                                                                          | Host default 600 s; PD configured 5 s                                                  | 5 s                                                                        | Not independently verified in TUI                         | NOT_RUN: ConPTY/TTY driver unavailable  |
| WorkBuddy 5.9.2 `lite-wb` CLI     | `UserPromptSubmit` 3/3; `SessionStart` 3/3; concurrent; no guaranteed ordering                                                                       | Start-to-request +108–204 ms; hook-end-to-request +87–183 ms                                               | Tested hook timeout 30 s; timeout blocks submission and mock receives no model request | Canonical PD runtime UPS 15 s; installed marketplace cache 0.2.0 uses 30 s | Injection occurred; role/channel UNKNOWN                  | VERIFIED-E3, version-sensitive          |
| WorkBuddy Desktop/IDE             | Not run                                                                                                                                              | —                                                                                                          | Official IDE documentation is not runtime evidence for this isolated Desktop profile   | Do not assume                                                              | Unknown                                                   | NOT_RUN: isolation not proven           |
| OpenClaw 2026.10.10 embedded      | `before_prompt_build`, `before_tool_call`, `after_tool_call`, `llm_output`, `before_compaction`, `after_compaction`, `before_message_write` observed | `before_prompt_build` to model request +871–1846 ms in normal turns; +145–390 ms in compaction retry turns | `before_prompt_build` host timeout 15 s; fail-open and request continues               | PD-specific internal budget NOT ESTABLISHED by this probe                  | `system` body + `user` prefix for short dynamic directive | VERIFIED-E3 for tested embedded profile |
| OpenClaw Gateway `sessions.reset` | `before_reset`, `session_end`, `session_start` 4/4/4; order verified                                                                                 | Reset-to-end 12–17 ms; end-to-start 0–1 ms                                                                 | `session_start` has no default timeout in the inspected source                         | Not applicable to prompt hook budget                                       | Not a prompt-delivery profile                             | VERIFIED-E3 for this reset path only    |
| OpenClaw reply `/reset`           | Not run                                                                                                                                              | —                                                                                                          | Unknown                                                                                | Unknown                                                                    | Unknown                                                   | NOT_RUN                                 |
| OpenClaw ordinary Gateway turn    | Not run by this matrix                                                                                                                               | —                                                                                                          | Unknown                                                                                | Unknown                                                                    | Unknown                                                   | NOT_RUN                                 |

### Evidence interpretation

- The probe’s own callback duration was 0–1 ms for Codex and OpenClaw,
  and 21–27 ms for WorkBuddy. These are probe measurements, **not PD
  plugin measurements**.
- OpenClaw `before_prompt_build` was observed across 7 processes;
  repeated dispatch counts do not justify a 100% availability claim.
- WorkBuddy tool events were `NOT_RUN` because the mock response was
  rejected by that build. This is not evidence that those events are
  unsupported.
- WorkBuddy Desktop was not tested because isolation could not be
  proven.
- Codex TUI was not tested because the available environment lacked a
  reliable ConPTY/TTY driver.
- OpenClaw reply `/reset` and ordinary Gateway turn were not tested.
- `SessionStart` must not be used to count sessions: Codex `resume` can
  trigger it again.

## 12.4 Host-specific Execution Rules

### Codex headless CLI

- Only the headless CLI profile is verified.
- The synchronous PD `UserPromptSubmit` budget is 5 s, despite the host
  outer timeout being 600 s.
- The hook may perform bounded local reads, validation, Native
  selection, budget packing, and rendering.
- It MUST NOT wait for remote Decision Model or Selector inference.
- Do not depend on Codex tool hooks; the tested Codex hook set does not
  provide tool events.
- Injection is `developer` via `additionalContext`; do not describe it
  as system-level.
- TUI remains disabled until independently tested.

### WorkBuddy `lite-wb` CLI

- Only the `lite-wb` CLI profile is verified.
- Use `UserPromptSubmit` as the prompt-boundary event.
- `SessionStart` and `UserPromptSubmit` are concurrent; do not depend on
  their order.
- Only depend on `UserPromptSubmit` and `SessionStart` where necessary;
  do not use unverified tool/compaction events as design inputs.
- Timeout can block the user’s submission. Fail fast and return a safe
  degraded result well before the effective deadline.
- Resolve the actual installed PD plugin version and its configured
  timeout. Canonical runtime UPS budget is 15 s; the tested local
  marketplace cache 0.2.0 is 30 s. Never infer one from the repository
  version alone.
- Injection was observed, but message role/channel is unknown. All
  injected content must be self-contained and must not rely on a
  system/developer priority assumption.
- Desktop/IDE remains excluded.

### OpenClaw embedded

- Use the typed hook API verified by the probe (`api.on(...)`); do not
  use the legacy `api.registerHook(...)` path for typed lifecycle
  events.
- `before_prompt_build` maps to the internal `BEFORE_MODEL_TURN` event
  for the verified embedded profile.
- Host hook timeout is 15 s and failure is fail-open: the model request
  can proceed while the injection is silently skipped.
- PD must record its own delivery result; absence of a host error is not
  success evidence.
- Use `prependSystemContext` for the main principle content and
  `prependContext` for short dynamic user-prefix directives, as
  supported by the verified injection path.
- Keep injected content self-contained. Do not assume that every
  instruction in a system channel is automatically followed.
- Do not rely on `turn_complete`; it was not present in the tested
  OpenClaw version. `llm_output` is a different event and must not be
  treated as semantically equivalent.
- Gateway reset lifecycle evidence is restricted to `sessions.reset`; do
  not extrapolate to reply `/reset` or ordinary Gateway turns.

## 12.5 Host Integration Rules

1.  Use only real host-provided events.
2.  Do not simulate missing events.
3.  Do not fabricate turn ordinals, session IDs, or workspace IDs.
4.  Do not make a host-specific behavior a shared-runtime precondition.
5.  Do not wait for external model inference in the synchronous prompt
    hook.
6.  Use the current valid Working Set or Native when deferred results
    are unavailable.
7.  A host/mode without verified prompt event, identity, timeout, and
    injection contract cannot enter Model-assisted Live.
8.  Keep `NOT_RUN` distinct from failure and unsupported capability.
9.  Reverify profiles after host, adapter, or installed plugin version
    changes.
10. Never use a different runtime mode’s evidence to fill a `NOT_RUN`
    cell.

------------------------------------------------------------------------

# 13. Host-specific Prompt Injection Contract

## 13.1 Shared Selection Result, Host-specific Encoding

The Selector and Working Set Resolver produce one validated,
host-independent semantic selection result. Each adapter encodes that
result using the exact channel and return contract supported by its
verified profile.

Do not duplicate Selector logic per host. Do not share one injection
template across hosts.

## 13.2 Channel Matrix

| Host profile            | Verified injection channel                         | Contract                                                                                                             |
|:------------------------|:---------------------------------------------------|:---------------------------------------------------------------------------------------------------------------------|
| OpenClaw embedded       | `system` main body + `user` prefix short directive | Main principles via `prependSystemContext`; short dynamic directives via `prependContext`                            |
| Codex headless CLI      | `developer`                                        | Use `additionalContext`; do not claim system priority                                                                |
| WorkBuddy `lite-wb` CLI | Unknown                                            | Injection occurred, but role/channel is not established; use self-contained text and avoid role-priority assumptions |
| Unverified modes        | Unknown                                            | Model-assisted Live disabled                                                                                         |

## 13.3 Injection Content Rules

- Preserve Principle Artifact meaning; do not rewrite the principle into
  a new policy.
- Keep dynamic directives short and separately attributable.
- Do not inject model reasoning or free-form selector explanations as
  commands.
- Make content self-contained.
- Respect each host’s actual output-size constraints.
- Use existing Renderer and escaping/sanitization rules.
- Do not assume message role or precedence beyond the verified profile.

## 13.4 Delivery Status

The adapter must report what it can actually prove:

- `returned`: adapter returned the injection payload to the host
  callback.
- `confirmed`: independent evidence confirms the payload entered the
  current model request.
- `skipped`: deliberately did not contribute content.
- `timeout`: the adapter/PD deadline was exceeded.
- `failed`: the adapter returned an execution/encoding error.
- `unknown`: available evidence cannot establish the result.

`returned` is not equivalent to `confirmed`.

`confirmed` is not equivalent to the model understanding or following
the principle.

------------------------------------------------------------------------

# 14. Execution and Failure Handling

## 14.1 Synchronous Hook Policy

The synchronous hook critical path is limited to:

1.  Resolve the exact Host Runtime Capability Profile.
2.  Normalize the verified source event.
3.  Read minimal context using pure readers.
4.  Read the valid Session Working Set, if any.
5.  Read currently eligible activated principles.
6.  Revalidate cached principle IDs against Runtime V2.
7.  Choose a valid cached Model-assisted set only when explicitly
    Live-enabled and still valid; otherwise use Native.
8.  Apply existing Prompt Capacity Budget/Packer.
9.  Render and encode using the host adapter.
10. Write a bounded, non-blocking receipt or a safe local evidence
    record.
11. Return before the profile-specific soft deadline.

No synchronous Decision Model or General Selector call is permitted by
default.

## 14.2 Deferred Refresh

When a verified non-blocking worker exists:

- Current prompt uses current valid Working Set or Native.
- Worker performs Decision Model and, if needed, General Selector.
- Worker result is bound to workspace, host profile, session, context
  fingerprint, activation revision, and expected Working Set revision.
- Result applies only at a later prompt boundary.
- Stale results are discarded.
- Background work never edits a prompt already submitted.
- Worker failure leaves current prompt behavior unchanged.

If a safe worker cannot be demonstrated using existing PD
infrastructure, Shadow and Live remain OFF. Do not invent host
background capability.

## 14.3 Host-specific Failure Semantics

| Host profile            |                 Host timeout | Host behavior on timeout                            | PD consequence                                                | Required policy                                                                               |
|:------------------------|-----------------------------:|:----------------------------------------------------|:--------------------------------------------------------------|:----------------------------------------------------------------------------------------------|
| Codex headless CLI      |           600 s host default | Hook marked failed; turn continues                  | PD UPS is configured for 5 s                                  | PD must honor its own 5 s budget; local-only synchronous path                                 |
| WorkBuddy `lite-wb` CLI | 30 s in tested configuration | Submission blocked; model request not sent          | Canonical PD UPS budget 15 s; installed cache 0.2.0 uses 30 s | Fail-fast; resolve actual installed version; soft deadline materially below effective timeout |
| OpenClaw embedded       |   15 s `before_prompt_build` | Fail-open; hook skipped and model request continues | PD internal budget not established                            | Measure PD path; return well before host deadline; always record delivery outcome             |

These are not interchangeable global constants.

## 14.4 Soft Deadline Resolution

The adapter must resolve a per-profile soft deadline:

``` typescript
interface ResolvedExecutionBudget {
  hostHookTimeoutMs: number;
  pdConfiguredHookBudgetMs?: number;
  measuredSafeBudgetMs?: number;
  safetyMarginMs: number;
  softDeadlineMs: number;
  source: "installed_config" | "source_confirmed" | "measured";
}
```

Rules:

- Use the actual installed host/plugin version, not a guessed canonical
  value.
- `softDeadlineMs` must be lower than every applicable hard limit.
- If PD’s own measured safe budget is unknown, do not infer it from
  probe callback duration.
- Until PD Hook Performance Probe passes, only a minimal Native path may
  be considered for a verified host; Model-assisted Live remains
  blocked.
- Do not set a global hook timeout.
- The exact safety margin is an implementation parameter to be
  calibrated from PD p95/p99 and worst-case measurements; it is not
  prescribed as an unsupported fixed number in this SPEC.

## 14.5 Failure Matrix

| Failure                       | Required behavior                                                               |
|:------------------------------|:--------------------------------------------------------------------------------|
| Decision Model not configured | Native                                                                          |
| Selector Model not configured | Native                                                                          |
| Deferred worker unavailable   | Native; Shadow/Live remain disabled                                             |
| Provider unavailable          | Keep current valid Working Set or Native                                        |
| Worker timeout                | Discard result; keep current valid set or Native                                |
| Invalid JSON/schema           | Reject model result                                                             |
| Unknown Principle ID          | Reject model result                                                             |
| Inactive Principle            | Reject candidate                                                                |
| Invalid Artifact              | Reject candidate                                                                |
| Low confidence                | Keep valid existing set or Native                                               |
| `NONE_APPLICABLE`             | Valid empty model-assisted selection, subject to explicit validation            |
| Context unavailable           | Native                                                                          |
| Workspace Focus unavailable   | Continue without Focus                                                          |
| INTENT disabled               | Do not read Intent                                                              |
| Storage conflict              | Do not commit stale result                                                      |
| Session identity unreliable   | Disable persisted Model-assisted Live; Native                                   |
| Workspace identity unreliable | Disable persisted Model-assisted Live; Native                                   |
| Candidate pool overflow       | Native                                                                          |
| Prompt capacity overflow      | Existing Packer behavior                                                        |
| Host hook timeout             | Respect exact host behavior; record timeout if possible                         |
| OpenClaw silent fail-open     | Do not infer delivery; record `timeout`/`unknown` based on PD’s own observation |
| WorkBuddy timeout             | Treat as potential submission loss; fail fast before host deadline              |
| Codex hook failure            | Turn may continue; record hook failure and do not claim delivery                |
| Host profile mismatch         | Reject profile; Native only if safe and supported                               |

## 14.6 Fail-open Boundary

Fail-open means Adaptive Activation failure does not prevent the
existing host/Native path from proceeding where the host allows it.

It does not mean:

- Ignore governance.
- Accept invalid artifacts.
- Bypass Activation Validation.
- Inject unauthorized principles.
- Reuse stale cross-session state.
- Treat unknown delivery as success.

Governance and authorization checks remain fail-closed.

------------------------------------------------------------------------

# 15. Activation Receipt, Observability, and Evidence

## 15.1 Four Evidence Stages

The evidence chain must distinguish:

1.  **Governance Activation** — Is the principle authorized and active?
2.  **Runtime Selection** — Was it selected for this task and why?
3.  **Prompt Delivery** — Was it rendered, returned, and independently
    confirmed in the current request?
4.  **Behavioral Effect** — Did it change host behavior, as
    independently assessed by Examiner?

A success at one stage does not prove the next stage.

## 15.2 Required Receipt Contract

Reuse existing Receipt/Evidence infrastructure. Extend it only where
required.

``` typescript
interface AdaptiveActivationReceipt {
  receiptId: string;
  timestamp: string;

  host: {
    kind: "openclaw" | "codex" | "workbuddy";
    hostVersion: string;
    adapterVersion?: string;
    installedPluginVersion?: string;
    runtimeMode: string;
    profileId: string;
    profileRevision: string;
    sourceEvent: string;
  };

  identity: {
    workspaceHash?: string;
    sessionHash?: string;
    turnId?: string;
  };

  governance: {
    eligiblePrincipleIds: string[];
    activationRevision?: string;
    validationStatus: "valid" | "invalid" | "unknown";
  };

  selection: {
    mode: "native" | "model-assisted";
    selectedPrincipleIds: string[];
    decisionType?: TaskChangeType;
    decisionReason?: string;
    selectionReason?: string;
    confidence?: number;
    workingSetRevision?: number;
    contextFingerprint?: string;
  };

  delivery: {
    renderStatus: "rendered" | "skipped" | "failed" | "unknown";
    injectionStatus:
      | "returned"
      | "confirmed"
      | "skipped"
      | "timeout"
      | "failed"
      | "unknown";
    injectionChannel: "system" | "developer" | "user_prefix" | "unknown";
    elapsedMs?: number;
    timeoutStatus?: string;
    evidenceReference?: string;
  };

  fallbackReason?: string;
}
```

Do not store raw conversation, API keys, or full model chain-of-thought
in this receipt.

## 15.3 Required Events

Retain and extend the v0.3 event set:

``` typescript
type AdaptiveActivationEvent =
  | "adaptive_check_triggered"
  | "decision_model_enqueued"
  | "decision_model_started"
  | "decision_model_completed"
  | "selector_enqueued"
  | "selector_started"
  | "selector_completed"
  | "selection_validated"
  | "working_set_updated"
  | "working_set_reused"
  | "native_fallback"
  | "prompt_rendered"
  | "injection_returned"
  | "injection_confirmed"
  | "injection_skipped"
  | "injection_timeout"
  | "injection_failed";
```

Each event should include, where available:

- Timestamp.
- Workspace/session hashes.
- Host kind/version/runtime mode.
- Host profile ID/revision.
- Original source event.
- Trigger type.
- Selection mode.
- Model profile/version.
- Latency.
- Token usage, when available.
- Working Set revision.
- Selected Principle IDs.
- Fallback reason.
- Evidence reference.

## 15.4 Evidence Semantics

| Evidence               | What it proves                                                        | What it does not prove                                         |
|:-----------------------|:----------------------------------------------------------------------|:---------------------------------------------------------------|
| Governance eligibility | Principle is currently authorized                                     | It was selected                                                |
| Selection decision     | Selector chose a principle                                            | It passed validation                                           |
| Selection validation   | Candidate IDs and activation passed checks                            | It was rendered                                                |
| Prompt rendered        | Renderer produced content                                             | Adapter returned it                                            |
| `returned`             | Adapter returned payload to host callback                             | Host included it in the model request                          |
| `confirmed`            | Independent evidence confirms content entered the current request     | Model understood or followed it                                |
| Behavioral Effect      | Examiner observed a behavior difference under its evaluation protocol | Long-term improvement unless longitudinal evidence supports it |

Do not infer `confirmed` from `returned`, absence of an exception, or a
host’s fail-open behavior.

## 15.5 Host-specific Delivery Evidence

- **OpenClaw:** because timeout can silently skip injection while the
  request proceeds, PD must write its own receipt. A callback return may
  be `returned`; only request-level evidence such as a verified request
  diff or equivalent may be `confirmed`.
- **Codex:** record the `additionalContext`/developer contribution and
  its hook result. Do not label it system-level. If no independent
  request evidence exists for a run, use `returned` or `unknown`, not
  `confirmed`.
- **WorkBuddy:** record that injection occurred where supported by probe
  evidence, but set channel to `unknown` until the exact message role is
  proven. Do not infer priority from the unknown channel.

## 15.6 Examiner Integration

Examiner reuses:

- Task context and context fingerprint.
- Decision Model classification.
- Selector result.
- Working Set revision.
- Prompt delivery receipt.
- Subsequent host behavior.
- Independent behavioral evaluation evidence.

Examiner must separately evaluate:

1.  Was principle selection correct?
2.  Was the principle delivered to the model request?
3.  Did the host behavior change?
4.  Was the change consistent with the principle?
5.  Is the change attributable to activation rather than unrelated
    factors?
6.  Does the effect persist over time?

Adaptive Activation cannot self-certify its own behavioral effect.

------------------------------------------------------------------------

# 16. Security and Privacy

## 16.1 Principle Authority

All candidates must come from currently valid Runtime V2 Activation.
Selector is never an authority source.

## 16.2 Model Output

Treat all model output as untrusted:

- Schema validation.
- Candidate allowlist.
- Activation revalidation.
- Artifact revalidation.
- Output-size limits.
- Duplicate removal.
- Context/session/profile binding.
- Stale-result rejection.

No model output may directly enter host execution as arbitrary code or
an unvalidated instruction.

## 16.3 Prompt Injection Protection

User conversation, Workspace Focus, INTENT, and Candidate Cards are data
to be analyzed. They cannot override Selector system constraints.

Candidate text must be treated as data, not executable instructions.

## 16.4 Data Minimization

External models receive only the minimum context required.

Do not persist by default:

- Raw user conversation.
- Full model chain-of-thought.
- API keys.
- Unnecessary personal information.

Shadow also transmits context externally; therefore it requires explicit
Owner opt-in and data-egress policy.

## 16.5 Workspace and Session Isolation

Every model result must bind to:

- Workspace ID/hash.
- Host kind/version.
- Runtime mode.
- Host Profile ID/revision.
- Session ID/hash.
- Context fingerprint.
- Working Set revision.
- Relevant activation revision.

No cross-workspace or cross-session reuse without explicit identity
validation.

------------------------------------------------------------------------

# 17. Performance and Cost Budget

## 17.1 Performance Dimensions

Measure separately:

1.  Adapter callback overhead.
2.  Context snapshot read.
3.  Activation Reader query.
4.  Native Selector.
5.  Prompt Capacity Budget/Packer.
6.  Prompt Renderer.
7.  Host encoding/return.
8.  Receipt persistence.
9.  Deferred worker queue delay.
10. Decision Model latency.
11. General Selector latency.

The Host Matrix probe measured probe callback latency, not the PD
implementation. It cannot establish PD’s real latency.

## 17.2 Initial Targets and Constraints

| Metric                           | Initial target / constraint              |
|:---------------------------------|:-----------------------------------------|
| Per-message Decision Model calls | 0 by default                             |
| Decision worker timeout          | 1.5 s initial experiment                 |
| Selector worker timeout          | 3.0 s initial experiment                 |
| Maximum context input            | 12,000 chars initial                     |
| Maximum candidate cards          | 48 initial                               |
| Maximum selected principles      | 12 initial                               |
| Working Set idle TTL             | 24 h initial                             |
| Model failure                    | Must not block current prompt            |
| Native Selection                 | No additional model calls                |
| Synchronous hook                 | No external model inference              |
| Host execution budget            | Per verified profile; no global constant |
| Prompt capacity                  | Existing Model-aware Prompt Budget       |

The 1.5 s and 3.0 s model values apply only to deferred workers. They
must never be interpreted as host-hook deadlines.

## 17.3 Mandatory PD Hook Performance Probe

Before any Model-assisted activation implementation or Live rollout,
measure the actual PD path for each verified host profile.

Minimum measurements:

- Cold and warm process.
- Empty and populated Working Set.
- Small and maximum allowed candidate pool.
- Workspace Focus available/unavailable.
- Intent enabled/disabled.
- DB read latency.
- Activation validation latency.
- Native selection latency.
- Prompt budget/packing latency.
- Rendering/encoding latency.
- Receipt write latency.
- p50, p95, p99, and worst observed duration.
- Timeout/failure injection.
- Large transcript and context truncation.
- Concurrent refresh/read contention.

Report separately:

- PD internal execution time.
- Host callback wall-clock time.
- Hook-to-model-request timing.
- Deferred worker queue delay.
- Model inference time.

Do not use the probe’s 0–27 ms callback duration as a substitute.

## 17.4 Per-host Performance Constraints

- **Codex:** PD `UserPromptSubmit` configured budget is 5 s. Synchronous
  path is local-only. The host’s 600 s outer timeout does not grant PD a
  600 s budget.
- **WorkBuddy:** actual installed version determines PD’s own timeout
  (canonical 15 s; locally observed cached 0.2.0 is 30 s). Because
  timeout blocks submission, use a conservative soft deadline materially
  below the effective budget. The exact safe value must come from PD
  performance measurements.
- **OpenClaw:** host `before_prompt_build` timeout is 15 s and
  fail-open. PD’s own safe internal budget remains unmeasured. The
  adapter must return early enough to preserve a reliable safety margin;
  do not assume the full 15 s is available.

## 17.5 Cost Control

Record:

- Decision calls per 100 observed prompt events.
- Selector calls per 100 observed prompt events.
- Average input/output tokens.
- Cost per task change.
- Stale-result discard rate.
- Shadow vs Live cost.
- Queue backlog and refresh coalescing.

Optimization order:

1.  Avoid unnecessary Decision calls.
2.  Bound context.
3.  Avoid duplicate refreshes.
4.  Reuse valid Working Sets.
5.  Use a lower-cost Decision Model when quality remains acceptable.

Do not reduce principle understanding quality solely to minimize token
cost.

------------------------------------------------------------------------

# 18. Evaluation and Experiments

## 18.1 Evaluation Objectives

Evaluate four independent questions:

- E1 — Task Change Detection.
- E2 — Principle Selection.
- E3 — Selection Stability.
- E4 — Runtime Efficiency and host safety.

Add E5 — Delivery Evidence Integrity: can the system distinguish
rendered, returned, and confirmed delivery?

## 18.2 Test Dataset

Retain v0.3 scenario families:

| Scenario                      | Purpose                         |
|:------------------------------|:--------------------------------|
| Same Task / Different Wording | Task stability                  |
| New Task                      | Task switch                     |
| Goal Shift                    | Goal-change detection           |
| Phase Shift                   | Phase-change detection          |
| Multi-task                    | Multi-principle selection       |
| Abstract Principle            | Abstract understanding          |
| Similar Principles            | Principle distinction           |
| Conflicting Principles        | Applicability boundaries        |
| Long Context                  | Context truncation              |
| Missing Focus                 | Degradation                     |
| No Applicable Principle       | Empty-set correctness           |
| Invalid Candidate             | Governance/allowlist validation |

Initial dataset recommendation:

- 30 same-task scenarios.
- 30 task-change scenarios.
- 40 principle-selection scenarios.

Ground truth must be supplied by Owner or an independent reviewer.
Report sample size and uncertainty; do not claim reliability from a
small sample.

## 18.3 Decision Metrics

| Metric             | Description                                  |
|:-------------------|:---------------------------------------------|
| Change Precision   | Correct positive task-change classifications |
| Change Recall      | True changes detected                        |
| False Refresh Rate | Unnecessary re-selection                     |
| Missed Goal Shift  | Missed goal changes                          |
| Decision Latency   | Deferred decision duration                   |
| Decision Cost      | Per-decision cost                            |
| Stale Result Rate  | Results discarded because context changed    |

Initial Shadow thresholds retained from v0.3:

- Change Precision \>= 0.90.
- Change Recall \>= 0.85.
- False Refresh Rate \<= 0.10.

These are proposed initial gates, not proven optimal thresholds.
Interpret with sample size and confidence intervals.

## 18.4 Selector Metrics

| Metric                    | Description                         |
|:--------------------------|:------------------------------------|
| Precision@K               | Correct principles among selected   |
| Recall@K                  | Coverage of relevant principles     |
| NDCG@K                    | Ranking quality                     |
| Critical Principle Recall | Coverage of critical principles     |
| Invalid ID Rate           | Unauthorized/non-candidate IDs      |
| Empty Selection Accuracy  | Correct `NONE_APPLICABLE` decisions |
| Selection Stability       | Unnecessary Working Set changes     |

Initial targets retained:

- Precision@K \>= 0.80.
- Critical Principle Recall \>= 0.90.
- Invalid ID Rate = 0.
- NDCG@K \>= 0.75.

## 18.5 Delivery Metrics

Add:

- Rendered-to-returned rate.
- Returned-to-confirmed rate, where confirmation evidence exists.
- Unknown delivery rate.
- Host timeout rate.
- Host profile mismatch rate.
- Prompt channel correctness.
- Duplicate injection rate.
- Cross-session contamination rate (must be zero).

Do not score `unknown` as success or failure without additional
evidence.

## 18.6 Native vs Model-assisted Comparison

Compare:

1.  Native Selection.
2.  Model-assisted selection in Shadow.
3.  Model-assisted selection passed through the existing Packer.

Observe:

- Relevant principle coverage.
- Irrelevant principle ratio.
- Prompt characters/tokens.
- Conflicting principles.
- Task-change response delay.
- Selection stability.
- Model cost.
- Delivery status and host-specific failures.

------------------------------------------------------------------------

# 19. Rollout Plan and Gates

## Phase 0 — Evidence and Architecture Baseline

Status: Host Event Capability Matrix v0.1 completed for the stated
runtime modes. This does not mean all host modes are verified.

Tasks:

1.  Freeze the Host Matrix evidence references and version/mode scope.
2.  Create exact Host Runtime Capability Profiles for Codex headless,
    WorkBuddy `lite-wb`, and OpenClaw embedded.
3.  Keep Codex TUI, WorkBuddy Desktop/IDE, OpenClaw reply `/reset`, and
    ordinary Gateway turn as `NOT_RUN`.
4.  Audit stable Workspace/Session identity per profile.
5.  Audit existing async worker capability.
6.  Audit SQLite storage ownership.
7.  Confirm Activation Reader extension contract.
8.  Confirm internal Agent registration and Profile Binding.
9.  Verify host-specific injection contracts.

Gate 0:

- Exact profile exists.
- Event and identity evidence is adequate.
- Timeout and failure behavior is documented.
- No unverified mode is silently included.
- Storage and deferred worker ownership are understood.

No Live implementation before Gate 0.

## Phase 1 — Current Focus / Workspace Focus Repair

Tasks:

1.  Complete `currentTask` extraction.
2.  Complete restore/parsing.
3.  Fix latest-message truncation.
4.  Separate pure Reader from Maintainer.
5.  Preserve Owner-authored content.
6.  Enforce Workspace/Session isolation.
7.  Add tests.
8.  Verify existing OpenClaw behavior does not regress.

Gate 1:

Workspace Focus can be read and restored reliably, without overwriting
Owner content. Unverified host lifecycle events are not required.

## Phase 2 — PD Hook Performance Probe

Tasks:

1.  Measure real PD hook path on each verified profile.
2.  Measure DB, activation reader, Native selection, Packer, Renderer,
    adapter, receipt.
3.  Measure p50/p95/p99 and worst observed time.
4.  Exercise timeout and storage contention.
5.  Set profile-specific soft deadlines from evidence.
6.  Verify the host failure behavior remains safe.

Gate 2:

The real PD hook path has evidence-backed safe execution budgets. Until
then, no Model-assisted Live.

## Phase 3 — Host Adapter Contract Verification + Native Foundation

Tasks:

1.  Implement/verify canonical event envelope.
2.  Implement exact host profile resolution.
3.  Connect existing Activation Reader.
4.  Connect existing Native Selection.
5.  Connect Working Set read path only after storage gate.
6.  Reuse existing Packer and Renderer.
7.  Implement host-specific injection encoder.
8.  Record delivery receipts.
9.  Test Native compatibility and no duplicate injection.

Gate 3:

Native path is compatible with the existing production path; host
contracts are verified; no governance boundary changes; no prompt
blockage; delivery statuses are honest.

## Phase 4 — Model-assisted Shadow

Tasks:

1.  Verify safe deferred worker.
2.  Register `principle_decision`.
3.  Register `principle_selector`.
4.  Reuse Pi AI Runtime.
5.  Implement Decision Model.
6.  Implement multi-label Selector.
7.  Implement Candidate Validation.
8.  Implement versioned Working Set refresh.
9.  Record Shadow results and stale-result discards.
10. Obtain explicit external data-transmission authorization.
11. Run the evaluation dataset.

Gate 4:

- Decision and Selector quality gates pass.
- No governance bypass.
- No cross-session leakage.
- No stale result commit.
- Worker cannot block prompt hook.
- Host delivery remains Native in Shadow.

## Phase 5 — Controlled Live

Prerequisites:

- Explicit Owner authorization.
- Gates 0–4 pass.
- Exact host profile verified.
- PD hook performance evidence passes.
- Worker and model failure paths pass.
- Session/workspace isolation passes.
- External data egress is authorized.
- Delivery Receipt can distinguish `returned` from `confirmed`.
- Rollback to Native is tested.

Live is enabled only for explicitly selected host profiles and
workspaces.

Gate 5:

No unauthorized principle, cross-session contamination, prompt blockage,
unverified host behavior, or governance bypass.

## Phase 6 — Examiner Evaluation

Evaluate separately:

1.  Was the principle selection correct?
2.  Was the selected principle delivered?
3.  Did the host follow it?
4.  Did behavior improve?
5.  Is the effect attributable?
6.  Does the effect persist?

Do not use the first three as substitutes for the last three.

------------------------------------------------------------------------

# 20. Acceptance Criteria

## A. Governance

- [ ] Runtime V2 remains the sole activation authority.
- [ ] Selector cannot activate or deactivate principles.
- [ ] Selector cannot bypass Artifact Validation.
- [ ] Invalid principles cannot enter the prompt.
- [ ] Host Adapter cannot change governance semantics.

## B. Native Mode

- [ ] No external model is required.
- [ ] Existing Native Prompt Selection has no regression.
- [ ] Existing Prompt Capacity Budget/Packer works.
- [ ] `fair_rotation_v1` claims remain within verified scope.
- [ ] No fake host turn ordinal is created.
- [ ] No model call is added per user message.

## C. Model-assisted Mode

- [ ] Decision Model supports all five change types.
- [ ] General Selector supports multi-label selection.
- [ ] Model outputs pass Candidate Validation.
- [ ] `NONE_APPLICABLE` is supported.
- [ ] Model failure falls back safely.
- [ ] Synchronous hook does not wait for external model inference.
- [ ] Shadow never changes actual injection.
- [ ] Live requires explicit Owner authorization.
- [ ] No safe worker means Model-assisted modes remain OFF.

## D. Working Set

- [ ] State is scoped by workspace, host profile, and session.
- [ ] Same-session state can be restored.
- [ ] Different sessions remain isolated.
- [ ] Concurrent updates cannot overwrite newer state.
- [ ] Stale/expired state is not used for Live.
- [ ] Raw user conversation is not persisted.
- [ ] Installed host/plugin profile changes invalidate stale state.

## E. Workspace Focus

- [ ] `currentTask` can be extracted.
- [ ] `currentTask` can be restored.
- [ ] Latest conversation is not lost through head truncation.
- [ ] Owner-authored content is preserved.
- [ ] Selector uses a pure read-only interface.
- [ ] Workspace and Session state are isolated.

## F. Host Compatibility

- [ ] Codex headless CLI profile is verified.
- [ ] WorkBuddy `lite-wb` CLI profile is verified.
- [ ] OpenClaw embedded profile is verified.
- [ ] OpenClaw Gateway reset profile is limited to `sessions.reset`.
- [ ] Each profile records exact host/plugin version and runtime mode.
- [ ] Each profile records timeout and failure semantics.
- [ ] Each profile records injection channel and evidence grade.
- [ ] Codex TUI remains disabled until separately verified.
- [ ] WorkBuddy Desktop/IDE remains disabled until isolation and runtime
  are verified.
- [ ] OpenClaw reply `/reset` and ordinary Gateway turn remain unclaimed
  until verified.
- [ ] No cross-mode evidence substitution.

## G. Execution Safety

- [ ] No synchronous external model call in the prompt hook.
- [ ] Hook execution budget and Prompt Capacity Budget are separate.
- [ ] PD’s actual hook performance has been measured.
- [ ] WorkBuddy fail-fast prevents reaching the submission-blocking
  timeout.
- [ ] OpenClaw fail-open cannot be mistaken for successful injection.
- [ ] Codex 5 s PD budget is honored despite the 600 s host timeout.
- [ ] Profile-specific soft deadlines are enforced.

## H. Evidence

- [ ] Governance eligibility is auditable.
- [ ] Selection decision and validation are auditable.
- [ ] Prompt rendering is auditable.
- [ ] Adapter return is auditable.
- [ ] Confirmed delivery requires independent evidence.
- [ ] Unknown delivery is not scored as confirmed.
- [ ] Working Set revision and fallback reason are traceable.
- [ ] Examiner distinguishes delivery from behavioral effect.

------------------------------------------------------------------------

# 21. Stop Conditions

Stop Live rollout and revert to Native if any of the following occurs:

1.  Selector returns an unauthorized Principle ID.
2.  Cross-session or cross-workspace Working Set contamination occurs.
3.  Model output bypasses governance validation.
4.  External inference blocks the synchronous host prompt hook.
5.  Workspace Focus overwrites Owner-authored content.
6.  Task-change detection exhibits severe systematic errors.
7.  Shadow data transmission lacks Owner authorization.
8.  Actual injection cannot be evidenced honestly.
9.  Native path regresses.
10. Model cost exceeds Owner budget.
11. Host version/profile changes without revalidation.
12. WorkBuddy timeout can block a user submission.
13. OpenClaw fail-open is incorrectly recorded as confirmed delivery.
14. A stale deferred result overwrites a newer Working Set.

On stop, return to Native without changing existing governance state.

------------------------------------------------------------------------

# 22. Open Questions

| ID    | Question                                                                                         | Required evidence / decision                   |
|:------|:-------------------------------------------------------------------------------------------------|:-----------------------------------------------|
| OQ-01 | Does Codex interactive TUI expose the same usable prompt hook as headless CLI?                   | Isolated TUI probe with reliable TTY/ConPTY    |
| OQ-02 | Does WorkBuddy Desktop/IDE expose the same prompt event and injection behavior as `lite-wb` CLI? | Isolation proof and real Desktop runtime probe |
| OQ-03 | Does OpenClaw reply `/reset` dispatch the same lifecycle events as Gateway `sessions.reset`?     | Separate reply-path probe                      |
| OQ-04 | Does ordinary OpenClaw Gateway turn dispatch the same `before_prompt_build` path?                | Separate Gateway turn probe                    |
| OQ-05 | What are the reliable Workspace and Session identity sources for each profile?                   | Identity/path audit                            |
| OQ-06 | Which existing PD worker can run deferred model refresh without blocking host hooks?             | Runtime capability and failure audit           |
| OQ-07 | Which SQLite database owns Working Set state?                                                    | Database ownership/migration audit             |
| OQ-08 | What are the real PD hook p95/p99 and worst-case timings?                                        | PD Hook Performance Probe                      |
| OQ-09 | What soft deadline and safety margin are safe per profile?                                       | PD performance data + host failure semantics   |
| OQ-10 | What is the best checkpoint interval?                                                            | Shadow evaluation                              |
| OQ-11 | Can a low-cost Decision Model reliably detect goal/phase changes?                                | Labeled evaluation                             |
| OQ-12 | Does General Selector understand abstract principles sufficiently?                               | Multi-label selection evaluation               |
| OQ-13 | Does candidate pool need to exceed 48?                                                           | Candidate distribution and overflow statistics |
| OQ-14 | Can all adapters independently confirm actual request delivery?                                  | Host-specific request evidence                 |
| OQ-15 | What is the exact WorkBuddy injection role/channel?                                              | Runtime request inspection                     |
| OQ-16 | What identity/deduplication semantics exist for periodic checkpoints?                            | Per-profile event correlation tests            |

------------------------------------------------------------------------

# 23. Architecture Decision Records

## ADR-001 — Runtime V2 Remains the Only Governance Authority

**Decision: ACCEPTED / RETAINED.**

Avoid two independent principle activation authorities.

## ADR-002 — Native and Model-assisted Coexist

**Decision: ACCEPTED / RETAINED.**

PD must remain operational without an external model.

## ADR-003 — Two-stage Model Architecture

**Decision: ACCEPTED / RETAINED, execution timing revised.**

Decision Model detects task changes. General Reasoning Model selects
abstract principles. Both execute outside the synchronous hook by
default.

## ADR-004 — Multi-label Selection

**Decision: ACCEPTED / RETAINED.**

Real tasks may require multiple complementary principles.

## ADR-005 — No Per-message LLM Invocation by Default

**Decision: ACCEPTED / STRENGTHENED.**

No synchronous per-message external model invocation. Deferred refresh
is subject to worker verification.

## ADR-006 — Current Focus Is Upgraded, Not Replaced

**Decision: ACCEPTED / RETAINED.**

Keep `CURRENT_FOCUS.md`; clarify its semantic role as Workspace Focus
and repair lifecycle/read behavior.

## ADR-007 — Three Context Levels

**Decision: ACCEPTED / RETAINED.**

INTENT, Workspace Focus, and Session Working Set remain independent.

## ADR-008 — Existing Budget and Renderer Reused

**Decision: ACCEPTED / CLARIFIED.**

Reuse Prompt Capacity Budget, Packer, and Renderer. Hook execution time
is a separate host-specific budget.

## ADR-009 — Host Capability Is a Hard Gate

**Decision: ACCEPTED / STRENGTHENED.**

A capability profile is bound to exact host version and runtime mode.
`NOT_RUN` is not support and not failure.

## ADR-010 — Shadow Before Live

**Decision: ACCEPTED / RETAINED.**

Prove selection quality and evidence integrity before changing real host
behavior.

## ADR-011 — Shared Core, Host-specific Adapter Contracts

**Decision: NEW — PROPOSED.**

Use one selection core with per-host event, timeout, failure, identity,
and injection contracts. Adapter cannot change governance or semantic
selection.

## ADR-012 — Model Inference Is Deferred from the Synchronous Hook

**Decision: NEW — PROPOSED.**

Current prompt uses valid cached state or Native. Deferred results may
affect only a later prompt boundary.

## ADR-013 — Delivery Evidence Is Separate from Selection and Behavioral Effect

**Decision: NEW — PROPOSED.**

`returned` is not `confirmed`; `confirmed` is not behavioral effect.
Examiner independently evaluates behavior.

## ADR-014 — Working Set Selector v0.2 Hold Is Preserved

**Decision: ACCEPTED / GOVERNANCE PRESERVED.**

This SPEC does not promote the Working Set Selector v0.2 proposal or
bypass its Phase 1/2 Hold conditions. Any activation of that proposal
remains subject to its own Owner gate and route-to-restart conditions.

------------------------------------------------------------------------

# 24. v0.3 → v0.4 Change Log

| v0.3 section              | v0.4 change                                                                           | Reason / evidence                                                                        |
|:--------------------------|:--------------------------------------------------------------------------------------|:-----------------------------------------------------------------------------------------|
| Metadata                  | Add Host Matrix evidence baseline and exact verified runtime scope                    | Prevent host/mode extrapolation                                                          |
| 0 Executive Summary       | Add evidence-driven host-aware premise                                                | Host Matrix v0.1                                                                         |
| 1 Goals                   | Add host-aware delivery and evidence separation                                       | New runtime integration constraints                                                      |
| 2.2 Existing Capabilities | Distinguish verified code, proposal, and unimplemented capabilities; retain WSS Hold  | Avoid claiming proposal is production                                                    |
| 2.4 Native Selection      | Clarify `fair_rotation_v1` scope and FIFO fallback                                    | Existing implementation notes and selector reality audit                                 |
| 2.6 Current Focus         | Rename semantic role to Workspace Focus while preserving file path                    | Separate workspace-level focus from session state                                        |
| 3 Core Architecture       | Add Host Adapter boundary; model path is deferred                                     | Three hosts have different runtime contracts                                             |
| 4 Context Model           | Preserve three layers and add provenance/profile metadata                             | Identity and isolation requirements                                                      |
| 5 Task Change Detection   | Add canonical `BEFORE_MODEL_TURN`; prohibit SessionStart dependency                   | Codex resume repeats; WorkBuddy event concurrency; OpenClaw event differences            |
| 5 Checkpoints             | Restrict turn counter to verified/deduplicated sequence                               | No fabricated host turn ordinal                                                          |
| 6 Selector                | Retain schemas and multi-label policy; strengthen validation and stale-result binding | Governance and concurrency safety                                                        |
| 7 Budget/Packing          | Separate Hook Execution Budget from Prompt Capacity Budget                            | Different resource dimensions                                                            |
| 7 Fair Rotation           | Preserve scope; no cross-host guarantee                                               | Existing host-specific implementation reality                                            |
| 8 Working Set             | Mark schema as logical proposal; add profile/version binding; require storage audit   | Not verified in production                                                               |
| 9 Current Focus           | Preserve Markdown artifact and ownership; add pure read contract                      | Existing Focus side effects and isolation gaps                                           |
| 10 Model Runtime          | Retain Pi AI Runtime; move 1.5s/3s to deferred worker targets                         | Prevent hook blocking                                                                    |
| 11 Flags                  | Keep all OFF; explicitly disable unverified modes                                     | Evidence-limited host scope                                                              |
| 12 Host Capability Gate   | Replace pending matrix with exact evidence-backed profile matrix                      | Host Matrix v0.1                                                                         |
| 12–13 Host Execution      | Add per-host budgets and failure semantics                                            | Codex 5s PD/600s host; WorkBuddy 15s canonical vs 30s cached/30s host; OpenClaw 15s host |
| 13 Prompt Injection       | Add per-host channel contract                                                         | OpenClaw system+user; Codex developer; WorkBuddy unknown                                 |
| 14 Failure Handling       | Prohibit synchronous model inference; require deferred worker verification            | WorkBuddy can block submission; OpenClaw fail-open; Codex hook failed but turn continues |
| 15 Observability          | Add explicit delivery statuses and Receipt contract                                   | returned ≠ confirmed                                                                     |
| 16 Performance            | Add mandatory real PD Hook Performance Probe                                          | Probe latency is not PD latency                                                          |
| 17 Evaluation             | Add delivery evidence metrics                                                         | Selection and delivery are separate                                                      |
| 18 Rollout                | Add PD performance and adapter verification gates                                     | Host Matrix Owner conditions                                                             |
| 19 Acceptance             | Add profile, timeout, channel, evidence, and no-blocking requirements                 | New runtime constraints                                                                  |
| 20 Stop Conditions        | Add host-profile mismatch, stale result, and delivery misclassification               | Failure prevention                                                                       |
| 21 Open Questions         | Replace stale host questions with precise NOT_RUN and implementation gaps             | Evidence update                                                                          |
| 22 ADRs                   | Retain original ten and add four decisions                                            | Host-aware/deferred/evidence boundaries                                                  |
| 23 Final Statement        | Clarify one decision core + adapters + evidence chain                                 | Consolidated architecture                                                                |

## 24.1 Explicitly Preserved from v0.3

The following remain unchanged in principle:

- Runtime V2 as sole governance authority.
- Native + Model-assisted dual path.
- Decision Model + General Reasoning Selector roles.
- Multi-label selection.
- `SAME_TASK`, `NEW_TASK`, `GOAL_SHIFT`, `PHASE_SHIFT`, `UNCERTAIN`.
- INTENT / Workspace Focus / Session Working Set separation.
- Existing Prompt Capacity Budget, Packer, and Renderer.
- Working Set revision and optimistic concurrency concept.
- Current Focus upgrade, not replacement.
- Pi AI Runtime and Runtime Profile reuse.
- Native default.
- Shadow before Live.
- External context transmission explicit opt-in.
- Candidate limits and initial evaluation targets, clearly labeled
  experimental.
- Examiner’s independent behavioral-effect evaluation.
- Working Set Selector v0.2 proposal status and Hold gates.

------------------------------------------------------------------------

# 25. Self-audit and Implementation Readiness

## 25.1 Consistency Audit

| Check                                                                          | Result |
|:-------------------------------------------------------------------------------|:-------|
| Runtime V2 remains sole activation authority                                   | PASS   |
| Selector cannot mutate governance                                              | PASS   |
| Native remains independent of external model                                   | PASS   |
| Two model roles retained                                                       | PASS   |
| Model inference removed from synchronous hook by default                       | PASS   |
| Host profile bound to exact version and mode                                   | PASS   |
| `BEFORE_MODEL_TURN` defined as internal abstraction, not fabricated host event | PASS   |
| Codex headless evidence not extrapolated to TUI                                | PASS   |
| WorkBuddy CLI evidence not extrapolated to Desktop                             | PASS   |
| OpenClaw reset evidence not extrapolated to reply/Gateway turn                 | PASS   |
| WorkBuddy concurrent SessionStart/UPS ordering represented                     | PASS   |
| SessionStart not used as session counter                                       | PASS   |
| Hook execution budget separated from prompt capacity                           | PASS   |
| Codex 5 s PD budget not confused with 600 s host timeout                       | PASS   |
| WorkBuddy canonical 15 s distinguished from cached 0.2.0 30 s                  | PASS   |
| OpenClaw PD internal budget remains pending                                    | PASS   |
| Probe callback time not represented as PD hook time                            | PASS   |
| Injection channels differentiated by host                                      | PASS   |
| WorkBuddy channel remains unknown                                              | PASS   |
| `returned` not treated as `confirmed`                                          | PASS   |
| Delivery not treated as behavioral effect                                      | PASS   |
| `fair_rotation_v1` scope retained                                              | PASS   |
| Working Set Selector v0.2 Hold not bypassed                                    | PASS   |
| All feature flags remain OFF by default                                        | PASS   |
| No production implementation/authorization implied                             | PASS   |

## 25.2 Evidence Limitations

This SPEC does not claim:

- Codex interactive TUI is verified.
- WorkBuddy Desktop/IDE is verified.
- WorkBuddy tool/compaction events are supported or unsupported.
- OpenClaw reply `/reset` is verified.
- OpenClaw ordinary Gateway turn is verified.
- WorkBuddy injection role/channel is known.
- PD’s actual hook latency is known.
- OpenClaw PD-specific internal hook budget is known.
- Cross-host fair rotation is implemented.
- A deferred worker is already proven safe.
- `principle_working_sets` exists in production.
- Model-assisted selection has passed Shadow evaluation.
- Principle activation has improved long-term host behavior.

## 25.3 Final Architectural Statement

**Governance decides which principles are allowed.**

**Decision Model decides when task context has materially changed.**

**General Reasoning Model decides which authorized principles are
relevant.**

**Native Selection keeps PD operational without external models.**

**Prompt Capacity Budget decides what can fit.**

**Host Adapter decides how a verified host receives the selected
content.**

**Receipt and Evidence record what was actually delivered.**

**Examiner determines whether the intervention changes host behavior.**

These responsibilities remain independent.

Adaptive Activation is not a new large subsystem. It is a task-aware
enhancement to the existing principle activation chain, constrained by
the real behavior of each host.

The final objective remains:

**At the right time, let the right authorized principles enter the right
task context through a verified host channel — and preserve enough
evidence to determine whether that intervention actually created
value.**

------------------------------------------------------------------------

**END OF SPEC v0.4**
