# PD Adaptive Activation SPEC v0.5

**Evidence-driven Host-aware Adaptive Activation --- Architecture &
Engineering Specification**

  ------------------------------------------------------------------------------------------------------------------------------
  Metadata                                                 Value
  -------------------------------------------------------- ---------------------------------------------------------------------
  Version                                                  v0.5

  Date                                                     2026-11-04

  Status                                                   Proposed --- Owner Review Required; not implementation authorization

  Owner                                                    PD Owner

  Repository                                               `csuzngjh/principles`

  Code audit baseline                                      `49a91651ab6c755f9074a653998951f4f88c0f43` (v0.4 baseline; historical
                                                           unless re-frozen)

  Host evidence baseline                                   OpenClaw / Codex evidence retained from v0.4; WorkBuddy superseded by
                                                           `PD_WORKBUDDY_HOST_AUDIT_v0.1.md` +
                                                           `PD_WORKBUDDY_CAPABILITY_MATRIX_v0.2.md` (2026-11-04)

  Host probe baseline commit                               `5c3371c3935192081585d741f50a899bc4445b0e` (HISTORICAL)

  Host probe observed HEAD                                 `2f2bdf101955a807b8c041fca5a162174b9b494e` (HISTORICAL)

  WorkBuddy profile baseline                               Desktop `5.9.2`; engine `@genie/agent-cli 2.165.0`; Electron
                                                           `37.10.3-43`; engine SHA-256
                                                           `6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf`;
                                                           PD plugin `0.2.2`; enabled `hooks/hooks.json` SHA-256
                                                           `556d546aacf0bd66c10360e5823ce39e7f979cd36970766908af78ba66a21a85`;
                                                           UPS 15 s / other hooks 30 s; `effectiveSourceCoverage=partial`;
                                                           status `CONDITIONALLY_VERIFIED`

  Amendment baseline                                       `PD_ADAPTIVE_ACTIVATION_SPEC_AMENDMENT_v0.2.1.md` (2026-11-04;
                                                           `READY_FOR_OWNER_REVIEW_WITH_OPEN_QUESTIONS`; proposal, not code
                                                           verification)

  Supersedes                                               PD Adaptive Activation SPEC v0.4

  Original design lineage                                  Working Set Selector SPEC v0.2 (Proposal --- Hold; not promoted by
                                                           this SPEC)

  Target hosts                                             OpenClaw / Codex / WorkBuddy

  Verified runtime scope                                   OpenClaw embedded; OpenClaw Gateway `sessions.reset`; Codex headless
                                                           CLI; WorkBuddy Desktop 5.9.2 hosting CLI engine 2.165.0. WorkBuddy
                                                           Desktop UI-only capabilities and standalone IDE runtime remain
                                                           `NOT_RUN`.

  Primary architecture                                     Native + Model-assisted, with host-specific adapters

  Implementation principle                                 Reuse First, Evidence Before Activation, Minimal New Components

  Source baselines                                         v0.4 SHA-256
                                                           `c022cd66a73d2d644e6b91e24df280b08772ae3a93e77a97e7b30268e5b520c4`;
                                                           Amendment v0.2.1 SHA-256
                                                           `89273de56ef9023038fc2492cdc284f76979cbc36445fef0514105f2b283880a`;
                                                           Host Audit `dedc405b…`; Capability Matrix `327b2439…`; Gap Audit
                                                           `f982823a…`; Evidence Manifest `1b05a075…`; adversarial review
                                                           SHA-256
                                                           `763e783f8b45c6123e8bd65d50f9426490bd56cac1aa8cd9c2f944c50ca26d31`
  ------------------------------------------------------------------------------------------------------------------------------

> **Status and authority.** This document is an engineering
> specification, not implementation authorization. All feature flags
> remain OFF by default. No host enters Model-assisted Live solely
> because another mode or host passed a probe. Owner authorization and
> the gates in this document remain mandatory.

------------------------------------------------------------------------

> **v0.5 source integrity.** This draft is based on the complete
> 2,995-line SPEC v0.4 source (SHA-256
> `c022cd66a73d2d644e6b91e24df280b08772ae3a93e77a97e7b30268e5b520c4`)
> and the complete Amendment v0.2.1 source (SHA-256
> `89273de56ef9023038fc2492cdc284f76979cbc36445fef0514105f2b283880a`).
> WorkBuddy Host Audit SHA-256
> `dedc405b9c1788fc859b40a3cdfe632d81136ca328c4d4855d83dd272753b47b`,
> Capability Matrix
> `327b2439d8c72ca91ef0df62cb93c0ec7f011963340cfcea2703af424b355dcf`,
> Gap Audit
> `f982823ac8513a264bdbf1534f3a5c8dbb92281001eb0a524750216fda390ac8`,
> Evidence Manifest
> `1b05a075f067813f8faf2d00ef27a0726bac32d08edc8003aeab639e13c607c3`.
> The original v0.4 file remains unchanged. The WorkBuddy evidence is
> scoped to Desktop 5.9.2 hosting CLI engine 2.165.0 / PD plugin 0.2.2;
> it is not generalized to standalone IDE, Desktop UI-only paths, or
> other hosts.

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

**The v0.5 change integrates the current WorkBuddy runtime evidence into
the existing architecture without making WorkBuddy the architecture
center: one shared decision core, host-specific execution contracts, and
independently verifiable delivery evidence. The product objective is not
maximum hook coverage or injection volume; it is to activate the right
authorized principles at the right time and determine whether that
intervention improves Agent behavior over repeated work.**

## 0.2 Core Design Decisions

1.  **Runtime V2 remains the sole authority for principle activation
    eligibility.** Adaptive Activation cannot grant, revoke, approve, or
    mutate governance activation.
2.  **Native Selection remains independently operational.** No external
    model is required for baseline PD behavior.
3.  **Model-assisted Selection remains optional and two-stage.**
    -   `principle_decision`: detects `SAME_TASK`, `NEW_TASK`,
        `GOAL_SHIFT`, `PHASE_SHIFT`, or `UNCERTAIN`.
    -   `principle_selector`: performs abstract, multi-label principle
        selection.
4.  **Model inference is removed from the synchronous prompt-hook
    critical path by default.** The hook uses a valid cached Working Set
    or Native Selection. Model-assisted refresh is deferred and can
    affect a later prompt only.
5.  **The context model remains three-layered.**
    -   `INTENT`: long-term goals and non-negotiable constraints.
    -   `Workspace Focus`: workspace-level current priorities; the
        existing `memory/okr/CURRENT_FOCUS.md` remains the compatible
        artifact path.
    -   `Session Working Set`: session-scoped task state and selected
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

### 0.2.1 Review Disposition

  -----------------------------------------------------------------------
  Value                               Meaning
  ----------------------------------- -----------------------------------
  `ACCEPT`                            Review opinion accepts the design.

  `ACCEPT_WITH_CHANGE`                Review opinion accepts after the
                                      specified correction.

  `REJECT`                            Review opinion rejects the
                                      superseded proposal.

  `DEFERRED_PENDING_EVIDENCE`         Review opinion defers the
                                      capability pending required
                                      evidence.
  -----------------------------------------------------------------------

`ACCEPT` and `ACCEPT_WITH_CHANGE` are review opinions only. They are not
Owner approval, implementation, or permission to enable a feature flag.

### 0.2.2 Implementation Status

``` text
PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED → ACCEPTED
DEFERRED_PENDING_EVIDENCE (side state: capability remains OFF pending evidence)
```

  -----------------------------------------------------------------------------
  Status                        Definition              Required evidence
  ----------------------------- ----------------------- -----------------------
  `PROPOSED`                    Proposed in this v0.5   This draft.
                                draft; not yet formally 
                                merged/approved in the  
                                repository baseline.    

  `SPEC_REVISED`                Formally merged into    Merged v0.5 text and
                                the repository's v0.5   commit.
                                SPEC baseline.          

  `IMPLEMENTED`                 Corresponding code      Code change.
                                exists.                 

  `TESTED`                      Required tests have     Test run evidence.
                                executed and passed.    

  `RUNTIME_VERIFIED`            Behavior is verified in Isolated runtime probe
                                the exact current       or approved live
                                host/runtime profile.   evidence.

  `ACCEPTED`                    Owner explicitly        Owner approval record.
                                accepts the result.     

  `DEFERRED_PENDING_EVIDENCE`   Capability remains OFF  Evidence gate
                                until the required      definition.
                                evidence exists.        
  -----------------------------------------------------------------------------

No status may be inferred from another. A proposal MUST NOT be marked
`PASS`; a review `ACCEPT` MUST NOT be interpreted as Owner `ACCEPTED`.
`SPEC_REVISED` is not used until the v0.5 draft is formally merged into
the repository baseline.

### 0.2.3 Baseline Provenance

  -----------------------------------------------------------------------
  Value                               Meaning
  ----------------------------------- -----------------------------------
  `RETAINED_FROM_V0_4`                Existing v0.4 design retained
                                      without semantic change.

  `RETAINED_FROM_V0_2`                Existing Amendment v0.2 design
                                      retained.

  `REVISED_IN_V0_5`                   Existing design materially revised
                                      in this v0.5 draft.

  `NEW_IN_V0_5`                       New normative text introduced in
                                      this v0.5 draft.
  -----------------------------------------------------------------------

Provenance records origin, not implementation or approval status.

## 0.3 Evidence-Driven Host Findings

The v0.4 Host Event Capability Matrix v0.1 remains valid only for its
historical, explicitly tested runtime combinations. The 2026-11-04
WorkBuddy audit supersedes its WorkBuddy profile facts; it does not
upgrade unverified runtime modes.

-   Codex `0.166.0`, headless CLI: `UserPromptSubmit`, `SessionStart`,
    and `Stop` observed 8/8. The interactive TUI remains `NOT_RUN`.
-   **WorkBuddy Desktop `5.9.2` hosting CLI engine
    `@genie/agent-cli 2.165.0`, PD plugin `0.2.2`:** `UserPromptSubmit`
    1/1, `SessionStart` 1/1, `PreToolUse` 164 and `PostToolUse` 162 real
    dispatches observed in the live workspace log. `SessionStart` and
    `UserPromptSubmit` spawn concurrently; dispatch ordering is not
    guaranteed. `lite-wb` is an engine entry-file name, not a runtime
    mode. Desktop UI-only capabilities and standalone IDE runtime remain
    `NOT_RUN`.
-   OpenClaw `2026.10.10`, embedded runtime: seven event types were
    observed. Gateway `sessions.reset` lifecycle events `before_reset`,
    `session_end`, and `session_start` were observed 4/4/4. Reply
    `/reset` and ordinary Gateway turns remain `NOT_RUN`.

The current WorkBuddy evidence further establishes:

-   Injection role/channel is source-confirmed as a `user` message
    containing `<system-reminder data-role="hook">` before
    `<user_query>`. It is not a `system` or `developer` role and must
    not be assigned system-level priority. Request-level `confirmed`
    evidence for engine 2.165.0 remains `NOT_RUN`.
-   WorkBuddy submission behavior has two paths: PD self-degradation
    with `exit 1` is non-blocking and the turn proceeds; `exit 2`,
    `deny`, `continue:false`, or host-side kill after the configured
    timeout can block and clear the prompt. Hook execution outcome and
    submission outcome must be recorded independently.
-   Host timeout values are distinct: OpenClaw `before_prompt_build` 15
    s; WorkBuddy host default 60 s overridden by enabled plugin
    `hooks.json` (UPS 15 s, other hooks 30 s); Codex host hook default
    600 s. The active WorkBuddy `0.2.2` `hooks.json` is byte-identical
    to the repository canonical copy (SHA-256 `556d546a…`).
-   The historical WorkBuddy `0.2.0` cache divergence is resolved for
    the active profile. Physical stale `0.1.0` / `0.2.0` directories do
    not establish duplicate registration: the host resolves a single
    `installPath`. Concatenation can occur among participating
    configuration sources inside the same plugin root or other host hook
    sources.
-   WorkBuddy `TaskCreated` / `TaskCompleted` are Agent-internal
    todo/plan notifications, not user task boundaries. Their payloads
    lack prompt, generation, turn, and parent-task identity. They may
    not bypass `principle_decision` or directly select principles.
-   Classic WorkBuddy `PreCompact` cannot prevent compaction.
    `PostCompact` is observational; `compact_summary` is lossy metadata,
    not the full context. These lifecycle events remain `PROBE_PENDING`
    until isolated runtime verification.
-   WorkBuddy engine 2.165.0 source exposes `async:true` hooks, but no
    isolated runtime evidence proves their detach, timeout, or
    session-exit behavior. Host-native async refresh remains OFF. The
    candidate deferred carrier is PD's existing detached worker, whose
    Adaptive Refresh contract is not yet implemented.
-   **A real silent delivery failure has been observed:** a WorkBuddy
    `UserPromptSubmit` hook self-degraded at 12.113 s with `exit 1` and
    produced zero `runtime_v2_prompt_activations_injected` records. The
    turn was not blocked, but that turn received no principle
    contribution. The 12.021 s value is the wrapper self-deadline
    budget, not a measured stage attribution; phase-level timings are
    unavailable.
-   Probe callback latency is not PD plugin latency. Actual PD DB,
    selection, rendering, wrapper, and adapter timing remains
    unmeasured. This is a P0 delivery-reliability task, not evidence
    that any particular stage caused the 12 s degradation.

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
8.  Optimize for measurable, attributable Agent behavior improvement
    over repeated tasks, not for the number of supported host events or
    the volume of injected principles.

------------------------------------------------------------------------

# 1. Goals and Non-Goals

## 1.1 Goals

### G1 --- Task-aware Principle Selection

Select relevant principles from the set already authorized by Runtime
V2.

### G2 --- Adaptive Refresh

Detect and respond to:

-   New task.
-   Material goal change.
-   Important phase change.
-   Material workspace-context change.
-   Expired or invalid Working Set.
-   Loss of validity of one or more previously selected principles.

### G3 --- Dual Selection Modes

Support:

-   `native`
-   `model-assisted` (operated through `shadow` or explicitly authorized
    `live` rollout modes)

Native does not depend on external models.

### G4 --- Multi-label Selection

Permit multiple complementary principles. Do not force a single winner.

### G5 --- Context Continuity

Maintain workspace context across sessions where identity and ownership
are reliable, while strictly isolating session execution state.

### G6 --- Reuse Existing Infrastructure

Prefer reuse of:

-   Runtime V2 Activation.
-   Prompt Activation Reader.
-   Prompt Budget Policy / Model-aware Prompt Budget.
-   Existing Prompt Packer.
-   Existing Prompt Renderer.
-   Pi AI Runtime.
-   Runtime Profiles and Agent Registry.
-   Existing Receipt / Evidence.
-   Current Focus reader and maintainer, after separation.
-   Intent Reader.
-   Existing Examiner infrastructure.

### G7 --- Safe Degradation

Any unavailable enhancement returns to a valid existing Working Set or
Native path. Host-specific fail-open/fail-fast behavior must be
respected.

### G8 --- Host-aware Runtime Delivery

Normalize supported host events into an internal contract while
preserving original event identity, runtime mode, evidence grade, and
host-specific delivery semantics.

### G9 --- Evidence Separation

Distinguish governance eligibility, runtime selection, prompt rendering,
adapter delivery, confirmed model-request delivery, and behavioral
effect.

### G10 --- Behavioral Improvement Evidence

The system must enable repeatable evaluation of whether principle
activation changes Agent decisions and actions over time. Selection
accuracy and delivery integrity are necessary intermediate measures;
Examiner's behavioral evaluation is the outcome measure. Host event
coverage is an implementation constraint, not the product objective.

## 1.2 Non-Goals

This SPEC does not:

1.  Redesign principle governance, Owner approval, or activation
    permissions.
2.  Rebuild Principle Artifact management.
3.  Build a general task-management platform.
4.  Build a second model-provider or model-client framework.
5.  Let Selector modify principles or execute principle actions.
6.  Let a model directly modify the host's current task.
7.  Treat keywords or regex as the main abstract semantic selector.
8.  Train a dedicated decision model in this version.
9.  Treat prompt delivery as proof of behavioral improvement.
10. Enable unverified Desktop/TUI/runtime modes by extrapolation.
11. Replace the Working Set Selector v0.2 proposal's governance status
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

-   **VERIFIED-CODE**: confirmed in the stated code audit baseline.
-   **VERIFIED-E3**: observed in a real isolated runtime probe with
    evidence artifacts.
-   **SOURCE-CONFIRMED**: established by source inspection; does not
    alone prove runtime behavior.
-   **PROPOSED**: design introduced by this SPEC, not yet implemented.
-   **NOT_RUN**: the test was not performed; it is not a failure and not
    proof of unsupported capability.
-   **INFERRED**: an explicit inference, not a measured result.
-   **OWNER-GATED**: requires explicit Owner authorization.

### 2.1.1 Evidence Grade and Status Discipline (NEW)

The evidence labels above describe **how** a fact is known.
Implementation state is described separately by the status ladder in
§0.2 of the Amendment. These two dimensions MUST NOT be conflated:

-   `SOURCE_CONFIRMED` (matched-version host source) is NOT
    `RUNTIME_VERIFIED` (live execution on the current install).
-   `NOT_RUN` is neither support nor failure.
-   `PROBE_PENDING` denotes an event whose dispatch point is
    `SOURCE_CONFIRMED` but for which the current session produced **zero
    live samples**. It MUST NOT be used as an enablement basis; such
    events remain OFF until a `RUNTIME_VERIFIED` probe exists.
-   `OFFICIAL_DOC` claims apply only to the runtime mode named by that
    document. CLI, IDE and Desktop documents may contradict one another
    and the matched source; all three MUST be recorded separately.

When official documentation, matched-version source and live runtime
disagree, resolution for the active profile follows the priority in
§2.1, but the disagreement itself MUST remain in the Evidence Manifest.

Known CLI-document / source contradiction (2026-11-04): the CLI Hooks
reference states that a `PreCompact` exit code 2 can prevent compaction;
engine `2.165.0` `executeClassicPreCompactHooks` does not act on
`allowed:false` at all. The source behavior governs the current profile;
the document claim is retained as an `OFFICIAL_DOC` discrepancy.

## 2.2 Existing Capabilities

  -----------------------------------------------------------------------------
  Component                  Existing capability             Status at v0.3
                                                             audit
  -------------------------- ------------------------------- ------------------
  Runtime V2 Activation      Principle activation            VERIFIED-CODE
                             eligibility and authorization   

  Activation State Store     SQLite activation persistence   VERIFIED-CODE

  Prompt Activation Reader   Read valid activated principles VERIFIED-CODE

  Principle Artifact         Validate Principle Artifact     VERIFIED-CODE
  Validation                                                 

  Prompt Budget Policy       Model-aware prompt capacity     VERIFIED-CODE
                             calculation                     

  Fair Rotation              OpenClaw-path fairness          VERIFIED-CODE,
                             mechanism                       scope-limited

  Shared Host Runtime        Shared cross-host runtime       VERIFIED-CODE
                             components                      

  Pi AI Runtime              Internal model invocation       VERIFIED-CODE
                             infrastructure                  

  Runtime Profiles           Model binding for internal      VERIFIED-CODE
                             Agents                          

  SignalCollector            Keyword + optional LLM          VERIFIED-CODE
                             two-stage recognition           

  Current Focus              Workspace focus and             VERIFIED-CODE,
                             working-memory maintenance      INCOMPLETE

  Intent Reader              `INTENT.md` reader interface    VERIFIED-CODE
                             and Feature Flag                

  Working Set Selector v0.2  Earlier design proposal         PROPOSAL ONLY /
                                                             HOLD

  `principle_working_sets`   Earlier proposed data structure NOT VERIFIED IN
                                                             PRODUCTION

  Adaptive Task Change       Task-change recognition         NOT IMPLEMENTED
  Detection                                                  

  General Principle Selector Semantic multi-label selection  NOT IMPLEMENTED

  Host Runtime Capability    Version/mode-bound execution    PROPOSED
  Profiles                   profiles                        

  Canonical Event Normalizer Internal semantic event         PROPOSED
                             envelope                        

  PD Hook Performance Probe  Actual PD callback cost by host PENDING
  -----------------------------------------------------------------------------

## 2.3 Governance Activation --- Immutable Boundary

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

-   Create or approve Activation.
-   Modify or revoke Activation.
-   Change Principle lifecycle state.
-   Bypass Artifact Validation.
-   Promote a draft or historical artifact.
-   Interpret a model recommendation as governance authorization.

Primary code references from v0.3:

-   `packages/principles-core/src/runtime-v2/activation/activation-dispatcher.ts`
-   `packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts`
-   `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`
-   `packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts`

## 2.4 Existing Native Prompt Selection

Native Selection already provides:

-   Valid principle retrieval.
-   Prompt capacity calculation.
-   `fair_rotation_v1` on the supported OpenClaw path.
-   Over-budget principle handling.
-   Deterministic selection.

Its host-specific reality must remain explicit:

  -------------------------------------------------------------------------
  Host path   Existing behavior / limitation
  ----------- -------------------------------------------------------------
  OpenClaw    `fair_rotation_v1` is available on the verified supported
  Plugin      path; its fairness claim remains scoped to that path and its
              valid round identity.

  Shared Host Uses legacy FIFO behavior when reliable turn ordinal is
  Runtime     unavailable.

  Codex       Must not fabricate `user-turn ordinal`; no claim of
              cross-turn fair rotation without an authoritative ordinal.

  WorkBuddy   Use only behavior verified for the installed runtime/profile;
              do not infer a turn ordinal or reuse another host's fairness
              guarantee.
  -------------------------------------------------------------------------

`fair_rotation_v1` is a budget-packing fairness policy, not the semantic
Adaptive Selector. The two responsibilities must not be conflated.

The v0.3 audit noted that the shared path may use
`legacy_fifo_prefix_v1` when no reliable incrementing round authority
exists. This fallback remains valid and must not be silently replaced.

Relevant code:

-   `packages/principles-core/src/runtime-v2/activation/prompt-budget-policy.ts`
-   `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`
-   `packages/host-runtime/src/active-principle-prompt.ts`
-   `packages/openclaw-plugin/src/hooks/prompt.ts`

## 2.5 Existing Model Infrastructure

Reuse the Pi AI Runtime and Runtime Profile configuration system:

-   Provider.
-   Model.
-   API key environment variable.
-   Base URL.
-   Timeout.
-   Retry.
-   Max tokens.
-   Reasoning configuration.
-   Agent runtime binding.

Do not introduce another model client.

The two optional internal roles remain:

-   `principle_decision`
-   `principle_selector`

Registration must use the existing Agent Registry and Profile Binding
contracts.

Relevant code:

-   `packages/principles-core/src/runtime-v2/config/pd-config-types.ts`
-   `packages/principles-core/src/runtime-v2/config/pd-config-agent-binding.ts`
-   `packages/pd-cli/src/services/runtime-adapter-resolver.ts`
-   `packages/principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts`

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

-   `packages/openclaw-plugin/src/core/focus-history.ts`
-   `packages/openclaw-plugin/src/hooks/lifecycle.ts`
-   `packages/openclaw-plugin/src/commands/focus.ts`
-   `packages/principles-core/src/prompt-builder/focus-compression.ts`

## 2.7 Existing Intent

The existing Intent Reader remains a separate interface controlled by
`intent_engineering`.

Rules:

-   When disabled, do not read `INTENT.md`.
-   Do not bypass Owner configuration.
-   Do not promote Intent content into principle activation.
-   Do not let Selector modify long-term Intent.

Relevant code:

-   `packages/openclaw-plugin/src/core/intent-doc-reader.ts`
-   `packages/principles-core/src/runtime-v2/intent/intent-doc-reader-port.ts`
-   `packages/principles-core/src/runtime-v2/config/pd-config-feature-flags.ts`

## 2.8 Components Not to Repurpose

  ---------------------------------------------------------------------------
  Component             Existing purpose      Restriction
  --------------------- --------------------- -------------------------------
  Principle Reuse       Prevent duplicate     Not a semantic task selector
                        principles            

  Owner Decision        Select Owner          Do not reuse its business
  Semantic Selector     decision-card text    decision logic

  PrincipleClassifier   Console principle     Not a task selector
                        classification        

  Runtime V2 TaskStore  Internal task queue   Not a user Task Manager

  SignalCollector       Correction/empathy    Reuse only model infrastructure
                        signal recognition    and engineering patterns

  Context Intelligence  Internal Agent        Do not reuse wholesale as
                        diagnostic context    Selector

  Working Set Selector  Proposal/Hold design  Do not activate or bypass its
  v0.2                                        gates through this SPEC
  ---------------------------------------------------------------------------

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
    D -. bounded refresh request .-> W[PD existing detached worker (OFF)]
    W --> H --> I --> J --> R
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

1.  **Adaptive Activation Core** --- task-change policy, selection
    routing, Working Set resolution.
2.  **Decision Model Integration** --- deferred task-change
    classification.
3.  **General Principle Selector Integration** --- deferred semantic
    multi-label selection.
4.  **Host Adapter Layer** --- host event normalization, capability
    profile enforcement, host-specific timeout/degradation, injection
    encoding, and delivery evidence.

The Host Adapter is an integration boundary, not a new governance or
selection authority.

Host Adapter MUST NOT change:

-   Principle authorization.
-   Principle lifecycle.
-   Candidate eligibility.
-   Selection semantics.
-   Owner approval requirements.
-   Prompt capacity policy.

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

-   No external model.
-   No Decision Model.
-   No General Selector Model.
-   Preserves existing governance and native compatibility.
-   Uses existing budget and fairness behavior within its verified
    scope.
-   Does not claim abstract semantic relevance equivalent to
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

For WorkBuddy, "Deferred Refresh Eligibility" requires all of the
following, each independently verified before Shadow or Live may be
enabled:

1.  The carrier is a detached worker that does not block the synchronous
    prompt hook.
2.  A detached worker **may continue executing after the originating
    session has ended**. No host guarantee of session-bound cleanup may
    be assumed. The only host-side cleanup found is `killAllHooksSync()`
    in the `process.exit` wrapper, which does not cover natural
    event-loop drain, crashes, or OS-level termination.
3.  Worker results are bound to `sessionId`, `generationId` when the
    source event supplies one, `hostTaskId` when it supplies one,
    `workingSetRevision`, `hostProfileId`, and `contextFingerprint`.
    Missing fields MUST remain missing; adapters MUST NOT fabricate
    them.
4.  Results from a closed or different session MUST NOT contaminate a
    new session. Isolation is enforced by session-scoped keys, the
    durable task lease, a Working Set revision fence, idempotency keys,
    and stale-result discard.
5.  `asyncTimeout` bounds the child process lifetime only. It neither
    validates nor waits for the worker's result commit and MUST NOT be
    used as a substitute for a durable journal entry plus a revision
    check.
6.  Every deferred result is applied only at a later verified
    `BEFORE_MODEL_TURN`; it can never retroactively change the current
    turn.

Host-native async refresh and Model-assisted Shadow/Live remain
`DEFERRED_PENDING_EVIDENCE` until an isolated probe demonstrates items
1--6.

