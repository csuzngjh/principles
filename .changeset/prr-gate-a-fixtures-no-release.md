---
---

No release needed.

This PR only adds test assets and a dev-only test-runner exclusion for
`@principles/core`:

- `packages/principles-core/tests/fixtures/gate-a-reproducibility/` — byte-identical
  copies of the 2026-10-17 Gate A synthetic audit fixtures plus a
  `prepare-mirror.mjs` script and a README.
- `packages/principles-core/tests/fixtures/.gitignore` — ignores the generated
  `core-mirror/` snapshot.
- `packages/principles-core/vitest.config.ts` — adds
  `exclude: ['tests/fixtures/**']` so the generated-mirror replay asset is not
  picked up by default test discovery (it requires an explicit
  `prepare-mirror.mjs` run first).

No production source, runtime behaviour, public API or published artifact
changes. The `vitest.config.ts` edit is dev-tooling only and is not shipped.
