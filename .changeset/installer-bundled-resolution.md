---
'create-principles-disciple': patch
---

Make registry-installed bundled components executable: the pre-deployment
compatibility scan's bundled pd-cli now resolves every bundled component's
file:../ sibling deps through package-root node_modules links, and the
bundled graph's third-party runtime dependencies (@sinclair/typebox,
better-sqlite3, @earendil-works/pi-agent-core, @earendil-works/pi-ai, typebox,
undici, micromatch) are hoisted into the installer's top-level dependencies.
Upgrades from the registry no longer crash the scan with ERR_MODULE_NOT_FOUND.
(PRI-1060)
