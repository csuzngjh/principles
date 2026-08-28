# Error Experience Archive

> Archived ERR entries whose last recurrence is > 90 days old. These entries are no longer active but retained for historical reference and pattern analysis.

## Purpose

This file holds ERR entries that have been moved out of `ERROR_EXPERIENCE_HANDBOOK.md` because:
- Their last recurrence was > 90 days ago (the pattern appears to be learned)
- The active handbook exceeded 50 entries and needed pruning

Archived entries are still referenced by `ERROR_PATTERN_INDEX.md` (marked `[archived]`), because the pattern itself remains valid even if the specific incidents are old.

## Archive Process

Entries are moved here by the `record-error` skill (Step 10: Archive Gate) when:
1. Total active entries in `ERROR_EXPERIENCE_HANDBOOK.md` exceed 50
2. `npm run check:error-handbook -- --audit` identifies entries with no recurrence in > 90 days

When archiving:
1. Move the full detailed entry (including Recurrence history) from handbook to this file
2. Remove the category table row from the handbook
3. Mark the entry as `[archived]` in `ERROR_PATTERN_INDEX.md` representative ERRs
4. Keep the EP pattern card active — the pattern is still relevant

## Archived Entries

<!-- Archived ERR entries moved here from ERROR_EXPERIENCE_HANDBOOK.md. -->
<!-- Format: same as ERROR_EXPERIENCE_HANDBOOK.md detailed entries. -->

**[ERR-026]** | Hand-written test database schema drifts from production, allowing invalid SQL to pass tests

- **What happened**: Real-path tests for `InternalizationChainIntegrityReadModel` created a hand-written SQLite schema with `source_task_id` in the `artifacts` table, but the production schema (in `SqliteConnection`) uses `task_id`. The `lineage_mismatch` SQL query (`SELECT source_task_id FROM artifacts`) would fail in production with "no such column", but tests passed because the test schema matched the wrong column name. Additionally, the test schema omitted `NOT NULL` constraints present in production (e.g., `content_json`), allowing test data that production would reject.
- **Why it's wrong**: When test schemas drift from production, tests provide false confidence. Invalid SQL, missing columns, and wrong column names all pass in tests but fail in production. The test becomes a tautology — it proves the code works against the test schema, not against the real schema. This is the same class as ERR-025 (tests prove isolated behavior, not production defense) and ERR-012 (stale base causes rollback) — the test environment does not reflect the real environment.
- **Correct approach**: For SQLite real-path tests, prefer using the production schema initializer (e.g., `SqliteConnection` or the actual migration function) to create the test database. If a hand-written test schema is unavoidable, add `PRAGMA table_info(tableName)` assertions that verify critical columns exist and match production definitions. Never assume column names — assert them.
- **How to prevent**: (1) Prefer production schema initializers for test databases. (2) If hand-writing test schemas, add `PRAGMA table_info` assertions for every column referenced in production SQL. (3) When a query references a column, the test must prove that column exists in the production schema definition. Review trigger: any PR that creates a `CREATE TABLE` statement in a test file must also include a `PRAGMA table_info` assertion or use the production initializer.
- **Source**: PRI-209 / PR #689
- **Date**: 2026-05-23
- **Recurrence**: None

---

**[ERR-027]** | Strategic pivot lands but executable docs and issue templates continue dispatching superseded work

- **What happened**: PR #696 introduced ADR-0014 and an MVP-First execution document that paused Attribution / Phase 1C / Phase 1D expansion, but the same merged documentation set still contained a Linear sync template directing agents to create PRI-232~236, a risk register allowing Phase 1C work in parallel, active architecture status tables marking already-delivered RuleHost work as pending, and a mandatory feature-flag gate before any registry/loader existed.
- **Why it's wrong**: For an AI-driven project, route documents and issue templates are an executable control plane. Contradictory instructions are not cosmetic drift: they dispatch canceled work, make nonexistent enforcement mechanisms mandatory, and push the project away from its declared product objective.
- **Correct approach**: When a strategy ADR changes active scope, update the executable control plane in the same convergence change: agent instructions, current roadmap, Linear sync plan, risk register, active architecture status, user-facing scope statements, and live Linear issue states. Historical analysis may remain only with a prominent `DO NOT DISPATCH` marker and restart condition.
- **How to prevent**: Before merging a strategy pivot, search for the superseded issue IDs, phase names, component names, and gate requirements across active docs and Linear. Require one explicit table of active, deferred/canceled, and stretch issues. Do not state a governance gate is mandatory until a production enforcement path and test exist.
- **Source**: PRI-252 / follow-up to PR #696
- **Date**: 2026-05-24
- **Recurrence**: None

