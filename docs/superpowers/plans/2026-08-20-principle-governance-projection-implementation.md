# Principle Governance Projection Implementation Plan

> Design authority: `docs/superpowers/specs/2026-08-20-principle-governance-projection-contract.md`
> Linear: PRI-549, implemented in dependency order PRI-550 → PRI-551 → PRI-552 → PRI-553.

## Fixed boundaries

- Read-only projection over existing durable Runtime v2 and ledger facts.
- No new state, table, writer, lifecycle transition, approval action, or generic projection framework.
- `principles-core` contains schemas and pure derivation only; Console owns filesystem/SQLite composition.
- `principle_governance_projection_v2` is quiet, default off, and must be exercised through the production config loader.
- Existing Owner approval BDD remains unchanged; new scenarios only add observable projection behavior.

## Handbook gate

- ERR-001 — validate parsed JSON/SQLite metadata as `unknown`; no `as` shortcut at trust boundaries.
- ERR-004 — derive task, artifact, approval, and activation refs from the same canonical lineage component; add mismatch cases.
- ERR-009 — missing/malformed required fields produce collection issues or rejection; validators never silently skip.
- ERR-013 — use `Object.hasOwn` before reading untrusted object keys; cover inherited-key inputs.
- ERR-025 — tests must exercise the real Console collector and production flag loader, not only isolated helpers.

## Task 1 — Freeze executable contracts and rollback flag (PRI-550)

Files:

- Create `packages/principles-core/src/runtime-v2/governance-projection-contract.ts`.
- Create `packages/principles-core/src/runtime-v2/__tests__/governance-projection-contract.test.ts`.
- Modify `packages/principles-core/src/runtime-v2/index.ts`.
- Modify `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts`.
- Modify `packages/principles-core/src/runtime-v2/feature-flags/__tests__/feature-flag-contract.test.ts`.

Steps:

1. Add failing tests for required fields, array element validation, ISO timestamps, non-empty IDs, inherited keys, and flag metadata/default-off behavior.
2. Run the two focused test files and confirm failures are caused by missing schemas/flag.
3. Implement the minimum TypeBox schemas/static types and barrel exports; register the quiet flag.
4. Re-run focused tests, core build, architecture regression, and feature-flag loader tests.

## Task 2 — Collect canonical durable facts (PRI-550)

Files:

- Create `packages/pd-console/src/server/models/GovernanceProjectionCollector.ts`.
- Create `packages/pd-console/tests/models/governance-projection-collector.test.ts`.
- Reuse existing ledger parser and Runtime store APIs; add a narrow read-only facade only if current exports cannot perform a required query.

Steps:

1. Add real-schema tests for a strong artifact root, connected task graph, approval/activation lineage, no-root principle, malformed JSON, orphan edge, cycle, and node-bound overflow.
2. Confirm tests fail before collector production code exists.
3. Implement bounded read-only collection with one caller-supplied `asOf`; return structured collection issues for every omitted/degraded fact.
4. Verify no database/file mutations and no core I/O.

## Task 3 — Derive the Owner view (PRI-551)

Files:

- Create `packages/principles-core/src/runtime-v2/governance-projection.ts` and its test.
- Export through the Runtime v2 barrel.

Steps:

1. Encode every frozen decision-matrix row as a named failing table case.
2. Implement one pure `deriveOwnerGovernanceView(facts)` function.
3. Add permutation, conflict, stale-frontier, unknown-lineage, and invalid-output cases.
4. Verify determinism, output-schema validation, core build/tests, and architecture regression.

## Task 4 — Wire the flagged API (PRI-552)

Files:

- Extend the existing principles route/model and frontend API validator; do not create a parallel server.
- Add route integration tests using the production config loader and real SQLite schema.

Steps:

1. Add failing flag-off, flag-on, missing-principle, corrupt-fact, and repository-failure tests.
2. Compose collector → derivation → output validation under the existing route.
3. Prove flag-off performs no projection reads and failures have reason + next action.
4. Run Console typecheck, route integration tests, and no-mutation assertions.

## Task 5 — Render the Owner journey (PRI-553)

Files:

- Extend `PrincipleDetailPage.tsx`, shared validators/types, and all locale files.
- Add/extend BDD steps and `principle-detail-flow.spec.ts`.

Steps:

1. Add failing component/browser cases for every Owner-visible state and narrow screen.
2. Render status, reason, evidence, uncertainty, blockers, timeline, and safe next action; reuse current approval actions.
3. Verify flag-off parity, accessibility, localization, five-second comprehension content hierarchy, and no new mutations.
4. Run affected BDD, real-browser E2E, Console tests/typecheck, then repository merge verification.

## Completion gate

- Adversarial self-review against `rc-1`–`rc-9`; `rc-7` is N/A unless a retry loop is introduced.
- Diff contains only frozen-SPEC implementation and tests.
- Core, Console, plugin, lint, and `verify:merge` pass; skipped/expected-fail tests are reported explicitly.
- Each finished child moves to In Review with files, commands, outcomes, risks, and deviations; dependent child starts only after its blocker passes.