# 4. Context Model

## 4.1 Three Context Levels

The three levels are independent and have different owners and
lifecycles.

### A. INTENT --- Strategic Context

Long-term intent:

-   Why.
-   Desired Outcome.
-   Non-negotiables.
-   Strategic Constraints.
-   Long-term Direction.

Properties:

-   Long lifecycle.
-   Defined and controlled by Owner.
-   Not overwritten by ordinary tasks.
-   Read only when `intent_engineering` is enabled.

### B. Workspace Focus --- Workspace Context

The existing `CURRENT_FOCUS.md` artifact represents the current
workspace focus:

-   Current phase.
-   Current priority tasks.
-   P0/P1/P2.
-   Important blockers.
-   Next actions.
-   Working-memory summary.
-   Key artifacts and decisions.

Properties:

-   Workspace-scoped.
-   May be shared by multiple sessions in the same workspace.
-   Represents the workspace's current direction, not an individual
    Agent's live task.
-   Owner-controlled; automatic maintenance is restricted to explicitly
    authorized working-memory regions.

### C. Session Working Set --- Runtime Context

Session-scoped execution state:

-   Current task summary.
-   Current execution phase.
-   Selected principle IDs.
-   Last selection reason.
-   Last task-change decision.
-   Context fingerprint and revision.
-   Host profile and source event.
-   Expiry and validity metadata.

Properties:

-   Session-scoped.
-   Never shared with another Session.
-   Must not overwrite Workspace Focus.
-   May be refreshed when task context materially changes.
-   Is a cache of selection state, not a governance record or full task
    history.

## 4.2 Context Priority and Provenance

Retain the v0.3 read priority:

1.  Current Session conversation context.
2.  Current Session Working Set.
3.  Workspace Focus.
4.  Optional INTENT.

These are not concatenated into an untyped string. Every input must
retain:

-   Source.
-   Scope.
-   Revision or fingerprint.
-   Capture time.
-   Availability state.
-   Feature-flag state where applicable.

A lower-level context must not silently override a higher-authority
Owner-defined constraint. In particular, ordinary session text cannot
mutate INTENT or Owner-authored Workspace Focus.

## 4.3 Read-only Context Snapshot Contract

``` typescript
interface AdaptiveContextSnapshot {
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  engineVersion: string;          // e.g. "@genie/agent-cli 2.165.0"
  engineSha256?: string;
  runtimeMode: string;            // e.g. "desktop_cli_engine"
  hostProfileId: string;
  hostProfileRevision: string;
  profileStatus: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "EXPIRED" | "NOT_RUN";
  pdPluginVersion?: string;
  pluginConfigSha256?: string;             // plugin's own config files
  effectiveHookSetFingerprint?: string;    // host-resolved effective hook set
  effectiveSourceCoverage?: "complete" | "partial" | "unknown";
  hookInvocationId?: string;    // journal correlation; generated at wrapper entry
  hookEventName?: string;       // native event name; dedup key component
  hostRequestId?: string;       // only when the host actually supplies one
  correlationStatus: "correlated" | "unreliable" | "unknown";

  workspaceId?: string;
  sessionId: string;
  generationId?: string;         // present on UPS/Stop; ABSENT on Task/Compaction events
  hostTaskId?: string;           // sourced from snake_case `task_id`; Agent-internal plan item
  agentId?: string;              // SubagentStart/Stop session storeId
  sessionSource?: "startup" | "resume" | "clear" | "unknown";  // NO "compact"
  compactSummaryEvidence?: string; // metadata only; NOT a semantic input

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

-   No full host-history database scan.
-   No default full-workspace directory scan.
-   No bypass of Intent Feature Flag.
-   No writes, repairs, or initialization during context read.
-   No cross-Session context mixing.
-   No use of `safeReadCurrentFocus()` as a pure reader until its side
    effects are removed or isolated.
-   Missing, malformed, or untrusted Focus returns `unavailable`; the
    reader does not create a template.
-   Missing reliable `workspaceId` or `sessionId` disables persisted
    Model-assisted Live for that host profile. Native remains available
    if the existing path can operate safely.

------------------------------------------------------------------------

-   `generationId`, `hostTaskId`, `agentId`, `sessionSource` and
    `compactSummaryEvidence` MUST come only from verified host payload
    fields. Missing values remain missing; adapters MUST NOT derive them
    from message IDs, trace IDs, transcript parsing, or fabricated
    ordinals. In particular `generation_id` is absent from
    `TaskCreated`, `TaskCompleted` and `PostCompact` payloads.
-   `compactSummaryEvidence` is a lossy compression summary recorded for
    provenance only. It MUST NOT be used to compute
    `contextFingerprint`, to select principles, or to represent the full
    pre-compaction context.
-   `hostTaskId` identifies an Agent-internal todo/plan item, not a user
    task. It MUST NOT be interpreted as a user task boundary.
-   A change in `engineVersion`, `engineSha256`, `runtimeMode`,
    `pdPluginVersion`, `pluginConfigSha256`,
    `effectiveHookSetFingerprint` or `hostProfileRevision` invalidates
    the profile-bound Working Set until `resolveHostProfile()`
    re-verifies it.
-   `effectiveSourceCoverage` of `partial` / `unknown` caps the profile
    at `CONDITIONALLY_VERIFIED`; a fully `VERIFIED` profile requires
    complete coverage (§8.3.1).
-   `hookInvocationId`, `hookEventName` and `correlationStatus` are
    derived from real host/wrapper data only. Missing identity fields
    yield `unreliable` / `unknown`, never a fabricated id (§5.2.2).

# 5. Host Event Semantics and Task Change Detection

## 5.1 Canonical Event Is an Internal Abstraction

Define the internal semantic event:

`BEFORE_MODEL_TURN`

It means: **the adapter has received a verified host callback that
occurs before the host submits the current user turn to the model and
can still return the prompt contribution for that turn.**

It does not mean all hosts have identical lifecycle semantics. Every
normalized event must preserve the actual source event and evidence.

Current mappings supported by the Host Matrix and the 2026-11-04
WorkBuddy audit:

  -------------------------------------------------------------------------------------------
  Host/runtime mode     Source event            Mapping               Evidence
  --------------------- ----------------------- --------------------- -----------------------
  Codex headless CLI    `UserPromptSubmit`      `BEFORE_MODEL_TURN`   VERIFIED-E3, 8/8
                                                                      (historical)

  **WorkBuddy Desktop   `UserPromptSubmit`      `BEFORE_MODEL_TURN`   RUNTIME_VERIFIED, 1/1
  5.9.2 / CLI engine                                                  live dispatch +
  2.165.0**                                                           SOURCE_CONFIRMED

  OpenClaw embedded     `before_prompt_build`   `BEFORE_MODEL_TURN`   VERIFIED-E3, seven
                                                                      event types observed

  Codex interactive TUI ---                     No mapping authorized NOT_RUN

  **WorkBuddy           ---                     No mapping authorized NOT_RUN (IDE docs
  standalone IDE                                                      describe only 7 events;
  runtime**                                                           no runtime evidence)

  **WorkBuddy Desktop   ---                     No mapping authorized NOT_RUN (`/hooks`
  UI-only                                                             review panel, TUI; hook
  capabilities**                                                      engine itself IS
                                                                      verified)

  OpenClaw reply        ---                     No mapping authorized NOT_RUN
  `/reset`                                                            

  OpenClaw ordinary     ---                     No mapping authorized NOT_RUN
  Gateway turn                                  by this probe         
  -------------------------------------------------------------------------------------------

A mapping is permitted only for the exact host version / engine version
/ runtime mode / installed plugin version for which evidence exists. A
version or mode change invalidates the profile until reverified.
`lite-wb` is the name of the CLI engine entry file, **not** a runtime
mode; profiles MUST NOT be named after it.

For the current WorkBuddy profile, host events are classified as
follows:

  ----------------------------------------------------------------------------------------
  Class             Events                 Evidence grade             Activation
  ----------------- ---------------------- -------------------------- --------------------
  Injection         `UserPromptSubmit`     `RUNTIME_VERIFIED` (1 live Enabled for Native
                                           dispatch)                  

  Evidence channels `PreToolUse`,          `RUNTIME_VERIFIED`         Enabled as evidence
                    `PostToolUse`          (164/162 live dispatches)  channels; no
                                                                      principle injection

  Unobserved        `PostToolUseFailure`   `SOURCE_CONFIRMED`, zero   OFF until an
  tool-failure                             live samples               isolated probe
  event                                                               

  Session init      `SessionStart`         `RUNTIME_VERIFIED` (1 live Enabled;
                                           dispatch)                  health/profile check
                                                                      only

  `PROBE_PENDING`   `SessionEnd`, `Stop`,  `SOURCE_CONFIRMED`         **OFF** until a
  lifecycle         `PreCompact`,          dispatch points, **zero    `RUNTIME_VERIFIED`
                    `PostCompact`,         live samples**             isolated probe
                    `TaskCreated`,                                    
                    `TaskCompleted`,                                  
                    `SubagentStart`,                                  
                    `SubagentStop`                                    
  ----------------------------------------------------------------------------------------

`PROBE_PENDING` is not `Supported`. Source-level presence of an event
name is not evidence of its dispatch, its payload shape, its timing, or
its semantic suitability. No `PROBE_PENDING` event may be used as a
selection trigger, a session counter, or a task boundary until verified.

## 5.2 Canonical Event Envelope

``` typescript
type CanonicalEventType =
  | "BEFORE_MODEL_TURN"
  | "WORKSPACE_FOCUS_REVISION_CHANGED"
  | "SESSION_CONTEXT_RESTORED"
  | "SESSION_RESET_CONFIRMED"
  | "PERIODIC_CHECKPOINT"
  | "HOST_TASK_GRAPH_CHANGED"       // Agent-internal plan graph; weak signal
  | "HOST_SUBAGENT_SCOPE_CHANGED"   // subagent scope hint only
  | "HOST_SESSION_ENDED"            // best-effort lifecycle end
  | "HOST_POST_COMPACT";            // invalidation / revalidation only

interface CanonicalHostEvent {
  canonicalType: CanonicalEventType;
  sourceEvent: string;
  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  engineVersion?: string;
  engineSha256?: string;
  runtimeMode: string;
  hostProfileId: string;
  pluginConfigSha256?: string;
  effectiveHookSetFingerprint?: string;
  effectiveSourceCoverage?: "complete" | "partial" | "unknown";
  hookInvocationId?: string;
  hookEventName?: string;
  hostRequestId?: string;
  correlationStatus: "correlated" | "unreliable" | "unknown";
  generationId?: string;      // absent on Task / Compaction events
  hostTaskId?: string;        // sourced from snake_case task_id; plan item only
  agentId?: string;
  sessionSource?: "startup" | "resume" | "clear" | "unknown";
  semanticAuthority: false;
  triggerClass: "structural" | "provenance_only";

  observedAt: string;
  eventId?: string;
  turnId?: string;
  sessionId?: string;
  workspaceId?: string;
  identityReliability: "verified" | "partial" | "unavailable";
  dispatchEvidence: EvidenceGrade;
}
```

`eventId`, `turnId`, `sessionId`, and `workspaceId` are optional because
not every host/mode has verified values. Missing identity must remain
missing; adapters must not invent host IDs or ordinals.

### 5.2.1 Host Event Semantic Classification (NEW)

Engine 2.165.0 `TaskCreated` / `TaskCompleted` are best-effort
notifications emitted by the internal `TaskCreateTool` /
`TaskUpdateTool` when an Agent-internal todo/plan item is created or
marked `completed`. Their payload contains session-level identity and
snake_case `task_id` / `task_subject` / optional plan fields. There is
no user prompt, no `generation_id`, no turn identifier, no
`parentTaskId`, and no way to reverse-resolve the originating user
request. `task_id` is a session- partitioned auto-increment ordinal. One
user request may produce 0, 1 or N such events. `SubagentStart` /
`SubagentStop` belong to a separate session- lineage chain and share no
payload fields with Task events.

Four boundary classes MUST remain distinct:

1.  **User task boundary** --- only a verified prompt event carrying
    `prompt` and turn identity can indicate a new user request. No
    WorkBuddy host event currently provides a deterministic user task
    boundary. Semantic classification remains the responsibility of
    `principle_decision`.
2.  **Agent-internal task boundary** --- `TaskCreated` / `TaskCompleted`
    = `HOST_TASK_GRAPH_CHANGED`, a weak signal only.
3.  **Subagent boundary** --- `SubagentStart` / `SubagentStop` =
    `HOST_SUBAGENT_SCOPE_CHANGED`, a scope hint only.
4.  **Ordinary tool phase** --- `Pre/PostToolUse` = evidence channels
    only.

**No-semantic-bypass rule (hard constraint).** A host event MUST NOT:

-   produce a `TaskChangeType` decision (`NEW_TASK`, `GOAL_SHIFT`,
    `PHASE_SHIFT`, `UNCERTAIN`, `SAME_TASK`);
-   cause `principle_decision` to be skipped;
-   select, replace, activate or deactivate any principle;
-   serve as a session/turn counter, a user-identity source, or a
    billing boundary.

`HOST_TASK_GRAPH_CHANGED` may only (a) record provenance and (b) set
`structuralRevalidationRequired`. It MUST NOT set
`semanticReevaluationRequired`, enqueue a semantic decision task, or
cause the next verified `BEFORE_MODEL_TURN` to re-run
`principle_decision` indirectly. `teammate_name` / `team_name` are
optional agent/team labels and MUST NOT be read as user attribution.

#### 5.2.2 Event Correlation and Dedup Key (NEW, v0.2.1)

A `TaskCreated` and a `TaskCompleted` for the same todo item are **two
distinct host events** and MUST be retained separately. Using
`(session_id, task_id)` alone would deduplicate them into one record and
is prohibited.

Priority order for the correlation key:

1.  A **real host-provided event unique identifier**, if that payload
    actually supplies one. For WorkBuddy engine 2.165.0 `TaskCreated` /
    `TaskCompleted` payloads no dedicated event id was found; its
    existence is `UNKNOWN` (OQ-26) and MUST NOT be assumed or
    fabricated.
2.  Otherwise the composite key
    `(hostProfileId, session_id, task_id, hook_event_name)`. The
    `hook_event_name` component is mandatory: it keeps `TaskCreated` and
    `TaskCompleted` distinct. `session_id` is the session-level host
    field (`parentSessionId ?? session.id`), not a request id.
3.  If the host supplies a request id (`generation_id`,
    `conversationRequestId`) for that event, it MAY be attached as an
    extra `hostRequestId` correlation attribute. It MUST NOT be invented
    when absent --- Task and Compaction payloads do not carry it.

No adapter may fabricate `generation_id`, `turn_id`, `parentTaskId`, a
plan-item hierarchy, or a synthetic turn ordinal. When a required
identity field is missing, the record MUST be marked
`correlationStatus: "unreliable"` (or `"unknown"` when nothing can be
established) and MUST NOT be used to join events, merge Working Sets, or
trigger any reevaluation.

#### 5.2.3 Structural Revalidation vs Semantic Reevaluation (NEW, v0.2.1)

These are two different operations and MUST remain independent:

  --------------------------------------------------------------------------------------------
  Aspect                   `structuralRevalidationRequired`   `semanticReevaluationRequired`
  ------------------------ ---------------------------------- --------------------------------
  Checks                   Working Set revision; Host Profile Whether the user's task context
                           validity; `pluginConfigSha256` /   has materially changed
                           `effectiveHookSetFingerprint`      
                           consistency; Activation and        
                           Artifact validity; cache / result  
                           expiry                             

  May call                 **No**                             **Yes** --- and only via that
  `principle_decision`                                        path

  May change               **No**                             Only through a validated
  `selectedPrincipleIds`                                      selection result

  May be set by a host     **Yes**                            **No**
  event                    (`HOST_TASK_GRAPH_CHANGED`,        
                           `HOST_POST_COMPACT`,               
                           `HOST_SESSION_ENDED`)              

  Authorized triggers      Any verified structural signal     Only a **verified user semantic
                                                              change**, or a semantic trigger
                                                              explicitly authorized in SPEC
                                                              v0.4 §5
                                                              (`FOCUS_REVISION_CHANGED`,
                                                              `PERIODIC_CHECKPOINT`,
                                                              `CONTEXT_FINGERPRINT_CHANGED`
                                                              under §5.5 throttling,
                                                              `ACTIVATION_REVISION_CHANGED`
                                                              revalidation)
  --------------------------------------------------------------------------------------------

`HOST_TASK_GRAPH_CHANGED` is a **structural-only** signal. It MUST NOT
set a semantic flag, MUST NOT enqueue a deferred semantic task, MUST NOT
mark the next `BEFORE_MODEL_TURN` as requiring re-decision, and MUST NOT
be used as a proxy for `NEW_TASK` / `GOAL_SHIFT` / `PHASE_SHIFT`.
Structural revalidation that finds an invalid Activation or Artifact
falls back to Native; it does not ask the model to re-classify the task.

`principle_decision` remains the **sole semantic authority**. The Host
Adapter never performs or schedules semantic classification on its
behalf.

## 5.3 SessionStart Is Not a Universal Session Boundary

Do not depend on `SessionStart` to:

-   Count sessions.
-   Infer a unique session start.
-   Establish ordering before `UserPromptSubmit`.
-   Determine that a session is new rather than resumed.
-   Clear or overwrite the Working Set without a verified reset
    identity.

Evidence:

-   Codex `SessionStart` can repeat on `resume`.
-   WorkBuddy `SessionStart` and `UserPromptSubmit` were observed
    concurrently; ordering is not guaranteed.
-   OpenClaw embedded mode has no verified `session_start` dispatch
    point in this probe.
-   OpenClaw Gateway `sessions.reset` lifecycle events were verified
    only for that reset path; they do not prove reply `/reset` or
    ordinary Gateway turn behavior.

`SessionStart` may be used only as an ancillary hint inside a
host-specific adapter when its exact semantics are verified. It is not
the canonical initialization trigger.

## 5.4 Trigger Conditions

  ------------------------------------------------------------------------------------------------------------------------
  Trigger                         Class                   Description             Action
  ------------------------------- ----------------------- ----------------------- ----------------------------------------
  `INITIAL_SESSION`               `STRUCTURAL`            No valid Working Set    Native immediately; enqueue deferred
                                                          exists when a verified  initialization only if a safe worker
                                                          prompt event arrives    exists

  `HOST_TASK_GRAPH_CHANGED`       `STRUCTURAL`            Agent-internal plan     Record provenance using the §5.2.2
                                                          item created/completed  correlation key; set
                                                          (`task_id`, snake_case) `structuralRevalidationRequired=true`;
                                                                                  **no Decision Model call, no selection,
                                                                                  no semantic flag**

  `HOST_SUBAGENT_SCOPE_CHANGED`   `PROVENANCE_ONLY`       Subagent session        Record scope hint only; **no
                                                          started/stopped         revalidation flag, no selection**

  `HOST_SESSION_ENDED`            `STRUCTURAL`            `SessionEnd`            Best-effort cleanup +
                                                          (best-effort, not       `structuralRevalidationRequired=true`;
                                                          guaranteed)             idle TTL remains authoritative

  `HOST_POST_COMPACT`             `STRUCTURAL`            `PostCompact`           Invalidate cached fingerprint; set
                                                          (`compact_summary` is   `structuralRevalidationRequired=true`;
                                                          lossy metadata only)    **no injection, no blocking, no
                                                                                  selection, no fingerprint recompute from
                                                                                  the summary**

  `HOST_TASK_BOUNDARY`            `SEMANTIC_AUTHORIZED`   A verified host         Enqueue deferred Decision Model. **No
                                                          boundary that is proven WorkBuddy event currently qualifies.**
                                                          to carry user-task      
                                                          semantics               

  `FOCUS_REVISION_CHANGED`        `SEMANTIC_AUTHORIZED`   Workspace Focus         Enqueue Decision Model
                                                          revision changes (SPEC  
                                                          v0.4 authorized)        

  `CONTEXT_FINGERPRINT_CHANGED`   `SEMANTIC_AUTHORIZED`   Local context           Consider bounded refresh under §5.5
                                                          fingerprint changes     throttling
                                                          materially (SPEC v0.4   
                                                          authorized)             

  `PERIODIC_CHECKPOINT`           `SEMANTIC_AUTHORIZED`   A safe per-session      Enqueue Decision Model under the
                                                          checkpoint is reached   throttling rules in §5.5
                                                          (SPEC v0.4 authorized)  

  `COMPACTION_RESUME`             `STRUCTURAL`            A verified              Revalidate cached state only; do not
                                                          compaction/resume       assume all hosts support it
                                                          signal is available     

  `WORKING_SET_EXPIRED`           `STRUCTURAL`            Working Set TTL or      Native immediately; no semantic
                                                          validity has expired    re-decision unless a §5-authorized
                                                                                  semantic trigger fires

  `ACTIVATION_REVISION_CHANGED`   `STRUCTURAL`            Relevant activation     Revalidate selected IDs before delivery;
                                                          state changes           no re-selection
  ------------------------------------------------------------------------------------------------------------------------

A trigger can request a refresh; it cannot itself authorize a principle.
A host event can supply technical timing, provenance or **structural**
invalidation; it can never supply semantic task classification.

`STRUCTURAL` and `PROVENANCE_ONLY` triggers MUST NOT set
`semanticReevaluationRequired`, MUST NOT enqueue `principle_decision`,
and MUST NOT cause the next verified `BEFORE_MODEL_TURN` to re-run
semantic classification indirectly (§5.2.3). Only `SEMANTIC_AUTHORIZED`
triggers may set `semanticReevaluationRequired`, and the resulting
classification is performed exclusively by `principle_decision`.

**Removed rule (Amendment v0.1).** The "determinism-first rule" that
mapped `TaskCreated` to a deterministic `NEW_TASK` and skipped
`principle_decision` is withdrawn. It was based on a false premise about
host event semantics and would cause re-selection on every Agent
plan-item creation.

`principle_decision` remains the sole classifier for `GOAL_SHIFT`,
`PHASE_SHIFT`, `UNCERTAIN`, `SAME_TASK`, and for any user-task change
that no host event can express deterministically. §17.5 optimization
order item 1 ("Avoid unnecessary Decision calls") is satisfied by
**throttling and deduplication**, not by replacing semantic judgment
with a host signal.

## 5.5 Incremental Checkpoint

The v0.3 initial experiment values are retained as provisional policy
values, not verified optima:

  ------------------------------------------------------------------------------------------------
  Parameter                              v0.3 v0.4 treatment
                                      initial 
                                        value 
  --------------------------------- --------- ----------------------------------------------------
  `maxUserTurnsWithoutReview`               4 Use only if a reliable, deduplicated PD-observed
                                              prompt sequence can be maintained for that profile;
                                              never substitute a fabricated host turn ordinal

  `maxContextDeltaChars`                 2500 Retain as an experimental local fingerprint/delta
                                              threshold

  `minReviewIntervalMs`                 30000 Retain as an experimental lower bound between model
                                              refreshes

  `refreshOnFocusRevisionChange`         true Retain

  `refreshOnReliableHostBoundary`        true Retain only for verified source events
  ------------------------------------------------------------------------------------------------

Per-message behavior:

-   Perform only bounded local work in the synchronous hook.

-   Do not invoke an external model in the hook.

-   Do not run a Decision Model on every message.

-   Do not count duplicate/replayed callbacks as new turns unless
    idempotency is established.

-   If no reliable per-turn counter exists, use local context
    fingerprint/time-based checks or verified host boundaries.

-   A single-message semantic change may remain undetected until the
    next refresh checkpoint. The system must disclose this bounded
    detection delay rather than claim zero-delay semantic detection.

-   `maxUserTurnsWithoutReview` remains the **primary** review rhythm
    for user turns. `HOST_TASK_GRAPH_CHANGED`,
    `HOST_SUBAGENT_SCOPE_CHANGED` and `HOST_POST_COMPACT` are not user
    turns and MUST NOT increment any turn counter; they set only
    `structuralRevalidationRequired` (or nothing). They MUST NOT set
    `semanticReevaluationRequired`.

-   `SessionStart` with `source: "resume"` and `source: "clear"` may
    dispatch repeatedly and MUST NOT be counted as a new user turn.

-   A `PreToolUse` hook that returns `continue: false` causes the host
    to re-submit the user prompt, which fires `UserPromptSubmit` again
    in the same turn. The WorkBuddy adapter MUST NOT emit
    `continue: false`.

-   Every refresh request is idempotent on the tuple
    `(hookInvocationId, hostProfileId, sessionId, [generationId],   [hostTaskId], hook_event_name, contextFingerprint, workingSetRevision)`.
    `hookInvocationId` and `hook_event_name` are mandatory so that a
    `TaskCreated` and a `TaskCompleted` for the same todo item are never
    deduplicated into one record (§5.2.2). Bracketed fields are
    optional: when the source event does not supply `generation_id` or
    `task_id`, the key MUST omit them rather than substitute a
    fabricated value. A record with
    `correlationStatus: "unreliable" | "unknown"` MUST NOT participate
    in merging or in any reevaluation.

-   `periodKey` remains derived only from a verified, deduplicated
    user-turn sequence; no host event may create a fabricated host turn
    ordinal.

-   Structural revalidation and semantic reevaluation are independent
    (§5.2.3). A structural flag MUST NOT be consumed, promoted, or
    reinterpreted as a semantic trigger at any later checkpoint,
    including the next `BEFORE_MODEL_TURN`.

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

-   Recent six effective messages as the initial context window.
-   Prefer newest content.
-   Initial maximum input length: 12,000 characters.
-   On overflow, retain the newest complete message boundaries; do not
    truncate from the file head.
-   Do not persist full raw conversation in Working Set storage.
-   External context transmission remains explicit opt-in.

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

-   Structured JSON only.
-   Confidence in \[0, 1\].
-   Short reason.
-   No arbitrary Principle IDs.
-   No prompt instructions or executable content.
-   Output is untrusted and must be schema-validated.

## 5.8 Decision Rules

  ---------------------------------------------------------------------------
  Decision        Behavior
  --------------- -----------------------------------------------------------
  `SAME_TASK`     Retain existing valid Working Set

  `NEW_TASK`      Request General Selector

  `GOAL_SHIFT`    Request General Selector

  `PHASE_SHIFT`   Request General Selector

  `UNCERTAIN`     Do not replace a valid existing set; use Native if the
                  existing set is invalid
  ---------------------------------------------------------------------------

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

1.  User's current goal.
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

-   `triggerPattern`
-   `action`
-   `scope`
-   `domain`
-   `priority`
-   `tags`

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

-   Every field must come from a currently valid Artifact.
-   Optional fields may be absent.
-   Do not read unauthorized historical drafts to fill missing fields.
-   Candidate text is data, not an instruction to the Selector.

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

-   Every `principleId` must belong to the input candidate set.
-   No new Principle IDs.
-   No principle-body edits.
-   No activation-state changes.
-   No executable code.
-   Model reasons are audit metadata; do not inject them as arbitrary
    host instructions.
-   `NONE_APPLICABLE` is valid.

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

  Parameter                                Initial value
  ----------------------------- ------------------------
  Maximum candidates                                  48
  Maximum selected principles                         12
  Maximum reason length                   160 characters
  Minimum confidence                                0.70
  Candidate content               Verified Artifact only

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

The word "budget" refers to two different resource constraints. They
must not share a single resolver or global constant.

### A. Hook Execution Budget

Wall-clock budget for reading state, selecting/falling back, rendering,
encoding, and returning from a host hook.

It is host- and installed-version-specific. See Section 12.

### B. Prompt Capacity Budget

Capacity of the model prompt contribution, including:

-   Model/context-window awareness.
-   Existing character/token estimation rules.
-   Minimum and maximum content budgets.
-   Candidate ordering.
-   Over-budget handling.
-   Existing fairness behavior where valid.

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

-   Principle activation state.
-   Governance evidence.
-   Full task history.
-   Workspace Focus.
-   A general task manager.

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

  generationId?: string;
  hostTaskId?: string;
  hookEventName?: string;
  hookInvocationId?: string;
  hostRequestId?: string;
  correlationStatus: "correlated" | "unreliable" | "unknown";
  sessionSource?: "startup" | "resume" | "clear" | "unknown";
  engineVersion: string;
  engineSha256?: string;
  pluginConfigSha256?: string;
  effectiveHookSetFingerprint?: string;
  effectiveSourceCoverage?: "complete" | "partial" | "unknown";
  pdPluginVersion?: string;
  lastHostEvent?: CanonicalEventType;
  structuralRevalidationRequired: boolean;
  semanticReevaluationRequired: boolean;
  preCompactRevision?: number;

  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
```

