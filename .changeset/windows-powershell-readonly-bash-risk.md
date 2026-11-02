---
"@principles/core": patch
---

Treat positively verified Windows PowerShell read-only query cmdlets as `safe` in the shared bash-risk classifier.

`Get-Content`, `Get-ChildItem`, `Get-Item`, `Get-ItemProperty`, `Select-String`, `Test-Path`, `Resolve-Path` and `Get-Location` are accepted only by exact cmdlet name and a bounded allow-list of parameters; unlisted parameters, abbreviated names, two-letter aliases, unquoted glob expansion and composed/redirected forms still classify as `unknown`/`normal`. Without this, Windows read-only calls were classified `unknown` and design-approval RuleCode reported them as gate-face (would-block) even though the host had confirmed no mutation.