---

**[ERR-085]** | Intermediate checks and silent coercions bypass canonical validator — specific schema errors masked as generic reasons, unknown enum values silently coerced to defaults

- **What happened**: Two trust-boundary defects in PR #1079's `RuleHostWriter.extractGoldenTrace()` and `migrate-illegal-expected-decision.ts`:
  1. `extractGoldenTrace()` performed intermediate checks (`cases` non-empty, `traceId` non-empty) before calling the canonical `validateGoldenTrace()`. When these intermediate checks failed, the function returned `no_golden_trace` — masking the real schema violation (e.g. empty cases, missing traceId) with a less actionable "missing trace" reason. The owner saw `no_golden_trace` when the actual problem was "cases array missing required positive/negative entries".
  2. `normalizeExpectedDecision()` in the migration script coerced any unknown `kind` value to `block` via `kind === 'positive' ? 'allow' : 'block'`. An artifact with `kind: "shadow"` (illegal) and `expectedDecision: "requireApproval"` would be silently rewritten to `block`, hiding the data-quality issue from the operator.
- **Why it's wrong**: When a canonical validator exists (`validateGoldenTrace()`), intermediate field-level checks must NOT short-circuit it — they steal the validator's chance to produce actionable, specific error details. Silent coercion of unknown enum values to a default violates rc-9 (no silent fallback): the operator never learns the data was malformed. Both defects share the root cause: bypassing the canonical validator's specific, observable error surface.
- **Generalized failure mode**: When a canonical validator exists for a schema, intermediate checks must defer to it (not preempt it) so failure reasons stay specific and actionable; and unknown enum values must be recorded for manual review, never silently coerced to a "safe" default.
- **Correct approach**: (1) In `extractGoldenTrace()`, only check `typeof trace !== 'object' || trace === null || Array.isArray(trace)` to decide `no_golden_trace`; once it's an object, defer ALL field validation to `validateGoldenTrace()` and surface `golden_trace_schema_invalid: <detail>`. (2) In `normalizeExpectedDecision()`, only map explicit `kind === 'positive'` → `'allow'` and `kind === 'negative'` → `'block'`; for any other `kind`, return `null` and record the artifact in `issues[]` for manual review.
- **How to prevent**: (1) When writing a validator wrapper, ask: "Does my intermediate check produce a MORE specific reason than the canonical validator?" If no, delete the intermediate check. (2) For any coercion/default rule on enum-like fields, ask: "Can I distinguish 'default applies because value is X' from 'default applies because value is unknown'?" If no, the unknown case must be reported, not coerced. (3) Code-review checklist: grep for `? 'allow' : 'block'` and `'block' : 'allow'` ternaries in normalization code — every branch must be an explicit enum match.
- **Regression guard**: `rule-host-writer.test.ts` "rejects artifact with empty GoldenTrace cases" now asserts `golden_trace_schema_invalid` (not `no_golden_trace`); "rejects artifact with illegal expectedDecision" asserts `gateDeps.evaluateInSandbox` was NOT called, proving the schema guard (not the sandbox) is the defense. Migration script's `issues[]` array captures unknown-kind cases for manual review.
- **Related ERRs**: ERR-001, ERR-005, ERR-009, ERR-010, ERR-069 (same trust-boundary pattern group — `as`/intermediate checks/silent defaults bypass canonical validation); ERR-002 (silent degradation without observability — rc-9)
- **Source**: PR #1079
- **Date**: 2026-06-27
- **Recurrence**: None

---

**[ERR-086]** | Batch DB mutations in migration script not wrapped in transaction — partial failure leaves DB in inconsistent half-migrated state

