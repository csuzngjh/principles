---
name: pd-review
description: Open the Principles Disciple owner review console for this workspace to approve or reject pending principles, rules, and activations. Use when the user wants to review pending PD suggestions, approve a principle, promote a rule to live, or see what PD has recorded.
---

# PD Review

Opens the existing pd-console (the same owner-review UI used with the OpenClaw host) for the nearest PD workspace. This is where owner governance happens: pending principles and RuleHost activations wait for explicit approval; nothing becomes live without it.

## Steps

1. Launch the console:

   bash / zsh:
   ```bash
   node "$(ls -1d "$HOME/.codex/plugins/cache/"*/principles-disciple/*/scripts/pd-review.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)"
   ```

   PowerShell:
   ```powershell
   node (Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\*\principles-disciple\*\scripts\pd-review.cjs" | Sort-Object FullName | Select-Object -Last 1).FullName
   ```

2. Tell the user the console is opening in the browser (default `http://127.0.0.1:3100`) and summarize what to do there: review the pending queue, approve what matches their intent, reject the rest. Approved items take effect on the next hook invocation — no restart needed beyond a new session.

## Notes

- If `pd` is missing, install it first: `npm install -g @principles/pd-cli`, then retry.
- CLI fallback without the UI: `pd activation list`, `pd activation approve <id>`, `pd activation deactivate <id>`.
- This skill never approves anything itself — approval is always the owner's explicit action in the console or CLI.
