---
"create-principles-disciple": patch
---

The Console update routes (`/api/update/check`, `/api/update/apply-full`) no
longer hold the server's event loop while the readiness gate re-hashes the
deployed bootstrap executor. The gate gains an async factory
(`createReleaseManagerAuthorityAsync`, exported through the `./update-console`
seam) that reads the executor tree without blocking; both factories run one
readiness rule. The Console prefers the async factory and falls back to the
synchronous one against an older deployed release-manager (an update swaps
runtime components one by one). The synchronous factory and the bootstrap
executor are unchanged.

The Update page no longer waits for the network-bound version check before it
renders: history and recovery show immediately, the check reports in place
(with its reason when it fails, and with an explanation when it runs long), a
finished update's result stays on screen while data re-reads, the pre-update
status is not carried past the update, and transaction polls never stack.

An update in progress is narrated instead of looking stuck. The update
executor reports where it is — downloading (with bytes received, a rate and a
time left), verifying, deploying, finishing — through an observational
progress sidecar beside the transaction journal (never an authority: it is
removed when the transaction ends, and a stale or malformed one reads as
"unknown"). The page shows the stage, a progress number and the elapsed time,
and reads `readTransactionProgress` only when the deployed release-manager
exports it.

An update no longer starts a second console. The installer's run mode gains
`launchConsole`; the update executor turns it off, so no `pd console open`
runs beside the console the update was asked from and no welcome tab opens.
A fresh install keeps opening the console in the browser.

A console hands itself over to the release an update just activated: it
watches `<pdHome>/active.json` (written after the transaction reached
`confirmed`), starts a successor from the installed code on the same port,
and exits once the successor answers. It never leaves the port unserved — the
predecessor stops accepting only after the successor exists and takes the
port back if the successor never comes up. Two consoles do not hand
thems over: one the Companion launched (`PD_INVOCATION_SOURCE=companion` —
the Companion relaunches the console it owns) and one that does not run from
the installed runtime (its successor would be the same code).
`PD_CONSOLE_RELEASE_HANDOVER=off` disables the watch. The transaction
endpoint reports the answering `serverPid` and `handover` (`console`,
`companion` or `manual`); the page reloads into the successor, waits for the
Companion on its own beat, or asks for a restart when nobody switches.