- **What happened**: `migrate-illegal-expected-decision.ts` Step 4 ("应用修复") iterated over artifacts needing fixes and called `db.prepare('UPDATE pi_artifacts ...').run(...)` once per artifact without any transaction wrapping. If the script crashed, threw, or was interrupted (Ctrl+C, OOM, power loss) after updating some artifacts but before others, the DB would be left in a half-migrated state: some artifacts have corrected `expectedDecision`, others still have `requireApproval`. The operator has no way to know which subset was modified without inspecting each row.
- **Why it's wrong**: Migration scripts that mutate multiple rows must be atomic — either ALL rows are updated or NONE are. Without a transaction, a partial failure creates an inconsistent state that is strictly worse than no migration at all: the operator believes "the script ran" but the data is half-fixed, and re-running the script may skip already-fixed rows (depending on idempotency) or re-fix them (depending on logic). This violates the CLI Command Gate implicit contract that failure paths must not leave partial state.
- **Generalized failure mode**: When a migration or batch-mutation script modifies multiple DB rows, the entire mutation set must be wrapped in a single transaction (`db.transaction(() => { ... })()`) so partial failures roll back to the pre-migration state. Better-sqlite3's `db.transaction()` makes this trivial.
- **Correct approach**: Wrap the entire Step 4 loop in `const applyTx = db.transaction(() => { for (...) { ... } }); applyTx();`. If any `UPDATE` throws (e.g. DB locked, disk full, constraint violation), the transaction auto-rolls-back and the exception propagates — leaving the DB untouched. The script can then be safely re-run after the underlying issue is resolved.
- **How to prevent**: (1) Code-review checklist for any script that loops `db.prepare(...).run()`: "Is this loop inside `db.transaction(() => { ... })()`?" If no, block the PR. (2) Better-sqlite3 idiom: prefer `const tx = db.transaction(() => { ... }); tx()` over manual `BEGIN`/`COMMIT`/`ROLLBACK` (handles nested transactions and exception rollback automatically). (3) Test by killing the script mid-loop (Ctrl+C) and verifying the DB is unchanged.
- **Regression guard**: Manual smoke test — run `--write` mode, interrupt with Ctrl+C after first UPDATE, verify all artifacts still have original `expectedDecision` (transaction rolled back). The script's `[summary]` log now reports "transaction committed" only after the transaction completes.
- **Related ERRs**: ERR-071 (async cleanup not awaited — same "cleanup/lifecycle hygiene" class), ERR-074 (inner try/catch exit tunnel bypasses outer cleanup — same "transactional boundary" concern)
- **Source**: PR #1079
- **Date**: 2026-06-27
- **Recurrence**: None

---

**[ERR-087]** | Domain-specific generator lacks precondition guard — write-path templates applied to non-write tools, producing semantically wrong negative cases

