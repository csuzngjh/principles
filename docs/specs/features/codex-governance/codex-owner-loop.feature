# Codex Governance Closure — Owner loop (SPEC rev 2 §18)
# PRI-625 Slice D. Scenario ↔ §18 mapping (SPEC is the authority):
#   §18-1  → existing Principle injection and RuleHost denial remain unchanged
#   §18-3  → live user/tool plus transcript replay enriches rather than duplicates
#   §18-4  → two forks sharing a root session remain separate and correctly linked
#   §18-8  → truncated TURN_COMPLETE capture exposes lag the worker catches up
#   §18-9  → privacy negatives: hidden/system content and raw paths absent from
#            DB, logs, stdout, and telemetry
#   §18-10 → malformed / incomplete tail / conflict / quarantine / restart behavior
#   §18-11 → unpromoted content ages out; promoted evidence and decisions remain
#   §18-12 → worker/provider recovery advances one task without duplicate candidates
#   §18-16 → OpenClaw and Codex share a Workspace without evidence contamination
# (§18-2/5/6/7 are bound in codex-signal-admission.feature; §18-13/§18-14 —
#  diagnosis → candidate and Owner approval → later activation — are proven by
#  the installed real Codex E2E owner journey, which runs the live LLM loop.)
Feature: Codex governance owner loop — bounded observation, durable recovery, shared workspace
  As a PD Owner using Codex and OpenClaw in the same workspace
  I want the governance loop to stay quiet, durable, and recoverable under real session conditions
  So my corrections are learned once and my existing protections never change

  Scenario: Existing Principle injection and RuleHost denial remain unchanged (§18-1)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When Codex submits an ordinary prompt through the production hook
    Then the hook answers in the exact Codex schema without governance side effects
    And the existing tool evidence store is untouched by ingestion

  Scenario: Live user and tool delivery plus transcript replay enrich rather than duplicate (§18-3)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When a live tool failure is delivered and the same session is replayed from the transcript
    Then the user turn exists once with transcript enrichment and the tool call exists once

  Scenario: Two forks sharing a root session remain separate and correctly linked (§18-4)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When two rollout forks of the same root session are replayed
    Then each fork keeps its own observations and both link to the shared root session

  Scenario: A truncated turn-complete capture exposes lag that catch-up resolves (§18-8)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When the transcript grows past the committed checkpoint between stop events
    Then the checkpoint exposes lag and one bounded catch-up pass clears it

  Scenario: Privacy negatives — hidden context and raw paths never persist or leak (§18-9)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When the full session transcript is ingested through the production hook
    Then no host-injected context, hidden reasoning marker, or transcript file path exists in any governance store
    And the hook stdout carries no conversation content

  Scenario: A permanently invalid record is quarantined with an audit trail and survives restart (§18-10)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When a transcript record is stable-invalid and the audited quarantine runs with confirm
    Then the record is terminal with digest, reason, operator, timestamp, and gap recorded
    And a fresh process still reports the record quarantined and never touched the transcript

  Scenario: Unpromoted content ages out while promoted evidence and Owner decisions remain (§18-11)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When operational observations pass their retention window and one pain was promoted
    Then the aged unpromoted rows are expired and the promoted evidence row remains

  Scenario: Recovery advances one admitted pain without duplicate tasks (§18-12)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When recovery reconciliation runs twice over one admitted correction
    Then exactly one Diagnostician task exists and the admission marker links to it once

  Scenario: OpenClaw and Codex share a Workspace without evidence contamination (§18-16)
    Given an isolated Codex Workspace with conversation ingestion enabled
    When an OpenClaw-origin pain and a Codex-origin correction coexist
    Then each record carries its own evidence host and neither rewrites the other
