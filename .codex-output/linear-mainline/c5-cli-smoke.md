# Runtime Mainline C5: operator CLI consistency and MVP smoke command

## Why this matters
Operators currently need to stitch together `config doctor`, `runtime probe`, `integrity`, `recovery`, `run-once`, task commands, and Console pages manually. Some commands lack `--workspace` / `--json`, and output such as `%-22s` makes diagnosis harder. We need one reliable way to answer: can the MVP chain run now, and if not, what exact next action should I take?

## MVP gate
- What happens if we do not do this? We keep relying on manual debugging and screenshots; seed-user readiness remains unverifiable.
- How is it observed? `pd mvp smoke --workspace ... --json` returns one structured verdict using the shared mainline contract.
- How is it disabled? CLI/read-only smoke is non-mutating by default. Any optional mutation must require explicit `--confirm`.

## Scope
Add/standardize operator UX after C1-C4 are merged:
- Add `--workspace` and `--json` support where missing for relevant task/internalization commands (`pd task list/show` or equivalents).
- Fix broken table formatting like literal `%-22s`.
- Add `pd mvp smoke --workspace <dir> --json` or equivalent command that assembles a mainline snapshot, calls `assertMainlineContract`, and prints a single JSON object.
- Console can consume the same verdict later, but this issue only needs CLI/read-model integration unless already trivial.

## Non-goals
- Do not add a generic dashboard.
- Do not start background agents.
- Do not mutate production data unless an explicit subcommand says so and requires `--confirm`.

## ERR checklist
- EP-04 / CLI operator gate: strict JSON stdout, fail loud, nextAction, real parser tests.
- EP-02 / production path wiring: smoke must use shared snapshot reader/contract.
- EP-09 / test reality gap: include a no-real-LLM product-path smoke test.

## Acceptance criteria
- `pd task list --workspace ... --json` works or a documented replacement exists.
- `pd mvp smoke --workspace ... --json` returns exactly one JSON object and includes stage verdicts with reason/nextAction.
- Smoke fails on config drift, empty dreamer context, missing succeeded run, missing dreamer task.
- Smoke passes on a temp SQLite product path seeded through real services with stub runtime.
- `npm run verify:merge` passes.
