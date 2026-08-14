Feature: Codex desktop hook uses the shared owner-governed runtime
  As a PD Owner using Codex desktop or CLI
  I want approved behavior to use the same production runtime
  So prompt guidance, gate decisions, and pain evidence remain observable and reversible

  Scenario: Codex executable exercises all three MVP-Core behavior paths
    Given an isolated Codex Workspace with host.codex enabled and approved behavior
    When Codex submits a prompt through the production hook executable
    Then the approved prompt directive is returned in the exact Codex schema
    When Codex invokes a protected tool through the production hook executable
    Then the live owner-approved rule denies it with its exact reason
    When Codex reports a failed tool through the production hook executable
    Then one tool evidence row is persisted in that Codex Workspace
