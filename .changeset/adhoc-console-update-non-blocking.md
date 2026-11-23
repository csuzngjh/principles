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
