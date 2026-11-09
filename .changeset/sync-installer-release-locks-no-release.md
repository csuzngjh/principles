---
---

Re-resolve the installer's committed release locks against the dependency
ranges already on main (vite 8.3.6, vitest 5.1.0, @types/node 26.6.6).
The previous locks still pinned vite 8.3.5 / rolldown 1.2.16, so the staging
`npm ci --install-links` in the self-contained release build failed with
EUSAGE and broke quick-check / packaged-install / release-asset smoke.

Only dev-tooling entries used during staging resolution change; no published
runtime dependency or runtime behaviour changes. This is an explicit
no-release declaration.
