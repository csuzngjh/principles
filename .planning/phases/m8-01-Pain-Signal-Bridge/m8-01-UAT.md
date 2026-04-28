---
status: testing
phase: m8-01
source:
  - .planning/phases/m8-01-Pain-Signal-Bridge/m8-01-01-SUMMARY.md
  - .planning/phases/m8-01-Pain-Signal-Bridge/m8-01-02-SUMMARY.md
  - .planning/phases/m8-01-Pain-Signal-Bridge/m8-01-03-SUMMARY.md
  - .planning/phases/m8-01-Pain-Signal-Bridge/m8-01-04-SUMMARY.md
  - .planning/phases/m8-01-Pain-Signal-Bridge/m8-01-05-SUMMARY.md
started: 2026-04-28T08:35:00Z
updated: 2026-04-28T08:35:00Z
---

## Current Test

number: 1
name: Cold Start Smoke Test
expected: |
  Build completes without errors. All three packages (principles-core, openclaw-plugin, pd-cli) compile cleanly via `npm run verify:merge`.
awaiting: user response

## Tests

### 1. Cold Start Smoke Test
expected: Build completes without errors. All three packages (principles-core, openclaw-plugin, pd-cli) compile cleanly via `npm run verify:merge`.
result: pass

### 2. Legacy Diagnostician Path Removed
expected: |
  In a live session, triggering a tool failure that produces a pain signal should NOT create a `diagnostician_tasks.json` file in `.state/`. The pain signal should instead route through the new PainSignalBridge → DiagnosticianRunner pipeline.
result: pending

### 3. PainSignalBridge Initialization
expected: |
  When a pain_detected event fires (e.g., from a tool failure), PainSignalBridge is created lazily per workspace and calls DiagnosticianRunner.run() without errors. Bridge errors are caught and logged, not propagated.
result: pending

### 4. Runtime Summary Shows Diagnostician Tasks
expected: |
  Running `/pd-status` or equivalent shows `runtimeDiagnosis` count from task-store.db SQLite (diagnostician tasks with pending status), not from legacy diagnostician_tasks.json. Count should be 0 in an idle workspace.
result: pending

### 5. Full Chain (pain → ledger entry) — Manual
expected: |
  In a real workspace with openclaw-cli available: inject a pain signal (tool failure), wait for diagnostician to run, verify candidate was created in run-store.db, verify ledger probation entry in .principles/ledger/principles.jsonl.
result: pending

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0

## Gaps

[none yet]