Rules:

-   Do not save raw user conversation.

-   Do not save API keys.

-   Do not save full model chain-of-thought.

-   No cross-workspace reads.

-   No cross-session writes or reuse.

-   Every update uses a revision check.

-   Expired or stale state cannot be used as a Live selection.

-   A change in host version/runtime mode/profile invalidates the
    profile-bound result until revalidated.

-   Selected principle IDs must be revalidated against Runtime V2 before
    every delivery.

-   A change in `engineVersion`, `engineSha256`, `pluginConfigSha256`,
    `effectiveHookSetFingerprint`, `pdPluginVersion`, `runtimeMode`, or
    `hostProfileRevision` invalidates the result until
    `resolveHostProfile()` re-verifies it (implements §12.1).

-   `SessionEnd` is best-effort and MUST NOT be the sole cleanup
    trigger; idle TTL remains authoritative.

-   On `HOST_POST_COMPACT`, DO NOT recompute `contextFingerprint` from
    `compact_summary` and DO NOT change `selectedPrincipleIds`. Set
    `structuralRevalidationRequired = true`, leave
    `semanticReevaluationRequired` unchanged, and retain
    `preCompactRevision`. The next verified `BEFORE_MODEL_TURN`
    recomputes the fingerprint from the actual current context and
    revalidates; on mismatch, fall back to Native. This is structural
    work only (§5.2.3).

-   `HOST_TASK_GRAPH_CHANGED` may set only
    `structuralRevalidationRequired`. It MUST NOT change
    `selectedPrincipleIds`, set `semanticReevaluationRequired`, invoke
    `principle_decision`, or cause a semantic re-decision at the next
    `BEFORE_MODEL_TURN`.

-   Structural revalidation checks only: Working Set revision, Host
    Profile validity, fingerprint consistency, Activation / Artifact
    validity, and cache / result expiry. It MUST NOT call any model and
    MUST NOT alter `selectedPrincipleIds`. Semantic reevaluation is
    reserved for a verified user semantic change or a SPEC v0.4
    §5-authorized semantic trigger, and is performed only by
    `principle_decision` (§5.2.3).

-   A revision-fenced result whose `sessionId`, `workingSetRevision`,
    `contextFingerprint` or `hostProfileId` no longer matches the
    current turn MUST be discarded (stale-result discard).

-   `correlationStatus` MUST be derived only from host-supplied fields.
    Missing identity fields remain missing and yield `unreliable` or
    `unknown`, never a fabricated identifier (§5.2.2).

## 8.3 Concurrency

Use existing supported persistence mechanisms, subject to database
ownership audit:

-   Transaction.
-   Revision check.
-   Optimistic lock.
-   Deterministic upsert.

For concurrent refreshes, only a result matching the latest context
fingerprint and expected Working Set revision may commit. An older model
response must not overwrite a newer result.

### 8.3.1 Hook Configuration Discoverability and Identity (NEW)

Four levels MUST be distinguished; a lower level is not evidence of a
higher one:

1.  A plugin version directory **exists physically** on disk.
2.  That directory is **discoverable** by the host --- i.e. it is the
    single `installPath` resolved from `installed_plugins.json`
    (`resolveInstalledPluginCache`), or an explicit `--plugin-dir`.
3.  The host **actually loads** `hooks/hooks.json` from that root
    (`HookExtensionLoader.load` resolves exactly one path).
4.  **Two effective hook registrations exist for the same event** ---
    e.g. both a manifest `hooks` field and the default
    `hooks/hooks.json` inside the **same** plugin root are concatenated
    by `mergeHooks`, or multiple configuration sources (user settings,
    plugin, scoped registry) are merged by `getHooks`.

Stale plugin version directories that are merely present on disk are NOT
evidence of level 2, 3 or 4. The host reads `.orphaned_at` markers only
for plugin-cache garbage collection (approximately 14 days), not as a
hook loading blacklist. Therefore "old `hooks.json` files remain on
disk" MUST NOT be reported as production duplicate injection.

Required controls (v0.2.1 --- two distinct fingerprints):

-   `pluginConfigSha256` describes **the plugin's own configuration
    files** only: the enabled plugin's `hooks/hooks.json` plus, when
    present, the manifest `hooks` field. It answers "has the plugin's
    declared config changed?".
-   `effectiveHookSetFingerprint` describes **the effective Hook set the
    host actually resolves and merges**. Only configuration sources that
    are `SOURCE_CONFIRMED` to participate in hook registration may be
    included. For engine 2.165.0 the confirmed sources are: the plugin
    manifest `hooks` field, the default `hooks/hooks.json` of the
    resolved root (`HookExtensionLoader.load`), and the sources merged
    in `getHooks` (user settings `hooks`, `loadHooksFromPlugins`, scoped
    hook registry). Any source that cannot be observed at runtime MUST
    NOT be assumed to be covered.
-   Both fingerprints use a deterministic canonicalization
    (`canonical-v1`): UTF-8, stable key ordering, whitespace-normalized,
    event name → matcher → hook entries in declaration order, `${...}`
    placeholders resolved to a stable symbolic form rather than an
    absolute path. The normalization version is stored with the profile
    so a change in normalization itself can be detected.
-   `effectiveSourceCoverage` MUST be recorded as
    `complete | partial | unknown`, together with
    `coveredConfigSources: string[]` (source **names**, never absolute
    paths) and `unobservableSourcesNote?: string`. For the current
    2.165.0 profile it is `partial`: the host-side `getHooks` merge is
    source-confirmed but its runtime content is not fully observable
    from PD.
-   A profile with `effectiveSourceCoverage` of `partial` or `unknown`
    MUST NOT be declared fully `VERIFIED`; the maximum is
    `CONDITIONALLY_VERIFIED`. The `VERIFIED` status requires `complete`
    coverage plus `RUNTIME_VERIFIED` evidence of the effective hook set.
-   At hook entry, verify both fingerprints against the profile-bound
    values. On mismatch, return a neutral payload and write a journal
    line with `execution: "degraded"`,
    `degradationReason: "hook_config_mismatch"`. A known fingerprint
    change continues to enforce `EXPIRED` + Native-only (§12.1).
-   Verify that the same event is not registered twice from two config
    sources of one root; if it is, emit
    `hook_config_source_concat_detected` and return neutral.
-   `deduplicateHooks` deduplicates identical command strings only; it
    MUST NOT be relied upon for version or source deduplication.
-   **Non-goal:** these two fingerprints are derived integrity anchors
    computed by `resolveHostProfile()`. They do NOT create a new
    configuration management system, a new config authority, or a second
    source of truth for hook registration; the installed host
    configuration remains authoritative.

Long-term receipts MUST NOT contain absolute filesystem paths. Use
`HostPluginIdentity` (§12.2). Absolute paths are confined to local
diagnostic material (Evidence Manifest, local logs).

## 8.4 Expiration

Retain v0.3 initial idle TTL of 24 hours as an experimental default:

-   Extend only on verified activity for the same Session.
-   Mark inactive Session state expired after TTL.
-   Never use expired state as a Live selection.
-   Re-select or fall back to Native.
-   TTL does not mean the task is complete.

## 8.5 Storage Ownership Gate

Before implementation, establish:

-   Which existing SQLite database owns this state.
-   Whether the selected database is writable by each adapter.
-   Migration and backup policy.
-   Transaction/concurrency semantics.
-   Workspace/session identity source.
-   Whether cross-process access is supported.

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

### F1 --- Complete `currentTask` Production and Restore

-   Extract current task from supported context.
-   Write only to a clearly designated, authorized working-memory
    region.
-   Support parsing and restore.
-   Preserve human-edited content.
-   Never overwrite Owner-authored strategic descriptions.

### F2 --- Read Latest Conversation

-   Ensure latest messages are not omitted by head truncation.
-   Prefer recent context.
-   Preserve message boundaries.
-   Test truncation behavior.

### F3 --- Host-aware Lifecycle Maintenance

Evaluate only verified events, and record the exact source event per
host profile together with its evidence grade:

-   Prompt build / user prompt submit (`before_prompt_build`,
    `UserPromptSubmit`) --- the only user-turn-carrying events.
-   Compaction **before** (`PreCompact`, `before_compaction`) and
    **after** (`PostCompact`, `after_compaction`).
-   Session resume / clear (`SessionStart.source` = `resume` \|
    `clear`).
-   Session end (`SessionEnd`, best-effort).
-   Agent-internal plan-item signals (`TaskCreated`, `TaskCompleted`)
    --- `HOST_TASK_GRAPH_CHANGED`, provenance only.
-   Subagent scope (`SubagentStart`, `SubagentStop`) --- scope hints
    only.
-   Workspace Focus update.

For the WorkBuddy profile (engine 2.165.0):

-   Classic `PreCompact` hooks **cannot prevent or delay compaction**.
    `allowed:false`, `continue:false` and exit code 2 only suppress
    adoption of the hook's stdout as extra compaction instructions. PD
    MUST NOT rely on PreCompact to block compression and MUST NOT return
    a blocking result from it. PD may perform only a **bounded Working
    Set checkpoint**: record `preCompactRevision`, write one journal
    line, and return.
-   **No LLM inference, no external model call, and no principle
    selection may execute inside a synchronous PreCompact hook.** The
    compaction path awaits this hook; any such work directly inflates
    compaction latency and violates §3.3.
-   `PostCompact` is observational: the host discards its return value.
    `compact_summary` is a lossy summary extracted from `<summary>` /
    `<conversation_history_summary>`; it has no length or completeness
    guarantee and may be absent. It MUST NOT be treated as the full
    context, MUST NOT be used as a `contextFingerprint` input, and MUST
    NOT authorize principle selection. `PostCompact` is a **state
    invalidation and revalidation signal** only (§8.2).
-   `transcript_path` is unchanged across compaction. PreCompact can
    read the pre-compaction transcript; PostCompact is triggered before
    an explicit history flush, so reading the post-compaction file is
    NOT guaranteed. PD MUST NOT depend on that.
-   `PreCompact` has no `hasHooks` gate and swallows exceptions;
    `PostCompact` has a `hasHooks` gate and swallows exceptions. Neither
    is guaranteed to dispatch. PD MUST NOT treat their absence as a
    confirmed boundary.
-   `SessionStart.source` values are `startup` / `resume` / `clear`; a
    `"compact"` value is NOT present in this engine build.

Do not assume each host exposes the same lifecycle, and do not use a
`NOT_RUN` or `PROBE_PENDING` cell from one runtime mode as evidence for
another.

### F4 --- Separate Read from Maintenance

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

### F5 --- Multi-session Isolation

Workspace Focus may be shared within the same workspace. Session Working
Sets remain isolated.

### F6 --- Cross-host Consistency Without Capability Fabrication

Use a common internal reader contract, but do not invent lifecycle
events or identity values.

If a host/mode cannot supply reliable Workspace Identity or Session
Identity, Model-assisted persisted Live is disabled for that profile.
Native remains available where safe.

## 9.4 Ownership

Owner retains final control over Workspace Focus and INTENT.

Selector cannot automatically modify:

-   INTENT.
-   Owner's strategic goals.
-   Owner-authored P0/P1/P2 descriptions.

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
    requireExactVersionMatch: true
    workbuddy:
      appVersion: "5.9.2"
      engineVersion: "2.165.0"
      engineSha256: "6fbfd77bae7e7688abf7dfd2488b50c79390c966a9132e73ebe7a5a2d7df99cf"
      runtimeMode: "desktop_cli_engine"
      pdPluginVersion: "0.2.2"
      pluginConfigSha256: "<canonical-v1 hash of enabled plugin config files>"
      effectiveHookSetFingerprint: "<canonical-v1 hash of host-resolved effective hook set>"
      fingerprintNormalization: "canonical-v1"
      effectiveSourceCoverage: "partial"   # complete | partial | unknown
      coveredConfigSources:
        - "plugin_manifest_hooks"
        - "plugin_root_hooks_json"
        - "host_getHooks_merge"
      unobservableSourcesNote: "runtime content of host-side getHooks merge is not fully observable from PD"
      rootFingerprint: "<computed identity fingerprint, no absolute path>"
      hookTimeoutsMs:
        UserPromptSubmit: 15000
        default: 30000
      hostDefaultTimeoutMs: 60000
      deferredWorker:
        carrier: "pd_existing_worker"   # pd workbuddy worker + Runtime V2 task lease
        enabled: false                  # OFF; contract not implemented
        cycleIntervalMs: 120000
        leaseTtlMs: 300000
      hostAsyncHook:
        enabled: false                  # OFF / DEFERRED_PENDING_EVIDENCE
        asyncTimeoutMs: 30000           # bounds child lifetime only; NOT result commit
```

Important:

-   `workerTimeoutMs` applies to deferred model work, not the
    synchronous host hook.

-   The v0.3 values 1.5 s and 3 s remain initial model-worker targets
    only. They are not host budgets and are not evidence-backed
    performance guarantees.

-   Synchronous hook work must not wait for these calls.

-   `persistence.enabled` remains OFF until database ownership and
    identity gates pass.

-   Installed plugin/runtime version must be inspected; do not assume
    repository canonical configuration equals the installed cache.

-   `hookTimeoutsMs` values are **resolved at runtime from the enabled
    plugin's `hooks/hooks.json`**; the YAML values above are the frozen
    profile baseline used for mismatch detection, not an override
    authority. This dynamic resolution is a **correctness /
    configuration-drift fix**, not a performance optimization.

-   `resolveHostProfile()` MUST read `install-manifest.json`,
    `cli/package.json`, `installed_plugins.json` and the enabled
    `hooks/hooks.json`, compute `pluginConfigSha256`,
    `effectiveHookSetFingerprint` and `rootFingerprint`, compare them
    with the frozen profile, and set `profile.status = EXPIRED` on any
    mismatch. On `EXPIRED`, fall back to Native-only and discard
    deferred results bound to the old profile.

-   `effectiveSourceCoverage` MUST be declared explicitly. `partial` or
    `unknown` coverage caps `profile.status` at
    `CONDITIONALLY_VERIFIED`; a fully `VERIFIED` profile requires
    complete coverage plus runtime evidence. No unobservable host
    configuration source may be assumed to be covered (§8.3.1).

-   The host engine contains no `pluginConfigSha256` /
    `effectiveHookSetFingerprint` / `rootFingerprint` / coverage
    mechanism; PD computes all of them. Absolute plugin paths are never
    written to long-term receipts. These fingerprints are integrity
    anchors only --- they do not create a configuration management
    system or a second config authority.

## 10.3 Model Selection Policy

Decision Model priorities:

-   Low latency.
-   Low cost.
-   Stable structured output.
-   Adequate task-change understanding.

General Selector priorities:

-   Abstract principle understanding.
-   Long-context understanding.
-   Multi-label judgment.
-   Constraint reasoning.
-   Stable structured output.

The Decision Model does not need to understand abstract principles. The
General Selector owns that task.

## 10.4 Deferred Execution Prerequisite

A deferred model path requires a safe execution mechanism that does not
block the host prompt hook.

Before enabling Shadow or Live, verify whether an existing PD or host
worker/Agent execution path can:

-   Accept a refresh request without blocking the hook.
-   Persist or safely cache the result.
-   Enforce workspace/session/profile binding.
-   Cancel or discard stale work.
-   Avoid duplicate concurrent refreshes.
-   Report failures and latency.

Reuse existing runtime infrastructure if it satisfies these
requirements. Do not assume a host supports background execution merely
because it supports prompt hooks. If no safe deferred execution
mechanism is proven, keep model-assisted modes OFF and use Native.

### 10.4.1 WorkBuddy deferred carrier (REVISED)

PD already ships a detached background worker: PD Companion spawns
`pd workbuddy worker` as a separate process on a 120 s cycle, backed by
the durable Runtime V2 task lease (`lease_owner`, `lease_expires_at`,
`status`) and a recovery sweep. This is the **candidate carrier** for
Deferred Refresh and is preferred over any new worker subsystem.

However, the Deferred Refresh **contract** --- context fingerprint
binding, Working Set revision fencing, stale-result discard, and "result
affects only a later prompt boundary" --- is not implemented in PD code.
Therefore Shadow and Live remain OFF until the contract is implemented,
tested, and verified in an isolated probe.

### 10.4.2 Detached worker lifetime and result safety (NEW, hard constraints)

1.  A detached worker **may continue executing after the originating
    session has ended**. The host provides no session-bound cleanup
    guarantee for detached hooks: `killAllHooksSync()` is reachable only
    from the `process.exit` wrapper, not from `SessionEnd`,
    `process.on("exit")`, or `beforeExit`; natural event-loop drain,
    crashes, and OS-level termination leave no cleanup. PD MUST assume
    the worker outlives the session.
2.  The worker MUST NOT inject content into the current user turn and
    MUST NOT modify a prompt already submitted to the host.
3.  Every worker result MUST be bound to `sessionId`, `generationId`
    (when the source event supplies one), `hostTaskId` (when supplied),
    `workingSetRevision`, `contextFingerprint` and `hostProfileId`.
    Missing fields remain missing; no fabricated identifiers.
4.  A result produced under a closed, different, or `EXPIRED`
    session/profile MUST NOT contaminate a new session. Safety is
    enforced by session-scoped keys, the durable task lease, a Working
    Set revision fence, idempotency keys, and stale-result discard. On
    any mismatch the result is discarded and
    `worker_result_stale_discarded` is recorded.
5.  `asyncTimeout` bounds child process lifetime only. It does **not**
    validate or wait for a result commit, and MUST NOT be used as a
    substitute for a durable journal entry plus a revision check.
6.  Deferred results are consumed only at a later verified
    `BEFORE_MODEL_TURN`. The current turn always uses Native or a valid
    cached Working Set.

### 10.4.3 Host-native async hook status (NEW)

WorkBuddy engine 2.165.0 exposes an `async: true` / `asyncTimeout`
branch in source. It is `PROBE_PENDING`: no isolated runtime probe has
confirmed detach behavior, timeout enforcement, or session-exit behavior
on the current build. It is **OFF** and MUST NOT be adopted as the
Deferred Refresh carrier until such a probe is `RUNTIME_VERIFIED` and
Owner accepts the change. Other hosts remain subject to their own worker
verification; no cross-host inference is permitted.

# 11. Feature Flags and Rollout Modes

## 11.1 Mode Definitions

``` typescript
type AdaptiveActivationMode = "native" | "shadow" | "live";
```

### Native

Default mode:

-   No external model calls.
-   Existing selection behavior remains authoritative.
-   No Model-assisted result changes the injected set.

### Shadow

-   Native produces the actual prompt contribution.
-   Deferred Model-assisted work computes a comparison result.
-   Model result is not injected.
-   Differences and evidence are recorded.
-   Owner explicitly opts into external context transmission.
-   Shadow does not imply Live readiness.

### Live

-   Uses a valid Model-assisted Working Set at a later prompt boundary.
-   Still passes Runtime V2 activation revalidation, existing
    budget/packer, and renderer.
-   Requires explicit Owner authorization per host profile/workspace.
-   Any stale result, worker failure, validation error, or missing
    profile falls back to Native.
-   No automatic promotion from Shadow.

## 11.2 Default Flags

  -----------------------------------------------------------------------
  Feature                             Default
  ----------------------------------- -----------------------------------
  Adaptive Activation                 OFF / Native

  Decision Model                      OFF

  General Selector Model              OFF

  Shadow Mode                         OFF

  Live Mode                           OFF

  Working Set Persistence             OFF until storage gate passes

  Host Adapter Model-assisted         OFF
  execution                           

  Current Focus Repair                Separate authorized maintenance
                                      task

  Intent Engineering                  Existing default OFF

  External Context Transmission       Explicit Opt-in

  Codex TUI                           Disabled / NOT_RUN

  WorkBuddy Desktop 5.9.2 / engine    Native `UserPromptSubmit` profile
  2.165.0                             is `CONDITIONALLY_VERIFIED`;
                                      Desktop UI-only and standalone IDE
                                      remain OFF / `NOT_RUN`

  OpenClaw reply `/reset`             Not relied upon / NOT_RUN

  OpenClaw ordinary Gateway turn      Not relied upon / NOT_RUN

  WorkBuddy host-native async refresh OFF / `DEFERRED_PENDING_EVIDENCE`
                                      --- isolated probe required

  WorkBuddy `PROBE_PENDING` lifecycle OFF until a `RUNTIME_VERIFIED`
  triggers                            isolated probe per event class

  PD existing-worker Deferred Refresh OFF until implemented, tested, and
  contract                            probe-verified

  Host Profile exact-version          OFF until `resolveHostProfile()` is
  enforcement                         implemented and tested

  `HOST_TASK_GRAPH_CHANGED`           OFF (weak signal; no semantic
  provenance capture                  authority)

  Current-version `confirmed`         DISABLED until request-level
  delivery claim                      evidence exists
  -----------------------------------------------------------------------

------------------------------------------------------------------------

### 11.2.1 Mandatory observability (not a feature flag)

The Delivery Integrity journal is **not** a feature flag and is not
optional. It is a mandatory, behavior-neutral evidence mechanism:

-   one append-only journal line at hook entry and one at hook
    termination;
-   no synchronous database operation, no schema DDL, no idempotency
    reads;
-   bounded by the receipt latency budget in §17.3;
-   failure of the journal write MUST NOT change the injection payload,
    the exit code, or the turn outcome.

Because it adds no selection, activation, injection, or model behavior,
it does not conflict with the "all flags OFF by default" rule in §0
Status.

  -------------------------------------------------------------------------------
  Capability           Flag default                  Enabling gate
  -------------------- ----------------------------- ----------------------------
  Native injection via Existing production behavior  Profile
  `UserPromptSubmit`                                 `CONDITIONALLY_VERIFIED` +
                                                     degraded receipts observable

  Degraded             Mandatory (no flag)           Gate 0 (T-03/T-04)
  observability                                      
  journal                                            

  Host Profile         OFF                           Gate 0 (T-01)
  exact-version                                      
  enforcement                                        

  `PROBE_PENDING`      OFF                           Gate 0 (P3/P4 probes)
  lifecycle triggers                                 

  PD worker Deferred   OFF                           Gate 4 (§10.4.1 contract +
  Refresh                                            probe)

  Host-native async    OFF /                         Gate 4 + isolated P6 probe +
  refresh              `DEFERRED_PENDING_EVIDENCE`   Owner acceptance

  Model-assisted       OFF                           Gates 0--4
  Shadow                                             

  Model-assisted Live  OFF                           Gates 0--5 + explicit Owner
                                                     authorization
  -------------------------------------------------------------------------------

No gate may be satisfied by a `SOURCE_CONFIRMED` or `OFFICIAL_DOC` claim
alone where the gate requires `RUNTIME_VERIFIED`.

# 12. Host Runtime Capability Profiles

## 12.1 Host Profile Is a Hard Contract

A Host Runtime Capability Profile binds a specific combination of:

-   Host kind.
-   Host version.
-   PD adapter/plugin version.
-   Runtime mode.
-   Source event.
-   Hook timeout and failure semantics.
-   PD's own configured hook budget.
-   Injection channel.
-   Identity capabilities.
-   Evidence references and verification date.

A host name alone is not a profile. `Codex headless CLI` and
`Codex interactive TUI` are different profiles. The verified WorkBuddy
profile is **Desktop 5.9.2 hosting CLI engine 2.165.0**; Desktop UI-only
capabilities and standalone IDE runtime are separate, unverified
profiles. `lite-wb` is an engine entry-file name, not a runtime mode.

## 12.2 Profile Contract

``` typescript
type ProfileStatus =
  | "VERIFIED" | "CONDITIONALLY_VERIFIED" | "NOT_RUN" | "EXPIRED";

type EvidenceGrade =
  | "OFFICIAL_DOC" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED"
  | "STATIC_CONFIG" | "HISTORICAL_PROBE" | "INFERRED"
  | "PROBE_PENDING" | "NOT_RUN" | "UNKNOWN" | "NOT_FOUND";

/** Long-term identity. NO absolute filesystem paths. */
interface HostPluginIdentity {
  pluginId: string;              // "principles-disciple@principles-disciple-market"
  pluginVersion: string;         // "0.2.2"
  profileId: string;
  pluginConfigSha256: string;    // plugin's own config files (manifest hooks + hooks/hooks.json)
  effectiveHookSetFingerprint: string; // host-resolved + merged effective hook set
  fingerprintNormalization: string;    // e.g. "canonical-v1"
  effectiveSourceCoverage: "complete" | "partial" | "unknown";
  coveredConfigSources: string[];      // source NAMES only, never paths
  unobservableSourcesNote?: string;
  rootFingerprint: string;       // sha256(marketplaceId|pluginId|version|pluginConfigSha256)
  discoverability: "registry_resolved" | "plugin_dir" | "unknown";
  effectiveHookRegistrations?: number; // same-event registrations after merge
}

interface HostRuntimeCapabilityProfile {
  profileId: string;
  revision: string;

  hostKind: "openclaw" | "codex" | "workbuddy";
  hostVersion: string;
  engineVersion: string;
  engineSha256?: string;
  electronVersion?: string;
  runtimeMode: string;           // "desktop_cli_engine"
  pdAdapterVersion?: string;
  plugin: HostPluginIdentity;

  beforeModelTurn: {
    sourceEvent: string;
    verified: boolean;
    evidenceGrade: EvidenceGrade;
    dispatchSamples: number;
  };