- **What happened**: In PRI-485 Phase 6, `generateV2CasesFromArtificer()` (packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts) generated 5 v2 adversarial cases for ANY `canonicalKind` returned by `canonicalizeToolKind()`. But the 5 templates (alias/path-boundary/combination) are write-path semantics — they assume the action tool is a write tool. For non-write tools (read/search/execute/agent/other), the generated cases are semantically wrong: e.g. `v2-path-boundary` expects `block` on a `read_file` tool, which a correct read-rule would never do. This would cause the Evaluator to reject valid read-path rules during adversarial replay.
- **Why it's wrong**: The function's type signature accepts all `CanonicalKind` values (`read | search | write | execute | agent | other`), but its implementation only correctly handles `write`. This is a type contract overpromise — the signature promises more than the implementation delivers. The spec §10.1 acceptance scenarios are ALL write-oriented, which created a blind spot: the generator was coded to the spec's examples without considering what happens for non-write inputs the spec didn't mention.
- **Generalized failure mode**: When implementing a generator whose templates are domain-specific (proven by spec examples all being one domain), assistants must add a precondition guard that filters non-applicable inputs and degrades with structured telemetry (rc-9), otherwise the generator produces semantically wrong artifacts for unhandled domains.
- **Correct approach**: Before calling `generateV2ContextAdversarialCases()`, check `canonicalKind !== 'write'` and degrade to `[]` with a telemetry event carrying `reason` + `nextAction` + `toolName` + `canonicalKind`. Non-write tools fall back to LLM-supplied adversarial cases only.
- **How to prevent**: 30-second PR-review check — when a generator produces domain-specific artifacts from a generic input type (enum/union), verify: (1) does the spec/acceptance criteria cover ALL values of the input type, or only a subset? (2) if only a subset, is there a precondition guard filtering non-applicable values? (3) is there a regression test asserting the guard fires for a non-applicable value? If any answer is no, the generator has a domain blind spot.
- **Regression guard**: `packages/principles-core/src/runtime-v2/__tests__/evaluator-runner-vslice-v2.test.ts` — "PRI-485 Phase 6: v2 cases skipped when canonicalKind is non-write (read tool)" asserts: (a) trace captured with only 3 LLM cases (no v2 caseIds), (b) telemetry event `evaluator_v2_adversarial_cases_skipped` emitted with `reason: 'non_write_canonical_kind_for_v2_adversarial_cases'` and `canonicalKind: 'read'`.
- **Related ERRs**: ERR-069 (writing against remembered contract instead of actual schema — same pattern group: spec-driven blind spot), ERR-025 (test reality gap — fixtures used read_file and passed without asserting semantic correctness), EP-02 (production path wiring — component exists but real inputs it can't handle break it).
- **Source**: PRI-485 / PR #1102 (CodeRabbit review)
- **Date**: 2026-06-29
- **Recurrence**: None

---

**[ERR-028]** | Baseline fixture directly constructs writer instead of routing through production dispatcher

- **What happened**: `proven-channel-baseline.ts` directly constructed `PromptWriter`, `RuleHostWriter`, and `DeferArchiveWriter` instances and called `canActivate()`/`activate()` on them, then claimed the results proved production continuity. But the real production path routes through `ActivationDispatcher.dispatch()`, which performs writer selection, gate evaluation, approval queue routing, and idempotency checks.
- **Why it's wrong**: A baseline that bypasses the production dispatcher proves the writer works in isolation, not that the production activation path works. This is the same class as ERR-024/ERR-025 (validator/helper tested in isolation but not wired into production path). The baseline would pass even if the dispatcher was broken.
- **Correct approach**: Baseline fixtures must route through the same `ActivationDispatcher.dispatch()` path used by production, with in-memory read models. The fixture's `evidenceSource` must reference `ActivationDispatcher.dispatch` to prove the real path was exercised.
- **How to prevent**: For any baseline/continuity fixture, the test must exercise the same entry point as production code. If production uses a dispatcher/facade/mediator, the fixture must use it too. Never test the leaf component and claim the tree is healthy.
- **Source**: PRI-240 / PR #699
- **Date**: 2026-05-24
- **Recurrence**: Yes - same class as ERR-024, ERR-025
- **Archived**: 2026-08-25 (no recurrence in > 90 days)

---

**[ERR-031]** | Config resolver hard-fails on valid runtime when optional mode flags are absent

- **What happened**: `resolvePDConfig()` required `--openclaw-local` or `--openclaw-gateway` when `runtimeKind === 'openclaw-cli'`, but the `run-once` command and `--runtime config` path don't always expose these flags. This made previously supported `openclaw-cli` runtime paths unreachable.
- **Why it's wrong**: Making optional mode flags mandatory breaks backward compatibility and violates the principle that config resolution should succeed when the runtime kind is valid. The mode can be resolved later by the consumer. This is the same class as ERR-009 (required field check that's too strict for the actual use case).
- **Correct approach**: When `runtimeKind === 'openclaw-cli'` and neither mode flag is set, set `openclawMode = undefined` instead of failing. The mode is optional metadata that the consumer can resolve. Only fail when both flags are set (mutually exclusive).
- **How to prevent**: When adding validation to a config resolver, distinguish between "required for the resolver to produce a valid config" and "required for the consumer to operate". The resolver should produce the config; the consumer should validate its own requirements. Add tests for each runtime kind without optional flags.
- **Source**: PRI-162 / PR #700
- **Date**: 2026-05-24
- **Recurrence**: None
- **Archived**: 2026-08-25 (no recurrence in > 90 days)

---

**[ERR-044]** | Structured failure reason hardcoded to console gap regardless of actual failure

- **What happened**: `buildSuccessOutput` always set `reason: 'owner_review_console_not_deliverable'` when `isComplete` was false, even when the actual failure was `plugin: 'failed'` or `cli: 'failed'`. A user seeing `reason: owner_review_console_not_deliverable` would investigate the console, but the real problem was a broken CLI or plugin.
- **Why it's wrong**: The `reason` field is a contract with the caller for diagnostics and automated remediation. An incorrect reason misdirects troubleshooting. This is the same class as ERR-002 (silent degradation hides failure reason) and ERR-042 (output does not reflect actual state).
- **Correct approach**: Compute the reason from the actual component statuses: `plugin_failed`, `cli_failed`, `console_not_deliverable`. When multiple components fail, comma-separate the reasons. Never hardcode a single reason when multiple failure modes exist.
- **How to prevent**: When a function has multiple failure paths, the output must distinguish them. Add tests that: (1) each failure mode produces a distinct reason, (2) the reason does not mention unrelated components, (3) multiple failures produce a combined reason.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-002, ERR-042
- **Archived**: 2026-08-25 (no recurrence in > 90 days)

