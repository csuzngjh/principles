Feature: WorkBuddy owner governance loop
  As a PD Owner governing AI behavior in WorkBuddy
  I want to approve, observe, and withdraw principles through the product surfaces
  So my corrections persist across projects and remain reversible

  Background:
    Given an isolated WorkBuddy governance workspace with host.workbuddy enabled
    And a synthetic test principle created through the existing product entry

  Scenario: Owner approves and the next turn carries the principle
    When the Owner approves the pending principle through the existing approval flow
    And WorkBuddy submits the next prompt
    Then the approved principle directive is part of that turn's injection

  Scenario: A forbidden operation produces no side effect
    When WorkBuddy attempts a forbidden write to a protected path
    Then the tool is denied before execution
    And the protected target file is unchanged

  Scenario: Owner withdrawal stops future governance
    When the Owner withdraws the activated principle
    And WorkBuddy submits a new prompt in a new session
    Then the withdrawn principle is no longer injected
    And its rule no longer denies matching tools

  Scenario: Real tool failure becomes background governance work
    When WorkBuddy reports a real tool failure through the hook
    Then the failure is admitted as evidence in the governance workspace
    And the background worker advances it toward a reviewable proposal
    And the Owner sees the pending work on the existing approval surfaces

  Scenario: Governance workspace is shared across projects and explicit
    When two different WorkBuddy projects run hooks against the same governance workspace
    Then both read the same approved activation state
    And neither project directory receives governance state files
    And an uninitialized governance workspace reports the setup action instead of silently creating state