  /** Events usable ONLY as refresh/evidence signals; never as semantic authority. */
  refreshEvents: Array<{
    sourceEvent: string;
    evidenceGrade: EvidenceGrade;
    dispatchSamples: number;
    semanticAuthority: false;
    triggerClass: "structural" | "provenance_only";  // NEW v0.2.1: never "semantic"
    activation: "enabled" | "off" | "deferred_pending_evidence";
    boundaryClass:
      | "user_task" | "agent_internal_plan" | "subagent_scope"
      | "tool_phase" | "session_lifecycle" | "compaction";
  }>;

  identity: {
    workspaceId: "verified" | "partial" | "unavailable";
    sessionId: "verified" | "partial" | "unavailable";
    generationId: "verified" | "partial" | "unavailable";
    hostTaskId: "verified" | "partial" | "unavailable"; // snake_case task_id
    hookEventName: "verified" | "partial" | "unavailable";  // NEW: dedup key component
    hookInvocationId: "verified" | "partial" | "unavailable"; // NEW: journal correlation
    eventUniqueId: "verified" | "partial" | "unavailable";   // NEW: host-provided, if any
    turnId: "verified" | "partial" | "unavailable";
    deduplication: "verified" | "partial" | "unavailable";
    correlationStatus: "correlated" | "unreliable" | "unknown";
    note?: string; // e.g. "generation_id absent on Task/PostCompact payloads"
  };

  /** Seven separate timing dimensions; never collapse into one number. */
  timing: {
    hostDefaultTimeoutMs: number;          // 60000
    hostHookTimeoutMs: number;             // resolved from enabled hooks.json
    wrapperSelfDeadlineMs: number;         // budget setting, not a measurement
    pdSyncPathP95Ms?: number;              // measured, may be unknown
    pdSyncPathP99Ms?: number;
    sessionStartHookSelfMs?: number;       // 15552 observed
    sessionStartChainMs?: number;          // 16736 observed, includes other plugins
    sqliteContention: "measured" | "static_only" | "unknown";
    receiptWriteP99Ms?: number;
    softDeadlineMs?: number;
    resolutionSource: "installed_config" | "source_confirmed" | "measured";
  };

  failureSemantics: {
    onHostKill: "block_submission" | "fail_open" | "block_tool" | "unknown";
    onExit0: string;
    onExit1: string;
    onExit2: string;
    onSelfDegradation: string;
    /** NEW v0.2.1: whether independent host evidence for submission outcome exists. */
    submissionOutcomeEvidence: "host_log" | "request_probe" | "none" | "unknown";
    submissionOutcomeDefault: "unknown";
    preCompactCanBlock: false;             // classic hook cannot prevent compaction
    postCompactObservational: true;
  };

  injection: {
    channel: "system" | "developer" | "user_prefix"
           | "user_message_system_reminder" | "unknown";
    confirmedClaimAllowed: boolean;        // false for current WorkBuddy profile
    encodingContract: string;
    hostContentLimit: "enforced" | "absent";
    injectionPosition?: "first" | "last";
  };

  asyncCapability: {
    pdExistingWorker: "implemented" | "contract_missing" | "unavailable";
    hostNativeDetachedHook: "probe_pending" | "runtime_verified" | "unavailable";
    detachedWorkerMayOutliveSession: true;
    contributesToCurrentTurn: false;
    asyncTimeoutValidatesResultCommit: false;
    activation: "off" | "owner_gated";
  };

  verifiedAt: string;
  evidenceReferences: string[];
  status: ProfileStatus;         // VERIFIED requires effectiveSourceCoverage === "complete"
  /** NEW v0.2.1: implementation status is INDEPENDENT of profile status. */
  implementationStatus:
    | "PROPOSED" | "SPEC_REVISED" | "IMPLEMENTED" | "TESTED"
    | "RUNTIME_VERIFIED" | "ACCEPTED" | "DEFERRED_PENDING_EVIDENCE";
  reviewDisposition?: "ACCEPT" | "ACCEPT_WITH_CHANGE" | "REJECT" | "DEFERRED_PENDING_EVIDENCE";
  baselineProvenance: "RETAINED_FROM_V0_4" | "RETAINED_FROM_V0_2"
                    | "REVISED_IN_V0_2_1" | "NEW_IN_V0_2_1";
}
```

The profile is evidence-bound. A version change, runtime-mode change,
adapter change, or event-contract change invalidates the relevant
verification until rechecked.

## 12.3 Verified Host Matrix

The table below is scoped to the exact runtime modes tested by Host
Event Capability Matrix v0.1.

  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Host/runtime       Verified events                                                                                               Hook-to-request         Host timeout / failure  PD configured     Injection channel                      Status
  profile                                                                                                                          observation                                     budget                                                   
  ------------------ ------------------------------------------------------------------------------------------------------------- ----------------------- ----------------------- ----------------- -------------------------------------- --------------------------
  Codex 0.166.0      `UserPromptSubmit` 8/8; `SessionStart` 8/8; `Stop` 8/8                                                        UPS to model request:   Host default 600 s;     PD UPS 5 s        `developer` via `additionalContext`    VERIFIED-E3
  headless CLI                                                                                                                     +58--68 ms; median 60   timeout marks hook                                                               
                                                                                                                                   ms                      failed, turn continues                                                           

  Codex interactive  Not run                                                                                                       ---                     Host default 600 s; PD  5 s               Not independently verified in TUI      NOT_RUN: ConPTY/TTY driver
  TUI                                                                                                                                                      configured 5 s                                                                   unavailable

  WorkBuddy Desktop  `UserPromptSubmit` 1/1; `SessionStart` 1/1; `PreToolUse` 164; `PostToolUse` 162 (RUNTIME_VERIFIED).           Start-to-spawn          Host default 60 s       Enabled `0.2.2`   **`user` message                       `CONDITIONALLY_VERIFIED`
  5.9.2 / CLI engine `SessionEnd`/`Stop`/`PreCompact`/`PostCompact`/`TaskCreated`/`TaskCompleted`/`SubagentStart`/`SubagentStop` = `timeout=15000ms`;      overridden by enabled   `hooks.json` is   `<system-reminder data-role="hook">`   --- degraded delivery must
  2.165.0 / PD 0.2.2 `PROBE_PENDING` (SOURCE_CONFIRMED dispatch points, 0 live samples). Concurrent spawn across plugins observed. **this session's UPS    plugin                  byte-identical to before `<user_query>`**; UPS=`last`,   be fixed before Live
                                                                                                                                   hook degraded at 12.113 `hooks/hooks.json`: UPS canonical         SessionStart=`first`; no host-side     
                                                                                                                                   s with exit 1 and       15 s, others 30 s. Host (SHA-256          content limit; `confirmed` claim not   
                                                                                                                                   produced zero injection kill / exit 2 →         `556d546a…`).     allowed                                
                                                                                                                                   records**               `block_submission`;     Stale                                                    
                                                                                                                                                           exit 1 → non-blocking   `0.1.0`/`0.2.0`                                          
                                                                                                                                                           turn continues.         directories exist                                        
                                                                                                                                                           `SessionStart` self     physically but                                           
                                                                                                                                                           15.6 s / chain 16.7 s   are NOT                                                  
                                                                                                                                                                                   discoverable:                                            
                                                                                                                                                                                   loading resolves                                         
                                                                                                                                                                                   a single                                                 
                                                                                                                                                                                   `installPath`.                                           
                                                                                                                                                                                   `mergeHooks`                                             
                                                                                                                                                                                   concatenation                                            
                                                                                                                                                                                   applies to config                                        
                                                                                                                                                                                   sources within                                           
                                                                                                                                                                                   one root, not                                            
                                                                                                                                                                                   version                                                  
                                                                                                                                                                                   directories                                              

  WorkBuddy          Not run                                                                                                       ---                     IDE official docs       Do not assume     Unknown                                `NOT_RUN`: no isolated IDE
  standalone IDE                                                                                                                                           describe 7 events and a                                                          runtime probe
  runtime                                                                                                                                                  different config/exit-2                                                          
                                                                                                                                                           model; **not runtime                                                             
                                                                                                                                                           evidence for this                                                                
                                                                                                                                                           profile**                                                                        

  OpenClaw           `before_prompt_build`, `before_tool_call`, `after_tool_call`, `llm_output`, `before_compaction`,              `before_prompt_build`   `before_prompt_build`   PD-specific       `system` body + `user` prefix for      VERIFIED-E3 for tested
  2026.10.10         `after_compaction`, `before_message_write` observed                                                           to model request        host timeout 15 s;      internal budget   short dynamic directive                embedded profile
  embedded                                                                                                                         +871--1846 ms in normal fail-open and request   NOT ESTABLISHED                                          
                                                                                                                                   turns; +145--390 ms in  continues               by this probe                                            
                                                                                                                                   compaction retry turns                                                                                   

  OpenClaw Gateway   `before_reset`, `session_end`, `session_start` 4/4/4; order verified                                          Reset-to-end 12--17 ms; `session_start` has no  Not applicable to Not a prompt-delivery profile          VERIFIED-E3 for this reset
  `sessions.reset`                                                                                                                 end-to-start 0--1 ms    default timeout in the  prompt hook                                              path only
                                                                                                                                                           inspected source        budget                                                   

  OpenClaw reply     Not run                                                                                                       ---                     Unknown                 Unknown           Unknown                                NOT_RUN
  `/reset`                                                                                                                                                                                                                                  

  OpenClaw ordinary  Not run by this matrix                                                                                        ---                     Unknown                 Unknown           Unknown                                NOT_RUN
  Gateway turn                                                                                                                                                                                                                              
  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

### Evidence interpretation

-   The 2026-11-04 live log contains 332 hook spawns; `0` host-side
    timeouts and `0` blocked submissions. PD's own wrapper self-degraded
    once (exit 1, non-blocking) and that turn received no principle
    contribution. A degraded hook is a first-class **execution**
    outcome, never a success.
-   WorkBuddy tool events are `RUNTIME_VERIFIED` for the current profile
    (164/162 live dispatches + historical P02/P03 contract). Lifecycle
    and compaction events are `PROBE_PENDING`: their dispatch points are
    `SOURCE_CONFIRMED`, but there are zero live samples and their
    payload semantics must not be assumed. `PROBE_PENDING` is not
    `Supported`.
-   `TaskCreated` / `TaskCompleted` are Agent-internal todo
    notifications with no user-request identity. They are classified as
    `boundaryClass: "agent_internal_plan"`, `triggerClass: "structural"`
    and carry `semanticAuthority: false`. They are correlated with the
    §5.2.2 composite key and MUST NOT be deduplicated against each
    other. WorkBuddy Desktop UI-only capabilities remain `NOT_RUN`; the
    Desktop's hook engine itself is verified because it runs as the CLI
    engine subprocess inside the Desktop process tree.
-   The current profile records `effectiveSourceCoverage: "partial"`:
    the host-side `getHooks` merge is `SOURCE_CONFIRMED` but its runtime
    content is not fully observable from PD. Therefore the profile MUST
    NOT be declared fully `VERIFIED`; `CONDITIONALLY_VERIFIED` is the
    maximum until coverage is `complete` and the effective hook set is
    `RUNTIME_VERIFIED` (§8.3.1, §10.2).

## 12.4 Host-specific Execution Rules

### Codex headless CLI

-   Only the headless CLI profile is verified.
-   The synchronous PD `UserPromptSubmit` budget is 5 s, despite the
    host outer timeout being 600 s.
-   The hook may perform bounded local reads, validation, Native
    selection, budget packing, and rendering.
-   It MUST NOT wait for remote Decision Model or Selector inference.
-   Do not depend on Codex tool hooks; the tested Codex hook set does
    not provide tool events.
-   Injection is `developer` via `additionalContext`; do not describe it
    as system-level.
-   TUI remains disabled until independently tested.

### WorkBuddy Desktop / CLI engine profile

-   Only the profile
    `workbuddy-desktop/5.9.2/cli-engine-2.165.0/pd-0.2.2` is
    `CONDITIONALLY_VERIFIED`. `lite-wb` is an engine file name, not a
    runtime mode.
-   Use `UserPromptSubmit` (15 s) as the **sole injection event**. It is
    the only hook that can contribute context to the current turn.
-   Use `SessionStart` (30 s) only for health checks and host-profile
    binding verification; it injects at position `first` and MUST NOT be
    used to count sessions or clear a Working Set.
-   `PROBE_PENDING` lifecycle events (`SessionEnd`, `Stop`,
    `PreCompact`, `PostCompact`, `TaskCreated`, `TaskCompleted`,
    `SubagentStart`, `SubagentStop`) are **OFF** until an isolated
    `RUNTIME_VERIFIED` probe. They may never inject, may never select
    principles, and may never produce a `TaskChangeType` decision
    (§5.2.1). `PreToolUse` and `PostToolUse` are verified evidence
    channels (§7.1 single Resolver rule). `PostToolUseFailure` has zero
    live samples and remains OFF until separately probed.
-   Do not return `continue: false` from `PreToolUse`: it causes the
    host to re-submit the user prompt and re-fire `UserPromptSubmit`.
-   **Timeout semantics are two-path, not one**: host-side kill of the
    hook (configured timeout exceeded) or `exit 2` / `deny` /
    `continue:false` yields `allowed:false` and **blocks and clears the
    user prompt**; PD's own self-degradation MUST exit with a
    non-blocking code and MUST write a degraded journal line. The
    adapter MUST resolve its soft deadline from the **actually enabled
    `hooks/hooks.json`**, never from a hard-coded constant, and keep it
    strictly below the resolved hard limit. This is a correctness fix,
    not a performance optimization.
-   Classic `PreCompact` hooks cannot prevent compaction; `PostCompact`
    is observational; `compact_summary` is lossy metadata. PD performs
    only a bounded checkpoint at PreCompact and a state-invalidation at
    PostCompact (§9.3). No LLM in the synchronous compaction path.
-   Injection channel is `user_message_system_reminder`. Content MUST be
    self-contained, MUST NOT be written in the voice of a user
    instruction, and MUST NOT assume system/developer priority. The host
    provides **no** `additionalContextLimit`; PD MUST truncate using the
    existing Prompt Capacity Budget and record truncation in the journal
    (no synchronous DB).
-   Host-native `async: true` hooks are `PROBE_PENDING` / OFF. The
    Deferred Refresh candidate carrier is PD's existing detached worker,
    whose contract is not yet implemented (§10.4).
-   `pluginConfigSha256` + `effectiveHookSetFingerprint` +
    `rootFingerprint` identify the enabled plugin configuration and the
    host-resolved effective hook set separately.
    `effectiveSourceCoverage` is declared `partial` for this profile; a
    `partial` / `unknown` coverage caps `profile.status` at
    `CONDITIONALLY_VERIFIED`. Physical presence of stale version
    directories is not evidence of duplicate registration (§8.3.1).
    Long-term receipts carry fingerprints and source **names**, never
    absolute paths.
-   `HostSubmissionOutcome` is an **independent fourth observation
    dimension**. It defaults to `unknown` and may be upgraded to
    `proceeded` or `blocked` only with independent host evidence (host
    log / request probe). `exit 2`, `deny`, `continue:false` and host
    kill are recorded by their actual Hook execution result; they MUST
    NOT all be classified as `timeout`, and a Hook failure MUST NOT by
    itself imply a blocked submission (§13.4). This WorkBuddy-specific
    failure semantics MUST NOT be extrapolated to OpenClaw or Codex.
-   `structuralRevalidationRequired` and `semanticReevaluationRequired`
    are independent. `PROBE_PENDING` lifecycle / Task events may set
    only the former; only a verified user semantic change or a SPEC v0.4
    §5-authorized semantic trigger may set the latter, and only
    `principle_decision` may perform it (§5.2.3).
-   `TaskCreated` and `TaskCompleted` are correlated with the §5.2.2
    composite key, retained as distinct events, and never used to skip
    or indirectly trigger `principle_decision`.
-   Standalone IDE runtime and Desktop UI-only capabilities remain
    excluded.

### OpenClaw embedded

-   Use the typed hook API verified by the probe (`api.on(...)`); do not
    use the legacy `api.registerHook(...)` path for typed lifecycle
    events.
-   `before_prompt_build` maps to the internal `BEFORE_MODEL_TURN` event
    for the verified embedded profile.
-   Host hook timeout is 15 s and failure is fail-open: the model
    request can proceed while the injection is silently skipped.
-   PD must record its own delivery result; absence of a host error is
    not success evidence.
-   Use `prependSystemContext` for the main principle content and
    `prependContext` for short dynamic user-prefix directives, as
    supported by the verified injection path.
-   Keep injected content self-contained. Do not assume that every
    instruction in a system channel is automatically followed.
-   Do not rely on `turn_complete`; it was not present in the tested
    OpenClaw version. `llm_output` is a different event and must not be
    treated as semantically equivalent.
-   Gateway reset lifecycle evidence is restricted to `sessions.reset`;
    do not extrapolate to reply `/reset` or ordinary Gateway turns.

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

10. Never use a different runtime mode's evidence to fill a `NOT_RUN`
    cell.

11. CLI, IDE and Desktop documentation describe different contracts. A
    capability claim MUST name its source document, engine version,
    runtime mode and evidence date. Do not use an IDE-only document to
    deny an engine capability, and do not use engine source to claim an
    IDE runtime is verified.

12. When official documentation, matched-version source and live runtime
    disagree, record all three separately with their evidence grades;
    resolution for the active profile follows the priority in §2.1.

13. `NOT_RUN` from one runtime mode MUST NOT be used to fill a cell of
    another runtime mode, and MUST NOT be silently upgraded to
    "supported" because the same engine binary contains the event name.

14. **Source-level presence of an event name is not semantic support.**
    A dispatch point proves only that the host can emit an event; it
    does not prove what the event means. `TaskCreated` / `TaskCompleted`
    are Agent-internal plan-item notifications and MUST NOT be mapped to
    a user task boundary (§5.2.1).

15. Evidence grades and implementation states MUST NOT be upgraded
    across the ladder in §0.2 without the corresponding evidence.
    `SOURCE_CONFIRMED` is not `RUNTIME_VERIFIED`; `PROBE_PENDING` and
    `NOT_RUN` are not `Supported`.

16. A host event MUST NOT bypass PD's semantic judgment. No host event
    may produce a `TaskChangeType` decision, skip `principle_decision`,
    or select / activate / deactivate a principle. A structural
    revalidation signal MUST NOT be promoted into a semantic
    reevaluation at the next `BEFORE_MODEL_TURN` (§5.2.3).

17. Host event deduplication MUST use the §5.2.2 key. `TaskCreated` and
    `TaskCompleted` are distinct events; missing identity fields are
    recorded as `unreliable` / `unknown`, never fabricated.

18. Hook execution state, payload state, selection state and **host
    submission outcome** are four independent observations. No
    observation may be inferred from another, and host-specific failure
    semantics MUST NOT be generalized across hosts (§13.4).

19. `pluginConfigSha256` and `effectiveHookSetFingerprint` are distinct.
    Only `SOURCE_CONFIRMED` participating config sources may be
    included; coverage MUST be declared; a profile with incomplete
    coverage MUST NOT be declared fully `VERIFIED` (§8.3.1).

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

  --------------------------------------------------------------------------
  Host profile Verified injection Contract
               channel            
  ------------ ------------------ ------------------------------------------
  OpenClaw     `system` main      Main principles via
  embedded     body + `user`      `prependSystemContext`; short dynamic
               prefix short       directives via `prependContext`
               directive          

  Codex        `developer`        Use `additionalContext`; do not claim
  headless CLI                    system priority

  WorkBuddy    Unknown            Injection occurred, but role/channel is
  Desktop                         not established; use self-contained text
  5.9.2 / CLI                     and avoid role-priority assumptions
  engine                          
  2.165.0                         

  Unverified   Unknown            Model-assisted Live disabled
  modes                           
  --------------------------------------------------------------------------

For the current WorkBuddy Desktop 5.9.2 / engine 2.165.0 profile,
matched engine source identifies the contribution as a `user` message
containing `<system-reminder data-role="hook">` before `<user_query>`
(`SOURCE_CONFIRMED`). The matrix above retains `Unknown` as the verified
request-level channel because the current-version request probe is
`NOT_RUN`. `confirmedClaimAllowed=false`; no system/developer priority
may be assumed.

## 13.3 Injection Content Rules

-   Preserve Principle Artifact meaning; do not rewrite the principle
    into a new policy.

-   Keep dynamic directives short and separately attributable.

-   Do not inject model reasoning or free-form selector explanations as
    commands.

-   Make content self-contained.

-   Respect each host's actual output-size constraints.

-   Use existing Renderer and escaping/sanitization rules.

-   Do not assume message role or precedence beyond the verified
    profile.

-   **WorkBuddy**: recording truncation MUST be a single append-only
    journal line. It MUST NOT add a synchronous database operation, an
    idempotency read, or a schema operation to the prompt hook.

## 13.4 Delivery Integrity

Delivery is described by **four independent observation dimensions plus
evidence and journal state**. No single `injectionStatus` enum may
combine them. The four dimensions are:

1.  `HookExecutionStatus` --- how the PD hook process ended.
2.  `PayloadStatus` --- what happened to the injection payload.
3.  `SelectionStatus` --- what the selection stage decided.
4.  `HostSubmissionOutcome` --- whether the **user submission**
    proceeded, was blocked, or is unknown. This is a host-level
    observation and MUST NOT be inferred from any of the first three.

``` typescript
type HookExecutionStatus =
  | "completed"   // hook returned normally (exit 0)
  | "degraded"    // hook intentionally returned neutral because of a
                  // self-imposed deadline, dependency failure or resource limit
  | "timeout"     // host-side kill with independent host evidence; PD self-deadline is degraded
  | "failed"      // execution or encoding error
  | "unknown";    // termination cause cannot be established

type PayloadStatus =
  | "none"        // no payload produced (policy, valid empty selection, or degradation)
  | "prepared"    // renderer produced content, not yet returned
  | "returned"    // adapter emitted payload to the host callback; request inclusion is not proven
  | "confirmed"   // independent request-level evidence of entry into the
                  // current model request
  | "unknown";    // cannot be established (missing evidence)

type SelectionStatus =
  | "selected"         // semantic judgment succeeded; principles selected
  | "none_applicable"  // semantic judgment succeeded; VALID EMPTY DECISION
  | "skipped"          // policy or feature flag decided NOT to run selection
  | "unavailable";     // dependency failure prevented selection

type HostSubmissionOutcome =
  | "proceeded"   // independent host evidence: the user submission continued
  | "blocked"     // independent host evidence: the submission was blocked
  | "unknown";    // DEFAULT; no independent host evidence

type ReceiptState = "open" | "closed" | "reconciled";

type EvidenceGrade =
  | "OFFICIAL_DOC" | "SOURCE_CONFIRMED" | "RUNTIME_VERIFIED"
  | "STATIC_CONFIG" | "HISTORICAL_PROBE" | "INFERRED"
  | "PROBE_PENDING" | "NOT_RUN" | "UNKNOWN" | "NOT_FOUND";

interface DeliveryEvidence {
  evidenceGrade: EvidenceGrade;
  evidenceReference?: string;   // mandatory for "confirmed" and for non-unknown submission outcomes
  observedAt: string;           // ISO 8601
  independentlyVerified: boolean;
}

interface DeliveryIntegrity {
  hookInvocationId: string;          // generated at the earliest wrapper entry
  hostRequestId?: string;            // only when the host actually supplies one
  correlationStatus: "correlated" | "unreliable" | "unknown";

  receiptState: ReceiptState;
  execution: HookExecutionStatus;    // "unknown" while "open"
  payload: PayloadStatus;            // "unknown" while "open"
  selection: SelectionStatus;        // "unavailable" while "open"
  submission: HostSubmissionOutcome; // "unknown" while "open" — INDEPENDENT

