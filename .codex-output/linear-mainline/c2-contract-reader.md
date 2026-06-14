# Runtime Mainline C2: shared MainlineSnapshot assembler and executable contract wiring

## Why this matters
`assertMainlineContract()` exists in core, but the production path still lacks a shared reader that assembles a `MainlineSnapshot` from real Runtime V2 state. Without this, integrity, Console, and smoke tests each infer chain state differently, which is why UI errors and CLI diagnostics keep disagreeing.

## MVP gate
- What happens if we do not do this? We keep fixing one reader at a time and regress elsewhere; the owner cannot tell where the chain is blocked.
- How is it observed? One command/read-model can show every stage: config, diagnostician readiness, pain, diagnosis task, artifact, candidate lineage, dreamer lineage/context, successor, owner-reviewable principle, auto-consumption.
- How is it disabled? This is a read-only diagnostic/read-model. Rollback is PR revert; no runtime behavior mutation.

## Scope
Implement a shared production reader for the existing contract:
- `assembleMainlineSnapshot(...)` or equivalent I/O boundary reader outside pure core if DB access is needed.
- It must call `assertMainlineContract()` from `packages/principles-core/src/runtime-v2/mainline-contract.ts`.
- Wire it to integrity read-model and expose a CLI/operator path suitable for `pd mvp smoke` in C5.

## Non-goals
- Do not change diagnosis or internalization behavior in this PR.
- Do not add dashboard metrics.
- Do not create a second chain contract.

## Required implementation notes
- Core remains pure. DB/filesystem reading must live in CLI/plugin/server boundary code.
- Use unknown-first validation for DB JSON (`diagnosticJson`, artifact metadata, run output).
- Do not hand-fill fields in tests. Seed real SQLite temp workspace state through existing stores/services where possible.
- The existing `mainline-product-path.test.ts` TODOs should start moving from TODO to real tests as this reader becomes available.

## ERR checklist
- EP-01 / trust boundary: DB JSON is untrusted.
- EP-02 / production path wiring: one reader powers integrity/smoke/Console.
- EP-07 / lineage alignment: same-source fields must be checked together.
- EP-09 / test reality gap: tests must use real product stores, not mock-only snapshots.

## Acceptance criteria
- A shared snapshot assembler exists and is imported by at least one product-path CLI/integrity path.
- `assertMainlineContract(snapshot)` identifies the current known failure stages without throwing.
- Tests cover malformed DB JSON, missing fields, missing succeeded run, missing dreamer task, empty dreamer context.
- No second copy of mainline stage rules exists outside `mainline-contract.ts`.
- `npm run verify:merge` passes.
