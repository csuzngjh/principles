---
name: pd-pain-signal
description: Manually trigger a Principles Disciple Runtime V2 pain diagnosis. Use this when the user reports the agent is stuck, looping, unresponsive, or asks to record/trigger a pain signal. Mandatory path: use `pd pain record`; never write `.state/.pain_flag` and never use legacy write_pain_flag tooling.
disable-model-invocation: false
---

# Pain Signal (Runtime V2)

Manual pain diagnosis must enter Runtime V2 through the CLI:

```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

## Forbidden

- Do not write `.state/.pain_flag` directly.
- Do not use `write_file`, shell redirection, `Set-Content`, `Out-File`, `node -e`, or any other file-writing method to create `.state/.pain_flag`.
- Do not use `write_pain_flag`. That was a legacy path.

## Verify

Use:
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
pd candidate list --workspace "<workspace>" --json
pd runtime flow show --workspace "<workspace>" --json
```

Success requires non-empty `candidateIds` and `ledgerEntryIds`.