---

**[ERR-046]** | Rollback failure silently swallowed — install result may falsely claim old state restored

- **What happened**: `restoreBackup()` caught its own errors and only logged them. The install catch block then returned `success: false` with `nextAction: 'Previous install has been restored if it existed'` — but if rollback failed, the previous install was NOT restored and the user received misleading guidance.
- **Why it's wrong**: After a failed install + failed rollback, the system is in an uncertain state. Telling the user "previous install restored" when it wasn't is worse than no message at all — it prevents the user from taking corrective action. This is the same class as ERR-002 (silent degradation hides failure reason).
- **Correct approach**: `restoreBackup` returns `{ restored: boolean; error?: string }`. The install catch block distinguishes: (1) install failed, rollback succeeded → normal failure with restored state; (2) install failed, rollback failed → CRITICAL, state uncertain, manual intervention required. JSON output `reason` includes `install_failed_rollback_failed` for the second case.
- **How to prevent**: Any function that can fail must report its outcome. When composing operations (install + rollback), each failure mode must be distinguishable in the output. Never assume a recovery action succeeded without confirmation.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-002, ERR-044
- **Archived**: 2026-08-25 (no recurrence in > 90 days)

---

**[ERR-047]** | Non-boolean enabled field in feature flags silently treated as disabled

- **What happened**: `readEnabledChannelsFromDisk()` checked `flag.enabled === true` but did not validate that `enabled` was a boolean. YAML values like `enabled: "true"` (string), `enabled: 1` (number), or `enabled: null` were silently treated as disabled, since strict equality `=== true` fails for non-boolean types.
- **Why it's wrong**: A user writing `enabled: "true"` in YAML expects the channel to be enabled. Silently treating it as disabled violates the principle of least surprise and violates Runtime Contract Rule 3 (required fields must fail loud when malformed). This is the same class as ERR-001/ERR-005 (using `===` comparison instead of runtime type validation).
- **Correct approach**: Validate `typeof flag.enabled === 'boolean'` before comparing. Non-boolean values throw a structured error with the configPath, channel name, actual type, and remediation instructions.
- **How to prevent**: When validating configuration fields, always check the type first, then the value. Never rely on strict equality to implicitly reject wrong types — it silently accepts the wrong behavior instead of failing loud.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-001, ERR-005
- **Archived**: 2026-08-25 (no recurrence in > 90 days)

---

## Archived Recurrence Records

### ERR-024 — recurrence record moved for size budget (2026-08-26, PRI-606)

