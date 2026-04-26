---
phase: m6-02
plan: "01"
subsystem: runtime-v2/adapter
tags: [runtime-v2, adapter, openclaw-cli, OCRA-01, OCRA-02, OCRA-03, OCRA-04]
requires: [OCRA-01, OCRA-02, OCRA-03, OCRA-04]
provides: [OpenClawCliRuntimeAdapter]
affects: [m6-03, m6-04]
tech_stack:
  added: [TypeBox Value.Check, crypto.randomUUID]
  patterns: [one-shot async run, 5-category error mapping, JSON extraction fallback]
key_files:
  created:
    - packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts
  modified: []
key_decisions:
  - "One-shot async: startRun() blocks until CLI exits, stores CliOutput in Map<runId, RunState>"
  - "CLI args: 'agent', '--agent', '<id>', '--message', '<json>', '--json', '--local', '--timeout', '<seconds>'"
  - "Error mapping order: ENOENT→runtime_unavailable, timedOut→timeout, non-zero→execution_failed, JSON parse fail→output_invalid, schema mismatch→output_invalid"
  - "JSON extraction: direct parse first, then balanced {...} fragment regex fallback"
requirements_completed: [OCRA-01, OCRA-02, OCRA-03, OCRA-04]
duration: ~
completed: "2026-04-24"
---

# Phase m6-02 Plan 01: OpenClawCliRuntimeAdapter Implementation

**Substantive:** `OpenClawCliRuntimeAdapter` implementing PDRuntimeAdapter with one-shot openclaw agent run, JSON output parsing, and 5-category error mapping.

## What Was Built

`packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — 227 lines implementing:
- `kind()` → `'openclaw-cli'`
- `startRun()` — spawns `openclaw agent` with correct CLI args, blocks until exit
- `fetchOutput()` — parses stdout as JSON, validates against `DiagnosticianOutputV1Schema`
- `pollRun()` — returns status based on stored `CliOutput`
- `cancelRun()`, `getCapabilities()`, `healthCheck()`, `fetchArtifacts()` — required interface methods
- 5-category error mapping via `PDRuntimeError`

## OCRA Coverage

| Requirement | Implementation |
|-------------|----------------|
| OCRA-01: kind() | `return 'openclaw-cli'` |
| OCRA-02: startRun args | `['agent', '--agent', id, '--message', json, '--json', '--local', '--timeout', secs]` |
| OCRA-03: fetchOutput parsing | `JSON.parse()` + balanced-fragment regex fallback → `Value.Check(DiagnosticianOutputV1Schema, parsed)` |
| OCRA-04: error mapping | ENOENT→runtime_unavailable, timedOut→timeout, non-zero→execution_failed, parse fail→output_invalid, schema mismatch→output_invalid |

## Verification

- `grep "kind.*openclaw-cli" openclaw-cli-runtime-adapter.ts` — OCRA-01 ✓
- `grep "runCliProcess" openclaw-cli-runtime-adapter.ts` — OCRA-02 ✓
- `grep "Value.Check(DiagnosticianOutputV1Schema" openclaw-cli-runtime-adapter.ts` — OCRA-03 ✓
- `grep "runtime_unavailable\|timeout\|execution_failed\|output_invalid" openclaw-cli-runtime-adapter.ts` — OCRA-04 (all 5) ✓
- `npx tsc --noEmit` — clean ✓

## Next

Ready for m6-02-02 (unit tests) — depends on this implementation.
