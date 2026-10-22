---
name: pd-control
description: Initialize or manage the PD Codex integration when the Owner explicitly requests setup, disablement, re-enablement, or repair. Use the shipped setup/kill-switch scripts and verify their receipts.
---

# PD Control

Only perform an operation explicitly requested by the Owner. This skill manages Codex integration; it does not approve principles or mutate business records.

## Setup or initialize

Run the setup script shipped with the installed plugin version.

Bash / zsh:

    node "$(ls -1d "${CODEX_HOME:-$HOME/.codex}/plugins/cache/"*/principles-disciple/*/scripts/pd-setup.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)"

PowerShell:

    $pdCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
    node (Get-ChildItem "$pdCodexHome\plugins\cache\*\principles-disciple\*\scripts\pd-setup.cjs" | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1).FullName

Supported options include `--skip-init`, `--json`, `--workspace <absolute-path>`, and `--ingest accept|decline|skip`. Check the script's current help before using optional flags. Never edit `.pd/config.yaml` by hand.

The setup script owns the explicit consent flow for Codex conversation ingestion. In a non-interactive run it may return `no_tty` and print the frozen disclosure. Present that exact disclosure to the Owner and wait for an explicit choice; only then rerun the wrapper with `--ingest accept` or `--ingest decline`. Never choose for the Owner or invoke the underlying CLI's `--accept` / `--decline` directly. If the wrapper reports `disclosure_unavailable`, show the frozen disclosure from `pd codex setup --show-disclosure`, then resume the wrapper flow after the Owner decides. User-level shared-workspace consent can cover multiple projects; do not enable it merely because shared principle injection was requested.

After setup, use `pd-cli-operator` to verify plugin/runtime status and `pd-review` to open the Owner Console if needed. Runtime installation alone does not prove hooks are trusted, Companion is running, or the business pipeline is healthy.

## Disable or re-enable

Run the shipped kill-switch script.

Bash / zsh:

    node "$(ls -1d "${CODEX_HOME:-$HOME/.codex}/plugins/cache/"*/principles-disciple/*/scripts/pd-disable.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)"

PowerShell:

    $pdCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
    node (Get-ChildItem "$pdCodexHome\plugins\cache\*\principles-disciple\*\scripts\pd-disable.cjs" | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1).FullName

Append `--enable` only when the Owner explicitly asks to re-enable PD. Verify the script's actual receipt; do not infer success from process exit alone. The kill switch must work even when the Runtime is missing and must preserve `.pd/`, `.state/`, and other hosts' settings.

## Repair and failure

Use the script's reported reason and next action. If the installed script cannot be located, report the plugin installation/cache issue; do not select a random version or recreate the script. Preserve user configuration and all business data.

## Never

- Directly edit configuration, databases, ledgers, or Runtime files.
- Treat installation as enabling, or enabling as proof of a healthy pipeline.
- Approve, reject, or activate principles through CLI, scripts, or this skill.