  evidence: DeliveryEvidence;
  reconciliation?: {
    source: "journal" | "host_log" | "request_diff" | "worker";
    at: string;
    note?: string;
    outcome?: "confirmed" | "unknown" | "timeout";
  };
}
```

### 13.4.0 ReceiptState semantics (NEW, v0.2.1)

  -----------------------------------------------------------------------
  State                           Meaning
  ------------------------------- ---------------------------------------
  `open`                          A T0 journal line exists: the
                                  invocation **has started**, no terminal
                                  record yet. It is NOT a success, NOT a
                                  timeout and NOT a blocked submission.

  `closed`                        The hook produced a **terminal record**
                                  (T2 / T4a / T4b / T4c / D1 / D2) ---
                                  any outcome, including failure,
                                  degradation or a valid empty selection.

  `reconciled`                    Background reconciliation **has
                                  completed**, regardless of its result
                                  (`confirmed`, `unknown` or `timeout`).
                                  `reconciled` NEVER means delivery
                                  succeeded.
  -----------------------------------------------------------------------

### 13.4.1 State transitions

  -----------------------------------------------------------------------------
  \#       Condition                      Transition
  -------- ------------------------------ -------------------------------------
  T0       Earliest controllable wrapper  Generate `hookInvocationId`; append
           entry, before expensive work   one `open` line with
                                          `payload=unknown`,
                                          `selection=unavailable`,
                                          `execution=unknown`,
                                          `submission=unknown`,
                                          `evidenceGrade=RUNTIME_VERIFIED` (the
                                          PD hook process is actually running
                                          --- this is **runtime dispatch
                                          evidence of the PD hook**, not host
                                          request evidence),
                                          `independentlyVerified=false`.

  T1       Renderer produced content      `payload=prepared`,
                                          `selection=selected`

  T2       Payload written to stdout,     `closed`, `execution=completed`,
           exit 0                         `payload=returned`

  T3       Independent request-level      `reconciled`, `payload=confirmed`,
           evidence obtained              `evidenceGrade=RUNTIME_VERIFIED`,
                                          `evidenceReference` present,
                                          `independentlyVerified=true`

  T4a      Selection succeeded with no    `closed`, `execution=completed`,
           applicable principle           `payload=none`,
           (`NONE_APPLICABLE`)            `selection=none_applicable`

  T4b      Policy / feature flag decided  `closed`, `execution=completed`,
           not to run selection           `payload=none`, `selection=skipped`

  T4c      Dependency failure prevented   `closed`, `execution=failed`,
           selection                      `payload=unknown`,
                                          `selection=unavailable`

  D1       Self-deadline / dependency /   `closed`, `execution=degraded`,
           resource limit                 `payload=none`

  D2       Encoding or execution error    `closed`, `execution=failed`,
                                          `payload=unknown`

  D3       Host or wrapper killed the     Reconciliation sets
           process **and independent host `execution=timeout`,
           evidence exists**              `payload=unknown`,
                                          `receiptState=reconciled`,
                                          `reconciliation.outcome="timeout"`

  D4       T0 exists, no terminal line,   Reconciliation sets
           **no independent host          `execution=unknown`,
           evidence**                     `payload=unknown`,
                                          `submission=unknown`,
                                          `receiptState=reconciled`,
                                          `reconciliation.outcome="unknown"`.
                                          **Never `returned`, `confirmed`,
                                          `timeout` or `blocked`.**

  D5       Reconciliation with            `receiptState=reconciled`,
           independent request-level      `payload=confirmed` (T3)
           evidence                       

  D6       **No T0 line at all**          Record as `execution=unknown`,
                                          `payload=unknown`,
                                          `submission=unknown`,
                                          `correlationStatus="unknown"`. **No
                                          T0 is NOT evidence of host kill,
                                          timeout, or blocked submission**; it
                                          may mean the wrapper never started,
                                          the journal write failed, or the
                                          record was lost.

  S0       Default at T0                  `submission=unknown`

  S1       Independent host evidence that `submission=proceeded`, with
           the turn continued             `evidenceReference`

  S2       Independent host evidence that `submission=blocked`, with
           the submission was rejected    `evidenceReference`
  -----------------------------------------------------------------------------

**Host submission outcome scenario table (normative):**

  ------------------------------------------------------------------------------
  Scenario           `HookExecutionStatus`        `HostSubmissionOutcome`
  ------------------ ---------------------------- ------------------------------
  Normal exit 0      `completed`                  `proceeded` **only with host
                                                  evidence**; otherwise
                                                  `unknown`

  `exit 1`           `degraded` (or `failed` by   `proceeded` **only with host
  self-degradation   actual record)               evidence**; otherwise
                                                  `unknown`

  `exit 2`           recorded by its **actual**   `blocked` **only with host
                     execution result             evidence**; otherwise
                                                  `unknown`

  `deny` /           recorded by its **actual**   `blocked` **only with host
  `continue:false`   execution result             evidence**; otherwise
                                                  `unknown`

  Host kill          `timeout` **only with host   determined by host evidence;
                     evidence**; otherwise        otherwise `unknown`
                     `unknown`                    

  Unexplained        `unknown`                    `unknown`
  process                                         
  termination                                     
  ------------------------------------------------------------------------------

`exit 2`, `deny`, `continue:false` and host kill MUST NOT all be
collapsed into `timeout`. A Hook execution failure MUST NOT by itself
imply that the user submission was blocked. `HostSubmissionOutcome`
defaults to `unknown` and may be upgraded only by **independent host
evidence** (host log, request probe), never by PD's own exit code or by
absence of an error. This WorkBuddy-specific failure semantics MUST NOT
be generalized to OpenClaw or Codex.

### 13.4.2 Invariants (MUST hold)

1.  `payload === "confirmed"` ⇒ `execution === "completed"` ∧
    `evidence.independentlyVerified === true` ∧
    `evidence.evidenceReference` is present.
2.  `execution ∈ {"degraded","timeout","failed","unknown"}` ⇒
    `payload ∉ {"returned","confirmed"}`.
3.  `selection === "unavailable"` ⇒ `payload ∈ {"unknown","none"}` and
    `execution ∈ {"failed","unknown"}`.
4.  `selection === "none_applicable"` ⇒ `payload === "none"` and the
    record is a **successful semantic decision**, not a failure and not
    a skip.
5.  `receiptState === "open"` ⇒ `payload === "unknown"` ∧
    `submission === "unknown"`, and the record MUST NOT be counted as a
    success.
6.  `submission !== "unknown"` ⇒ `evidence.evidenceReference` is present
    and `evidence.independentlyVerified === true`.
7.  `execution === "timeout"` ⇒ independent host evidence of a kill
    exists; `execution === "unknown"` otherwise.
8.  `submission === "blocked"` MUST NOT imply `execution === "timeout"`,
    and `execution ∈ {"failed","degraded","timeout"}` MUST NOT imply
    `submission === "blocked"`.
9.  Reconciliation MUST NOT upgrade `unknown` or `none` to `returned` or
    `confirmed` without positive independent evidence, and MUST NOT
    upgrade `submission=unknown` without host evidence.
10. `receiptState === "reconciled"` carries no implication of success;
    only `payload === "confirmed"` counts as delivered success in
    scoring.
11. `confirmed` is not equivalent to the model understanding or
    following the principle; behavioral effect is evaluated only by
    Examiner.
12. Every journal record of one invocation MUST carry the same
    `hookInvocationId`; a record without it cannot be joined or counted.

### 13.4.3 Answers to the seven integrity questions

1.  `degraded` is a **HookExecutionStatus**, not a payload state.
2.  Yes --- `execution=completed` with `payload=none` is a valid
    combination (T4a / T4b) and is distinct from `degraded` (D1). It is
    also distinct from `selection=none_applicable` (a valid semantic
    decision) and `selection=skipped` (a policy decision).
3.  `returned` is adapter-side evidence (payload written to stdout);
    `confirmed` requires independent request-level evidence (T3).
    `returned` MUST NOT be inferred as `confirmed`.
4.  When a host kill prevents a terminal receipt, the T0 `open` journal
    line plus reconciliation records `timeout` / `unknown` **only when
    host evidence exists**; the turn is never counted as delivered. If
    there is no T0 line at all (D6), nothing may be inferred about the
    cause.
5.  Receipt writing MUST be a single `O_APPEND` line to
    `events_<date>.jsonl`: no synchronous SQLite transaction, no
    idempotency reads, no schema DDL, no per-call `mkdirSync`. Heavy
    evidence replay is performed by the existing background worker from
    the journal. The receipt-write latency budget is defined in §17.3.
    Generating `hookInvocationId` MUST NOT add I/O.
6.  Closed-world default: every receipt begins as `unknown`; only
    explicit positive evidence can move it to `returned` / `confirmed` /
    `proceeded` / `blocked`. In evaluation scoring, **only `confirmed`
    counts as success**; `returned` is an attempted delivery, `unknown`
    is unscored, and `degraded`/`timeout`/`failed` are execution
    failures. A valid `none_applicable` decision is NEVER a failure.
7.  `HostSubmissionOutcome` is independent: Hook failure does not prove
    a blocked submission, and a proceeded submission does not prove a
    payload was delivered.

### 13.4.4 Selection outcome semantics --- `NONE_APPLICABLE` (NEW, v0.2.1)

SPEC v0.4 §6.3 / §6.5 / §6.6 / §18.4 / §20C already establish that
`NONE_APPLICABLE` is a **valid model-assisted selection result**,
subject to explicit validation. This amendment preserves that semantics
and MUST NOT reclassify it:

-   `selected` --- semantic judgment succeeded and principles were
    chosen.
-   `none_applicable` --- semantic judgment succeeded and concluded that
    no principle should be activated. `selectedPrincipleIds` is empty
    **by decision**, not by failure, skip, or degradation.
-   `skipped` --- a policy or feature flag decided that selection should
    not run at all. No semantic judgment was performed.
-   `unavailable` --- a dependency failure prevented selection from
    completing.

Consistency requirements across Receipt, Selection and Scorer:

  --------------------------------------------------------------------------------------
  Surface                               Required behaviour
  ------------------------------------- ------------------------------------------------
  Selector                              `NONE_APPLICABLE` remains a valid `status` per
  (`PrincipleSelectionResult.status`)   SPEC v0.4 §6.5; unchanged.

  Receipt (`selection.selectionStatus`, Record `none_applicable`; `payload=none`,
  `delivery.selection`)                 `execution=completed`. MUST NOT set `degraded`,
                                        `failed`, `skipped` or `unavailable`.

  Scorer (§18.4                         `none_applicable` is scored as a **correct
  `Empty Selection Accuracy`)           semantic decision** when ground truth agrees; it
                                        is NOT counted as a delivery failure, a hook
                                        failure, or a skip.

  Failure-rate statistics (§17.3.3)     `none_applicable` MUST NOT be counted in
                                        `execution ∈ {degraded,timeout,failed}` failure
                                        rates.
  --------------------------------------------------------------------------------------

A correct empty decision MUST NOT be recorded as an execution failure or
a policy skip. `skipped` and `unavailable` MUST NOT be used to hide a
`NONE_APPLICABLE` result.

### 13.4.5 Journal identity, propagation and reconciliation (NEW, v0.2.1)

-   `hookInvocationId` is generated at the **earliest controllable point
    in `wrapper.cjs`**, before the adapter entry is spawned and before
    any expensive work. It is one opaque identifier (e.g. a UUID); no
    absolute paths, no timestamps-only guessing, no reuse across
    invocations.
-   The SAME identifier MUST be propagated through: `wrapper.cjs` → the
    adapter child process (via an environment variable) → emitter →
    every journal line (T0, terminal line, reconciliation line) → the
    receipt. A record lacking it cannot be joined to the invocation.
-   If the host supplies a request id, it MAY be recorded separately as
    `hostRequestId`. It MUST NOT be fabricated; Task and Compaction
    payloads do not carry one.
-   T0 MUST be written **as early as possible, before expensive
    operations** (module load, config reads, DB open, renderer). Its
    `evidenceGrade` is `RUNTIME_VERIFIED` for the fact "this PD hook
    invocation is running", with `independentlyVerified=false` (it is
    not host-side request evidence). `STATIC_CONFIG` MUST NOT be used as
    the T0 grade.
-   **No T0 record is NOT equivalent to a host kill** (D6). Without
    independent host evidence, reconciliation MUST NOT infer `blocked`
    or `timeout`.
-   If T0 exists but no terminal line exists, reconciliation MAY
    conclude `unknown` (D4), never `returned` or `confirmed`.
-   `reconciled` means reconciliation has finished, whatever its result.
    It MUST NOT be treated as delivery success.
-   Journal remains **single-line, append-only, no synchronous SQLite**;
    generating and propagating the identifier adds no database
    operation.

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

-   Current prompt uses current valid Working Set or Native.
-   Worker performs Decision Model and, if needed, General Selector.
-   Worker result is bound to workspace, host profile, session, context
    fingerprint, activation revision, and expected Working Set revision.
-   Result applies only at a later prompt boundary.
-   Stale results are discarded.
-   Background work never edits a prompt already submitted.
-   Worker failure leaves current prompt behavior unchanged.

If a safe worker cannot be demonstrated using existing PD
infrastructure, Shadow and Live remain OFF. Do not invent host
background capability.

For the WorkBuddy profile, the Deferred Refresh candidate carrier is
PD's existing detached worker (§10.4.1), and its contract is not yet
implemented. Host-native `async: true` hooks are `PROBE_PENDING` / OFF
and MUST NOT be described as a verified non-blocking worker. Any
detached worker MAY outlive its originating session; §10.4.2 constraints
are mandatory. No deferred result may contribute to the current turn.

## 14.3 Host-specific Failure Semantics

  -----------------------------------------------------------------------------------------------------------
  Host profile                    Host timeout Host behavior on timeout  PD consequence  Required policy
                                               / non-blocking exit                       
  -------------------- ----------------------- ------------------------- --------------- --------------------
  Codex headless CLI        600 s host default Hook marked failed; turn  PD UPS          Honor 5 s budget;
                                               continues                 configured 5 s  local-only
                                                                                         synchronous path

  **WorkBuddy Desktop     **host default 60 s; **Host kill / exit 2 /    Enabled `0.2.2` Fail fast **with a
  / engine 2.165.0**     overridden by enabled `deny` / `continue:false` = 15 s; PD      degraded journal
                       `hooks.json`: UPS 15 s, → `allowed:false` →       wrapper         line**; resolve the
                                 others 30 s** submission blocked and    hard-codes a 12 hard deadline from
                                               prompt cleared.** **exit  s self-deadline the enabled
                                               1 or other non-zero →     and **has       `hooks/hooks.json`
                                               non-blocking, turn        already         at runtime; keep
                                               continues, stderr becomes degraded once   soft deadline
                                               a user-visible warning.** in a live       strictly below it;
                                               `PreToolUse` timeout →    session**,      never block the
                                               tool blocked              losing that     submission
                                               (fail-closed).            turn's          
                                               `SessionStart` timeout →  injection. The  
                                               session proceeds.         12 s figure is  
                                               **Classic `PreCompact`    a budget        
                                               `allowed:false` does NOT  setting; no     
                                               prevent compaction.**     phase-level     
                                               `PostCompact` return      attribution     
                                               value is discarded.       exists.         

  OpenClaw embedded                       15 s Fail-open; hook skipped   PD internal     Measure PD path;
                         `before_prompt_build` and model request         budget not      return well before
                                               continues                 established     host deadline;
                                                                                         always record
                                                                                         delivery outcome
  -----------------------------------------------------------------------------------------------------------

These are not interchangeable global constants, and failure semantics
are **event-specific**. Seven timing dimensions MUST be recorded
separately (§17.3): PD synchronous path, wrapper self-deadline,
`hooks.json` hard timeout, `SessionStart` self duration, the whole
`SessionStart` hook chain, SQLite lock contention, and receipt-write
latency. Do not extrapolate one event's semantics or one timing
dimension to another.

The CLI Hooks reference states that `PreCompact` exit code 2 may prevent
compaction; engine 2.165.0 source does not implement that behavior. Both
claims are recorded; the source governs the current profile.

**Host submission outcome is a separate observation (v0.2.1).** The
`exit 2` / `deny` / `continue:false` / host-kill behaviours above
describe what WorkBuddy *does to the submission* when the corresponding
hook result reaches the host. They MUST NOT be transcribed into
`HookExecutionStatus` as `timeout`, and they do NOT by themselves
constitute evidence for a particular invocation. For each invocation,
`HostSubmissionOutcome` defaults to `unknown` and is upgraded to
`proceeded` / `blocked` only with independent host evidence (§13.4.1
S1/S2). A Hook execution failure MUST NOT be read as a blocked user
submission, and a proceeded submission MUST NOT be read as successful
payload delivery. These are WorkBuddy-specific semantics and MUST NOT be
extrapolated to OpenClaw or Codex.

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

-   Use the actual installed host/plugin version, not a guessed
    canonical value.

-   `softDeadlineMs` must be lower than every applicable hard limit.

-   If PD's own measured safe budget is unknown, do not infer it from
    probe callback duration.

-   Until PD Hook Performance Probe passes, only a minimal Native path
    may be considered for a verified host; Model-assisted Live remains
    blocked.

-   Do not set a global hook timeout.

-   The exact safety margin is an implementation parameter to be
    calibrated from PD p95/p99 and worst-case measurements; it is not
    prescribed as an unsupported fixed number in this SPEC.

-   `hostHookTimeoutMs` MUST be read at runtime from the **enabled
    plugin's `hooks/hooks.json`** for the current event (`timeout` is in
    seconds). Hard-coded host timeout constants are prohibited. This is
    a **correctness / configuration-drift** requirement, not a
    performance optimization.

-   `softDeadlineMs` MUST be strictly lower than
    `min(hostHookTimeoutMs, pdConfiguredHookBudgetMs)` with a safety
    margin derived from measured PD p95/p99 and worst-case observations.

-   A self-degradation MUST complete before `softDeadlineMs` with enough
    residual time to append one journal line; otherwise the host may
    kill the process and block the submission.

-   The degraded journal line MUST be append-only and MUST NOT open a
    database connection or perform an idempotency read (§13.4.3).

-   `hookInvocationId` MUST be generated at the earliest controllable
    wrapper entry and the T0 `open` line written **before** expensive
    work; the same id is propagated to the child process, emitter and
    all journal lines (§13.4.5). Generating the id and writing T0 MUST
    NOT add a database operation; its cost is included in the §17.3.1
    receipt/journal timing dimension.

## 14.5 Failure Matrix

  ------------------------------------------------------------------------------
  Failure / condition                 Required behaviour
  ----------------------------------- ------------------------------------------
  Decision Model not configured       Native; no semantic decision is
                                      fabricated.

  Selector Model not configured       Native.

  Deferred worker unavailable         Native; Shadow / Live remain OFF.

  Provider unavailable                Keep current valid Working Set or Native.

  Worker timeout                      Discard result; keep current valid set or
                                      Native.

  Invalid JSON / schema               Reject model result; Native fallback.

  Unknown Principle ID                Reject candidate; never bypass Runtime V2
                                      validation.

  Inactive Principle                  Reject candidate.

  Invalid Artifact                    Reject candidate.

  Low confidence                      Keep valid existing set or Native.

  `NONE_APPLICABLE`                   Valid empty semantic decision:
                                      `selection=none_applicable`,
                                      `execution=completed`, `payload=none`; not
                                      a failure or skip.

  Context unavailable                 Native.

  Workspace Focus unavailable         Continue without Focus; do not create or
                                      repair Focus in the reader.

  INTENT disabled                     Do not read Intent.

  Storage conflict                    Do not commit stale result.

  Session identity unreliable         Disable persisted Model-assisted Live for
                                      that profile; Native if safe.

  Workspace identity unreliable       Disable persisted Model-assisted Live for
                                      that profile; Native if safe.

  Candidate pool overflow             Native.

  Prompt capacity overflow            Existing Packer behaviour; journal-only
                                      truncation evidence.

  Codex hook failure                  Turn may continue; record actual failure
                                      and do not claim delivery.

  OpenClaw fail-open / silent skip    Do not infer payload return or
                                      confirmation from absence of host error.
                                      Record the PD observation; submission
                                      remains unknown without independent host
                                      evidence.

  WorkBuddy `exit 1` / non-blocking   The host may proceed. Record actual
  error                               `HookExecutionStatus`; if PD
                                      self-degraded, `execution=degraded` and
                                      `payload=none`; if a payload was actually
                                      returned, record `execution=completed` and
                                      `payload=returned`. `submission=proceeded`
                                      requires independent host evidence.

  WorkBuddy `exit 2` / `deny` /       Record the actual Hook execution result;
  `continue:false`                    do NOT force `execution=timeout`.
                                      `submission=blocked` only with independent
                                      host evidence; otherwise `unknown`. Fail
                                      the affected profile gate.

  Host kill **with** independent host Reconciliation → `execution=timeout`,
  evidence                            `payload=unknown`,
                                      `receiptState=reconciled`; set submission
                                      only from host evidence.

  Host kill **without** independent   Reconciliation → `execution=unknown`,
  host evidence; or T0 exists with no `payload=unknown`, `submission=unknown`,
  terminal line                       `reconciliation.outcome=unknown`. Never
                                      `returned`, `confirmed`, `timeout`, or
                                      `blocked`.

  **No T0 journal line**              `execution=unknown`, `payload=unknown`,
                                      `submission=unknown`,
                                      `correlationStatus=unknown`. No T0 is NOT
                                      evidence of host kill, timeout, or blocked
                                      submission.

  Structural revalidation flag        Run structural checks only; MUST NOT set
  present                             `semanticReevaluationRequired` or enqueue
                                      `principle_decision` (§5.2.3).

  Hook config source concat /         Neutral return + journal line with
  fingerprint mismatch                `degradationReason=hook_config_mismatch`
                                      or `hook_config_source_concat_detected`;
                                      incomplete coverage caps profile at
                                      `CONDITIONALLY_VERIFIED`. Physical stale
                                      directories alone are not a failure.

  WorkBuddy `PreCompact` blocking     Prohibited. Classic PreCompact cannot
  result                              block compaction; PD performs only a
                                      bounded checkpoint.

  WorkBuddy `PostCompact` selection / Prohibited. Only
  fingerprint recompute               `structuralRevalidationRequired=true` may
                                      be set.

  Host Task / Subagent event used as  Prohibited (§5.2.1). Record
  semantic boundary                   `semantic_bypass_rejected` if attempted;
                                      TaskCreated / TaskCompleted remain
                                      distinct events.

  WorkBuddy `PreToolUse`              Prohibited in the adapter; it can
  `continue:false`                    re-submit the user prompt and duplicate
                                      `UserPromptSubmit`.

  Host profile mismatch (`EXPIRED`)   Native only; discard deferred results
                                      bound to the old profile; write
                                      `host_profile_expired`.

  Injection content truncated by PD   Journal-only `truncated=true` plus
                                      discarded count; `payload=returned`,
                                      `execution=completed` only if the
                                      truncated payload was actually emitted.

  Deferred worker result stale /      Discard; record
  cross-session                       `worker_result_stale_discarded` (§10.4.2).
  ------------------------------------------------------------------------------

All rows are profile-specific where a host is named. Do not generalize
WorkBuddy failure semantics to Codex or OpenClaw.

## 14.6 Fail-open Boundary

Fail-open means Adaptive Activation failure does not prevent the
existing host/Native path from proceeding where the host allows it.

It does not mean:

-   Ignore governance.
-   Accept invalid artifacts.
-   Bypass Activation Validation.
-   Inject unauthorized principles.
-   Reuse stale cross-session state.
-   Treat unknown delivery as success.

Governance and authorization checks remain fail-closed.

------------------------------------------------------------------------

# 15. Activation Receipt, Observability, and Evidence

## 15.1 Four Evidence Stages

The evidence chain must distinguish:

1.  **Governance Activation** --- Is the principle authorized and
    active?
2.  **Runtime Selection** --- Was it selected for this task and why?
3.  **Prompt Delivery** --- Was it rendered, returned, and independently
    confirmed in the current request?
4.  **Behavioral Effect** --- Did it change host behavior, as
    independently assessed by Examiner?

A success at one stage does not prove the next stage.

## 15.2 Required Receipt Contract

Reuse existing Receipt/Evidence infrastructure. Extend it only where
required.

``` typescript
interface AdaptiveActivationReceipt {
  receiptId: string;
  hookInvocationId: string;   // NEW v0.2.1: same id across wrapper/child/emitter/journal
  timestamp: string;

  host: {
    kind: "openclaw" | "codex" | "workbuddy";
    hostVersion: string;
    engineVersion: string;
    engineSha256?: string;
    runtimeMode: string;
    adapterVersion?: string;
    profileId: string;
    profileRevision: string;
    profileStatus: "VERIFIED" | "CONDITIONALLY_VERIFIED" | "EXPIRED" | "NOT_RUN";
    sourceEvent: string;
    /** NO absolute filesystem paths in long-term receipts. */
    plugin: {
      pluginId: string;
      pluginVersion: string;
      pluginConfigSha256: string;
      effectiveHookSetFingerprint: string;
      fingerprintNormalization: string;
      effectiveSourceCoverage: "complete" | "partial" | "unknown";
      coveredConfigSources: string[];
      rootFingerprint: string;
      discoverability: "registry_resolved" | "plugin_dir" | "unknown";
    };
  };

  identity: {
    workspaceHash?: string;
    sessionHash?: string;
    generationId?: string;   // absent on Task/Compaction-sourced events
    hostTaskId?: string;     // snake_case task_id; Agent-internal plan item
    hookEventName?: string;  // native hook_event_name; dedup key component
    hostRequestId?: string;  // only when the host actually supplies one
    correlationStatus: "correlated" | "unreliable" | "unknown";
    agentId?: string;
    turnId?: string;
  };

  governance: {
    eligiblePrincipleIds: string[];
    activationRevision?: string;
    validationStatus: "valid" | "invalid" | "unknown";
  };

  selection: {
    mode: "native" | "model-assisted";
    selectionStatus: SelectionStatus;   // NEW v0.2.1: includes none_applicable
    selectedPrincipleIds: string[];
    decisionType?: TaskChangeType;
    decisionReason?: string;
    selectionReason?: string;
    confidence?: number;
    workingSetRevision?: number;
    contextFingerprint?: string;
  };

  /** Four independent observation dimensions; see §13.4. */
  delivery: DeliveryIntegrity;

  /** Six independently evidenced stages; see §15.2.1. */
  lifecycle: StageObservation[];

  fallbackReason?: string;
}
```

Do not store raw conversation, API keys, or full model chain-of-thought
in this receipt.

### 15.2.1 Lifecycle Stage Observations (NEW)

Boolean lifecycle flags are NOT permitted. Each stage is an independent
observation with its own status, evidence grade, timestamp, reference
and asserting owner:

``` typescript
type LifecycleStage =
  | "plugin_installed"
  | "plugin_loaded"
  | "hook_dispatched"
  | "payload_returned"
  | "request_confirmed"
  | "behavioral_effect";

type StageStatus = "observed" | "not_observed" | "unverifiable";

interface StageObservation {
  hookInvocationId: string; // same invocation id as receipt and journal
  stage: LifecycleStage;
  status: StageStatus;
  evidenceGrade: EvidenceGrade;
  timestamp: string;
  evidenceReference?: string;
  assertedBy: "installer" | "host_loader" | "hook_entry" | "encoder" | "request_probe" | "reconciler" | "examiner";
}
```

Stage ownership (MUST NOT be violated):

  -----------------------------------------------------------------------------------------------
  Stage                 Sole asserting owner                     Evidence
  --------------------- ---------------------------------------- --------------------------------
  `plugin_installed`    installer                                `installed_plugins.json`

  `plugin_loaded`       host loader / reconciler                 `HookExtensionLoader` log

  `hook_dispatched`     hook entry                               process start + T0 `open`
                                                                 journal line carrying
                                                                 `hookInvocationId`
                                                                 (`RUNTIME_VERIFIED` for PD
                                                                 dispatch,
                                                                 `independentlyVerified=false`)

  `payload_returned`    encoder                                  stdout single-line record with
                                                                 the same `hookInvocationId`

  `request_confirmed`   request probe / reconciler               independent request-level
                                                                 evidence, joined by
                                                                 `hookInvocationId`

  `behavioral_effect`   Examiner                                 PD MUST NOT assert; always
                                                                 `unverifiable`
  -----------------------------------------------------------------------------------------------

Rules:

1.  A hook receipt may assert only `hook_dispatched` and
    `payload_returned`. `plugin_installed` / `plugin_loaded` are
    back-filled by the reconciler from host-side evidence, never
    invented by the hook.
2.  `request_confirmed` may be appended only after T3 evidence exists.
    `HostSubmissionOutcome` is NOT a lifecycle stage; it is an
    independent observation dimension in `DeliveryIntegrity` (§13.4).
3.  A later stage MUST NOT be used to infer an earlier stage. Seeing
    `payload_returned` does not prove `hook_dispatched` unless that
    stage was independently recorded.
4.  `behavioral_effect` remains `unverifiable` in every PD receipt.
5.  No stage may be recorded without its own `timestamp` and, when
    `observed`, its own `evidenceReference`.
6.  Every stage observation and every journal line for one invocation
    MUST carry the same `hookInvocationId` (§13.4.5). A missing id makes
    the observation unjoinable and MUST NOT be back-filled by guessing.
7.  Reconciliation completion adds no stage and does not upgrade any
    stage to `observed` without its own independent evidence.

These six stages are strictly ordered in evidentiary strength: installed
⇏ loaded ⇏ dispatched ⇏ returned ⇏ present in the model request ⇏
understood or followed by the model.

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
  | "injection_failed"
  | "plugin_installed"
  | "plugin_loaded"
  | "hook_dispatched"
  | "journal_t0_written"
  | "hook_config_source_concat_detected"
  | "hook_config_mismatch"
  | "host_profile_expired"
  | "injection_degraded"
  | "injection_truncated"
  | "receipt_reconciled"
  | "host_submission_outcome_observed"
  | "worker_result_stale_discarded"
  | "host_task_graph_changed"
  | "subagent_scope_changed"
  | "post_compact_invalidated"
  | "structural_revalidation_recorded"
  | "none_applicable_selected"
  | "semantic_bypass_rejected";
```

Each event should include, where available:

-   Timestamp.
-   Workspace/session hashes.
-   Host kind/version/runtime mode.
-   Host profile ID/revision.
-   Original source event.
-   Trigger type.
-   Selection mode.
-   Model profile/version.
-   Latency.
-   Token usage, when available.
-   Working Set revision.
-   Selected Principle IDs.
-   Fallback reason.
-   Evidence reference.

