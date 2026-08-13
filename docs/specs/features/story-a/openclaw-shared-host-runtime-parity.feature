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

  Scenario: A live RuleHost rule denies a protected write
    Given an approved live RuleHost rule is active
    When OpenClaw checks a write to a protected system path
    Then the tool call is denied with the rule reason

  Scenario: An owner pain signal is persisted as evidence
    When OpenClaw reports an owner pain signal after a tool call
    Then a pain evidence row is persisted in the workspace trajectory
