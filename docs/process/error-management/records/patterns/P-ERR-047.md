<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-047",
  "displayId": "ERR-047",
  "title": "Non-boolean enabled field in feature flags silently treated as disabled",
  "status": "archived",
  "category": null,
  "ep": null,
  "createdAt": "2026-05-26",
  "source": "PRI-247 / PR #721",
  "trailerLines": [
    "- **Archived**: 2026-08-25 (no recurrence in > 90 days)",
    "## Archived Recurrence Records",
    "### ERR-024 — recurrence record moved for size budget (2026-08-26, PRI-606)",
    "- 2026-05-24 PRI-227 (PR#698): Nocturnal guard `if (isFrozenImport) continue;` was fail-open — removed bypass. (Original entry: ERR-024 Recurrence list in ERROR_EXPERIENCE_HANDBOOK.md; moved out when the handbook hit its 300KB size cap.)",
    "### ERR-024 Recurrence full-text archive (2026-08-26, PRI-606 size budget; summaries remain in handbook)",
    "- 2026-08-19 PR #1358 final-review blocker A self-review: the succeeded-transition reconciliation was moved into a per-cycle bounded budget executed in `runConsumerCycle`'s `finally`, but the budget was gated on `if (orchestrator)` — and the orchestrator was constructed only AFTER the `\u0021decision.shouldConsume` early return. With `readyTaskCount === 0` (the pure crash-orphan scenario the reconciliation exists for: task succeeded → crash before commit → queue empty), the cycle returned before construction and the budget never ran — the safety net existed with green orchestrator-level tests (A1/A3/A4) but was dead on exactly the production path it was built to defend. Fixed by constructing the orchestrator immediately after the state handle opens (before all queue-state early returns) and adding the A2-idle test that recovers an orphan through the REAL `runConsumerCycle` with an empty queue. Rule of thumb: a finally-blocked budget/cleanup must not depend on any resource constructed after an early-return branch — enumerate every early return between handle-open and the budget and prove the budget still runs on each.",
    "- 2026-07-04 PRI-510 (PR#1188, fixing PRI-509/PR#1186): `EvaluatorRunnerDeps` added optional `isRepairLoopEnabled` + `seedArtificerRepairTask` with isolated tests in `evaluator-runner.ts`, but 2 CLI construction sites (`rulehost-pipeline-runner.ts:366`, `runtime-internalization-run-once.ts:518`) only passed the 5 base deps — repair loop was dead code at runtime. Fixed by centralizing deps construction in `createEvaluatorRunnerDeps` helper used by both CLI sites.",
    "- 2026-08-20 PR #1358 final authority-reset round (ab173bd5, post-freeze): the `pd runtime internalization retry` Owner out-edge was built BEFORE the `completionIntent` authority protocol landed (round 5/6), and was never re-audited against it — retry cleared only `runnerDecision` and kept `completionIntent`, so after requeue the entry gate resumed/finalized the OLD verdict with zero LLM calls: the Owner's \"retry\" never actually re-ran the machine loop (INV-03 violated), silently. It also performed two durable writes (`updateTaskDiagnosticJson` then `updateTask`), leaving a \"authority cleared but task still needs_human_review\" partial-Owner-action window between them. Fixed by making Owner retry an explicit authority reset in ONE atomic `updateTask` patch (status=pending + attemptCount=0 + runnerDecision AND completionIntent cleared together; un-hydratable metadata fails closed as `metadata_invalid`), with real-store + real-Runner tests proving llmCalls=1 and the new verdict becomes authority. Rule of thumb (complements round 6): when introducing (or inheriting) an authority protocol, enumerate not only every branch that PERSISTS the decision and every side effect, but also every path that RESETS or re-enters the decision (owner retry/revise edges, requeue commands, reopening tooling) — each must either preserve the intent (crash/lease/auto retry ⇒ resume) or clear it atomically with the state flip (explicit Owner action ⇒ new authority allowed); and an Owner mutation that spans two durable writes is a partial-action window — merge it into one store patch.",
    "## Full-entry archive (2026-08-28, ERR-110 size budget)"
  ]
}
-->

**Recurrence**: Same class as ERR-001, ERR-005
