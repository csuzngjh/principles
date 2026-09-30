---
name: pd-setup
description: Initialize Principles Disciple for this Codex workspace — installs the pinned PD runtime into plugin-private storage and initializes .pd workspace state. Use when the user wants to set up, install, or start using Principles Disciple in the current workspace, or after installing/updating the plugin.
---

# PD Setup

Prepares PD so owner-approved principles can steer Codex sessions. The runtime is installed into the plugin's private data dir and workspace state is initialized through `pd runtime init`.

When the Owner requests principles shared across projects, initialize `<CODEX_HOME>/pd-workspace` (default `~/.codex/pd-workspace`) using `--workspace <absolute-path>`. Once that directory contains `.pd/config.yaml`, Codex hooks and the review/status/disable skills use it before project-local configurations. This is an explicit opt-in to one Codex user-level governance workspace; OpenClaw remains separate. Without it, the nearest project workspace still applies. A disabled or malformed user configuration does not fall back to a project configuration.

## Steps

1. Run the setup script (it self-locates the installed plugin):

   bash / zsh:
   ```bash
   node "$(ls -1d "${CODEX_HOME:-$HOME/.codex}/plugins/cache/"*/principles-disciple/*/scripts/pd-setup.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)"
   ```

   PowerShell:
   ```powershell
   $pdCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
   node (Get-ChildItem "$pdCodexHome\plugins\cache\*\principles-disciple\*\scripts\pd-setup.cjs" | Sort-Object FullName | Select-Object -Last 1).FullName
   ```

   Useful flags: `--skip-init` (runtime only), `--json` (machine-readable), `--workspace <dir>`.

2. Interpret the output for the user, calmly:
   - `[PD:setup] ok` → summarize the runtime versions, workspace path and `workerRegistration`. **Run `/hooks` in Codex and trust the Principles Disciple hooks**. Automatic background processing also requires **PD Companion to be running**; registration alone does not prove it is running. If `manual_action_required`, explain the reported reason and manual processing command. Never describe runtime installation alone as a working automatic pipeline.
   - `status=failed reason=... nextAction=...` → read the reason aloud in plain language and perform the nextAction with the user. Common ones: Node < 22 (install Node ≥ 22), npm missing, `@principles` packages not yet published (wait for the release note), pd CLI missing (`npm install -g @principles/pd-cli`).

## Notes

- Never edit `.pd/config.yaml` by hand during setup; the script and `pd runtime init` own it.
- After setup, `$pd-status` verifies everything, and principles can be added/reviewed via `$pd-review`.
- Configure the selected workspace's internal agents to use a valid `pi-ai` profile through the existing Console configuration controls. Initialization alone does not supply model credentials or approved principles.
- Obtain conversation-observation consent for the user-level scope explicitly: it can cover sessions from different projects. Never enable it merely because shared principle injection was requested.
- For local development, `--adapter-source <built-package-directory>` and `--host-runtime-source <built-package-directory>` install an isolated copies of the adapter and shared host runtime through npm. Its package name/version must match the runtime pin. The runtime marker and setup result identify this as a local build; this does not publish a release.