## 15.4 Evidence Semantics

  ------------------------------------------------------------------------------------------
  Evidence                      What it proves                  What it does not prove
  ----------------------------- ------------------------------- ----------------------------
  `execution=completed`         The hook returned normally      That a payload existed or
                                                                reached the model

  `payload=returned`            Adapter wrote the payload to    That the host included it in
                                the host callback               the model request

  `payload=confirmed`           Independent evidence places     Model understanding or
                                content in the current request  compliance

  `execution=degraded`          A contribution that should have That the submission was
                                existed was lost                blocked

  `execution=timeout`           Independent host evidence of a  That the submission was
                                kill exists                     blocked; that a payload was
                                                                delivered

  `execution=unknown`           Termination cause could not be  Any specific failure mode,
                                established                     including host kill

  `selection=none_applicable`   A **valid semantic decision**   An execution failure, a
                                produced an empty selection     skip, or a delivery failure

  `submission=proceeded`        Independent host evidence that  That a payload was returned,
                                the user submission continued   confirmed, or followed

  `submission=blocked`          Independent host evidence that  Which Hook execution status
                                the submission was rejected     caused it

  `submission=unknown`          No independent host evidence    Either `proceeded` or
                                exists                          `blocked`

  `receiptState=open`           A hook started (T0 exists); no  Delivery of any kind
                                terminal outcome is known       

  `receiptState=reconciled`     Background reconciliation has   Delivery success
                                completed (any result)          

  Absence of T0                 Only that no T0 journal line is Host kill, timeout, or
                                present                         blocked submission

  Behavioral Effect             Examiner observed a behavior    Long-term improvement unless
                                difference under its evaluation longitudinal evidence
                                protocol                        supports it
  ------------------------------------------------------------------------------------------

Do not infer `confirmed` from `returned`, absence of an exception,
`execution=completed`, a host's fail-open behavior, a known injection
channel, or from `submission=proceeded`. Do not infer `blocked` from a
Hook failure, and do not infer `timeout` from a missing T0 line.

Do not infer `confirmed` from `returned`, absence of an exception,
`execution=completed`, a host's fail-open behavior, a known injection
channel, or `submission=proceeded`. Do not infer `blocked` from a Hook
failure, and do not infer `timeout` from a missing T0 journal line.

## 15.5 Host-specific Delivery Evidence

-   **OpenClaw:** because timeout can silently skip injection while the
    request proceeds, PD must write its own receipt. A callback return
    may be `returned`; only request-level evidence such as a verified
    request diff or equivalent may be `confirmed`.
-   **Codex:** record the `additionalContext`/developer contribution and
    its hook result. Do not label it system-level. If no independent
    request evidence exists for a run, use `returned` or `unknown`, not
    `confirmed`.
-   **WorkBuddy:** the injection channel is
    `user_message_system_reminder` and the injection position is
    deterministic (`UserPromptSubmit`=`last`, `SessionStart`=`first`).
    Nevertheless `confirmed` still requires independent request-level
    evidence; a channel definition is not proof of delivery, and
    `confirmedClaimAllowed` is `false` for the current profile. Because
    PD's self-degradation exits non-blockingly while the turn continues,
    absence of a host error MUST NOT be read as successful injection.
    Every degraded hook MUST append one journal line with
    `execution="degraded"`, `payload="none"` and a `degradationReason`;
    the wrapper's degrade path MUST also append that line (it currently
    does not). Every journal line and the receipt MUST carry the same
    `hookInvocationId` (§13.4.5). `HostSubmissionOutcome` defaults to
    `unknown` and is upgraded to `proceeded` / `blocked` only with
    independent host evidence; a hook failure is NEVER read as a blocked
    submission, and `exit 2` / `deny` / `continue:false` are NOT all
    recorded as `timeout`. A T0 `open` line without a terminal line
    reconciles to `unknown`; a missing T0 line is NOT evidence of host
    kill. `reconciled` never means success. A `NONE_APPLICABLE` result
    is recorded as `selection="none_applicable"` (valid decision), never
    as `skipped`, `degraded` or `failed`. Lifecycle stages MUST be
    recorded as `StageObservation[]` (§15.2.1); the receipt MUST NOT
    claim `plugin_installed`, `plugin_loaded`, `request_confirmed` or
    `behavioral_effect` on its own authority.

# 16. Security and Privacy

## 16.1 Principle Authority

All candidates must come from currently valid Runtime V2 Activation.
Selector is never an authority source.

## 16.2 Model Output

Treat all model output as untrusted:

-   Schema validation.
-   Candidate allowlist.
-   Activation revalidation.
-   Artifact revalidation.
-   Output-size limits.
-   Duplicate removal.
-   Context/session/profile binding.
-   Stale-result rejection.

No model output may directly enter host execution as arbitrary code or
an unvalidated instruction.

## 16.3 Prompt Injection Protection

User conversation, Workspace Focus, INTENT, and Candidate Cards are data
to be analyzed. They cannot override Selector system constraints.

Candidate text must be treated as data, not executable instructions.

## 16.4 Data Minimization

External models receive only the minimum context required.

Do not persist by default:

-   Raw user conversation.
-   Full model chain-of-thought.
-   API keys.
-   Unnecessary personal information.

Shadow also transmits context externally; therefore it requires explicit
Owner opt-in and data-egress policy.

## 16.5 Workspace and Session Isolation

Every model result must bind to:

-   Workspace ID/hash.
-   Host kind/version.
-   Runtime mode.
-   Host Profile ID/revision.
-   Session ID/hash.
-   Context fingerprint.
-   Working Set revision.
-   Relevant activation revision.

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
implementation. It cannot establish PD's real latency.

## 17.2 Initial Targets and Constraints

  -----------------------------------------------------------------------
  Metric                          Initial target / constraint
  ------------------------------- ---------------------------------------
  Per-message Decision Model      0 by default
  calls                           

  Decision worker timeout         1.5 s initial experiment

  Selector worker timeout         3.0 s initial experiment

  Maximum context input           12,000 chars initial

  Maximum candidate cards         48 initial

  Maximum selected principles     12 initial

  Working Set idle TTL            24 h initial

  Model failure                   Must not block current prompt

  Native Selection                No additional model calls

  Synchronous hook                No external model inference

  Host execution budget           Per verified profile; no global
                                  constant

  Prompt capacity                 Existing Model-aware Prompt Budget
  -----------------------------------------------------------------------

The 1.5 s and 3.0 s model values apply only to deferred workers. They
must never be interpreted as host-hook deadlines.

## 17.3 Mandatory PD Hook Performance Probe

**Status correction (2026-11-04):** this probe is no longer a
future-only Phase 2 task for the WorkBuddy profile. A live session
recorded a 12.113 s PD `UserPromptSubmit` self-degradation with zero
injection. Measuring and repairing the synchronous path is a **P0
prerequisite** for SPEC finalization. The 12.021 s figure is the
wrapper's **self-deadline budget setting**, NOT an attribution to any
stage; no phase-level timing data exists and no stage may be named as
the cause without measurement.

### 17.3.1 Seven separate timing dimensions (NEW)

Measure and report these independently; do not collapse them:

1.  PD synchronous path internal time (cold and warm process).
2.  Wrapper self-deadline (`wrapperSelfDeadlineMs`, a configured
    budget).
3.  `hooks.json` hard timeout resolved at runtime.
4.  `SessionStart` hook self duration (15.552 s observed).
5.  Whole `SessionStart` hook chain wall time (16.736 s observed,
    includes other plugins).
6.  SQLite lock contention (write connections use `busyTimeoutMs: 0`;
    read-only connections set no `busy_timeout`; six connection
    open/close points exist in the synchronous path).
7.  Receipt/journal write latency (single append-only line).

Dynamic resolution of `hooks.json` is a **correctness /
configuration-drift fix**, not a performance optimization. It MUST NOT
be counted as a latency improvement.

Mandatory instrumentation: phase-level timers at module load, config
reads, DB open, activation reader, renderer, emitter, encode, and
stdout. Record p50 / p95 / p99 / max and dropped/kill rate.

### 17.3.2 Load matrix and sample size (v0.2.1)

Load matrix: cold/warm process; empty/populated Working Set; minimum and
maximum candidate pools; Workspace Focus available/unavailable; Intent
on/off; concurrent `SessionStart` + `UserPromptSubmit`; DB lock
contention; large transcript and context truncation; receipt-write
contention; configured timeouts of 5 s / 15 s / 30 s.

**Performance observation sample size**: at least **200 measured hook
invocations per matrix cell**, across at least **3 independent runs**
and at least **2 distinct sessions or dates**. Report p50 / p95 / p99 /
max, degraded rate, timeout rate, blocked rate and
`INSUFFICIENT_EVIDENCE` markers per cell.

**Critical strata** (each MUST be analysed and reported separately):
cold start; maximum candidate pool; concurrent `SessionStart` +
`UserPromptSubmit`; DB lock contention; smallest configured timeout (5
s); receipt-write contention.

### 17.3.3 Three-layer statistical acceptance (REVISED, v0.2.1)

#### Layer 1 --- Performance observation

-   Report p50 / p95 / p99 / max **per cell**, with the measurement
    method and the number of samples.
-   `p99` MUST be accompanied by an appropriate **confidence interval or
    upper bound** (method declared in the report, e.g. bootstrap or an
    order-statistic/binomial interval). A raw sample p99 alone MUST NOT
    be used to declare the gate satisfied.
-   **200 samples are generally insufficient for a stable p99 claim**
    (only about two observations lie above it). If the p99 interval is
    too wide to compare with `softDeadlineMs − safety margin`, the cell
    MUST be marked `INSUFFICIENT_EVIDENCE` and the gate MUST NOT be
    marked `PASS`.
-   Gate:
    `upper_bound(p99(PD synchronous path)) ≤ softDeadlineMs − safety   margin`
    and `worst observed < hostHookTimeoutMs`.
-   Synchronous path executes **zero** SQLite transactions after the
    emitter change; journal append `p99 ≤ 2 ms` and `max ≤ 5 ms`, with
    the same interval requirement.
-   No `payload=confirmed` misclassification, no cross-session result
    contamination, and no `allowed:false` / `submission=blocked`
    outcome.

#### Layer 2 --- Failure-rate acceptance (per critical stratum)

-   Failure is defined as `execution ∈ {degraded, timeout, failed}`
    **or** an independently-evidenced `submission=blocked`. A valid
    `selection=none_applicable`, a `skipped` selection and
    `execution=unknown` are NOT automatically failures, but `unknown`
    MUST be reported separately and MUST NOT be silently dropped.
-   Compute the failure rate **separately for each predefined critical
    stratum**. Do NOT merge different load classes and do NOT use the
    overall N to satisfy a single stratum's threshold.
-   If observed failures in a stratum are 0 and the report claims a 95%
    upper bound `≤ 1%`, that stratum MUST have **N ≥ 300** and its OWN
    Rule-of-Three bound `≈ 3 / N` (N = 300 ⇒ ≈ 1%). Each bound is stated
    with its stratum and N.
-   If a stratum has fewer than 300 samples, its bound MUST be reported
    as `> 1%` or `INSUFFICIENT_EVIDENCE`; it MUST NOT borrow samples
    from other strata.
-   **Multiple comparisons**: if an overall 95% confidence statement is
    made across strata, the report MUST declare and apply a multiple
    comparison method (e.g. Bonferroni or Holm) to the per-stratum
    bounds. Without such a method, only per-stratum statements are
    permitted and no overall claim may be made.

#### Layer 3 --- Release adjudication

-   If sample size is insufficient, a confidence interval / upper bound
    does not satisfy the gate, or any critical stratum lacks sufficient
    data, the adjudication MUST be `INSUFFICIENT_EVIDENCE`. It MUST NOT
    be marked `PASS`, and no Shadow / Live enablement may follow.
-   `PASS` requires: all Layer 1 intervals satisfy their gates; every
    critical stratum satisfies its Layer 2 bound; the
    multiple-comparison method (if used) is documented; and the report
    states N, bounds, stratum list and measurement method.
-   **Zero observed failures is NOT zero risk.** The Rule-of-Three bound
    is an upper bound on the failure *rate*, not proof of its absence.
-   This is a release gate, not proof of zero production risk.
    Post-rollout telemetry of degraded / timeout / blocked / unknown
    rates and the §21 Stop Conditions remain in force.

## 17.4 Per-host Performance Constraints

-   **Codex:** PD `UserPromptSubmit` configured budget is 5 s.
    Synchronous path is local-only. The host's 600 s outer timeout does
    not grant PD a 600 s budget.
-   **WorkBuddy:** the effective hard limit is the `timeout` of the
    **enabled plugin version's `hooks/hooks.json`** (`UserPromptSubmit`
    15 s in the current 0.2.2 profile), not a repository canonical
    constant and not the host's 60 s default. Host kill blocks the
    submission; PD self-degradation with exit 1 does not, but silently
    loses the contribution. Resolving this value at runtime is a
    correctness requirement. The soft deadline derives from measured PD
    p95/p99 with enough residual time to append one degraded journal
    line. The `SessionStart` self duration (15.6 s) and the whole chain
    (16.7 s against a 30 s budget) are recorded separately and MUST NOT
    be charged to the PD synchronous-path budget.
-   **OpenClaw:** host `before_prompt_build` timeout is 15 s and
    fail-open. PD's own safe internal budget remains unmeasured. The
    adapter must return early enough to preserve a reliable safety
    margin; do not assume the full 15 s is available.

## 17.5 Cost Control

Record:

-   Decision calls per 100 observed prompt events.
-   Selector calls per 100 observed prompt events.
-   Average input/output tokens.
-   Cost per task change.
-   Stale-result discard rate.
-   Shadow vs Live cost.
-   Queue backlog and refresh coalescing.

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

-   E1 --- Task Change Detection.
-   E2 --- Principle Selection.
-   E3 --- Selection Stability.
-   E4 --- Runtime Efficiency and host safety.

Add E5 --- Delivery Evidence Integrity: can the system distinguish
rendered, returned, and confirmed delivery?

## 18.2 Test Dataset

Retain v0.3 scenario families:

  Scenario                        Purpose
  ------------------------------- ---------------------------------
  Same Task / Different Wording   Task stability
  New Task                        Task switch
  Goal Shift                      Goal-change detection
  Phase Shift                     Phase-change detection
  Multi-task                      Multi-principle selection
  Abstract Principle              Abstract understanding
  Similar Principles              Principle distinction
  Conflicting Principles          Applicability boundaries
  Long Context                    Context truncation
  Missing Focus                   Degradation
  No Applicable Principle         Empty-set correctness
  Invalid Candidate               Governance/allowlist validation

Initial dataset recommendation:

-   30 same-task scenarios.
-   30 task-change scenarios.
-   40 principle-selection scenarios.

Ground truth must be supplied by Owner or an independent reviewer.
Report sample size and uncertainty; do not claim reliability from a
small sample.

## 18.3 Decision Metrics

  Metric               Description
  -------------------- ----------------------------------------------
  Change Precision     Correct positive task-change classifications
  Change Recall        True changes detected
  False Refresh Rate   Unnecessary re-selection
  Missed Goal Shift    Missed goal changes
  Decision Latency     Deferred decision duration
  Decision Cost        Per-decision cost
  Stale Result Rate    Results discarded because context changed

Initial Shadow thresholds retained from v0.3:

-   Change Precision \>= 0.90.
-   Change Recall \>= 0.85.
-   False Refresh Rate \<= 0.10.

These are proposed initial gates, not proven optimal thresholds.
Interpret with sample size and confidence intervals.

## 18.4 Selector Metrics

  Metric                      Description
  --------------------------- -------------------------------------
  Precision@K                 Correct principles among selected
  Recall@K                    Coverage of relevant principles
  NDCG@K                      Ranking quality
  Critical Principle Recall   Coverage of critical principles
  Invalid ID Rate             Unauthorized/non-candidate IDs
  Empty Selection Accuracy    Correct `NONE_APPLICABLE` decisions
  Selection Stability         Unnecessary Working Set changes

Initial targets retained:

-   Precision@K \>= 0.80.
-   Critical Principle Recall \>= 0.90.
-   Invalid ID Rate = 0.
-   NDCG@K \>= 0.75.

`Empty Selection Accuracy` measures correct `NONE_APPLICABLE` decisions.
A `none_applicable` outcome is a **valid semantic decision**
(`SelectionStatus.none_applicable`, §13.4.4) and MUST be recorded
consistently in the Selector result, the Receipt
(`selection.selectionStatus` / `delivery.selection`) and this Scorer.
Scorer MUST NOT count it as an execution failure, a policy skip, a
delivery failure, or a Hook failure. It MUST NOT be included in the
§17.3.3 Hook execution failure-rate denominator. `skipped` (no selection
performed) and `unavailable` (selection could not complete) are excluded
from this metric entirely and reported separately.

## 18.5 Delivery Metrics

Add:

-   Rendered-to-returned rate.
-   Returned-to-confirmed rate, where confirmation evidence exists.
-   Unknown delivery rate.
-   Host timeout rate.
-   Host profile mismatch rate.
-   Prompt channel correctness.
-   Duplicate injection rate.
-   Cross-session contamination rate (must be zero).

Do not score `unknown` as success or failure without additional
evidence.

## 18.6 Native vs Model-assisted Comparison

Compare:

1.  Native Selection.
2.  Model-assisted selection in Shadow.
3.  Model-assisted selection passed through the existing Packer.

Observe:

-   Relevant principle coverage.
-   Irrelevant principle ratio.
-   Prompt characters/tokens.
-   Conflicting principles.
-   Task-change response delay.
-   Selection stability.
-   Model cost.
-   Delivery status and host-specific failures.

------------------------------------------------------------------------

## 18.7 Normative Test Matrix and Evidence Classes

**测试类型分层（强制区分；本轮只定义测试，不执行生产探针）**：

  ------------------------------------------------------------------------------------------------------------
  类型                    含义                                                 本轮是否执行
  ----------------------- ---------------------------------------------------- -------------------------------
  `文档契约`              对 Amendment / SPEC                                  否（仅定义）
                          文本做静态一致性断言（枚举、状态组合、编号、引用）   

  `单元测试`              纯函数 / 类型 / 状态机 /                             否（仅定义）
                          指纹计算的隔离断言，不启动宿主                       

  `集成测试`              在测试进程内联动 wrapper / adapter / journal /       否（仅定义）
                          reconciler，不触碰真实用户会话                       

  `真实运行时探针`        在隔离 lab 中驱动真实宿主引擎与 mock model           否（保持
                                                                               `DEFERRED_PENDING_EVIDENCE`）
  ------------------------------------------------------------------------------------------------------------

所有测试在本 SPEC 中均为 `PROPOSED`，除明确标注
`DEFERRED_PENDING_EVIDENCE` 的隔离探针外；标注
`DEFERRED_PENDING_EVIDENCE` 的探针在 A-48 通过前保持 OFF。

  -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  \#          测试                              断言                                                                                 类型                       Implementation Status
  ----------- --------------------------------- ------------------------------------------------------------------------------------ -------------------------- -----------------------------
  T-01        `resolveHostProfile()` 版本匹配   任一身份字段或 `pluginConfigSha256` / `effectiveHookSetFingerprint` 不匹配 →         `单元测试`                 `PROPOSED`
                                                `EXPIRED` + Native-only + `host_profile_expired`；receipt 不含绝对路径                                          

  T-02        hooks.json 动态 deadline          给定 5/15/30 s，self-deadline 恒 \< hard limit，receipt                              `单元测试`（属性）         `PROPOSED`
                                                记录实际值；**不得标为性能优化**                                                                                

  T-03        degraded journal                  wrapper 降级 → 一行含                                                                `集成测试`                 `PROPOSED`
                                                `hookInvocationId`、`execution=degraded`、`payload=none`、`submission=unknown`；无                              
                                                SQLite 连接；`open` 不算成功                                                                                    

  T-04        非阻断降级                        exit 1 降级不产生 `continue:false`/`deny`/exit 2；`submission` 不因 Hook             `真实运行时探针`（隔离）   `DEFERRED_PENDING_EVIDENCE`
                                                失败而升级；缺失 T0 不得推断 kill                                                                               

  T-05        当前回合注入形状                  2.165.0 mock request body 中 `role:"user"` 的 hook system-reminder 位于              `真实运行时探针`（隔离）   `DEFERRED_PENDING_EVIDENCE`
                                                `<user_query>` 前；`confirmed` 证据可用                                                                         

  T-06        async detach 生命周期             `allowed:true` 立即返回、不贡献当前回合、`asyncTimeout` 生效、**Session              `真实运行时探针`（隔离）   `DEFERRED_PENDING_EVIDENCE`
                                                结束后进程行为**、结果提交校验                                                                                  

  T-07′       **无语义绕过**                    宿主 Task/Session/Compaction/Subagent 事件触发时：① `TaskChangeType` 产出数=0；②     `单元测试` + 计数断言      `PROPOSED`
                                                `selectedPrincipleIds` 不变；③ `principle_decision` 不被跳过；④ 仅写 provenance /                               
                                                `structuralRevalidationRequired`                                                                                

  T-08′       同 root 配置来源 concat           manifest `hooks` + 默认 `hooks/hooks.json` 同事件 →                                  `集成测试`                 `PROPOSED`
                                                `hook_config_source_concat_detected` + 中性返回；**物理残留目录不触发**                                         

  T-09        `continue:false` 禁用             adapter 任何路径不输出 `continue:false`；重投时按可用身份去重                        `单元测试` +               `PROPOSED`
                                                                                                                                     `真实运行时探针`           

  T-10        注入截断                          按 principle 边界截断，journal-only `truncated:true`；无同步 DB                      `单元测试`                 `PROPOSED`

  T-11        七维耗时测量                      七维分别记录；`SessionStart` self 与 chain 分开；无阶段归因推断                      `集成测试` +               `PROPOSED`
                                                                                                                                     `真实运行时探针`           

  T-12        分模式证据                        CLI/IDE/Desktop 三份 profile 独立；`SOURCE_CONFIRMED` 不被升格；PreCompact           `文档契约`                 `PROPOSED`
                                                文档/源码矛盾登记                                                                                               

  T-13        六阶段观察                        每阶段独立 `status/evidenceGrade/timestamp/evidenceReference/assertedBy` +           `集成测试`                 `PROPOSED`
                                                `hookInvocationId`；hook 不得断言 installed/loaded/confirmed/behavioral_effect                                  

  T-14        引擎基线守卫                      `--version` 与 `sha256sum` 等于冻结 profile，否则 SKIP（不得 faked green）           `文档契约` +               `PROPOSED`
                                                                                                                                     `真实运行时探针`           

  T-15        Compaction 契约                   PreCompact 不返回阻断结果、无 LLM；PostCompact 只置                                  `单元测试` +               `PROPOSED`
                                                `structuralRevalidationRequired`；`compact_summary` 不进 fingerprint                 `真实运行时探针`           

  T-16        四维状态机不变量                  §13.4.2 全部十二条不变量（含 `open` 不算成功、reconciliation 不升级、`submission`    `单元测试`（属性）         `PROPOSED`
                                                独立、`none_applicable` 非失败）                                                                                

  T-17        三层统计验收                      分层 N、p99 区间、Rule of Three 上界、多重比较方法；证据不足标                       `集成测试` + 统计报告      `PROPOSED`
                                                `INSUFFICIENT_EVIDENCE`；不得以「0 次失败」声明零风险                                                           

  T-18        跨 Session 污染                   旧 session / `EXPIRED` profile 的 deferred 结果被丢弃并记                            `集成测试`                 `PROPOSED`
                                                `worker_result_stale_discarded`                                                                                 

  **T-19**    **Task                            ① `TaskCreated` / `TaskCompleted` 在同一 `task_id` 下产生**两条独立记录**（复合键含  `单元测试` + `集成测试`    `PROPOSED`
              事件去重与语义重新决策隔离**      `hook_event_name`）；② 宿主无事件唯一标识时不伪造；③ 缺身份字段标                                               
                                                `unreliable`/`unknown`；④ 两个事件均不得设置                                                                    
                                                `semanticReevaluationRequired`、不得入队语义任务、不得让下一个 `BEFORE_MODEL_TURN`                              
                                                重跑 `principle_decision`；⑤ `structuralRevalidationRequired` 不改变                                            
                                                `selectedPrincipleIds`                                                                                          

  **T-20**    **`HostSubmissionOutcome`         构造表格中六种场景，断言 `execution` 与 `submission` 独立；`submission` 默认         `单元测试` + `文档契约`    `PROPOSED`
              独立性**                          `unknown`；`proceeded`/`blocked` 必须有 `evidenceReference` 且                                                  
                                                `independentlyVerified=true`；`exit 2`/`deny`/`continue:false` 不被强制标为                                     
                                                `timeout`；Hook 失败不推断 blocked；不向其它宿主外推                                                            

  **T-21**    **`hookInvocationId` / Journal /  wrapper 生成的 id 在 child / emitter / T0 / terminal / reconciliation / receipt      `集成测试`                 `PROPOSED`
              reconciliation 关联**             中完全一致；T0 在昂贵操作前且 grade=`RUNTIME_VERIFIED`；无 T0 ≠ kill；T0 无终态 →                               
                                                `unknown`；`reconciled` 不计成功；`unknown` 不升级为 `returned`/`confirmed`；journal                            
                                                单行 append-only、无同步 DB                                                                                     

  **T-22**    **`NONE_APPLICABLE`               `selection=none_applicable` 时 `execution=completed`、`payload=none`，不得为         `单元测试` + `文档契约`    `PROPOSED`
              独立状态与有效决策**              `skipped`/`degraded`/`failed`；Selector status 保持 SPEC v0.4 语义；Scorer                                      
                                                `Empty Selection Accuracy` 计为正确决策；不计入 §17.3.3 Hook 失败率                                             

  **T-23**    **`effectiveHookSetFingerprint`   双指纹确定性规范化；只纳入 `SOURCE_CONFIRMED` 来源；`partial`/`unknown` coverage     `单元测试` + `集成测试`    `PROPOSED`
              覆盖与缺失配置源**                不得标 `VERIFIED`；指纹变化触发 `EXPIRED` +                                                                     
                                                Native-only；物理残留目录不影响指纹；receipt 不含绝对路径；不引入新配置管理系统                                 

  **T-24**    **分层统计验收及置信区间**        每个关键分层独立报告 N、p99 CI/上界、`3/N` 上界；禁止用总体 N                        `集成测试` + 统计报告      `PROPOSED`
                                                满足单层；整体声明需多重比较方法；样本不足/区间不满足 → `INSUFFICIENT_EVIDENCE`                                 
                                                且不得 PASS                                                                                                     

  **T-25**    **状态三维度一致性**              每条 Self-audit / 修订总表项具备 `Review Disposition` / `Implementation Status` /    `文档契约`                 `PROPOSED`
                                                `Baseline Provenance`；`ACCEPT` 不等于 `ACCEPTED`；`SPEC_REVISED` 在 SPEC v0.5                                  
                                                合入前出现即为失败；`RETAINED_FROM_V0_4` 不被当作已完成修订；A-20 为 `PROPOSED`                                 
  -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**历史测试纠正**：T-07 原断言「Task 事件时 `principle_decision` 调用数为
