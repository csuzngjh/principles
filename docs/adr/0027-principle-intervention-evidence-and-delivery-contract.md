# ADR-0027: Principle Intervention Evidence and Delivery Contract

> **Status**: Proposed — Owner-authorized documentation integration; pending the existing ADR review process
> **Date**: 2026-10-07
> **Decider**: Owner
> **Decision basis**: Owner-provided R7 findings, PD v2 architecture freeze, and Phase 1 Evidence Foundation design. This records a target contract, not a new runtime acceptance result.
> **Supersedes**: ADR-0013's proposed attribution architecture and automatic governance consequences, upon acceptance. Its ADR-0014 deferral history remains preserved.
> **Related**: [ADR-0014](0014-mvp-first-strategy-and-product-pivot.md), [ADR-0020](0020-codex-cli-host-adapter.md), [ADR-0028](0028-owner-principle-assets-and-evolution.md)
> **Existing contracts**: [Core Value Pipeline Governance SPEC](../specs/PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md), [Principle Receipt design](../superpowers/specs/2026-08-principle-receipt-design.md), [Behavioral Learning acceptance](../specs/BEHAVIORAL_LEARNING_MVP_ACCEPTANCE_v3.md)

## 1. Context

R7's supplied facts establish the dual-host governance chain through Runtime Injection. They do not establish a complete, uniformly linked record of application, behavior and results. Codex has durable runtime receipts; OpenClaw has application/effect sources with collection and lineage gaps. Existing task completion observations retain their original meaning.

The missing contract is not another scoring pipeline. PD needs to distinguish what happened, what is inferred, and what the Owner decided. ADR-0013's historical proposal coupled attribution verdicts to automatic archive and probation mechanisms. That direction is replaced by reviewable evidence and Owner decisions; its scheduler, scores and automatic transitions are not reactivated.

## 2. Decision

### 2.1 Evidence is a first-class domain record

Effect Evidence records a bounded factual observation associated with a particular Principle content revision and Behavior Episode. It is not an effectiveness score or causal verdict.

The intervention relationship is:

```text
Activation -> Delivery -> Application
                              |
                       Behavior Episode
                              |
                        Effect Evidence
                              |
                      Outcome Observation
```

This is a relationship model, not a mandatory chronological sequence. Partial chains remain admissible when their missing links are explicit:

| Claim | Required evidence |
| --- | --- |
| Authorized intervention | Exact existing authorization and activation references |
| Delivered | Delivery record and confirmation source at the stated target boundary |
| Applied | Application record with its proof method |
| Behavior observed | Episode, Effect Evidence and observation source |
| Behavior changed | Comparable observations; one aligned action alone is insufficient |
| Positive or negative value | Outcome Observation and an Owner-defined criterion, interpreted by Evaluation |

Missing links never become successful links. An observation associated with a revision does not itself establish that the revision caused it.

### 2.2 Identity, lineage and lifecycle

Every evidence record has an immutable identity, a stable source event key, occurrence time when supplied, recording time, and a source reference. References preserve the selected governance workspace, host/runtime instance, available native session/run/tool identities, exact Principle identity, content reference and known activation/application relationships.

Entity identity comes from the existing ledger. Titles, text and digests cannot mint a Principle identity. A content digest identifies observed bytes; it does not grant approval or create a formal Principle Revision. Existing repair-process `RevisionIdentity` is not silently reinterpreted as a Principle content version.

An activation reference must preserve its occurrence and observed source snapshot. A reusable activation ID or a mutable current row cannot silently replace the historical activation associated with evidence.

Repeated ingestion of the same source key and content is idempotent. A conflicting payload under the same key is reported, not overwritten. Out-of-order records can remain pending association; association requires exact source references, not title similarity or timestamp proximity.

Effect Evidence uses `observed`, `disputed`, and `invalidated`. Corrections preserve the original source and reason. `observed` means the source contract was accepted, not that a Principle works. Source expiry means no longer independently reviewable; it does not mean the observation was disproved.

### 2.3 Writer authority

| Record | Authorized source | Meaning |
| --- | --- | --- |
| Delivery | Trusted host adapter | An actual attempt and supported confirmation |
| Application: agent claimed | Actual Agent output captured through an authorized observation path | The Agent made a claim |
| Application: runtime verified | Trusted runtime execution event | A particular governance action actually executed |
| Episode / Effect | Authorized runtime observation or explicit Owner observation | A bounded observed action |
| Outcome | Authorized result observation or explicit Owner feedback | A result was observed or feedback was given |
| Evaluation, later stage | Evidence-based evaluator | A revisable interpretation without decision authority |

A validating evidence ingress writes canonical normalized records. Raw host sources keep their provenance; normalization does not create another independent writer of the raw fact. LLMs may propose associations and interpretations, but cannot impersonate Runtime/Owner sources, validate their own application claims, or create governance decisions.

