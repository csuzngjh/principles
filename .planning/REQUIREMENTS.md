# Requirements: v1.13 Boundary Contract Hardening

## Milestone Goal

Remove the systemic "implicit assumption + silent fallback" failure mode from the nocturnal production path so boundary errors fail fast instead of corrupting state or creating misleading downstream noise.

## Scope

This milestone is intentionally narrow. It does not add new product features. It hardens the existing production loop so current nocturnal, pain, replay, and operator flows can be trusted.

## Requirements

### Workspace Resolution

- `BC-01` All hooks, commands, workers, and HTTP routes must resolve workspace directories through one shared contract entry.
- `BC-02` No production path may fall back to `api.resolvePath('.')` for workspace resolution.
- `BC-03` If workspace resolution fails, the caller must stop and emit an explicit error instead of writing into a guessed directory.

### Critical Data Contracts

- `SCHEMA-01` `.pain_flag` reads must go through one shared parser/validator contract.
- `SCHEMA-02` sleep-reflection snapshot ingress and related worker inputs must be schema-checked before use.
- `SCHEMA-03` parse failures or missing required fields must surface as explicit failures or skips, not empty/default "success" objects.

### Runtime Capability Contract

- `RT-01` Background workflow capability checks must not rely on `constructor.name === 'AsyncFunction'`.
- `RT-02` Background execution must distinguish "runtime unavailable" from downstream task failures, so workflow state reflects the real root cause.
- `RT-03` `/pd-reflect` and related manual triggers must use the same runtime and workspace contracts as the worker path.

### End-to-End Validation

- `E2E-01` A pain signal written in the correct workspace must enqueue and preserve the correct `session_id` and context.
- `E2E-02` Hook and command paths must prove they write under the active workspace `.state`, never HOME.
- `E2E-03` Nocturnal candidate session selection must be time-bounded to the triggering pain/task context.

## Out of Scope

- New nocturnal features
- UI/dashboard improvements
- LoRA or fine-tune internalization paths
- General code cleanup that does not reduce boundary risk

## Success Criteria

1. No remaining production path writes state based on `api.resolvePath('.')`.
2. Critical state-file and snapshot parsing goes through shared validation, not scattered ad-hoc readers.
3. Background runtime checks stop guessing and produce explicit, causally correct states.
4. End-to-end tests catch wrong-workspace writes, missing contract fields, and time-unbounded snapshot selection.

*Last updated: 2026-04-11*