0」→ 改为 T-07′（同时验证「不跳过」与「不产出语义决策」）；T-08 原「两版
hooks.json 同时可发现」→ T-08′；T-03 补 journal-only 与
`hookInvocationId`；T-05/T-06 保持 `DEFERRED_PENDING_EVIDENCE`；T-16
由六条不变量扩为十二条；T-17 由单一统计门禁扩为三层口径。

------------------------------------------------------------------------

# 19. Rollout Plan and Gates

## Phase 0 --- Evidence, Delivery Reliability, and Architecture Baseline

### Development lanes and blocking policy

-   **Shared-core offline development may proceed** after Owner approval
    of this SPEC and confirmation of the existing Runtime V2 / Native
    Selection interfaces. Use deterministic fixtures and mock host
    envelopes; do not change production hooks, database state, flags, or
    live prompt behavior.
-   **WorkBuddy Native production delivery is blocked by the P0 delivery
    integrity issue** until the self-degradation path is measured, made
    non-blocking, and made observable. This does not block offline
    Context, Selector, or Working Set implementation.
-   **WorkBuddy lifecycle-trigger expansion is blocked per event** until
    an isolated runtime probe upgrades that event from `PROBE_PENDING`
    to `RUNTIME_VERIFIED`.
-   **PD Worker Deferred Refresh remains OFF** until its result-binding,
    revision-fence, stale-discard, idempotency, and next-prompt-only
    contract is implemented and verified. Host-native async remains OFF.
-   **Model-assisted Shadow / Live remain OFF** until their applicable
    gates pass; Live additionally requires explicit Owner authorization.
    Unresolved host-specific questions do not block shared-core offline
    work.

### Baseline tasks retained from v0.4

1.  Freeze Host Matrix evidence references and exact version/mode scope.
2.  Resolve exact profiles for Codex headless, WorkBuddy Desktop-hosted
    CLI engine, and OpenClaw embedded.
3.  Keep Codex TUI, WorkBuddy Desktop UI-only / standalone IDE, OpenClaw
    reply `/reset`, and ordinary Gateway turn as `NOT_RUN`.
4.  Audit stable Workspace / Session identity per profile.
5.  Audit existing PD worker capability and SQLite storage ownership.
6.  Confirm Activation Reader, internal Agent registration, and Profile
    Binding contracts.
7.  Verify host-specific injection contracts without generalizing
    between modes.

### Additional Phase 0 tasks (P0 items in mandatory order)

1.  Instrument and measure the PD synchronous path to **attribute** the
    12 s self-degradation to specific stages (§17.3.1). Do not infer the
    cause from the budget value.
2.  Optimize the measured synchronous critical path.
3.  Move non-essential evidence writes out of the synchronous path:
    emitter converges to a single append-only journal line; the
    synchronous SQLite evidence transaction and idempotency reads are
    replayed by the existing background worker.
4.  Resolve the actual `hooks/hooks.json` timeout dynamically
    (correctness fix; property test T-02).
5.  Guarantee self-degradation cannot block the user submission (exit 1
    non-blocking; no `continue:false` / `deny` / exit 2).
6.  Guarantee degraded outcomes are observable: journal-only, no
    synchronous DB, `hookInvocationId` generated at wrapper entry and
    propagated through child / emitter / journal / receipt, and
    `open→closed→reconciled` reconciliation (T-03/T-04/T-21). No T0 line
    is NOT a host kill.
7.  Freeze the WorkBuddy profile identity (appVersion, engineVersion,
    engineSha256, runtimeMode, pdPluginVersion, `pluginConfigSha256`,
    `effectiveHookSetFingerprint`, `fingerprintNormalization`,
    `effectiveSourceCoverage`, `rootFingerprint`) and its evidence date.
    Declaration of `partial` / `unknown` coverage is mandatory.
8.  Implement `resolveHostProfile()`; any mismatch sets
    `status=EXPIRED`, falls back to Native-only, and discards stale
    deferred results.
9.  Verify discoverability as four distinct levels (§8.3.1); confirm the
    same event is not registered from two config sources of one root.
    Verify `structuralRevalidationRequired` never becomes
    `semanticReevaluationRequired` (T-19).
10. Rebuild the isolated probe lab and run P1 / P3 / P4 / P6 against
    engine 2.165.0. `PROBE_PENDING` lifecycle events and host-native
    async hooks remain OFF throughout.

Gate 0 additions:

-   The synchronous path satisfies the **three-layer** §17.3.3
    acceptance with per-stratum N, p99 intervals and 95% bounds; any
    shortfall is marked `INSUFFICIENT_EVIDENCE` and the gate is NOT
    `PASS`.
-   Degraded journal lines are emitted and observable; every line
    carries the same `hookInvocationId`; no receipt write adds a
    synchronous database operation.
-   `HostSubmissionOutcome` defaults to `unknown`; no Hook failure is
    recorded as a blocked submission and no blocked submission is
    recorded as a Hook timeout without independent host evidence.
-   `NONE_APPLICABLE` is recorded as a valid decision, never as a skip
    or failure (T-22).
-   `resolveHostProfile()` is implemented and tested (T-01); coverage is
    declared and incomplete coverage is not labelled `VERIFIED` (T-23).
-   Discoverability is verified at all four levels; no same-event
    duplicate registration from one root.
-   `PROBE_PENDING` events and host-native async refresh remain
    explicitly OFF (A-48).

Gate 2 additionally requires evidence that the resolved soft deadline is
derived from installed configuration at runtime, not a hard-coded
constant, and that this is treated as correctness rather than a latency
improvement.

Gate 4 requires the PD-worker Deferred Refresh contract (§10.4.1) to be
implemented, tested and probe-verified before Shadow; host-native async
refresh requires a separate isolated probe and Owner acceptance.

## Phase 1 --- Current Focus / Workspace Focus Repair

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

## Phase 2 --- PD Hook Performance Probe

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

## Phase 3 --- Host Adapter Contract Verification + Native Foundation

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

## Phase 4 --- Model-assisted Shadow

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

-   Decision and Selector quality gates pass.
-   No governance bypass.
-   No cross-session leakage.
-   No stale result commit.
-   Worker cannot block prompt hook.
-   Host delivery remains Native in Shadow.

## Phase 5 --- Controlled Live

Prerequisites:

-   Explicit Owner authorization.
-   Gates 0--4 pass.
-   Exact host profile verified.
-   PD hook performance evidence passes.
-   Worker and model failure paths pass.
-   Session/workspace isolation passes.
-   External data egress is authorized.
-   Delivery Receipt can distinguish `returned` from `confirmed`.
-   Rollback to Native is tested.

Live is enabled only for explicitly selected host profiles and
workspaces.

Gate 5:

No unauthorized principle, cross-session contamination, prompt blockage,
unverified host behavior, or governance bypass.

## Phase 6 --- Examiner Evaluation

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

-   [ ] Runtime V2 remains the sole activation authority.
-   [ ] Selector cannot activate or deactivate principles.
-   [ ] Selector cannot bypass Artifact Validation.
-   [ ] Invalid principles cannot enter the prompt.
-   [ ] Host Adapter cannot change governance semantics.

## B. Native Mode

-   [ ] No external model is required.

-   [ ] Existing Native Prompt Selection has no regression.

-   [ ] Existing Prompt Capacity Budget/Packer works.

-   [ ] `fair_rotation_v1` claims remain within verified scope.

-   [ ] No fake host turn ordinal is created.

-   [ ] No model call is added per user message.

-   [ ] A degraded hook NEVER prevents the user submission from
    proceeding in the WorkBuddy profile; `submission=proceeded` is only
    recorded with independent host evidence.

-   [ ] The three-layer §17.3.3 acceptance is satisfied with per-stratum
    N, p99 confidence intervals/upper bounds and Rule-of-Three bounds;
    any shortfall is `INSUFFICIENT_EVIDENCE`, never `PASS`.

-   [ ] Seven timing dimensions of §17.3.1 are reported separately and
    no stage attribution is inferred from the self-deadline budget.

-   [ ] Every journal line and receipt for one invocation carries the
    same `hookInvocationId`; T0 precedes expensive work; no synchronous
    DB.

## C. Model-assisted Mode

-   [ ] Decision Model supports all five change types.

-   [ ] General Selector supports multi-label selection.

-   [ ] Model outputs pass Candidate Validation.

-   [ ] `NONE_APPLICABLE` is supported.

-   [ ] Model failure falls back safely.

-   [ ] Synchronous hook does not wait for external model inference.

-   [ ] Shadow never changes actual injection.

-   [ ] Live requires explicit Owner authorization.

-   [ ] No safe worker means Model-assisted modes remain OFF.

-   [ ] No host event (`TaskCreated`, `TaskCompleted`, `SessionEnd`,
    `PostCompact`, `SubagentStart/Stop`) produces a `TaskChangeType`
    decision, selects a principle, or causes `principle_decision` to be
    skipped (§5.2.1, T-07′/T-19).

-   [ ] `HOST_TASK_GRAPH_CHANGED` only records provenance and sets
    `structuralRevalidationRequired`; it MUST NOT set
    `semanticReevaluationRequired`, enqueue a semantic task, or cause a
    semantic re-decision at the next `BEFORE_MODEL_TURN` (T-19).

-   [ ] `TaskCreated` and `TaskCompleted` are retained as distinct
    events under the §5.2.2 composite key; no fabricated `generation_id`
    / `turn_id` / `parentTaskId` (T-19).

-   [ ] `NONE_APPLICABLE` is a valid semantic decision in Selector,
    Receipt and Scorer; it is never recorded as `skipped`, `degraded` or
    `failed` (§13.4.4, T-22).

-   [ ] Deferred Refresh carrier is PD's existing detached worker with
    the §10.4.2 constraints implemented and verified; host-native async
    refresh remains OFF unless separately probed and Owner-accepted.

-   [ ] No detached worker contributes to the current turn.

-   [ ] `PreToolUse` never returns `continue:false` in the WorkBuddy
    adapter.

## D. Working Set

-   [ ] State is scoped by workspace, host profile, and session.

-   [ ] Same-session state can be restored.

-   [ ] Different sessions remain isolated.

-   [ ] Concurrent updates cannot overwrite newer state.

-   [ ] Stale/expired state is not used for Live.

-   [ ] Raw user conversation is not persisted.

-   [ ] Installed host/plugin profile changes invalidate stale state.

-   [ ] `generationId` (when present), `hostTaskId` (snake_case
    `task_id`), `hookEventName`, `hookInvocationId`,
    `correlationStatus`, `engineVersion`, `engineSha256`,
    `pdPluginVersion` are bound into the Working Set record; missing
    fields are never fabricated.

-   [ ] `structuralRevalidationRequired` and
    `semanticReevaluationRequired` are independent; structural checks
    never call a model and never alter `selectedPrincipleIds` (T-19).

-   [ ] Discoverability is verified at all four levels of §8.3.1;
    physical residue alone is not treated as duplicate registration.

-   [ ] `pluginConfigSha256` / `effectiveHookSetFingerprint` /
    `rootFingerprint` mismatches yield a neutral return and a degraded
    journal line; coverage is declared and incomplete coverage is never
    labelled `VERIFIED` (T-23).

-   [ ] `SessionEnd` is best-effort and TTL remains authoritative.

-   [ ] `PostCompact` sets only `structuralRevalidationRequired` without
    changing `selectedPrincipleIds` or recomputing the fingerprint from
    `compact_summary`.

-   [ ] Stale, cross-session and `EXPIRED`-profile deferred results are
    discarded with `worker_result_stale_discarded`.

## E. Workspace Focus

-   [ ] `currentTask` can be extracted.
-   [ ] `currentTask` can be restored.
-   [ ] Latest conversation is not lost through head truncation.
-   [ ] Owner-authored content is preserved.
-   [ ] Selector uses a pure read-only interface.
-   [ ] Workspace and Session state are isolated.

### E2. Compaction

-   [ ] No LLM inference or principle selection executes inside a
    synchronous `PreCompact` hook.
-   [ ] PD never returns a blocking result from `PreCompact`, and never
    relies on it to prevent compaction.
-   [ ] `compact_summary` is recorded as evidence metadata only.

## F. Host Compatibility

-   [ ] Codex headless CLI profile is verified.

-   [ ] WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 profile is
    `CONDITIONALLY_VERIFIED`; `effectiveSourceCoverage=partial`.

-   [ ] OpenClaw embedded profile is verified.

-   [ ] OpenClaw Gateway reset profile is limited to `sessions.reset`.

-   [ ] Each profile records exact host/plugin version and runtime mode.

-   [ ] Each profile records timeout and failure semantics.

-   [ ] Each profile records injection channel and evidence grade.

-   [ ] Codex TUI remains disabled until separately verified.

-   [ ] WorkBuddy Desktop UI-only capabilities and standalone IDE
    runtime remain disabled / `NOT_RUN`.

-   [ ] OpenClaw reply `/reset` and ordinary Gateway turn remain
    unclaimed until verified.

-   [ ] No cross-mode evidence substitution.

-   [ ] **WorkBuddy Desktop 5.9.2 / CLI engine 2.165.0 / PD 0.2.2
    profile is `CONDITIONALLY_VERIFIED`** (replaces the `lite-wb CLI`
    item); `effectiveSourceCoverage: "partial"` is declared.

-   [ ] Each profile records appVersion, engineVersion, engineSha256,
    runtimeMode, pluginVersion, `pluginConfigSha256`,
    `effectiveHookSetFingerprint`, `fingerprintNormalization`,
    `effectiveSourceCoverage`, `rootFingerprint`; **no absolute path in
    long-term receipts**.

-   [ ] `resolveHostProfile()` sets `status=EXPIRED` on any mismatch.

-   [ ] `RUNTIME_VERIFIED` tool events and `PROBE_PENDING` lifecycle
    events are recorded with distinct evidence grades; no cross-mode or
    grade substitution.

-   [ ] CLI / IDE / Desktop evidence is recorded separately; the
    PreCompact document/source contradiction is registered.

-   [ ] The WorkBuddy injection channel is recorded as
    `user_message_system_reminder` with position `first`/`last`, and
    `confirmedClaimAllowed=false`.

-   [ ] WorkBuddy failure semantics and `HostSubmissionOutcome` mapping
    are NOT extrapolated to OpenClaw or Codex.

## G. Execution Safety

-   [ ] No synchronous external model call in the prompt hook.

-   [ ] Hook execution budget and Prompt Capacity Budget are separate.

-   [ ] PD's actual hook performance has been measured.

-   [ ] WorkBuddy fail-fast prevents reaching the submission-blocking
    timeout.

-   [ ] OpenClaw fail-open cannot be mistaken for successful injection.

-   [ ] Codex 5 s PD budget is honored despite the 600 s host timeout.

-   [ ] Profile-specific soft deadlines are enforced.

-   [ ] The WorkBuddy soft deadline is resolved at runtime from the
    enabled plugin's `hooks/hooks.json`; no hard-coded host timeout
    constant.

-   [ ] PD self-degradation appends one degraded journal line carrying
    `hookInvocationId` before returning, with no synchronous database
    operation.

-   [ ] Injected content is truncated by PD using the existing Prompt
    Capacity Budget; truncation is recorded journal-only.

-   [ ] `SessionStart` self duration and hook-chain wall time are
    measured and recorded separately.

-   [ ] `none_applicable` and `skipped` are excluded from the §17.3.3
    Hook execution failure-rate denominator.

## H. Evidence

-   [ ] Governance eligibility is auditable.
-   [ ] Selection decision and validation are auditable.
-   [ ] Prompt rendering is auditable.
-   [ ] Adapter return is auditable.
-   [ ] Confirmed delivery requires independent evidence.
-   [ ] Unknown delivery is not scored as confirmed.
-   [ ] Working Set revision and fallback reason are traceable.
-   [ ] Examiner distinguishes delivery from behavioral effect.

------------------------------------------------------------------------

-   [ ] `DeliveryIntegrity` uses **four** independent dimensions plus
    evidence; `degraded` is a `HookExecutionStatus`, never a payload
    state; `HostSubmissionOutcome` defaults to `unknown`.
-   [ ] All twelve §13.4.2 invariants hold, including "open is never
    success", "no blocked without host evidence", "no timeout without
    host evidence", and "no T0 is not host kill".
-   [ ] Lifecycle is `StageObservation[]` with six stages, per-stage
    owner, timestamp, evidence grade, reference and `hookInvocationId`;
    no boolean flags.
-   [ ] Only `confirmed` is scored as success; `returned` is an
    attempted delivery; `unknown` is unscored; `none_applicable` is a
    valid semantic decision, not a failure.
-   [ ] `confirmed` is never claimed for WorkBuddy without request-level
    evidence from an isolated probe; `submission=proceeded|blocked` is
    never claimed without independent host evidence (T-20).
-   [ ] Reconciliation may conclude `unknown`; `reconciled` never
    implies delivery success; `unknown` is never upgraded to `returned`
    or `confirmed` (T-21).
-   [ ] Host-kill scenarios are reconciled from the T0 `open` journal
    line **only when independent host evidence exists**; a missing T0
    line is recorded as `unknown`, not as a kill.

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
12. **Any WorkBuddy submission-blocking hook outcome** (replaces the
    previous generic wording): host-side kill, `exit 2`, `deny`, or
    `continue:false` reaching the host, **when independently
    evidenced**. A Hook execution failure alone is NOT this condition.
13. OpenClaw fail-open is incorrectly recorded as confirmed delivery.
14. A stale deferred result overwrites a newer Working Set.
15. A PD self-degradation causes a turn to receive no principle
    contribution (`execution="degraded"` with `payload="none"` observed
    in Live).
16. A degraded / timeout / failed / unknown outcome is recorded as
    `returned`, `skipped`, `none_applicable`, `confirmed` or
    `proceeded`; no journal line is written; a T0 `open` record is
    counted as success; or `submission=proceeded|blocked` is asserted
    without independent host evidence.
17. A same-event duplicate hook registration arises from two config
    sources of one plugin root, or a `pluginConfigSha256` /
    `effectiveHookSetFingerprint` / `rootFingerprint` mismatch is not
    handled neutrally; or a profile with `partial` / `unknown` coverage
    is declared fully `VERIFIED`. (Physical presence of stale version
    directories alone is NOT a stop condition.)
18. `resolveHostProfile()` reports `EXPIRED` and the adapter does not
    fall back to Native-only, or a stale deferred result reaches a new
    session.
19. Any host event is observed producing a `TaskChangeType` decision,
    selecting a principle, skipping `principle_decision`, or converting
    `structuralRevalidationRequired` into `semanticReevaluationRequired`
    (`semantic_bypass_rejected`).
20. A `TaskCreated` and a `TaskCompleted` for the same todo item are
    deduplicated into one record, or a missing identity field is
    fabricated to force a correlation.
21. `exit 2`, `deny`, `continue:false` or a Hook failure is classified
    as `execution="timeout"` without host evidence, or a blocked
    submission is classified as a Hook timeout; or WorkBuddy submission
    semantics are extrapolated to another host.
22. A valid `NONE_APPLICABLE` decision is recorded / scored as a skip or
    an execution failure, or is included in the §17.3.3 Hook
    failure-rate denominator.
23. A release gate is marked `PASS` while any critical stratum has
    insufficient samples, an unsatisfied p99 interval, or an undeclared
    multiple-comparison method; i.e. `INSUFFICIENT_EVIDENCE` is
    overridden.

On stop, return to Native without changing existing governance state.

------------------------------------------------------------------------

# 22. Open Questions

  ------------------------------------------------------------------------------------------------------------------------
  ID                      Question                                                  Current status / required evidence
  ----------------------- --------------------------------------------------------- --------------------------------------
  OQ-01                   Does Codex interactive TUI expose the same usable prompt  `NOT_RUN`; isolated TUI probe with
                          hook as headless CLI?                                     reliable TTY/ConPTY.

  OQ-02                   Does WorkBuddy Desktop/IDE expose the same prompt event   Partially closed: Desktop 5.9.2
                          and injection behavior as the tested Desktop-hosted CLI   hosting engine 2.165.0 is verified for
                          engine?                                                   the observed hook paths; Desktop
                                                                                    UI-only capabilities and standalone
                                                                                    IDE remain `NOT_RUN`.

  OQ-03                   Does OpenClaw reply `/reset` dispatch the same lifecycle  Open; separate reply-path probe.
                          events as Gateway `sessions.reset`?                       

  OQ-04                   Does ordinary OpenClaw Gateway turn dispatch the same     Open; separate Gateway-turn probe.
                          `before_prompt_build` path?                               

  OQ-05                   What are reliable Workspace and Session identity sources  Partially closed: WorkBuddy
                          for each profile?                                         `session_id` is present across events;
                                                                                    `generation_id` is present on UPS/Stop
                                                                                    and absent on Task/Compaction; `cwd`,
                                                                                    snake_case `task_id`, and `agent_id`
                                                                                    are observed. `workspaceId` and stable
                                                                                    cross-process `conversationId` remain
                                                                                    UNKNOWN.

  OQ-06                   Which existing PD worker can safely run deferred model    PD detached worker exists with Runtime
                          refresh without blocking host hooks?                      V2 task lease; Deferred Refresh
                                                                                    contract is not implemented.
                                                                                    Host-native async is `PROBE_PENDING` /
                                                                                    OFF.

  OQ-07                   Which SQLite database owns Working Set state?             Open; database ownership and migration
                                                                                    audit.

  OQ-08                   What are real PD hook p95/p99 and worst-case timings, and `NOT_RUN`; phase-level PD Hook
                          which stage caused the observed 12 s self-degradation?    Performance Probe. The 12.021 s value
                                                                                    is a budget setting, not stage
                                                                                    attribution.

  OQ-09                   What soft deadline and safety margin are safe per         Open; derive from PD p95/p99 and
                          profile?                                                  worst-case measurements plus exact
                                                                                    host timeout semantics.

  OQ-10                   What is the best checkpoint interval?                     Open; Shadow evaluation after Gates
                                                                                    0--4.

  OQ-11                   Can a low-cost Decision Model reliably detect goal/phase  Open; labeled evaluation.
                          changes?                                                  

  OQ-12                   Does General Selector understand abstract principles      Open; multi-label selection
                          sufficiently?                                             evaluation.

  OQ-13                   Does candidate pool need to exceed 48?                    Open; candidate distribution and
                                                                                    overflow statistics.

  OQ-14                   Can adapters independently confirm actual request         Open/tightened: `confirmed` requires
                          delivery?                                                 request-level evidence;
                                                                                    HostSubmissionOutcome defaults to
                                                                                    `unknown` without independent host
                                                                                    evidence.

  OQ-15                   What is the exact WorkBuddy injection role/channel?       Channel is source-confirmed: `user`
                                                                                    message with
                                                                                    `<system-reminder data-role="hook">`
                                                                                    before `<user_query>`. Per-turn
                                                                                    request-level `confirmed` evidence
                                                                                    remains `NOT_RUN`.

  OQ-16                   What identity/deduplication semantics exist for periodic  Partially closed: use only real fields
                          checkpoints and lifecycle events?                         such as `generation_id`, `task_id`,
                                                                                    and `call_id` where present;
                                                                                    `SessionEnd` is best-effort;
                                                                                    `deduplicateHooks` deduplicates
                                                                                    identical command strings only.

  OQ-17                   Does WorkBuddy `async:true` detached hook behave          `DEFERRED_PENDING_EVIDENCE`; isolated
                          non-blockingly, is `asyncTimeout` honored, and what       lifecycle probe. Host async remains
                          happens after the session ends?                           OFF.

  OQ-18                   Which specific synchronous stage caused the 12.021 s      `NOT_RUN`; phase-level PD Hook
                          self-degradation?                                         Performance Probe.

  OQ-19                   Does `PostCompact` reliably dispatch, and can             `NOT_RUN`; isolated compaction probe.
                          `compact_summary` ever represent complete context?        Treat summary as lossy metadata
                                                                                    meanwhile.

  OQ-20                   Can `ConfigChange` detect `hooks.json` / profile drift    Open; source + runtime correlation.
                          within a session?                                         

  OQ-21                   Are WorkBuddy `task_id` / `task_subject` payload shapes   Open; per-version probe.
                          stable across engine upgrades?                            

  OQ-22                   Do `TaskCreated` / `TaskCompleted` / `SubagentStart` /    `PROBE_PENDING`; isolated P3 probe. No
                          `SubagentStop` dispatch reliably with the observed        semantic authority.
                          payload shapes?                                           

  OQ-23                   Can `PreCompact` execute a bounded checkpoint without     `PROBE_PENDING`; isolated P4 probe +
                          inflating compaction latency under load?                  phase timings.

  OQ-24                   Is `events_<date>.jsonl` append latency within the §17.3  Open; concurrency measurement.
                          receipt budget under concurrent hooks?                    

  OQ-25                   Can an isolated probe produce request-level `confirmed`   `NOT_RUN`; P1 mock-request probe.
                          evidence for engine 2.165.0?                              

  OQ-26                   Do WorkBuddy Task events contain a real host event unique `UNKNOWN`; per-version payload probe.
                          identifier? If not, is                                    Composite key is the current fallback.
                          `(hostProfileId, session_id, task_id, hook_event_name)`   
                          collision-safe across sessions and engine upgrades?       

  OQ-27                   Which host-side `getHooks` configuration sources can be   Current coverage `partial`; runtime
                          observed at runtime, and can `effectiveSourceCoverage`    config-observability probe.
                          become `complete`?                                        

  OQ-28                   Which p99 confidence-interval method and                  `UNKNOWN`; statistical design review
                          multiple-comparison correction are normative for §17.3.3? and probe calibration.

  OQ-29                   Can independent host evidence for                         `UNKNOWN`; isolated probe with host
                          `submission=proceeded|blocked` be obtained without a      log capture.
                          production session or blocking test?                      

  OQ-30                   Is a `hostRequestId` present on Task / Compaction         `UNKNOWN`; per-version payload probe.
                          payloads to improve correlation beyond the composite key? 
  ------------------------------------------------------------------------------------------------------------------------

Open Questions OQ-01...OQ-30 do not all block offline shared-core
development. They block only the specific host capability, runtime
claim, statistical release gate, or rollout phase that depends on the
missing evidence. See §19 and §25.4.

# 23. Architecture Decision Records

## ADR-001 --- Runtime V2 Remains the Only Governance Authority

**Decision: ACCEPTED / RETAINED.**

Avoid two independent principle activation authorities.

## ADR-002 --- Native and Model-assisted Coexist

**Decision: ACCEPTED / RETAINED.**

PD must remain operational without an external model.

## ADR-003 --- Two-stage Model Architecture

**Decision: ACCEPTED / RETAINED, execution timing revised.**

Decision Model detects task changes. General Reasoning Model selects
abstract principles. Both execute outside the synchronous hook by
default.

## ADR-004 --- Multi-label Selection

