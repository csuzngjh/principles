Feature: Codex governance signal admission — one correction, one canonical pain, one task
  As a PD Owner using Codex
  I want real owner corrections and governed tool failures to enter the PD learning loop exactly once
  So the system learns from what actually matters without noise or duplicates

  Scenario: Ordinary conversation stays completely quiet
    Given an isolated Codex Workspace with conversation ingestion enabled
    When Codex submits an ordinary prompt through the production hook
    Then one governance observation exists and no pain or task was created
    And no correction rate-limit quota was consumed

  Scenario: A real owner correction creates exactly one canonical pain and one pending Diagnostician task
    Given an isolated Codex Workspace with conversation ingestion enabled
    When Codex submits a high-precision owner correction through the production hook
    Then exactly one canonical pain with a deterministic id exists
    And exactly one pending Diagnostician task linked to that pain exists
    And the bounded evidence promotion window was armed for the correction turn

  Scenario: Duplicate delivery of the same correction converges (live + replay + fresh process)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When Codex submits a high-precision owner correction through the production hook twice
    Then still exactly one canonical pain and one pending Diagnostician task exist

  Scenario: One real tool failure resolves to one pain whether delivered live or via transcript
    Given an isolated Codex Workspace with conversation ingestion enabled
    When Codex reports a failed write tool through the production hook
    And the Stop transcript replay of the same tool call is ingested
    Then exactly one tool pain and one pending Diagnostician task exist
