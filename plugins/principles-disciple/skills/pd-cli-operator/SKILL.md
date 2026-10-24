---
name: pd-cli-operator
description: Inspect whether PD is installed and active in Codex, query Runtime and evidence-chain state, or diagnose why principles are not being applied. Use for read-only status and CLI operations, not pain registration, Owner review, or setup/control.
---

# PD CLI Operator

## 1. Verify the Codex integration first

Run the bundled status script for the installed plugin version through the shipped locator (`scripts/pd-locate.cjs`); let the plugin resolve its authoritative workspace.

Bash / zsh:

    node "$(ls -1d "${CODEX_HOME:-$HOME/.codex}/plugins/cache/"*/principles-disciple/*/scripts/pd-locate.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)" --exec scripts/pd-status.cjs -- --json

PowerShell:

    $pdCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
    node (Get-ChildItem "$pdCodexHome\plugins\cache\*\principles-disciple\*\scripts\pd-locate.cjs" | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1).FullName --exec scripts/pd-status.cjs -- --json

This checks plugin/runtime installation, pinned runtime version, `host.codex`, Hook trust, and workspace resolution. The shipped locator resolves the plugin root once (newest installed version), reports marketplace ambiguity instead of guessing, and refuses to fall back to an older version when the newest install does not ship the target script. If the script cannot be found, report an installation problem; do not choose an arbitrary stale cache path.

## 2. Query only the state needed

When the status result points to a Runtime or business-pipeline issue, use the installed `pd` CLI and check its actual help first:

- `pd health --host codex --workspace "<workspace>" --json`
- `pd runtime probe --runtime pi-ai --workspace "<workspace>" --json`
- `pd runtime flow show --workspace "<workspace>" --json`
- `pd pain list --workspace "<workspace>" --json`
- `pd pain evidence --workspace "<workspace>" --json`
- `pd runtime trace show --pain-id "<painId>" --workspace "<workspace>" --json`
- `pd task show "<taskId>" --workspace "<workspace>" --json`
- `pd run show "<runId>" --workspace "<workspace>"`
- `pd candidate list --task-id "<taskId>" --workspace "<workspace>" --json`
- `pd candidate show "<candidateId>" --workspace "<workspace>" --json`
- `pd artifact show "<artifactId>" --workspace "<workspace>" --json`
- `pd pain recall --principle-id "<canonical principle id>" --context "<your current question>" --limit 3 --workspace "<workspace>" --json`

Resolve the authoritative workspace through the installed status script or existing workspace resolver. Do not silently replace an initialized shared Codex governance workspace with the current project directory.

## 2a. Recall a principle's historical pains

Use `pd pain recall` when the principle text alone is not enough: you are unsure why the principle exists, what its trigger boundary is, or whether the current situation matches the original failure. Skip it when the principle is already clear or the task is unrelated to its history — it only adds latency.

- Pass the canonical ledger principle id (a UUID); display titles and prompt-rendered ids never resolve. `--pain-id` (e.g. `pd pain recall --principle-id "<id>" --pain-id "<painId>" --workspace "<workspace>" --json`) filters within this principle's verified associations only — a candidate/task/artifact id is never a pain id.
- Check the top-level `status` first. `ok` / `no_matches` / `partial` are successful reads (exit 0). `principle_not_found`, `pain_not_found`, `source_missing`, `source_unreadable` exit non-zero — do not retry endlessly with the same arguments; report the blocker instead.
- Each result separates the pain record (`pain.reason`, `pain.text`) from saved `diagnoses` (model-generated — `isOriginalOwnerStatement` is always `false`; never quote a diagnosis as the Owner's original words) and `correctionEvidence` (the only place an Owner's verbatim statement can appear).
- Per-result `availability` distinguishes `not_recorded` from `unreadable`; a `partial` top-level status means some sources were unavailable — state the gap, do not guess. Recalled history is context, not authority: it must not override the direct evidence of the current task.

## 3. Report stage-by-stage

Separate plugin discovery, Hook trust, Runtime readiness, worker liveness, pain registration, diagnosis, candidate admission, Owner approval, and activation. A green status script does not prove a particular pain was diagnosed; a candidate ID does not prove admission.

## Writes and governance

This skill is read-only by default. For repair, setup, disablement, or re-enablement, use `pd-control`. Do not directly edit `.pd/config.yaml`, the database, or Runtime files. Never approve, reject, or activate a principle through CLI or scripts; Owner governance must be completed in the Web Console.