**Decision: ACCEPTED / RETAINED.**

Real tasks may require multiple complementary principles.

## ADR-005 --- No Per-message LLM Invocation by Default

**Decision: ACCEPTED / STRENGTHENED.**

No synchronous per-message external model invocation. Deferred refresh
is subject to worker verification.

## ADR-006 --- Current Focus Is Upgraded, Not Replaced

**Decision: ACCEPTED / RETAINED.**

Keep `CURRENT_FOCUS.md`; clarify its semantic role as Workspace Focus
and repair lifecycle/read behavior.

## ADR-007 --- Three Context Levels

**Decision: ACCEPTED / RETAINED.**

INTENT, Workspace Focus, and Session Working Set remain independent.

## ADR-008 --- Existing Budget and Renderer Reused

**Decision: ACCEPTED / CLARIFIED.**

Reuse Prompt Capacity Budget, Packer, and Renderer. Hook execution time
is a separate host-specific budget.

## ADR-009 --- Host Capability Is a Hard Gate

**Decision: ACCEPTED / STRENGTHENED.**

A capability profile is bound to exact host version and runtime mode.
`NOT_RUN` is not support and not failure.

## ADR-010 --- Shadow Before Live

**Decision: ACCEPTED / RETAINED.**

Prove selection quality and evidence integrity before changing real host
behavior.

## ADR-011 --- Shared Core, Host-specific Adapter Contracts

**Decision: NEW --- PROPOSED.**

Use one selection core with per-host event, timeout, failure, identity,
and injection contracts. Adapter cannot change governance or semantic
selection.

## ADR-012 --- Model Inference Is Deferred from the Synchronous Hook

**Decision: NEW --- PROPOSED.**

Current prompt uses valid cached state or Native. Deferred results may
affect only a later prompt boundary.

## ADR-013 --- Delivery Evidence Is Separate from Selection and Behavioral Effect

**Decision: NEW --- PROPOSED.**

`returned` is not `confirmed`; `confirmed` is not behavioral effect.
Examiner independently evaluates behavior.

## ADR-014 --- Working Set Selector v0.2 Hold Is Preserved

**Decision: ACCEPTED / GOVERNANCE PRESERVED.**

This SPEC does not promote the Working Set Selector v0.2 proposal or
bypass its Phase 1/2 Hold conditions. Any activation of that proposal
remains subject to its own Owner gate and route-to-restart conditions.

------------------------------------------------------------------------

## ADR-015 --- Host Events Supply Technical Signals, Never Semantic Authority

**Decision: NEW --- PROPOSED. Status: `PROPOSED`.**

Host lifecycle events may supply timing, provenance, deduplication and
invalidation signals. They MUST NOT supply semantic task classification
or principle selection.

A host event MUST NOT produce a `TaskChangeType` decision, skip
`principle_decision`, select/activate/deactivate a principle, or serve
as a user task boundary. `TaskCreated` / `TaskCompleted` in WorkBuddy
engine 2.165.0 are Agent-internal todo notifications: they carry no user
prompt, no turn identity, no parent hierarchy, and their `task_id`
cannot resolve the originating user request. `SubagentStart` /
`SubagentStop` belong to a separate session-lineage chain. `PostCompact`
carries only a lossy `compact_summary`.

`principle_decision` remains the sole semantic classifier. §17.5
optimization order item 1 is satisfied by throttling, deduplication and
cached Working Set reuse --- not by replacing semantic judgment with a
host signal.

**Structural / semantic separation (v0.2.1, P0-1).**
`structuralRevalidationRequired` and `semanticReevaluationRequired` are
independent. Structural revalidation checks only Working Set revision,
Host Profile validity, configuration fingerprints, Activation / Artifact
validity and cache expiry; it MUST NOT call a model, MUST NOT change
`selectedPrincipleIds`, and MUST NOT set a semantic flag. Semantic
reevaluation is permitted only for a verified user semantic change or a
SPEC v0.4 §5-authorized semantic trigger, and is performed exclusively
by `principle_decision`.

`HOST_TASK_GRAPH_CHANGED` is structural-only. It MUST NOT set a semantic
flag, enqueue a deferred semantic task, or cause the next verified
`BEFORE_MODEL_TURN` to re-run semantic classification indirectly. A
structural flag MUST NOT be promoted, consumed as, or reinterpreted into
a semantic trigger at any later checkpoint. `TaskCreated` and
`TaskCompleted` are distinct events correlated by the §5.2.2 composite
key; missing identity fields are recorded as `unreliable` / `unknown`,
never fabricated.

Rationale: Amendment v0.1 proposed a "determinism-first rule" that
mapped `TaskCreated` to a deterministic `NEW_TASK`; source inspection
showed this would re-select principles on every Agent plan-item creation
and could cause systematic erroneous activation. This ADR supersedes
that proposal.

## ADR-016 --- Mode-Scoped Evidence, Grade Discipline and Status Ladder

**Decision: NEW --- PROPOSED. Status: `PROPOSED`.**

Every host capability claim MUST be bound to (a) CLI / IDE / Desktop
mode, (b) official document URL and check date, (c) engine version and
binary hash where available, (d) evidence grade, (e) verification date.
Official documents may contradict matched source and live runtime; such
contradictions MUST be recorded separately, never resolved by silently
discarding one source. `SOURCE_CONFIRMED` MUST NOT be upgraded to
`RUNTIME_VERIFIED`; `NOT_RUN` and `PROBE_PENDING` MUST NOT be upgraded
to `Supported`.

Implementation state is tracked by the §0.2.2 ladder
(`PROPOSED → SPEC_REVISED → IMPLEMENTED → TESTED → RUNTIME_VERIFIED → ACCEPTED`,
plus `DEFERRED_PENDING_EVIDENCE`). A proposal MUST NOT be marked `PASS`
in a self-audit. A profile is `EXPIRED` on any version, engine hash,
runtime mode, plugin version, `pluginConfigSha256` or
`effectiveHookSetFingerprint` change until reverified.

**Three separate status dimensions (v0.2.1, P2).** `Review Disposition`
is a review opinion (`ACCEPT` / `ACCEPT_WITH_CHANGE` / `REJECT` /
`DEFERRED_PENDING_EVIDENCE`) and is NOT Owner approval, NOT a SPEC
change and NOT an implementation. `Implementation Status` is the §0.2.2
ladder; `SPEC_REVISED` is permitted **only after formal merge into SPEC
v0.5** --- before that, every amendment item is `PROPOSED`.
`Baseline Provenance` records content origin, including
`RETAINED_FROM_V0_4` for original SPEC v0.4 designs that are preserved;
that marker does NOT mean a new revision has been implemented. No
dimension may substitute for another, and no self-audit row may claim
`SPEC_REVISED` or `ACCEPTED` prematurely.

Rationale: the 2026-11-04 audit found 13 concrete contradictions between
CLI docs, IDE docs, engine source and live runtime, and a historical
probe baseline (2.161.0) that had silently gone stale after a host
auto-upgrade to 2.165.0.

## ADR-017 --- Delivery Evidence Uses a Closed-World Default and Four Independent Observations

**Decision: NEW --- PROPOSED. Status: `PROPOSED`.**

Delivery state is represented by **four independent observation
dimensions** --- `HookExecutionStatus`, `PayloadStatus`,
`SelectionStatus` and `HostSubmissionOutcome` --- plus
`DeliveryEvidence` and an `open / closed / reconciled` journal state.
Every record begins as `unknown`; only explicit positive evidence can
move it to `returned`, `confirmed`, `proceeded` or `blocked`. A Hook
failure MUST NOT be read as a blocked user submission; a proceeded
submission MUST NOT be read as a delivered payload; `exit 2` / `deny` /
`continue:false` / host kill MUST NOT all be collapsed into `timeout`.
`HostSubmissionOutcome` defaults to `unknown` and requires independent
host evidence. WorkBuddy-specific submission semantics MUST NOT be
generalized to other hosts.

`open` means the invocation started with no terminal record; `closed`
means a terminal record exists (any outcome); `reconciled` means
background reconciliation has completed (any result) and is NOT success.
A missing T0 line is NOT evidence of a host kill; with no independent
host evidence, reconciliation concludes `unknown`. `reconciled` never
implies delivery success, and `unknown` is never upgraded to `returned`
or `confirmed`.

Every journal line and receipt carries one `hookInvocationId`, generated
at the earliest controllable wrapper entry and propagated through the
child process, emitter and reconciliation. T0 is `RUNTIME_VERIFIED`
evidence of PD hook runtime dispatch with `independentlyVerified=false`,
and is written before expensive work.

Lifecycle is a set of independently evidenced `StageObservation`
records, not booleans. PD may not assert `plugin_installed`,
`plugin_loaded`, `request_confirmed` or `behavioral_effect` on its own
authority.

Receipt writing MUST NOT add a synchronous database operation to the
prompt hook; it is a single append-only journal line, with heavy
evidence replay delegated to the existing background worker.

Rationale: a live session already lost an injection silently. Treating
"no exception" or a known channel as delivery would make that loss
invisible; adding synchronous evidence writes would make the underlying
latency problem worse.

## ADR-018 --- `NONE_APPLICABLE` Is a Valid Semantic Decision, Not a Failure

**Decision: NEW --- PROPOSED. Status: `PROPOSED`.**

SPEC v0.4 §6.3 / §6.5 / §6.6 / §18.4 / §20C establishes
`NONE_APPLICABLE` as a valid model-assisted selection result subject to
explicit validation. v0.2 collapsed it into `skipped`; v0.2.1 restores
its independent status in `SelectionStatus`.

`selected` = judgment succeeded with principles; `none_applicable` =
judgment succeeded with a valid empty decision; `skipped` = policy/flag
decided not to run selection; `unavailable` = dependency failure
prevented selection. These four states MUST be recorded consistently in
the Selector result, the Receipt (`selection.selectionStatus` and
`delivery.selection`) and the Scorer (`Empty Selection Accuracy`). A
correct `NONE_APPLICABLE` decision MUST NOT be recorded as an execution
failure, a skip, or a delivery failure, and MUST NOT be counted in the
§17.3.3 Hook execution failure-rate denominator.

Rationale: treating a correct empty selection as a skip or failure would
corrupt both governance evidence and statistical release gates, and
would silently contradict the retained SPEC v0.4 design.

# 24. Change Log

## 24.1 Historical v0.3 → v0.4 Change Log

  -------------------------------------------------------------------------------
  v0.3 section     v0.4 change                    Reason / evidence
  ---------------- ------------------------------ -------------------------------
  Metadata         Add Host Matrix evidence       Prevent host/mode extrapolation
                   baseline and exact verified    
                   runtime scope                  

  0 Executive      Add evidence-driven host-aware Host Matrix v0.1
  Summary          premise                        

  1 Goals          Add host-aware delivery and    New runtime integration
                   evidence separation            constraints

  2.2 Existing     Distinguish verified code,     Avoid claiming proposal is
  Capabilities     proposal, and unimplemented    production
                   capabilities; retain WSS Hold  

  2.4 Native       Clarify `fair_rotation_v1`     Existing implementation notes
  Selection        scope and FIFO fallback        and selector reality audit

  2.6 Current      Rename semantic role to        Separate workspace-level focus
  Focus            Workspace Focus while          from session state
                   preserving file path           

  3 Core           Add Host Adapter boundary;     Three hosts have different
  Architecture     model path is deferred         runtime contracts

  4 Context Model  Preserve three layers and add  Identity and isolation
                   provenance/profile metadata    requirements

  5 Task Change    Add canonical                  Codex resume repeats; WorkBuddy
  Detection        `BEFORE_MODEL_TURN`; prohibit  event concurrency; OpenClaw
                   SessionStart dependency        event differences

  5 Checkpoints    Restrict turn counter to       No fabricated host turn ordinal
                   verified/deduplicated sequence 

  6 Selector       Retain schemas and multi-label Governance and concurrency
                   policy; strengthen validation  safety
                   and stale-result binding       

  7 Budget/Packing Separate Hook Execution Budget Different resource dimensions
                   from Prompt Capacity Budget    

  7 Fair Rotation  Preserve scope; no cross-host  Existing host-specific
                   guarantee                      implementation reality

  8 Working Set    Mark schema as logical         Not verified in production
                   proposal; add profile/version  
                   binding; require storage audit 

  9 Current Focus  Preserve Markdown artifact and Existing Focus side effects and
                   ownership; add pure read       isolation gaps
                   contract                       

  10 Model Runtime Retain Pi AI Runtime; move     Prevent hook blocking
                   1.5s/3s to deferred worker     
                   targets                        

  11 Flags         Keep all OFF; explicitly       Evidence-limited host scope
                   disable unverified modes       

  12 Host          Replace pending matrix with    Host Matrix v0.1
  Capability Gate  exact evidence-backed profile  
                   matrix                         

  12--13 Host      Add per-host budgets and       Codex 5s PD/600s host;
  Execution        failure semantics              WorkBuddy 15s canonical vs 30s
                                                  cached/30s host; OpenClaw 15s
                                                  host

  13 Prompt        Add per-host channel contract  OpenClaw system+user; Codex
  Injection                                       developer; WorkBuddy unknown

  14 Failure       Prohibit synchronous model     WorkBuddy can block submission;
  Handling         inference; require deferred    OpenClaw fail-open; Codex hook
                   worker verification            failed but turn continues

  15 Observability Add explicit delivery statuses returned ≠ confirmed
                   and Receipt contract           

  16 Performance   Add mandatory real PD Hook     Probe latency is not PD latency
                   Performance Probe              

  17 Evaluation    Add delivery evidence metrics  Selection and delivery are
                                                  separate

  18 Rollout       Add PD performance and adapter Host Matrix Owner conditions
                   verification gates             

  19 Acceptance    Add profile, timeout, channel, New runtime constraints
                   evidence, and no-blocking      
                   requirements                   

  20 Stop          Add host-profile mismatch,     Failure prevention
  Conditions       stale result, and delivery     
                   misclassification              

  21 Open          Replace stale host questions   Evidence update
  Questions        with precise NOT_RUN and       
                   implementation gaps            

  22 ADRs          Retain original ten and add    Host-aware/deferred/evidence
                   four decisions                 boundaries

  23 Final         Clarify one decision core +    Consolidated architecture
  Statement        adapters + evidence chain      
  -------------------------------------------------------------------------------

## 24.2 v0.4 → v0.5 Change Log

  ---------------------------------------------------------------------------------
  Scope                   v0.5 change                       Source
  ----------------------- --------------------------------- -----------------------
  Metadata / §0.3 / §2.1  Add WorkBuddy host-native         WorkBuddy Host Audit +
                          revision + adversarial review     Amendment v0.2.1 +
                          corrections; remove               adversarial review
                          determinism-first rule and the    
                          "cannot outlive the session"      
                          guarantee                         

  §0.2 / §1 / §25.1       Split Review Disposition /        Amendment v0.2.1 (P2)
                          Implementation Status / Baseline  
                          Provenance; correct premature     
                          `SPEC_REVISED`                    

  §5.2.1--5.5 / §8.2 /    Task event composite dedup key;   Amendment v0.2.1 (P0-1)
  §12.2 / §12.5           structural vs semantic            
                          revalidation isolation            

  §13.4 / §14 / §15       `HostSubmissionOutcome` as fourth Amendment v0.2.1 (P0-2
                          dimension; `hookInvocationId` and / P1-1 / P1-2)
                          reconciliation semantics;         
                          `NONE_APPLICABLE` restored        

  §8.3.1 / §10.2 / §12.2  `pluginConfigSha256` /            Amendment v0.2.1 (P1-3)
  / §15.2                 `effectiveHookSetFingerprint` +   
                          coverage declaration              

  §17.3 / §19 / §20 / §21 Three-layer statistical           Amendment v0.2.1 (P1-4)
                          acceptance;                       
                          `INSUFFICIENT_EVIDENCE` release   
                          adjudication                      

  §23                     ADR-015/016/017 revised; ADR-018  Amendment v0.2.1
                          added                             

  Metadata / §0 / §1 / §3 Re-center success on long-term    Owner direction +
                          behavior improvement; bind        WorkBuddy Host Audit
                          WorkBuddy facts to Desktop-hosted 
                          CLI engine profile; retain one    
                          shared core                       

  §19 / §25.4             Split offline shared-core         Owner direction +
                          development from host-specific    v0.2.1 open-question
                          runtime release gates so          policy
                          unverified host details do not    
                          block core development            
  ---------------------------------------------------------------------------------

## 24.3 Explicitly Preserved from v0.3

The following remain unchanged in principle:

-   Runtime V2 as sole governance authority.
-   Native + Model-assisted dual path.
-   Decision Model + General Reasoning Selector roles.
-   Multi-label selection.
-   `SAME_TASK`, `NEW_TASK`, `GOAL_SHIFT`, `PHASE_SHIFT`, `UNCERTAIN`.
-   INTENT / Workspace Focus / Session Working Set separation.
-   Existing Prompt Capacity Budget, Packer, and Renderer.
-   Working Set revision and optimistic concurrency concept.
-   Current Focus upgrade, not replacement.
-   Pi AI Runtime and Runtime Profile reuse.
-   Native default.
-   Shadow before Live.
-   External context transmission explicit opt-in.
-   Candidate limits and initial evaluation targets, clearly labeled
    experimental.
-   Examiner's independent behavioral-effect evaluation.
-   Working Set Selector v0.2 proposal status and Hold gates.

------------------------------------------------------------------------

# 25. Self-audit and Implementation Readiness

## 25.1 Consistency Audit and Status Register

> This table records review disposition, implementation status, and
> baseline provenance as independent dimensions. The current v0.5 file
> is a proposed document baseline; no code implementation or runtime
> gate is claimed as complete.

  -----------------------------------------------------------------------------------------------------------------------------
  Check / decision         Review Disposition            Implementation Status         Baseline Provenance    Required next
                                                                                                              evidence
  ------------------------ ----------------------------- ----------------------------- ---------------------- -----------------
  Runtime V2 remains sole  `ACCEPT`                      `PROPOSED`                    `RETAINED_FROM_V0_4`   Owner acceptance;
  activation authority                                                                                        regression tests

  Native remains           `ACCEPT`                      `PROPOSED`                    `RETAINED_FROM_V0_4`   Offline
  independent of external                                                                                     Native-path tests
  model                                                                                                       

  Two-stage Decision       `ACCEPT`                      `PROPOSED`                    `RETAINED_FROM_V0_4`   Labeled
  Model + General Selector                                                                                    evaluation
  retained                                                                                                    

  Host events never bypass `ACCEPT_WITH_CHANGE`          `PROPOSED`                    `REVISED_IN_V0_5`      T-07′ / T-19
  `principle_decision`                                                                                        

  TaskCreated /            `ACCEPT_WITH_CHANGE`          `PROPOSED`                    `REVISED_IN_V0_5`      Per-version
  TaskCompleted are                                                                                           payload probe;
  internal todo                                                                                               OQ-26
  notifications                                                                                               

  Structural and semantic  `ACCEPT`                      `PROPOSED`                    `NEW_IN_V0_5`          T-19
  revalidation are                                                                                            
  independent                                                                                                 

  DeliveryIntegrity has    `ACCEPT`                      `PROPOSED`                    `REVISED_IN_V0_5`      T-16 / T-20
  four independent                                                                                            
  observations                                                                                                

  HostSubmissionOutcome    `ACCEPT`                      `PROPOSED`                    `NEW_IN_V0_5`          Independent host
  defaults to unknown                                                                                         evidence; OQ-29

  Journal uses             `ACCEPT`                      `PROPOSED`                    `NEW_IN_V0_5`          T-03 / T-21;
  hookInvocationId and                                                                                        runtime journal
  open/closed/reconciled                                                                                      evidence

  NONE_APPLICABLE is a     `ACCEPT`                      `PROPOSED`                    `REVISED_IN_V0_5`      T-22; Scorer
  valid semantic decision                                                                                     consistency

  WorkBuddy channel is     `ACCEPT_WITH_CHANGE`          `PROPOSED`                    `REVISED_IN_V0_5`      P1 request-level
  source-confirmed but not                                                                                    probe; OQ-25
  request-confirmed                                                                                           

  WorkBuddy profile is     `ACCEPT_WITH_CHANGE`          `PROPOSED`                    `REVISED_IN_V0_5`      Exact-version
  Desktop-hosted CLI                                                                                          profile resolver;
  engine 2.165.0                                                                                              T-01

  WorkBuddy effective      `ACCEPT`                      `PROPOSED`                    `NEW_IN_V0_5`          T-23; OQ-27
  source coverage remains                                                                                     
  partial                                                                                                     

  WorkBuddy 12 s           `ACCEPT_WITH_CHANGE`          `PROPOSED`                    `REVISED_IN_V0_5`      Phase-level
  self-degradation / zero                                                                                     measurement; P0
  contribution is P0                                                                                          remediation

  PD existing worker is    `ACCEPT_WITH_CHANGE`          `PROPOSED`                    `REVISED_IN_V0_5`      Contract
  Deferred Refresh                                                                                            implementation,
  candidate                                                                                                   T-18, Gate 4

  WorkBuddy host-native    `DEFERRED_PENDING_EVIDENCE`   `DEFERRED_PENDING_EVIDENCE`   `RETAINED_FROM_V0_2`   Isolated P6
  async remains OFF                                                                                           probe + Owner
                                                                                                              acceptance

  WorkBuddy lifecycle /    `DEFERRED_PENDING_EVIDENCE`   `DEFERRED_PENDING_EVIDENCE`   `REVISED_IN_V0_5`      Isolated P3/P4
  compaction triggers                                                                                         probes
  remain OFF pending probe                                                                                    

  Seven timing dimensions  `ACCEPT`                      `PROPOSED`                    `REVISED_IN_V0_5`      T-11 / T-17 /
  and three-layer                                                                                             T-24; OQ-28
  statistics                                                                                                  

  StageObservation         `ACCEPT`                      `PROPOSED`                    `REVISED_IN_V0_5`      T-13
  replaces lifecycle                                                                                          
  booleans                                                                                                    

  Shadow does not          `ACCEPT`                      `PROPOSED`                    `RETAINED_FROM_V0_4`   Gates 0--5; Owner
  auto-upgrade to Live                                                                                        authorization

  Examiner remains sole    `ACCEPT`                      `PROPOSED`                    `RETAINED_FROM_V0_4`   Controlled and
  behavioral-effect                                                                                           longitudinal
  assessor                                                                                                    evaluation
  -----------------------------------------------------------------------------------------------------------------------------

`ACCEPT` is a review opinion, not Owner approval. `PROPOSED` remains the
implementation status until formal repository merge or implementation.
`SPEC_REVISED` is not used prematurely. No item is `ACCEPTED` without
explicit Owner approval.

## 25.2 Evidence Limitations

This SPEC does not claim:

-   Codex interactive TUI is verified.
-   WorkBuddy standalone IDE runtime or Desktop UI-only capabilities are
    verified.
-   WorkBuddy `PROBE_PENDING` lifecycle / compaction events are usable
    as refresh triggers; they have source-level dispatch points but zero
    live samples.
-   `TaskCreated` / `TaskCompleted` represent user task boundaries; they
    do not. Their host event unique identifier remains `UNKNOWN`
    (OQ-26).
-   A structural revalidation signal is equivalent to, or may become, a
    semantic reevaluation.
-   A Hook execution failure proves blocked submission, or a missing T0
    journal line proves a host kill.
-   `NONE_APPLICABLE` is a skip or an execution failure.
-   WorkBuddy `effectiveSourceCoverage` is `complete`; the current
    profile is `partial`, so its maximum profile status is
    `CONDITIONALLY_VERIFIED`.
-   A release gate with insufficient samples can be marked `PASS`, or
    that 200 samples alone support a stable p99 claim.
-   A host-native `async:true` hook is a verified Deferred Refresh
    carrier, or that a detached worker cannot outlive its session.
-   WorkBuddy submission-outcome semantics apply to other hosts.
-   Classic WorkBuddy `PreCompact` can block compaction, or that
    `compact_summary` represents full context.
-   Stale plugin version directories on disk imply duplicate hook
    registration.
-   PD's synchronous path stage-level timings, p95/p99, or the cause of
    the 12 s self-degradation are known.
-   The Deferred Refresh contract is implemented in PD code.
-   Current WorkBuddy engine 2.165.0 request-level `confirmed` evidence
    exists.
-   Model-assisted selection has passed Shadow evaluation.
-   Principle activation has improved long-term host behavior.
-   Codex TUI, OpenClaw reply `/reset`, or ordinary OpenClaw Gateway
    turns are verified by evidence from a different runtime mode.
-   `principle_working_sets` exists in production or that a production
    migration is authorized.
-   Cross-host `fair_rotation_v1` behavior is implemented or verified.
-   OpenClaw PD-specific internal hook budget is known.

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
task context through a verified host channel --- and preserve enough
evidence to determine whether that intervention actually improved the
Agent's decisions and behavior over repeated work.**

Host integration is an enabling constraint, not the product objective.
WorkBuddy is one evidence-bound Host Profile, not the center of the
shared architecture. The shared core remains responsible for context
interpretation, semantic task-change judgment, principle selection,
validation, and Working Set resolution; Host Adapters only normalize
verified host facts and deliver the validated result.

------------------------------------------------------------------------

## 25.4 Implementation Readiness and Blocking Policy

### May proceed in the offline/shared-core lane after Owner SPEC approval

-   Context Snapshot and pure-reader contracts.
-   Native Selection integration and candidate validation.
-   Decision Model / General Selector interfaces using deterministic
    fixtures and mock runtime responses.
-   Multi-label selection validation, `NONE_APPLICABLE`, and Working Set
    revision semantics.
-   Host-independent Resolver and budget/renderer reuse.
-   Receipt state-machine unit tests and evidence-contract tests.

### Blocks WorkBuddy production Native delivery

-   P0 phase-level attribution and remediation of the observed
    self-degraded prompt with zero principle contribution.
-   Non-blocking self-degradation, dynamic effective timeout resolution,
    `hookInvocationId`, append-only degraded journal, and
    reconciliation.
-   Exact Host Profile binding and neutral fallback on profile/config
    mismatch.

### Blocks specific lifecycle capabilities or Model-assisted rollout

-   WorkBuddy `Task*`, `SessionEnd`, `PreCompact`, `PostCompact`, and
    `Subagent*` remain OFF until their own isolated runtime evidence
    exists.
-   PD Worker Deferred Refresh remains OFF until result binding, lease,
    revision fence, stale-result discard, idempotency, and
    next-prompt-only application are implemented and tested.
-   Host-native async remains OFF pending isolated P6 evidence and Owner
    acceptance.
-   Model-assisted Shadow requires Gates 0--4, external
    data-transmission authorization, and a verified deferred carrier.
    Live additionally requires Gate 5 and explicit Owner authorization.

Unresolved OQ-01 / OQ-17...OQ-30 do not block offline shared-core
implementation unless a specific work item depends on the corresponding
host capability or statistical claim. They do block the related runtime
claim or release gate. This is the mechanism for progressing the core
without pretending that unverified host behavior is known.

**END OF SPEC v0.5**
