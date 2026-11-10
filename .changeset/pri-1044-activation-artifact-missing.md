---
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

fix(rulehost): surface ACTIVE activations whose `pi_artifacts` row is missing

Both the host-runtime production gate and the OpenClaw `RuleHost` load candidates with `JOIN pi_artifacts`, so an armed activation whose artifact row was deleted vanished from the candidate set and enforcement degraded to `no_rules_armed` with no warning, marker or log (PRI-1044: 8+ hours of silent non-enforcement). The two load paths now detect the dangling reference and emit a structured `activation_artifact_missing` warning with a nextAction plus the existing `~/.pd/enforcement-health/` degraded marker. Decisions are unchanged (still fail-open, the orphaned rule does not run) and healthy sibling rules keep enforcing.

RuleHost review follow-up: log suppression is keyed on the dangling descriptor set instead of a one-shot latch, so the marker keeps refreshing `occurrences`/`lastSeenAt` while the gap persists and a later recurrence warns again.
