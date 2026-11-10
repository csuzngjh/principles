---
"create-principles-disciple": patch
---

chore(release): re-materialize the npm installer channel for product version 2.8.6

The product version bump (`#2470`, root manifest 2.8.5 → 2.8.6) landed after the
previous Version Packages cohort was merged, so the published installer
manifest's `gitHead` still resolves to a commit whose root manifest says 2.8.5.
The signed channel's PRI-1103 guard builds assets from that cohort and refuses a
product version the npm channel does not pin, which would leave 2.8.6
undeliverable to installed runtimes. This patch re-publishes the installer from
the post-bump commit so `product_version=auto` (2.8.6) resolves against a
published cohort.

No runtime behavior changes; only the installer's diagnostic version moves.