An Owner report proves that the Owner supplied that report; its provenance must not be confused with an independently measured environment result.

### 2.4 Host capability and delivery semantics

Approval permits use of a particular content version within an authorized scope. Activation enables a particular binding/configuration and establishes its stated contract. Delivery records an actual event. Approved is not delivered; delivered is not applied; applied is not effective.

Each host capability is `Supported`, `Unsupported`, or `Unknown`, with adapter version, channel, proof reference and maximum confirmation strength. Current health is separate: healthy, degraded or disabled. OpenClaw and Codex need not have equal capabilities.

Confirmation distinguishes prepared payload, submitted payload, host acceptance, context presence and runtime loading. Prepared/submitted is not confirmed delivery. `runtime_loaded` proves an enforcement runtime received the exact rule; it does not prove the Agent read or understood it. Agent self-report never independently proves receipt.

Phase 1 implements only Attempt/Result recording: `attempted`, `delivered`, `failed`, `unsupported`. An attempt without confirmation remains delivery-unknown. Explicit failure and unsupported capability are not interchangeable. Budget exclusion is recorded as a known non-attempt reason when available, not invented as a runtime failure.

The target architecture additionally defines Normal/Priority/Critical commitments. Priority requires an explicit eligible-opportunity/deadline bound; Critical requires a supported decision boundary, feasible resource budget and an Owner-authorized failure action. Unsupported commitments are refused, not silently downgraded. These scheduling and admission mechanisms are future scope, not Phase 1 implementation authority.

| Target level | Commitment | Failure/audit behavior |
| --- | --- | --- |
| Normal | Select within the existing budget when applicable; no deadline guarantee | Preserve available non-delivery reasons |
| Priority | Deliver within the Owner-defined eligible-opportunity or deadline bound | Exceeding the bound creates a governance exception with reason and next action |
| Critical | Satisfy the proven condition at the specified decision point | Explicit failure; block only an Owner-authorized operation the host can actually intercept |

Prompt delivery cannot guarantee application or behavior change. A hook can establish scoped execution or blocking, but cannot establish learned habits. Evidence write failure must not change an already computed tool decision.

### 2.5 Outcome and learning boundary

Behavior Episode is the bounded observation unit. A Task can contain several Episodes; an Episode may have no Task; results can relate to several Episodes. `task_outcomes` remains task completion observation.

Outcome Observation stores results separately from Evaluation. Later Evaluation reports behavior alignment, Owner-defined value and attribution uncertainty separately. It records comparable contexts, environment/model changes, other Principles and Owner interventions. Shared observations are not multiple independent samples; inseparable contributions are reported as combined effects.

Counter evidence distinguishes ineffective behavior in an applicable, exposed episode, harmful results, misuse, and non-applicability. Missing delivery, disabled collection and absent outcomes mean uncertainty, not an ineffective Principle. LLM interpretations remain recommendations; acceptance, revision, scope expansion and retirement remain Owner decisions.

## 3. Alternatives Considered

- A boolean or score on Application: hides provenance, uncertainty and counter evidence.
- Self-report as verified application: turns model claims into facts.
- Mandatory complete chains: encourages fabricated links or loss of useful partial observations.
- Reopen ADR-0013 unchanged: introduces deferred infrastructure and autonomous governance outside the frozen scope.
- A second receipt platform: duplicates existing host sources and mutation responsibility.

## 4. Consequences

PD can explain the exact strength of an intervention claim. Honest Unknown states are expected. Collection needs source identity and explicit coverage; an empty query alone cannot prove that nothing occurred.

The model remains local-first. Workspace evidence stays under its current local authority. Shared learning cannot bypass source consent, retention or privacy. This contract prevents LLM claims from being promoted into facts; it is not tamper-proof against an OS principal able to rewrite local files.

## 5. Migration Impact and implementation boundary

Phase 1 reuses existing Principle identity, approvals, activation state, receipts and authorized observation paths. It adds minimal evidence identity/association, Episodes, Effect Evidence, Outcome Observations, host capability declarations and audit queries. Existing fields retain their meanings, including legacy `principle_applications.level=effect` and `task_outcomes`.

Historical imports preserve their proof level. Unresolvable content/activation references remain explicit gaps. No automatic Principle Revision, Owner Asset Migration, causal engine, scores, ranking, merge/split, new daemon or cloud dependency is authorized.

ADR-0014 remains the scope gate. Acceptance of the target contract does not authorize every later-stage mechanism. Phase 1 SPEC alignment continues in the existing Principle Receipt design; the broader learning acceptance specification remains a stronger, separate acceptance contract.

## 6. Review and verification

This ADR requires the existing ADR review process. Documentation approval is not runtime acceptance. Engineering must demonstrate a real host journey with exact content/activation, confirmed runtime-boundary delivery, an execution fact, an Episode, Effect and Outcome, plus honest partial/failure paths and idempotent replay. That proves an observable intervention chain, not statistical attribution or model internalization.
