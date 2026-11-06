# PRI-1118 independent evidence audit and next-stage boundary

Reviewed source head: `c6d1dc8d8ffb961a831142152fd600673b299259`.
Source run: `aa-run-20261106T1258Z`. No new host, HTTP, tool or paid calls.

## Decision

The recorded experiment failed at its original positive gate and has no control
arm. Preserve that verdict. Independently inspect the raw evidence instead of
equating a gate implementation failure with absence of the controlled path.

The existing evidence supports a narrow observation: controlled admission was
consumed, the target directive body was observed at the local fake endpoint,
and one successful read belongs to the recorded run. This is not a completed
positive/control protocol, causal effect, autonomous adherence or G1 sign-off.
The fake provider prescribed the tool action.

## Verification performed by this reviewer

- Re-ran `scripts/__tests__/aa-controlled-admission.test.mjs`: 34 passed,
  0 failed, 0 skipped, exit 0.
- Independently called the corrected `evaluatePositiveGate` using the original
  run record, cumulative ledger, plan, manifest, P0 and consumed admission.
  Used `plan.requestModel`, as the launcher does, rather than its provider-qualified
  CLI model alias. All 13 checks passed. This is a derived offline result only.
- Independently ran the existing built read model on the isolated workspace,
  window `2026-11-06T12:58:00.000Z` to `2026-11-06T13:03:00.000Z`.
  It returned one invocation, one successful `read`, one model-completion
  outcome, `strong_run`, `coverage.complete=true`, no incomplete reasons.
  Request association, adherence and improvement remain `unknown`.
- Consumed identity: session/run `88b37c98-3052-47ff-9840-37e2d21463da`,
  hook invocation `4b181412-1734-432d-a281-28e3cb68d8e8`.
- Checked exact file hashes: frozen input and manifest match the hashes in the
  consumed admission. Raw endpoint user-message hashes do NOT equal the frozen
  input hash; do not claim byte-identical user-input transmission from those
  endpoint projections. This does not negate the separately observed directive
  body, admission consumption or run-level tool association.

Local machine-readable audit (contains the complete read-model result and
source-file SHA-256 values):
`artifacts/aa-controlled-admission/aa-run-20261106T1258Z/independent-audit-codex.json`.
The original records and earlier offline reevaluation were not overwritten.
This local artifact is not a remotely published asset.

## Why progress stalled

1. The old invocation gate counted a previous run's tool entry against this run.
   A cumulative budget and per-run outcome use different scopes.
2. The old identity gate required `fixtureRef` in the consumed admission even
   though that contract does not preserve it. Fixture binding is through the
   hash-bound manifest, not an invented consumed-file field.
3. A rule to preserve failed execution history was being treated as if it also
   prohibited reporting independently verifiable facts. Preserve both: original
   failure, and bounded offline evidence assessment.

These observations do not justify silently changing preregistered acceptance
or automatically restarting the host. No additional positive run is necessary
to inspect existing facts or begin the next offline integration task.

## Next task: PRI-1116 integration evidence closure

Consume this evidence in the C01-C09 matrix, keeping component, controlled-host
observation, full protocol and behavioral outcomes separate. Identify only
remaining substantive acceptance gaps; do not reopen completed component
development solely because the control arm is absent.

Keep C04/full G1 and the positive/control protocol pending where required by the
SPEC. If a control is later run, explicitly authorize a continuation after the
historical stop and label it a separate phase; do not fabricate a paired run or
spend another tool call. Existing remaining budget is not by itself permission
to resume a stopped experiment.

PRI-1115 can meanwhile exercise deterministic aggregation with this one-run
evidence and explicit unknowns. No estimated opportunity denominator, net
benefit, causal result or observation-window completion may be invented.

## Limits and unchanged boundaries

No full-PR correctness approval is implied by this evidence audit. CI was
observed green on the reviewed head; Owner still controls merge. No production
database was read or written by this reviewer, and the earlier production
incident and its exclusion records remain separate. Do not delete or roll back
production rows. No installation, release, model call or budget expansion.
