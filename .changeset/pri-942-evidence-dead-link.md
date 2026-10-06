---
"principles-disciple": patch
"create-principles-disciple": patch
---

Two "view the full evidence chain" links in the console now open a page instead
of a blank screen (PRI-942). Both pointed at `/evidence`, a route that has never
been registered: the console's inner route table has no wildcard fallback, so the
sidebar stayed put while `<main>` rendered nothing — the link looked like a
failure of the evidence chain rather than a dead address. They now point at
`/pain`, the only page in the product that actually fetches and renders the
evidence chain, and it needs no id, so it cannot 404 and never puts a machine
identifier in the URL. A new static guard in the navigation test walks every
in-app link the console UI writes with a visible path: literal `to` targets in
all their quote forms, plus the static part of a target that only becomes dynamic
after an interpolation marker. Each must resolve against the route table App.tsx
already publishes, so the next dead link fails CI instead of showing up as an
empty panel. Landing is not anchored to the individual candidate yet (it opens
the top of the chain list); per-candidate anchoring is tracked separately.
