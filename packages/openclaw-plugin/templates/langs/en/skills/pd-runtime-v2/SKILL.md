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
- The bridge runs `SplitDiagnosticianRunner`, commits candidates, and intakes them into the ledger.

Manual:
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --session "<session-id>" --json
```
`--session` binds the report to a recorded session (validated up front) so
diagnosis carries real trajectory evidence; when the binding is verified but
the trajectory evidence is empty or unreadable, the record degrades honestly
to bound + evidence-unavailable and the admission gate decides; without
`--session` the record is a legal unbound Owner report with no evidence and
its candidates will likely be gated.

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

Trace pain-to-ledger chain (PRI-455 promoted):
```bash
pd trace show --pain-id "<painId>" --workspace "<workspace>" --json
```

Activation status (PRI-455 promoted):
```bash
pd activation list --workspace "<workspace>" --json
```

Candidates:
```bash
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
```

## Success Criteria

A pain travels through four stages: record receipt (`painId`) → diagnosis
(produces candidates) → admission (`admitted`, into the ledger) → Owner
approval and activation.

A diagnosis is successful only when:
- `status` is `succeeded`
- `candidateIds` is non-empty
- `admissionResults` contains `admitted` decisions with non-empty
  `ledgerEntryIds`

Task creation alone, candidate generation alone, or a ledger entry alone is
not success — candidates without an `admitted` decision were never admitted.
Activation is a separate stage that follows Owner approval; `pd pain record`
never activates anything by itself.

## If Manual Diagnosis Is Needed

1. Use `pd pain record`.
2. Inspect JSON output.
3. If `candidateIds` or `ledgerEntryIds` is empty, or candidates are gated as
   `needs_evidence` / `deferred`, treat it as not completed (not internalized).
4. Use `pd candidate list/show` and `pd runtime flow show` for follow-up.
