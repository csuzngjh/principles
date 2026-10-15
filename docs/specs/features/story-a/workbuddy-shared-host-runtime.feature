Feature: WorkBuddy hook uses the shared owner-governed runtime
  As a PD Owner using WorkBuddy
  I want approved behavior to use the same production runtime as the other hosts
  So prompt guidance, gate decisions, and evidence remain observable and reversible

  Background:
    Given an isolated WorkBuddy governance workspace with host.workbuddy enabled

  Scenario: WorkBuddy hook entry exercises the three MVP behavior paths
    When WorkBuddy submits a prompt through the production hook entry (UserPromptSubmit)
    Then approved principle directives are returned as additionalContext for that turn
    When WorkBuddy invokes a protected tool through the production hook entry (PreToolUse)
    Then the live owner-approved rule denies it with a non-empty reason
    And the deny is encoded without ever emitting permissionDecision allow
    When WorkBuddy reports a failed tool through the production hook entry (PostToolUse)
    Then one failure evidence row is persisted in the governance workspace under the workbuddy source kind

  Scenario: The WorkBuddy host attribution is never lost or misattributed
    When any WorkBuddy event flows to evidence, pain, or injection records
    Then the recorded host attribution is workbuddy
    And no record falls back to openclaw or codex attribution

  Scenario: Flag-off keeps WorkBuddy neutral and observable
    Given host.workbuddy disabled in the governance workspace
    When any hook event arrives at the production entry
    Then the entry outputs no stdout payload and exits 0
    And an observable skip reason with a next action is recorded

  Scenario: Failures never invert a computed deny
    When the rule gate has computed deny for a protected tool
    And the evidence write fails afterwards
    Then the deny still reaches WorkBuddy
    And the evidence degradation is reported observably

  Scenario: User prompt is never destroyed by adapter failures
    When the production entry fails while handling UserPromptSubmit
    Then the entry emits a neutral result and exits 0
    And the user prompt still reaches the model
