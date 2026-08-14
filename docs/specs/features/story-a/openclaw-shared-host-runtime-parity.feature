@mvp-core @pri-523
Feature: OpenClaw shared host runtime preserves MVP behavior
  The quiet abstraction layer may be enabled without changing the Owner-visible
  prompt, enforcement, or evidence behavior of the three approved MVP paths.

  Background:
    Given an isolated OpenClaw workspace with abstraction_layer_v1 enabled
    And the OpenClaw plugin is registered through its production entry point

  Scenario: An activated principle is injected into the prompt
    Given an approved prompt principle is active
    When OpenClaw builds the next prompt
    Then the returned system context contains that activated principle

  Scenario: A masked legacy overlap remains available through Runtime V2
    Given an overlapping prompt principle is masked from legacy injection
    When OpenClaw builds the next prompt
    Then the Runtime V2 directive contains that masked overlap exactly once

  Scenario: A legacy-budget overlap remains available through Runtime V2
    Given an overlapping prompt principle is omitted by the legacy prompt budget
    When OpenClaw builds the next prompt
    Then the Runtime V2 directive contains that budget-omitted overlap exactly once

  Scenario: A live RuleHost rule denies a protected write
    Given an approved live RuleHost rule is active
    When OpenClaw checks a write to a protected system path
    Then the tool call is denied with the rule reason

  Scenario: A live RuleHost rule allows the safe control write
    Given an approved live RuleHost rule is active
    When OpenClaw checks a write to a safe project path
    Then the tool call is allowed by the evaluated live rule

  Scenario: An owner pain signal is persisted as evidence
    When OpenClaw reports an owner pain signal after a tool call
    Then a pain evidence row is persisted in the workspace trajectory

  Scenario: An ordinary failed write is admitted through the shared pain kernel
    When OpenClaw reports a failed write to a risky path
    Then one lineaged automatic pain and its tool evidence are persisted
