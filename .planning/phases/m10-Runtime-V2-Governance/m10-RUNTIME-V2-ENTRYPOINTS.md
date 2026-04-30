# M10 Runtime V2 Governance Contract

This document locks the post-M9 operating contract so future development does not reintroduce parallel pain diagnosis paths.

## Supported Entry Points

1. Automatic: OpenClaw `after_tool_call` failure routes through `emitPainDetectedEvent()`.
2. Manual: operator runs `pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json`.

Both paths must converge on:

```text
PainSignalBridge -> DiagnosticianRunner -> RuntimeAdapter -> candidate -> intake -> ledger
```

## Forbidden Entry Point

Writing `.state/.pain_flag` is forbidden for Runtime V2 diagnosis.

`.pain_flag` is legacy compatibility only. It may be read to enrich old sleep-reflection context, but it must not:

- create a diagnosis task
- enqueue `pain_diagnosis`
- trigger heartbeat diagnostician flows
- be repaired or rewritten by Runtime V2 code

## Acceptance Criteria

A pain diagnosis is complete only when:

- command/result status is `succeeded`
- `candidateIds.length > 0`
- `ledgerEntryIds.length > 0`

Task creation, run creation, or artifact creation alone is not sufficient.

## Required Operator Commands

```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
pd runtime flow show --workspace "<workspace>" --json
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
```
