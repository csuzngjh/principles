---
'create-principles-disciple': patch
---

Security (P1, follow-up of the PR #2319 review): installed sibling dependency
links no longer accept path-traversal package names. Names are parsed
structurally (unscoped = exactly one segment, scoped = exactly `@scope/pkg`)
and `.`, `..`, empty segments, repeated `/` and `\` are rejected before any
filesystem mutation, so `path.join()` can no longer normalize a name onto
`node_modules`, the scoped parent or the component root that the physical-copy
repair pass would recursively delete. Every entry is validated before any
link is created, replaced or removed, the normalized link path must be a
strict descendant of the component's real `node_modules`, and a symlinked
`node_modules`/scoped parent or a sibling resolving outside the runtime
directory is refused instead of followed. No dependency trimming,
release-lock, runtime pin or user install directory is touched.
