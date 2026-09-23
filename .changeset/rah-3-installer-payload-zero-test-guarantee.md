---
'@principles/install-layout': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

RAH-3 (PRI-907): complete the release-artifact content boundary. @principles/install-layout and principles-disciple (openclaw-plugin) production builds now exclude compiled tests (tsconfig.build.json; plugin build:types declaration emit filtered too) with the same fail-loud dist hygiene assertion as RAH-1. The installer bundle script (create-principles-disciple) filters compiled test artifacts out of every payload copy AND asserts zero test artifacts across all payload components after materialization — test code can no longer reach user machines even if a future package forgets its build-boundary guard. A repo-level scan (check:workspace-artifacts, wired into verify:merge) backstops all workspace dist trees.
