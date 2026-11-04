---
'create-principles-disciple': patch
---

Console update check: stop surfacing a "version divergence" between the active release product version and the plugin-directory package version. They are independent version planes (`RELEASE_PROCESS.md`, "The three version planes"), so the comparison flagged every healthy installation (product 2.8.0 vs plugin 2.5.0). The check now reports only the signed active-release identity; the plugin copy stays a diagnostic read.
