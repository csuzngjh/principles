# Runtime Mainline C4: make integrity repair schema-valid and cover succeeded-task/no-run

## Why this matters
Recent production repair wrote run rows with invalid `errorCategory` values such as `recovery_sweep`, and integrity still reports `task_succeeded_no_succeeded_run`. Repair that creates schema-invalid state makes the next repair/read path fail and blocks MVP validation.

## MVP gate
- What happens if we do not do this? We cannot safely recover dogfood chains; repair commands can make state less valid.
- How is it observed? `pd runtime internalization integrity-repair --confirm --json` produces schema-valid state and a follow-up integrity check is `ok` or reports only real remaining blockers.
- How is it disabled? Repair is operator-initiated and dry-run/confirm guarded. Rollback via DB quarantine backup plus PR revert.

## Scope
Improve integrity repair only:
- Validate every row after mutation before commit or before reporting success.
- Repair/quarantine malformed run rows without writing non-canonical enum values.
- Add repair strategy for `task_succeeded_no_succeeded_run` or fail loud with an executable nextAction if automatic repair is unsafe.
- Preserve dry-run by default and `--confirm` for mutation.

## Non-goals
- Do not rewrite internalization orchestration.
- Do not auto-run LLMs from repair.
- Do not delete production data without quarantine/manifest.

## ERR checklist
- EP-03 / fail loud: no successful repair message if integrity remains broken.
- EP-04 / CLI operator gate: JSON stdout, dry-run/confirm, nextAction.
- EP-05 / repair loops: distinguish current, next, recorded state; validate after repair.
- EP-07 / runtime state consistency: task/run status must agree.

## Acceptance criteria
- `integrity-repair --confirm --json` never writes invalid run `errorCategory` values.
- It handles or explicitly reports `task_succeeded_no_succeeded_run` with an actionable command.
- A second `integrity-repair --confirm --json` is idempotent.
- Product-path tests cover malformed run row, stuck running run, task succeeded without succeeded run.
- `npm run verify:merge` passes.
