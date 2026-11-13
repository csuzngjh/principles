---
---

CI only: pin `npm@11.19.1` on the publish legs and document why the floor exists.

Node `22.22.2` ships npm 10.9.7, which cannot use OIDC trusted publishing (needs npm >= 11.5.1),
so the legs fell back to `NPM_TOKEN` and the registry refused `principles-disciple@4.0.0` with
"Two-factor authentication is required to publish this package" (run 43238870812). A contract test
in `release-target-matrix.test.ts` now fails if the publish job drops below that floor.

No release intent: workflow + tests only, no package code or version change.
