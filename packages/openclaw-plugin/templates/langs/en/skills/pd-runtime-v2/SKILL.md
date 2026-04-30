---
name: pd-runtime-v2
description: Use this skill when manually triggering, verifying, or debugging Principles Disciple Runtime V2 pain diagnosis. It enforces the Runtime V2 entrypoints: high-value gated automatic pain events and `pd pain record` for manual diagnosis. It forbids writing `.state/.pain_flag` directly.
disable-model-invocation: false
---

# PD Runtime V2 Pain Diagnosis

Use Runtime V2 for all pain diagnosis work. Do not use legacy pain flag files as an entrypoint.

## Entry Points

Automatic:
- Tool failures first accumulate GFI/friction.
- Only high-value episodes enter Runtime V2: high GFI, repeated same failure, severe semantic pain, LLM paralysis, or explicit manual pain.
- Approved `pain_detected` events enter `PainSignalBridge`.
- The bridge runs `DiagnosticianRunner`, commits candidates, and intakes them into the ledger.

Manual:
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

Forbidden:
- Do not write `.state/.pain_flag`.
- Do not use `write_file`, shell redirection, `Set-Content`, `Out-File`, `node -e`, or any other file-writing method to create `.state/.pain_flag`.
- Do not use a `write_pain_flag` tool. Runtime V2 does not use that tool.

## Status Commands

Runtime health:
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
```

Flow policy:
```bash
pd runtime flow show --workspace "<workspace>" --json
```

Candidates:
```bash
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
```

## Success Criteria

A diagnosis is successful only when:
- `status` is `succeeded`
- `candidateIds` is non-empty
- `ledgerEntryIds` is non-empty

Task creation alone is not success. A run without candidates or ledger entries is failed/retried/incomplete.

## If Manual Diagnosis Is Needed

1. Use `pd pain record`.
2. Inspect JSON output.
3. If `candidateIds` or `ledgerEntryIds` is empty, treat it as not completed.
4. Use `pd candidate list/show` and `pd runtime flow show` for follow-up.