- 2026-05-24 PRI-227 (PR#698): Nocturnal guard `if (isFrozenImport) continue;` was fail-open — removed bypass. (Original entry: ERR-024 Recurrence list in ERROR_EXPERIENCE_HANDBOOK.md; moved out when the handbook hit its 300KB size cap.)

### ERR-024 Recurrence full-text archive (2026-08-26, PRI-606 size budget; summaries remain in handbook)

- 2026-08-19 PR #1358 final-review blocker A self-review: the succeeded-transition reconciliation was moved into a per-cycle bounded budget executed in `runConsumerCycle`'s `finally`, but the budget was gated on `if (orchestrator)` — and the orchestrator was constructed only AFTER the `!decision.shouldConsume` early return. With `readyTaskCount === 0` (the pure crash-orphan scenario the reconciliation exists for: task succeeded → crash before commit → queue empty), the cycle returned before construction and the budget never ran — the safety net existed with green orchestrator-level tests (A1/A3/A4) but was dead on exactly the production path it was built to defend. Fixed by constructing the orchestrator immediately after the state handle opens (before all queue-state early returns) and adding the A2-idle test that recovers an orphan through the REAL `runConsumerCycle` with an empty queue. Rule of thumb: a finally-blocked budget/cleanup must not depend on any resource constructed after an early-return branch — enumerate every early return between handle-open and the budget and prove the budget still runs on each.
- 2026-07-04 PRI-510 (PR#1188, fixing PRI-509/PR#1186): `EvaluatorRunnerDeps` added optional `isRepairLoopEnabled` + `seedArtificerRepairTask` with isolated tests in `evaluator-runner.ts`, but 2 CLI construction sites (`rulehost-pipeline-runner.ts:366`, `runtime-internalization-run-once.ts:518`) only passed the 5 base deps — repair loop was dead code at runtime. Fixed by centralizing deps construction in `createEvaluatorRunnerDeps` helper used by both CLI sites.
- 2026-08-20 PR #1358 final authority-reset round (ab173bd5, post-freeze): the `pd runtime internalization retry` Owner out-edge was built BEFORE the `completionIntent` authority protocol landed (round 5/6), and was never re-audited against it — retry cleared only `runnerDecision` and kept `completionIntent`, so after requeue the entry gate resumed/finalized the OLD verdict with zero LLM calls: the Owner's "retry" never actually re-ran the machine loop (INV-03 violated), silently. It also performed two durable writes (`updateTaskDiagnosticJson` then `updateTask`), leaving a "authority cleared but task still needs_human_review" partial-Owner-action window between them. Fixed by making Owner retry an explicit authority reset in ONE atomic `updateTask` patch (status=pending + attemptCount=0 + runnerDecision AND completionIntent cleared together; un-hydratable metadata fails closed as `metadata_invalid`), with real-store + real-Runner tests proving llmCalls=1 and the new verdict becomes authority. Rule of thumb (complements round 6): when introducing (or inheriting) an authority protocol, enumerate not only every branch that PERSISTS the decision and every side effect, but also every path that RESETS or re-enters the decision (owner retry/revise edges, requeue commands, reopening tooling) — each must either preserve the intent (crash/lease/auto retry ⇒ resume) or clear it atomically with the state flip (explicit Owner action ⇒ new authority allowed); and an Owner mutation that spans two durable writes is a partial-action window — merge it into one store patch.

## Full-entry archive (2026-08-28, ERR-110 size budget)

**[ERR-010]** | Falsy evaluator return silently passes validation instead of recording failure

- **What happened**: In `evaluateInRefinerSandbox`, the code used `if (result)` to guard validation, meaning a null/undefined return from `evaluateCode` was treated as a pass (no failure recorded).
- **Why it's wrong**: A null/undefined evaluator result is a validation failure — the evaluator failed to produce a decision. Silently passing it violates the invariant that every case must have an explicit pass/fail outcome. Same class as ERR-001/ERR-005/ERR-007/ERR-009 where falsy/invalid values bypass validation.
- **Correct approach**: Use `if (!result)` to record a `validation_failed` failure for null/undefined results, then `continue`. Only proceed to `validateCaseDecision` when `result` is truthy.
- **How to prevent**: When writing validation logic, always handle the falsy/null/undefined case explicitly as a failure. Never use `if (value)` to skip validation — use `if (!value)` to record failure.
- **Source**: PRI-172
- **Date**: 2026-05-20
- **Recurrence**: Yes - same pattern as ERR-001, ERR-005, ERR-007, ERR-009
- **Archived**: 2026-08-28 (no activity for 100 days; handbook size budget for ERR-110)

**[ERR-015]** | Repair loop uses stale schema errors across attempts — reduced repair effectiveness

- **What happened**: In `attemptStructuredOutputRepair()`, the repair loop always passed the original `schemaErrors` to `formatRepairPrompt()` for every attempt, even after the candidate output had changed. When `maxRepairAttempts > 1`, the second and subsequent repair prompts would contain errors from the original output, not the current candidate. This reduces repair effectiveness because the LLM is asked to fix errors that may no longer exist while missing new errors introduced by the previous repair attempt.
- **Why it's wrong**: The repair loop updates `invalidOutput` to `candidateWithLineage` after each failed attempt, but the prompt still references the original errors. This means the LLM gets a misleading prompt — "fix these errors" — when the actual errors have changed. The `callbacks.schemaErrors` callback was available to get fresh errors but was only used for the `repairAttempts` record, not for the next prompt.
- **Correct approach**: Track `currentErrors` as a mutable variable initialized from `schemaErrors`. After each failed attempt, if `callbacks.schemaErrors` is available, refresh `currentErrors` with the latest errors from the failed candidate. Pass `currentErrors` to `formatRepairPrompt()` on each iteration.
- **How to prevent**: When implementing a retry/repair loop that re-prompts an LLM, always refresh the error context from the latest attempt before building the next prompt. Never assume the errors are static across iterations. Add a test with `maxRepairAttempts > 1` and `callbacks.schemaErrors` returning different errors on each call to verify the prompt uses updated errors.
- **Source**: PRI-200 / PR #665 (CodeRabbit review)
- **Date**: 2026-05-21
- **Recurrence**: No
- **Archived**: 2026-08-28 (no activity for 99 days; handbook size budget for ERR-110; the EP-05 pattern card carries the rule)
