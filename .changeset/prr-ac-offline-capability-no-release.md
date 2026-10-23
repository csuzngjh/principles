---
---

No release needed.

This PR adds dev-only research tooling for PRR Gate B preparation
(PRI-1002 offline A/C capability), all under `scripts/`:

- `scripts/dev/principle-learning-lab/prr/` — offline A/C rehearsal runner
  (`run-prr-rehearsal.mjs`) plus libs for the PRR dataset contract, the
  mechanical adjudicator (five-value verdicts + negative-transfer dimension),
  the B0 FZ-01~FZ-15 freeze-record validator (fail-closed) and the read-only
  failure-semantics rehearsal (ledger four-way classification, explicit
  attribution ambiguity, state-unchanged assertions).
- `scripts/__tests__/prr-*.test.ts` + `prr-test-fixtures.ts` — regression
  suites (55 tests) covering every machinery path with synthetic test data.
- Root `package.json` — one dev script alias (`dev:prr-rehearsal`).

No production source, runtime behaviour, public API or published artifact
changes. Everything is FIXTURE_ONLY research tooling inside the existing
principle-learning-lab; no model calls, no network, no real workspace reads.
