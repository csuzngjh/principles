---
name: pd-cli-operator
description: Use this skill when operating the Principles Disciple `pd` CLI: probing runtime health, manually recording pain, inspecting tasks/runs/candidates/artifacts, intaking candidates, viewing flow policy, or cleaning legacy state. It routes CLI commands safely and forbids direct `.state/.pain_flag` writes.
disable-model-invocation: false
---

# PD CLI Operator

Use the `pd` CLI as the supported operator surface. Do not modify PD state files by hand unless a command explicitly says to do so.

## Runtime V2 Pain Diagnosis

Manual pain diagnosis:
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

Success requires:
- `status` is `succeeded`
- `candidateIds` is non-empty
- `ledgerEntryIds` is non-empty

Forbidden:
- Do not write `.state/.pain_flag`.
- Do not use `write_file`, shell redirection, `Set-Content`, `Out-File`, or `node -e` to create pain flags.

## Health And Policy

Runtime probe:
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
```

Flow policy:
```bash
pd runtime flow show --workspace "<workspace>" --json
```

## Inspect Runtime V2 Objects

Tasks and runs:
```bash
pd task show --task-id "<taskId>" --json
pd run show --run-id "<runId>" --json
```

Candidates and artifacts:
```bash
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
pd artifact show --artifact-id "<artifactId>" --workspace "<workspace>" --json
```

Manual intake:
```bash
pd candidate intake --candidate-id "<candidateId>" --workspace "<workspace>" --json
```

## Legacy Admin

Only when explicitly cleaning old state:
```bash
pd legacy cleanup --workspace "<workspace>" --dry-run
pd legacy cleanup --workspace "<workspace>" --apply
```

Never use legacy cleanup as a diagnosis trigger.
