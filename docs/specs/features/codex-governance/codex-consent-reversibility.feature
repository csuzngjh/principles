# Codex Governance Closure — Consent & reversibility (SPEC rev 2 §18, R1 §3)
# PRI-625 Slice D. Scenario ↔ §18 mapping (SPEC is the authority):
#   §18-17 → setup consent follows R1: the disclosure is presented, declining
#            leaves all governance intact, and declining causes no transcript read
#   §18-15 → reversibility (flag-off + consumer pause half, bound here; the
#            uninstall/legacy-migration half is bound by the installer suites —
#            uninstaller.test.ts + codex-host-installer.test.ts — which prove
#            uninstall removes PD registrations only and evidence is preserved)
Feature: Codex conversation-ingestion consent and reversibility
  As a PD Owner
  I want conversation observation to run only after an informed explicit yes, and to stop completely when I say no
  So my consent controls the machine, not the other way around

  Scenario: Setup presents the frozen disclosure before ingestion can be enabled (§18-17 / R1-1)
    Given an isolated Codex Workspace without a consent record
    When setup presents the ingestion disclosure
    Then the frozen Chinese text is shown verbatim with the version of the approved decision package

  Scenario: Accepting records consent before the flag moves (§18-17 / R1-1)
    Given an isolated Codex Workspace without a consent record
    When the Owner explicitly accepts after the disclosure
    Then the consent record exists with the granted decision and the ingestion flag is enabled
    And no config outside the workspace consent flow was modified

  Scenario: Declining leaves the flag off, governance intact, and no transcript read (§18-17 / R1-2, R1-3)
    Given an isolated Codex Workspace with the ingestion flag hand-enabled and no consent record
    When the Owner explicitly declines
    Then the consent record exists with the declined decision and the ingestion flag is off
    And no transcript was opened by the decline

  Scenario: Machine mode refuses to decide by itself (R1-4 guard)
    Given an isolated Codex Workspace without a consent record
    When setup runs in machine mode without an explicit accept or decline
    Then nothing is recorded and nothing is enabled

  Scenario: Reversibility — flag off stops ingestion and promoted evidence remains (§18-15)
    Given an isolated Codex Workspace with conversation ingestion enabled and evidence recorded
    When the ingestion flag is turned off
    Then catch-up reports feature_disabled with zero transcript reads
    And previously promoted evidence remains intact
