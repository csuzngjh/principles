---
name: pd-cli-operator
description: Use this skill when operating the Principles Disciple `pd` CLI: probing runtime health, manually recording pain, inspecting tasks/runs/candidates/artifacts, intaking candidates, viewing flow policy, or tracing pain-to-ledger chains. It routes CLI commands safely and forbids direct `.state/.pain_flag` writes.
disable-model-invocation: false
---

# PD CLI Operator

Use the `pd` CLI as the supported operator surface. Do not modify PD state files by hand unless a command explicitly says to do so.

## Runtime V2 Pain Diagnosis

Manual pain diagnosis (bind a recorded session so diagnosis carries real
trajectory evidence):
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --session "<session-id>" --json
```

- Without `--session` the record is an honest unbound Owner report: no
  trajectory evidence, candidates likely gated (`needs_evidence`) by the
  admission threshold — the CLI output warns about this.
- `--session <id>` is validated up front; a missing session fails with
  `session_not_found` before anything is written.

Success requires:
- `status` is `succeeded`
- candidates are ADMITTED, not merely generated: check `admissionResults` /
  `candidateOutcomes` for `admitted` decisions and non-empty `ledgerEntryIds`

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

## Trace Pain-To-Ledger Chain (PRI-455 promoted)

Trace the full evidence chain from pain signal to principle ledger:
```bash
pd trace show --pain-id "<painId>" --workspace "<workspace>" --json
```

## Activation Management (PRI-455 promoted)

List active activations:
```bash
pd activation list --workspace "<workspace>" --json
```

Deactivate (rollback) an activation:
```bash
pd activation deactivate --activation-id "<activationId>" --workspace "<workspace>" --json
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
