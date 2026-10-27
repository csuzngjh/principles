---
'@principles/codex-adapter': patch
'@principles/host-runtime': patch
---

Codex explicit pain statement: fix evidence-promotion ordering.

- Run the live observation ingestion BEFORE the explicit registration in
  pd-hook, so the FIRST `PD记录痛苦：` submission of a rollout promotes its
  evidence window instead of degrading with rollout_not_found /
  trigger_not_found (the trigger observation used to be written only by the
  ingestion pass that ran after the registration).
- Promote evidence BEFORE enqueuing the Diagnostician task, closing the
  window where a fast worker could start the first diagnosis before the
  available evidence window was promoted.
- With codex_conversation_ingestion disabled, skip promotion and disclose
  `conversation_ingestion_disabled` in the receipt (no transcript read, no
  session observation, no misleading missing-substrate reason).
- ensureGovernanceDiagnosticianTask: a concurrent ensure racing on the same
  deterministic task id now converges on the existing task instead of
  reporting task_submit_failed:UNIQUE while the task actually exists.
