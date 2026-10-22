---
name: pd-cli-operator
description: Use for read-only PD health checks, querying pains/tasks/runs/candidates/artifacts, tracing pain-to-principle evidence, or diagnosing PD CLI and Runtime issues. Do not use for pain registration, Owner governance review, or host setup/control.
disable-model-invocation: false
---

# PD CLI Operator

Use the existing PD CLI to inspect facts and locate pipeline breaks. This skill routes operations; it does not implement a second business logic path.

## Workflow

1. **Resolve the workspace.** Use the authoritative workspace supplied by the current OpenClaw host/plugin context. When a command requires `--workspace`, pass the confirmed absolute path. If the workspace is unknown, report the blocker instead of guessing from the current directory or another host.
2. **Discover actual commands.** Start with `pd --help`, then inspect the target command's `--help`. The installed CLI is authoritative.
3. **Prefer read-only inspection.** Choose the smallest set of queries that answers the question; do not scan unrelated workspaces.
4. **Trace each stage.** Verify pain registration, diagnostic task, run result, candidate, admission, and Owner governance separately. Never infer that the whole chain completed from one status field.
5. **Report evidence.** Separate confirmed facts, unknowns, the blocked stage, and next steps. Distinguish command success from business success.

## Common read-only commands

Confirm that the installed CLI supports a command before running it:

- Health: `pd health --workspace "<workspace>" --json`
- Runtime probe: `pd runtime probe --runtime pi-ai --workspace "<workspace>" --json`
- Flow policy: `pd runtime flow show --workspace "<workspace>" --json`
- Pain list and admission evidence: `pd pain list --workspace "<workspace>" --json`, `pd pain evidence --workspace "<workspace>" --json`
- Pain-to-principle trace: `pd runtime trace show --pain-id "<painId>" --workspace "<workspace>" --json`
- Task and run: `pd task show "<taskId>" --workspace "<workspace>" --json`, `pd run show "<runId>"`
- Candidates and artifacts: `pd candidate list --task-id "<taskId>" --workspace "<workspace>" --json`, `pd candidate show "<candidateId>" --workspace "<workspace>" --json`, `pd artifact show "<artifactId>" --workspace "<workspace>" --json`

OpenClaw's `/pd-status` primarily reports host status such as GFI/Pain dictionary; it is not a substitute for Runtime health or tracing a specific task.

## Interpret results correctly

- A `painId` proves only that pain registration returned a receipt.
- Task creation does not prove diagnosis completed.
- Candidate generation does not prove admission; inspect the actual admission decision and corresponding ledger evidence.
- Admission does not prove Owner approval or activation; opening the Console does not prove a governance decision was made.

## Writes and failures

This skill is read-only by default. Before any retry, recovery, repair, or other side effect, confirm user intent, command help, eligibility, and impact. Use dry-run first when supported and read back the resulting state afterward. Do not blindly retry commands that may have side effects.

When the CLI is unavailable, preserve the actual error and distinguish missing installation, uninitialized workspace, insufficient permissions, and Runtime failure. Route host installation, initialization, disablement, or recovery to `pd-control`.

## Never

- Edit the database, ledger, configuration, or internal artifacts directly.
- Write `.state/.pain_flag` or call legacy `write_pain_flag`.
- Fabricate runtime evidence or present a hypothesis as a confirmed root cause.
- Approve, reject, or activate a principle through CLI, scripts, or another skill.
- Treat exit code 0 as automatic proof of business success.
