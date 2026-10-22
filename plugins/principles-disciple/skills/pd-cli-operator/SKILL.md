---
name: pd-cli-operator
description: Inspect whether PD is installed and active in Codex, query Runtime and evidence-chain state, or diagnose why principles are not being applied. Use for read-only status and CLI operations, not pain registration, Owner review, or setup/control.
---

# PD CLI Operator

## 1. Verify the Codex integration first

Run the bundled status script for the installed plugin version; let the plugin resolve its authoritative workspace.

Bash / zsh:

    node "$(ls -1d "${CODEX_HOME:-$HOME/.codex}/plugins/cache/"*/principles-disciple/*/scripts/pd-status.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)" --json

PowerShell:

    $pdCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
    node (Get-ChildItem "$pdCodexHome\plugins\cache\*\principles-disciple\*\scripts\pd-status.cjs" | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1).FullName --json

This checks plugin/runtime installation, pinned runtime version, `host.codex`, Hook trust, and workspace resolution. If the script cannot be found, report an installation problem; do not choose an arbitrary stale cache path.

## 2. Query only the state needed

When the status result points to a Runtime or business-pipeline issue, use the installed `pd` CLI and check its actual help first:

- `pd health --host codex --json`
- `pd runtime probe --runtime pi-ai --workspace "<workspace>" --json`
- `pd runtime flow show --workspace "<workspace>" --json`
- `pd pain list --workspace "<workspace>" --json`
- `pd pain evidence --workspace "<workspace>" --json`
- `pd runtime trace show --pain-id "<painId>" --workspace "<workspace>" --json`
- `pd task show "<taskId>" --workspace "<workspace>" --json`
- `pd run show "<runId>"`
- `pd candidate list --task-id "<taskId>" --workspace "<workspace>" --json`
- `pd candidate show "<candidateId>" --workspace "<workspace>" --json`
- `pd artifact show "<artifactId>" --workspace "<workspace>" --json`

Resolve the authoritative workspace through the installed status script or existing workspace resolver. Do not silently replace an initialized shared Codex governance workspace with the current project directory.

## 3. Report stage-by-stage

Separate plugin discovery, Hook trust, Runtime readiness, worker liveness, pain registration, diagnosis, candidate admission, Owner approval, and activation. A green status script does not prove a particular pain was diagnosed; a candidate ID does not prove admission.

## Writes and governance

This skill is read-only by default. For repair, setup, disablement, or re-enablement, use `pd-control`. Do not directly edit `.pd/config.yaml`, the database, or Runtime files. Never approve, reject, or activate a principle through CLI or scripts; Owner governance must be completed in the Web Console.
