@mvp-core
Feature: Owner-governed RuleCode live decision preserves host liveness
  As a PD Owner
  I want evidence-bound review and immediate containment
  So a generated rule cannot silently make my host unusable

  Scenario: First approval creates shadow and cannot create live
    Then the activation remains shadow_observing
  Scenario: Ready shadow rule is visible for review
    Then Focus shows it in 待上线规则 with its safety evidence
  Scenario: Insufficient evidence needs an Owner reason
    Then promotion remains advisory-overridable with a recorded note
  Scenario: Hard safety failure cannot be overridden
    Then Console and CLI refuse promotion with the same failed checks
  Scenario: Comment-only retired symbol is harmless
    Then the host call continues and the rule evaluator still runs
  Scenario: Executable incompatible reference is isolated
    Then the host call continues fail-open
  Scenario: Unbounded rules never enter live
    Then wildcard empty-scope and global-deny artifacts fail a hard gate
  Scenario: Every production safety fact is required
    Then trace lineage capability neutral-probe and composition gaps block promotion
  Scenario: Promotion writes a distinct immutable Owner decision
    Then the decision binds artifact digest evaluation and evidence snapshot
  Scenario: Reject after shadow preserves evidence
    Then the shadow activation is deactivated without deleting history
  Scenario: Continue observing preserves shadow mode
    Then the Owner review intent is recorded without enforcement
  Scenario: New version replacement is atomic
    Then at most one RuleCode version for the Principle is live
  Scenario: Emergency controls do not depend on RuleHost
    Then per-rule deactivation and global pause take effect without restart
  Scenario: Circuit breaker isolates one bad rule
    Then it fails open and never automatically reactivates
  Scenario: Runtime without shadow telemetry cannot promote
    Then missing telemetry is shown as unavailable rather than zero
  Scenario: Legacy unknown actor remains honest
    Then unknown identity is not fabricated and known liveness failure isolates
  Scenario: Console and CLI share one promotion authority
    Then no route can bypass the Promotion Safety Gate
