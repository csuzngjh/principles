---
name: pd-setup
description: Initialize Principles Disciple for this Codex workspace — installs the pinned PD runtime into plugin-private storage and initializes .pd workspace state. Use when the user wants to set up, install, or start using Principles Disciple in the current workspace, or after installing/updating the plugin.
---

# PD Setup

Prepares the current workspace so owner-approved principles actually steer this Codex session. Two things happen: the pinned PD runtime is installed into the plugin's private data dir (never into the project), and the workspace `.pd` state is initialized through the standard `pd runtime init` command. Nothing in the user's project is modified beyond `.pd/`.

## Steps

1. Run the setup script (it self-locates the installed plugin):

   bash / zsh:
   ```bash
   node "$(ls -1d "$HOME/.codex/plugins/cache/"*/principles-disciple/*/scripts/pd-setup.cjs 2>/dev/null | sort | tail -1)"
   ```

   PowerShell:
   ```powershell
   node (Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\*\principles-disciple\*\scripts\pd-setup.cjs" | Sort-Object FullName | Select-Object -Last 1).FullName
   ```

   Useful flags: `--skip-init` (runtime only), `--json` (machine-readable), `--workspace <dir>`.

2. Interpret the output for the user, calmly:
   - `[PD:setup] ok` → summarize the runtime versions and workspace path, then tell the user the one remaining step: **run `/hooks` in Codex and trust the Principles Disciple hooks** — hooks never execute until trusted.
   - `status=failed reason=... nextAction=...` → read the reason aloud in plain language and perform the nextAction with the user. Common ones: Node < 20 (install Node ≥ 20), npm missing, `@principles` packages not yet published (wait for the release note), pd CLI missing (`npm install -g @principles/pd-cli`).

## Notes

- Never edit `.pd/config.yaml` by hand during setup; the script and `pd runtime init` own it.
- After setup, `$pd-status` verifies everything, and principles can be added/reviewed via `$pd-review`.
