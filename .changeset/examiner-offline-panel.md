---
'create-principles-disciple': minor
---

Ship the Examiner offline research panel in the installed console.

`/examiner` is no longer a DEV-only route: the console nav, page and server
now exist in production builds. The installer payload carries the research
engine subset under `<console>/lab`, so an installed console can create, run
and report offline studies without the repository. The panel states its
scope in-product — every study uses `SYNTHETIC_OFFLINE` gold and the
deterministic local stub, so it validates the research contract and never
real host behavior. Real model calls and real host runs stay refused (403).

Studies are workspace data: new studies are written under
`<workspace>/.pd/examiner/studies`, never into the installation or the
repository. The lab case constructors move from test fixtures into the lab
itself so packaged code never imports a test-only module.

No governance migration, real host run, real model call, or historical
research asset mutation is introduced.
