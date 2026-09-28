---
"create-principles-disciple": patch
---

The Console's update page no longer reports "Request timeout" on a slow
metadata host. `GET /api/update/check` refreshes the signed channel over the
network — TUF metadata, the channel document and the release metadata, several
sequential requests to the release metadata host — and it was running under the
generic 10-second request budget. Measured against GitHub Pages from a CN
network, the same request completes in ~1.2s most of the time and in ~12.5s
about one run in five, so the page failed intermittently while the installation
itself was healthy and already up to date.

The check route now has its own 30-second budget, overridable with
`PD_UPDATE_CHECK_TIMEOUT_MS` (milliseconds) exactly like the existing
`PD_UPDATE_APPLY_FULL_TIMEOUT_MS` knob for slow disks and networks. A refused
value falls back to the default with one observable log line. The check stays
read-only: a timeout never leaves a partial update behind.
