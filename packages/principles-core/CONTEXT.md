# Principles Core

Defines the product language for owner-governed behavior internalization and its reversible activation lifecycle.

## Language

**RuleCode**:
An executable implementation of an Owner-approved Principle that can observe or govern host tool calls through RuleHost.
_Avoid_: Rule, hook script, generated code

**Shadow Observation**:
A non-enforcing activation phase in which RuleCode decisions and their likely effects are recorded for Owner review without blocking host tool calls.
_Avoid_: Activated, live, enabled

**Owner Live Decision**:
The Owner's explicit, per-RuleCode decision to permit a shadow-observed RuleCode to begin enforcing decisions. It is independent from the earlier approval that admitted the RuleCode into Shadow Observation.
_Avoid_: Automatic promotion, implicit approval, first approval

**Live Enforcement**:
The reversible activation phase in which an Owner-approved RuleCode may affect host tool calls within its declared scope.
_Avoid_: Activated, promoted

**Deactivation**:
A reversible governance action that prevents an activation from observing or enforcing while preserving its history and evidence.
_Avoid_: Delete, remove, erase

**Promotion Safety Gate**:
The non-bypassable safety checks a RuleCode activation must pass before the Owner may authorize Live Enforcement. Evidence sufficiency may inform the Owner, but runtime compatibility and host-liveness failures are never overridable.
_Avoid_: Recommendation, confidence score

**Promotion Evidence Snapshot**:
The immutable RuleCode version, safety results, Shadow Observation evidence, and lineage reviewed as part of an Owner Live Decision.
_Avoid_: Current metrics, latest evidence

**Rejected After Shadow**:
A preserved, deactivated RuleCode activation that the Owner declined after reviewing Shadow Observation evidence.
_Avoid_: Deleted rule, failed activation

**Emergency Deactivation**:
An Owner control-plane action that stops Live Enforcement without depending on the governed host tool path.
_Avoid_: RuleHost tool call, rollback by agent

**Host Liveness Contract**:
The host-defined minimum diagnostic, governance, and recovery capabilities that RuleCode must never collectively make unavailable.
_Avoid_: Rule allowlist, generated recovery policy

**RuleCode Scope**:
The explicit, bounded set of host tools and actions a RuleCode is permitted to evaluate. Generated RuleCode cannot claim an implicit or wildcard global blocking scope.
_Avoid_: All tools, default scope

**Safety Isolation**:
The fail-open containment of a RuleCode that fails to load, times out, throws, returns an invalid decision, or is incompatible with its runtime context.
_Avoid_: Global deny, host failure

**Safety Circuit Breaker**:
An automatic suspension of Live Enforcement when a RuleCode threatens host liveness or exceeds its safety limits. Only a new Owner Live Decision can restore enforcement.
_Avoid_: Automatic rollback approval, automatic reactivation

**Eligible RuleHost Evaluation**:
A host tool call that reaches RuleHost with the context required for RuleCode evaluation. It is not a count of all host tool calls.
_Avoid_: Total tool calls, host activity

**Evidence Readiness**:
An advisory assessment of whether Shadow Observation gives the Owner enough representative information for an Owner Live Decision. Insufficient evidence may be overridden with a recorded reason; a failed Promotion Safety Gate may not.
_Avoid_: Safe, approved, promotion permission

**Safety Isolation State**:
The non-enforcing state entered after a Safety Circuit Breaker trips. It preserves evidence and requires a new Owner Live Decision before Live Enforcement can resume.
_Avoid_: Automatically recovered, temporarily live

**Global Emergency Pause**:
An immediate control-plane suspension of every Live Enforcement activation that does not require a host restart or pass through RuleHost.
_Avoid_: Feature flag reload, automatic bulk resume
