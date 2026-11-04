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

Security (P1, PR #2319 review): dependency names are now parsed structurally
(unscoped = one segment, scoped = exactly `@scope/pkg`); `.`, `..`, empty
segments, repeated `/` and `\` are rejected before any filesystem mutation, and
the normalized link path must be a strict descendant of the component's
`node_modules` real directory. All entries are validated before any link is
created/replaced, so an invalid later entry cannot leave half-applied links.
Symlinked `node_modules` / scoped parents and siblings resolving outside the
runtime dir are refused instead of being followed.

