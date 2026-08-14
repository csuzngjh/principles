---
name: pd-status
description: Show Principles Disciple health for this workspace — plugin install, pinned runtime, host.codex flag, hook trust, and workspace state. Use when the user asks whether PD is working, enabled, installed, or why principles are not being applied in Codex.
---

# PD Status

A read-only snapshot that answers "is PD actually steering this session?" in one glance. It checks five things: plugin install, pinned runtime presence + version match, the `host.codex` flag in the nearest `.pd/config.yaml`, Codex hook trust, and workspace resolution.

## Steps

1. Run the status script:

   bash / zsh:
   ```bash
   node "$(ls -1d "$HOME/.codex/plugins/cache/"*/principles-disciple/*/scripts/pd-status.cjs 2>/dev/null | sort | tail -1)" --workspace "$PWD"
   ```

   PowerShell:
   ```powershell
   node (Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\*\principles-disciple\*\scripts\pd-status.cjs" | Sort-Object FullName | Select-Object -Last 1).FullName --workspace (Get-Location).Path
   ```

   Add `--pd-health` to also include the richer `pd health --host codex` report (requires the pd CLI), or `--json` for machine-readable output.

2. Read the result to the user as a short verdict, e.g. "PD is active: runtime 0.1.0 pinned-match, host.codex enabled, hooks trusted." For any `✘` line, state what it means in one sentence and do the printed `next →` action. Typical findings:
   - runtime not installed → run `$pd-setup`
   - host.codex DISABLED → behavior is intentionally off; re-run `$pd-disable --enable` to resume
   - hook trust not found → run `/hooks` in Codex and trust the PD hooks
   - workspace not initialized → run `$pd-setup` in the project root

## Notes

- This command never changes anything — safe to run any time.
- If the user reports "PD never blocks/injects anything", this is the first diagnostic to run; the failing check names the exact layer.
