---
name: pd-review
description: Open the official PD Owner Console in the correct Codex governance workspace to inspect pain evidence, candidates, principles, and governance state. Use when the Owner asks to review or approve/reject a PD proposal.
---

# PD Review

## Steps

1. Use the workspace resolved by the installed PD plugin. Do not assume the current project directory is authoritative: Codex may use an explicitly initialized shared governance workspace.
2. Run the installed review script through the shipped locator (`scripts/pd-locate.cjs`).

   Bash / zsh:

       node "$(ls -1d "${CODEX_HOME:-$HOME/.codex}/plugins/cache/"*/principles-disciple/*/scripts/pd-locate.cjs 2>/dev/null | (sort -V 2>/dev/null || sort) | tail -1)" --exec scripts/pd-review.cjs

   PowerShell:

       $pdCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
       node (Get-ChildItem "$pdCodexHome\plugins\cache\*\principles-disciple\*\scripts\pd-locate.cjs" | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1).FullName --exec scripts/pd-review.cjs

3. Report the Console URL and startup state only when returned by the script. If the script fails, preserve the error and route installation/status checks to `pd-cli-operator` or `pd-control`.
4. The Owner reviews the evidence and completes any approval, rejection, or activation decision inside the Web Console.

## Evidence discipline

Keep Owner statements, host trajectory, model diagnosis, admission decisions, and completed governance actions separate. Opening the Console is not approval; a candidate is not an activation; activation is not proof of a later behavior change.

## Hard boundary

Never use a CLI approval command, script, database write, or file edit as a fallback. If the Console is unavailable, report the blocker and wait for the official governance interface to recover. The agent may explain a decision but must not make it for the Owner.
