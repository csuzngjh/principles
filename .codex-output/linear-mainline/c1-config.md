# Runtime Mainline C1: unify runtime config resolver for probe/run-once/diagnose/retry

## Why this matters
Current production evidence shows `pd config doctor` reads `.pd/config.yaml` and reports `pi-ai.lmstudio`, while `pd runtime probe` / `run-once --runtime config` can still resolve `.state/workflows.yaml` and use `sensenova-cn/deepseek-v4-flash`. This makes the MVP pain -> diagnosis -> internalization chain nondeterministic and invalidates dogfood validation.

## MVP gate
- What happens if we do not do this? We cannot trust any live smoke result because diagnostics and peer runners may use a different model/provider than the UI/config says.
- How is it observed? `pd config doctor`, `pd runtime probe`, `pd diagnose/run-once`, and `pd pain retry` all report the same runtime profile and canonical source `.pd/config.yaml`.
- How is it disabled? This is a cutover/bug fix. Rollback is PR revert. Do not add a compatibility branch that keeps two active runtime sources.

## Scope
Unify runtime resolution for the execution paths that currently drift:
- `pd runtime probe`
- `pd runtime internalization run-once --runtime config`
- `pd diagnose run` / diagnosis runner invocation
- `pd pain retry`

Canonical source: `.pd/config.yaml` via the existing PD config resolver/effective config path. `.state/workflows.yaml` may be reported as legacy if present, but must not drive runtime selection for MVP mainline execution.

## Non-goals
- Do not keep a second compatibility implementation.
- Do not edit OpenClaw provider config.
- Do not change model selection UI beyond what is needed for runtime correctness.

## Required implementation notes
- Search current callers of `resolveRuntimeConfig`, workflow YAML loaders, and `--runtime config` handling.
- Replace execution-time workflow YAML resolution with the PD-owned config resolver used by `pd config doctor`.
- Preserve fail-loud behavior: if config is missing/malformed, return reason + nextAction.
- If `.state/workflows.yaml` is detected, surface it only as a legacy warning/degraded note, not as an execution source.

## ERR checklist
- EP-02 / production path wiring: the paths tested must be the paths users run.
- EP-03 / fail loud: no silent fallback from `.pd/config.yaml` to `.state/workflows.yaml`.
- EP-07 / runtime state and source alignment: doctor/probe/run-once must agree on one source.
- EP-09 / test reality gap: add product-path tests, not only helper tests.

## Acceptance criteria
- `pd config doctor --workspace D:\.openclaw\workspace --json` and `pd runtime probe --workspace D:\.openclaw\workspace --runtime config --json` report the same profile and `.pd/config.yaml` source.
- `pd runtime internalization run-once --workspace ... --runner dreamer --runtime config --json` uses the same profile as doctor/probe.
- Tests cover `.state/workflows.yaml` present with conflicting provider and prove it is not used for execution.
- JSON mode remains a single parseable JSON object on stdout.
- `npm run verify:merge` passes.
