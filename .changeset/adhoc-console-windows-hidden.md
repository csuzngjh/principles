---
"create-principles-disciple": patch
"@principles/pd-cli": patch
---

On Windows, an update no longer opens a trail of terminal windows. The update
runs in the bootstrap executor, which is started detached and therefore has no
console; every console program it started without `windowsHide: true` got a
new, visible terminal window. The installer now hides the console of every
child process it starts (tar, `cmd /c npm`, the `pd` verification probes, the
console probe, the environment probes), and `pd console open` hides the console
of the Console server and of the stale-console probes it runs — that server
window used to stay open until the server was killed. An interactive
`pd console open` in a terminal is unchanged: the server still shares that
terminal.

A fail-closed source guard (`scripts/lib/child-process-window-scan.mjs`) now
runs in the installer and CLI test suites: a child_process call that does not
hide its console, or that the scan cannot attribute, fails the suite.
