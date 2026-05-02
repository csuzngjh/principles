# M9 Runtime V2 Pain Entry Points

Runtime V2 has exactly two supported pain diagnosis entry points.

## 1. Automatic

`after_tool_call` failure emits `pain_detected`.

Flow:

```text
after_tool_call failure
  -> emitPainDetectedEvent()
  -> PainSignalBridge.onPainDetected()
  -> DiagnosticianRunner
  -> PiAiRuntimeAdapter
  -> artifact/candidate
  -> CandidateIntakeService
  -> ledger probation entry
```

## 2. Manual

Use `pd pain record`:

```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

The command is successful only when `candidateIds` and `ledgerEntryIds` are both non-empty.

## 3. Forbidden

Do not write `.state/.pain_flag`.

Forbidden examples:

```bash
echo "..." > .state/.pain_flag
Set-Content .state/.pain_flag "..."
node -e "...write pain flag..."
```

`.pain_flag` is legacy compatibility state. It may be read for old sleep-reflection context, but it is not a Runtime V2 diagnosis entry and must not trigger the diagnostician.

## Verification

```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
pd runtime flow show --workspace "<workspace>" --json
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
```
