---
'create-principles-disciple': patch
---

G3 §10.5 (SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001 §10 item 5): the installed
pd-cli and pd-console sibling dependency links are now materialized through the
shared `ensureComponentFileDependencyLinks` helper, after the component
dependency stage. The previous hand-rolled blocks short-circuited on
`existsSync()`, so an npm-materialized physical copy silently won over the
intended runtime sibling; the consolidated pass corrects physical copies,
wrong-target and dangling links, and fails closed when a declared sibling is
missing. No dependency trimming, release-lock, runtime pin or user install
directory is touched.
