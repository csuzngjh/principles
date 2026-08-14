---
name: pd-disable
description: Immediately stop all Principles Disciple behavior in Codex for this workspace (prompt injection, tool gating, pain capture) by setting host.codex.enabled=false, or re-enable it. Use when the user wants PD off, to pause PD, to stop principles from being applied, or to re-enable PD after disabling.
---

# PD Disable (kill switch)

Turns PD's Codex behavior off instantly and reversibly: every hook returns the neutral allow/empty result with an observable skip reason, and no PD business state is written. Workspace owner data (`.pd/`, `.state/`) and the OpenClaw host are untouched. The plugin itself stays installed — no uninstall needed to stop behavior.

## Steps

1. Disable (or re-enable with `--enable`):

   bash / zsh:
   ```bash
   node "$(ls -1d "$HOME/.codex/plugins/cache/"*/principles-disciple/*/scripts/pd-disable.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)"
   ```

   PowerShell:
   ```powershell
   node (Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\*\principles-disciple\*\scripts\pd-disable.cjs" | Sort-Object FullName | Select-Object -Last 1).FullName
   ```

   Re-enable: append `--enable`.

2. Confirm to the user in one sentence: disabled ("PD is now inert in Codex; your data is untouched") or enabled ("PD is steering again from the next message"). The script is idempotent — running it twice is safe.

## Notes

- Works even when the PD runtime is not installed — the kill switch must never depend on the thing it stops.
- To also remove the plugin entirely: `codex plugin remove principles-disciple@principles`. That never deletes workspace `.pd/`/`.state/` data.
