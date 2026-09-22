---
'create-principles-disciple': patch
---

Fix PRI-898: the global `pd` command is no longer gated on the npm-distributed payload mode, and the Windows shim set now reaches every shell.

- Decoupling: self-contained release-asset installs (the recommended channel) now write the global `pd` shim into the PATH-managed npm global bin dir, so the host agent finds `pd` without manual PATH edits.
- Windows coverage: in addition to `pd.cmd` (cmd) and `pd.ps1` (PowerShell), the installer writes an extensionless `pd` sh shim — Git Bash/MSYS does not apply PATHEXT, so a bare `pd` only resolves to that exact-named file. Without it a Git Bash host got command-not-found even with the `.cmd` on PATH.
- Shim path quoting: the sh forwarding shim embeds its target path in POSIX single quotes, so an install directory containing spaces, `$`, backticks or an apostrophe resolves literally instead of being expanded or breaking out of the quote (the previous double-quote form only escaped `"`).

Foreign-`pd` protection, rollback bookkeeping, the uninstaller scan (now also cleaning the extensionless `pd` on Windows), and the `PD_SKIP_GLOBAL_SHIM` smoke gate are unchanged; the pd-cli upgrade / dependency-resolution payload-mode gates stay where they belong.
