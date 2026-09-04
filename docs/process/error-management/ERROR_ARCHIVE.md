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

**[ERR-019]** | schemaCheck failure branch writes next iteration's errors into current attempt's record — evidence timeline misalignment

- **What happened**: In `attemptStructuredOutputRepair()`, the schemaCheck-fail branch used `buildValidationErrorEntries(nextErrors)` for `repairAttempts.push()`. This wrote the NEXT iteration's errors into the CURRENT attempt's `validationErrors` field. For example, when attempt 1 had `/confidence` errors and `schemaErrors()` returned `/summary` for the failed candidate, attempt 1's record would show `/summary` instead of `/confidence`. This is a timeline misalignment — the evidence pack says "attempt 1 was trying to fix /summary" when it was actually fixing `/confidence`.
- **Why it's wrong**: The evidence pack is the primary observability artifact when repair fails. Each repairAttempt must record the errors that THIS attempt was trying to fix, not the errors the NEXT attempt will face. Writing nextErrors into the current record conflates "what this attempt saw" with "what the next attempt will see", making the timeline impossible to follow during incident analysis.
- **Correct approach**: Use `attemptValidationErrors` (computed from `currentErrors` at the top of each iteration) for the `repairAttempts.push()` call. `nextErrors` should only be used to update `currentErrors` for the next iteration. The sequence should be: push with `attemptValidationErrors` → update `invalidOutput` → update `currentErrors = nextErrors`.
- **How to prevent**: When a loop accumulates per-iteration records, each record must use data derived from the current iteration's state ONLY. Never write state that belongs to the next iteration into the current iteration's record. Add tests that verify each attempt's record contains exactly the errors from that attempt, not from adjacent attempts.
- **Source**: PRI-200 / PR #665
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-015/ERR-018 where loop iteration state is incorrectly scoped

**[ERR-016]** | maxRepairAttempts not hard-capped — { maxRepairAttempts: 999 } runs 999 calls

- **What happened**: The PR contract states "repair loop is bounded: default 1, maximum 2" but `attemptStructuredOutputRepair()` used `cfg.maxRepairAttempts` directly from the spread config without clamping. Passing `{ maxRepairAttempts: 999 }` would run 999 repair calls, violating the contract.
- **Why it's wrong**: The contract's "maximum 2" promise was only documented, not enforced in code. Any caller (including misconfigured adapters) could bypass the bound. This is the same class as ERR-001/ERR-005/ERR-014 where validation exists in prose but not in code.
- **Correct approach**: Add `MAX_REPAIR_ATTEMPTS = 2` as a hard cap constant. Add `normalizeMaxRepairAttempts()` helper that clamps, floors, handles NaN/Infinity/negative, and caps at MAX_REPAIR_ATTEMPTS. Apply normalization when building the config, not just at the loop boundary.
- **How to prevent**: When a contract specifies a numeric bound ("max N"), always enforce it with a constant and a normalization function — never trust caller input. Add tests for extreme values (999, Infinity, NaN, negative, decimal).
- **Source**: PRI-200 / PR #665 (final review)
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-001/ERR-005/ERR-014 where validation is in prose but not in code

**[ERR-007]** | Non-string evidenceRefs silently skipped instead of rejected in validator

- **What happened**: In `validateTraceRefinerAgentOutput()`, the `refinedTrace.evidenceRefs` and `refinedTrace.keyEvents[].evidenceRefs` validation used `if (typeof ref === 'string' && !allowedSourceRefs.has(ref))` — when `ref` was not a string, it was silently skipped instead of being rejected as invalid.
- **Why it's wrong**: This allows structurally invalid output (e.g., `evidenceRefs: [42, null, {}]`) to pass validation and be cast as `RefinedTracePayload` via `as`. This is the same class of error as ERR-001/ERR-005 where `as` casts on untrusted data bypass runtime validation.
- **Correct approach**: When validating untrusted data, every element must be either validated or rejected. Use `if (typeof ref !== 'string') { error } else if (!allowedSourceRefs.has(ref)) { error }` pattern.
- **How to prevent**: In any validator that iterates over `unknown[]` arrays, never use `typeof x === 'string' && condition` — this silently skips non-string elements. Always handle the non-string case explicitly as an error.
- **Source**: PRI-192 / PR #638 (CodeRabbit review)
- **Date**: 2026-05-19
- **Recurrence**: Yes - same pattern as ERR-001 and ERR-005

**[ERR-006]** | Missed Codex PR review comments due to API failure + no retry

- **What happened**: When asked to use `pr-review` skill on an existing PR, GitHub API calls timed out and I skipped checking for PR comments completely. Missed critical Codex review feedback on type safety issues that were already identified on the PR.
- **Why it's wrong**: The PR already had the review information available, but I failed to persistently retrieve it. This caused duplicate work and delayed fixing an issue that was already found.
- **Correct approach**: When working on an existing PR, **ALWAYS** try multiple ways to get PR comments/reviews (retry API, ask user, check git log). Never skip this critical step.
- **How to prevent**: Added Rule #8 in AGENTS.md. When asked to review/fix an existing PR, FIRST fetch all comments/reviews before doing any work. Retry API at least twice, or ask user to paste comments.
- **Source**: PRI-191 / PR #637
- **Date**: 2026-05-19
- **Recurrence**: No

**[ERR-003]** | PII sanitizer uses `includes()` substring matching causing false-positive over-sanitization

- **What happened**: `SECRET_KEY_NAMES.includes()` performed substring matching, causing keys like `tokenizer` and `tokenCount` to be incorrectly sanitized because they contain the substring `"token"`.
- **Why it's wrong**: `includes('token')` matches any string containing "token" as a substring, not just the exact key "token". This causes false-positive over-sanitization, stripping diagnostic context data that the diagnostician needs to operate correctly.
- **Correct approach**: Use segment-exact matching: `keyLower === p || keyLower.endsWith('_' + p)` to match only the full key name or the key as a segment after an underscore.
- **How to prevent**: PII sanitizer key matching must use exact match or segment-boundary match. Never use `includes()` for key matching. Every sanitization rule must have a negative test case to verify it does not over-sanitize.
- **Source**: PRI-171
- **Date**: 2026-05-19
- **Recurrence**: None

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


## Recurrence field archives — 2026-08-28 (checker >2KB size budget)

Full texts compressed out of over-limit Recurrence fields (checker prescription:
"Truncate to 3 most recent full entries; compress older ones to one-line summaries").
One-line summaries remain in the handbook; the verbatim texts live here.

### ERR-089 — compressed recurrence bullets

- 2026-08-11 PR #1299 (default-value/fallback flavor): `pd pain retry` had been fixed earlier (P1, `pain-retry.ts:331`, comment "must NOT default to test-double") to read `.pd/config.yaml` and refuse if no runtime binding instead of silently defaulting to the test-double runtime — but the sibling command `pd diagnose run` (`diagnose.ts:210`, `const runtimeKind = opts.runtime ?? 'test-double'`) was NOT audited at that time. Under the split pipeline the test-double's stale `DiagnosticianOutputV1` payload fails `DiagRootCauseOutputV1Schema` validation (missing `rootCauseCategory`/`causalChain`) → `max_attempts_exceeded`, silently producing failed/fake diagnostic data in a real workspace (rc-9-no-silent-fallback / ERR-002). Fix: mirrored the pain-retry pattern in `diagnose.ts` (+2 regression tests: refuse path, config-honored path). Lesson: when fixing a default-value/fallback bug in one CLI command, grep ALL sibling command handlers for the same default-value pattern (`grep "?? '<default>'"`) and fix each — a per-command default that silently produces wrong data is the same class as a missed gate, just expressed as a bad fallback rather than a missing check. Notably this is the THIRD time the `pain-retry.ts ↔ diagnose.ts` sibling pair has been involved in ERR-089 (also the 2026-07-03 PRI-503 admission-gate recurrence above): these two handlers share enough surface (runtime resolution, intake, admission gate) that a fix to one should always trigger a grep of the other.
- 2026-07-04 PRI-509 / PR #1186 review (original-code flavor): `maybeSeedArtificerRepair` had 4 return paths all returning the same discriminated-union variant `{ kind: 'max_iterations_reached' }`, but only 1 path (`priorRepairIteration >= 2`) called `stateManager.updateTask(taskId, { status: 'needs_human_review' })`. The other 3 paths (lineage missing, seeder missing, seeder throws) returned `max_iterations_reached` WITHOUT updating task state, leaving the task stuck in `leased` state → lease expiry → infinite re-evaluation loops. Fix: removed the in-method `updateTask` call from the `>= 2` branch and unified it in the caller — the caller now calls `updateTask` for ALL `max_iterations_reached` returns, wrapped in try/catch with a `repair_loop_mark_review_failed` event on failure (rc-9). Added 2 regression tests (seeder missing, seeder throws) verifying `updateTask` is called with `needs_human_review`. Lesson: when a helper method returns a discriminated union with N paths that ALL require the same side effect (state update, event emission, cleanup), place the side effect in the CALLER for all union variants — placing it in only one branch of the helper leaves sibling branches silently broken. The discriminated union is a contract: every variant that means "task needs review" must trigger the review-marking side effect, not just the variant the implementer happened to test first.
- 2026-07-04 PRI-442 / PR #1180 review: A-09 fix added rc-9 observability to `evaluatePainAdmissionForToolCall`'s early-return branch `if (!allowedTools.includes(toolName) || !outcome.isFailure)`. The implementer only considered the **failure sub-case** (non-write tool fails) and placed a `console.warn` at the top of the branch — but the boolean OR also makes the branch true for the **success sub-case** (any successful tool call, `!outcome.isFailure`). Result: the warn fired on every successful tool call (the happy path), the opposite of intended observability. Code-quality review caught 3 sibling issues: (1) P1 happy-path noise (warn fired on every success), (2) P2 wrong channel (`console.warn` instead of the established `SystemLogger.log` used 70 lines below at TRIGGER_DECISION and throughout `pain.ts`'s PAIN_* family), (3) P2 test only had a positive assertion for the failure case, missing a negative assertion that the success path stays silent. Fix: narrowed the log to `if (outcome.isFailure)`, switched to `SystemLogger.log(workspaceDir, 'PAIN_ADMISSION_SKIPPED', ...)`, added Case B/C negative assertion. Lesson: when adding observability/guard logic inside a boolean-OR early-return, enumerate every sub-case that makes the condition true (`!A || !B` is true when `!A` OR when `!B` OR both) and verify the intended behavior for EACH — a log that's correct for the failure sub-case may be wrong noise for the success sub-case. Also: before choosing an observability channel, grep the surrounding file + sibling files for the established pattern (here: `SystemLogger.log`, not `console.warn`).
- 2026-07-03 PRI-503 / PR #1164 (compressed): PR #1134 added `checkAdmissionGate` to 3 call sites in `candidate.ts` but missed 2 sibling commands (`pain-retry.ts`, `diagnose.ts`) calling `intakeService.intake()` without the gate. Lesson: when fixing a gate/check in one CLI command, grep ALL commands calling the same downstream API.
- 2026-06-30 PR #1132 (compressed): Consolidating N call sites into 1 left a redundant old call in place → double write. Lesson: grep ALL old call sites when consolidating.

### ERR-040 — compressed recurrence bullets

- 2026-08-25 release-update SPEC review (no Linear issue): the installer required self-contained component dependencies, but the producer still copied only dist/package metadata, the release test fabricated `node_modules`, and the plugin declared `./governance-audit` without delivering its export target after the production esbuild clean. Fixed by materializing production dependencies during bundling, validating every declared dependency before release-manifest creation, generating the export in both tsc/esbuild paths, and requiring a clean no-legacy packaged-install smoke. Prevention: every zero-install consumer contract must land with the producer and a clean consumer smoke in the same change; fixtures may not pre-create the invariant they claim the producer establishes.
- 2026-08-22 PRI-561: the same gap on the UPDATE delivery surface — the console's `/apply-full` inline updater (`doInlineFullUpdate` in pd-console `update.ts`) copied plugin/console/core/pd-cli but never `host-runtime/`, and created no `node_modules/@principles/host-runtime` resolution link (fresh installs get the link via npm install of the `file:../host-runtime` rewrite; the updater deliberately skips npm install). Any install created before 2026-08-14 (installers without bundled host-runtime) that ran a full update after 41cf97ee5 received a console dist statically importing `@principles/host-runtime` with nothing to resolve it → `ERR_MODULE_NOT_FOUND` at console startup. Fixed by adding a host-runtime copy mapping + create-if-missing junction/symlink links (mirroring installer `syncPdCli`), with a real-Node ESM resolution-probe regression test. Lesson: when a shipped package gains a new `@principles/*` dependency, EVERY delivery surface must be extended — `bundle-plugin.mjs` (publish), `installer.ts` (fresh install), AND the console inline updater (`update.ts` `/apply-full`).
- 2026-08-21 PR #1371 (RuleCode owner live-decision): the bundled console started statically importing `OPENCLAW_HOST_LIVENESS_CONTRACT` from `@principles/host-runtime`, but `bundle-plugin.mjs`'s dependency-rewrite step rewrote console's `@principles/core` → `file:../core` and never the new `@principles/host-runtime`. The packaged console therefore resolved `@principles/host-runtime` from the npm registry and crashed with an ESM named-export `SyntaxError` on clean install (source-tree tests passed because the monorepo had the package built). Fixed by rewriting console's `@principles/host-runtime` → `file:../host-runtime`, mirroring pd-cli's existing wiring; caught by `smoke-packaged-install.test.ts`. Lesson: when a new `@principles/*` package is consumed by any package `bundle-plugin.mjs` ships (pd-cli, pd-console), extend the console/cli `file:` dependency-rewrite map for it, and confirm the smoke-packaged-install test exercises that import before merging.
- 2026-08-14 PRI-524 (PR #1316 review): the new Codex plugin scripts (pd-setup/pd-status/pd-review) re-committed the exact PR #1146 error — spawning the pd .cmd shim with shell:false (EINVAL on modern Windows Node). Fixed the same way: resolve the real pd-cli JS entry under the global npm root and spawn via process.execPath. When a new consumption surface gains scripts that spawn project CLIs, grep the handbook for the CLI name first.
- 2026-08-13 PRI-523: bundled plugin retained an inlined workspace-only dependency, breaking clean install; packaging now strips and pack-tests it.
- 2026-07-03 PRI-505 / PR #1164 review: `bundle-plugin.mjs` `PLUGIN_REQUIRED` array only checked for `dist` directory existence, not the specific `dist/bundle.js` file (while PD_CLI_REQUIRED/CORE_REQUIRED correctly checked `dist/index.js`). If only `tsc` ran (no esbuild), `dist/` exists but `bundle.js` is missing — bundle passes but published plugin is broken. Fix: added `'dist/bundle.js'` to `PLUGIN_REQUIRED`.
- 2026-07-01 PR #1146: onboarding spawned a bare npm `pd` shim that fails under Windows `shell:false`; fixed by resolving the installed sibling `pd-cli/dist/index.js` and spawning it with `process.execPath`, with a regression assertion on the delivered layout.
- 2026-06-03 PRI-299 (PR #800): pd-cli imported better-sqlite3 without declaring it.
- 2026-06-02 PRI-250 (PR #794): Three missing-component issues — (1) `js-yaml`/`semver` in `devDependencies` instead of `dependencies`, npm publish stripped them; (2) console's bundled `agents.js` imports `better-sqlite3` but console `package.json` didn't declare it; (3) `installBundledCore` copies core/ but never runs `npm install`.

### ERR-024 — compressed recurrence bullets

- 2026-08-19 PR #1358 external review round 5 (verdict drift): both verdict runners persisted a durable `runnerDecision` (and, for rollout needs_revision, a pending revision intent) BEFORE their governance side effects — but the crash-RECOVERY path never consulted it: `run()` unconditionally re-invoked the LLM and overwrote the old verdict, so a non-deterministic re-run could contradict already-materialized side effects (live activation under a final reject; pending revision intent orphaned by a fresh approve; repair-seed then approved-advance; validated bearer under a needs_revision final verdict). The evaluator additionally recorded the verdict AFTER validate-bearer/seed-repair — widening the same window. Fixed by a unified `completionIntent` (pending|applied, revisionEpoch) recorded atomically with the verdict, an entry resume gate (`maybeResumePendingIntent`) that resumes idempotent effects from the durable run output WITHOUT calling the LLM, and `reopenTaskForRevision` clearing the intent so a genuine reopen is the only path to a new authoritative verdict. Rule of thumb: when a system persists a durable decision and then executes side effects, EVERY re-entry path (retry, lease-expiry recovery, reconciliation, resume) must treat that decision as the authority — a non-deterministic advisor (LLM) must never be re-consulted for a decision that is already durably recorded but not yet fully applied. Round 6 (same-day follow-up, ee7a5240) found TWO REMAINING BYPASSES of the new protocol, same root cause: (a) the rollout budget-exhausted branch recorded the verdict WITHOUT a completion intent — the "decision exists, no intent" gap re-opened the LLM window; (b) evaluator V2 rule assembly (upserts the rule artifact and flips it 'validated' — governance state consumed by RuleHostWriter.canActivate) still ran BEFORE the intent. Lesson: when introducing an authority protocol, enumerate EVERY branch that persists the decision (including terminal/degraded ones like budget-exhausted→needs_human_review) and EVERY side effect that changes consumable governance state (artifact validation flips count, not just dispatch/seed); an explicit allow-list of "what may run before the intent" (run output, own pending artifact, pure computation) vs "what must run after" (validated principle/rule, repair seed, activation/approval, revision reopen) makes the boundary checkable.
- 2026-08-19 PR #1358 final-review blocker: succeeded-transition reconciliation was gated on a resource constructed after an early return, so the idle path never ran the budget - fixed by constructing the orchestrator before all queue-state early returns; finally-blocked budgets must not depend on resources built after early returns. (full text archived)
- 2026-07-04 PRI-510 (PR#1188): EvaluatorRunnerDeps optional deps passed at only 2 of the construction sites - repair loop was dead code at runtime; centralize dep construction in one helper. (full text archived)
- 2026-06-25 PRI-467 (PR#1059): `truncateInjectionToBudget()` `blocks` param omitted `intentBlockContent` — size guard couldn't strip INTENT by priority. Fixed by adding to `blocks` + Step 1.5 strip
- 2026-06-19 PRI-408 (PR#972): `activateArtifact()` accepted `rolloutDecision='approved'` without verifying approval record — require `approvalId` + independent verification

### ERR-090 — compressed recurrence bullets

- 2026-08-25 release-update Phase 2b quality review (full text; compressed in handbook): two Windows-only defects in the release publish path. (1) A containment guard decided "is the parent a directory" with `lstatSync().isDirectory()` — on Windows a directory junction (and on POSIX a directory symlink) reports `isSymbolicLink()` via lstat, so the guard skipped path canonicalization and a junction alias of the input directory defeated the lexical containment check (`--archive <input-alias>/asset.tar` wrote the archive INTO the input). Fixed by deciding directory-ness with `statSync` (follows links) before `realpathSync` canonicalization, with a junction-alias regression test. (2) The final atomic publication `renameSync(staging, output)` failed EPERM because antivirus/indexer handles from the just-written ~270k-file payload transiently deny directory renames; fixed with a bounded retry (attempt stays one atomic rename; immutable-destination re-checked each attempt; fail loud with next action after the window). Prevention: on Windows, directory-ness checks that gate canonicalization must use stat-following semantics, and any single-rename atomic publication after a mass write needs a bounded EPERM/EACCES retry adapter (see also the atomic record adapters in the update-system SPEC Phase 4a).


<!-- Archived 2026-09-04 (PRI-634-F R2: handbook size guard) -->

**[ERR-020]** | Commander negated boolean `--no-intake` ignored — checking wrong property name

- **What happened**: Added a `--no-intake` CLI flag to skip candidate intake in `pd diagnose run`. The code checked `opts.noIntake` to determine whether to skip intake, but Commander.js negated boolean options are exposed without the `no-` prefix — `--no-intake` sets `opts.intake` (not `opts.noIntake`), defaulting to `true` when not passed and `false` when `--no-intake` is passed. Since `opts.noIntake` was always `undefined`, the `--no-intake` escape hatch was completely ineffective.
- **Why it's wrong**: The `--no-intake` flag was documented as an escape hatch for debugging, but it silently did nothing. Users running `pd diagnose run --no-intake` would expect candidates to remain at `pending`, but they would still be consumed and written to the ledger, potentially triggering unintended side effects.
- **Correct approach**: Define the flag as `--intake` (defaulting to `true`), which allows Commander to properly expose `--no-intake` to set it to `false`. Check `opts.intake === false` instead of `opts.noIntake`.
- **How to prevent**: When using Commander.js negated boolean flags (`--no-*`), always check the property without the `no-` prefix. Add a test that verifies the flag actually works by calling the CLI with the flag and asserting the expected behavior.
- **Source**: PRI-217 / PR #677 (Codex review)
- **Date**: 2026-05-22
- **Recurrence**: None

---

**[ERR-033]** | Operator failure path returns success exit code and breaks JSON contract

- **What happened**: In `pain-record.ts`, when `result.failureCategory === 'config_missing'` and `resolveRuntimeConfig()` returns a `RuntimeConfigError`, the code only printed diagnostic text to stderr and returned — without calling `process.exit(1)` and without outputting JSON in `--json` mode. Automation treated the failure as success, and JSON CLI contract was broken.
- **Why it's wrong**: CLI commands that fail must exit non-zero (CLI Command Gate rule 5: failure paths must not mutate state or appear to succeed). `--json` mode must always output exactly one parseable JSON object (CLI Command Gate rule 1). A `return` without `process.exit(1)` lets the caller continue as if the operation succeeded. This is the same class as ERR-022 (process.exit without return) and ERR-009 (silently skip invalid instead of failing loud).
- **Correct approach**: Every failure path in a CLI command must: (1) call `process.exit(1)`, (2) in `--json` mode output a structured JSON result with `status: 'failed'`, `failureCategory`, `message`, and `configError` (if applicable), (3) include `nextAction` per CLI Command Gate rule 6.
- **How to prevent**: After writing any CLI failure path, check: does it call `process.exit(1)`? Does `--json` mode output a parseable JSON result? Does the JSON include a `nextAction`? Add a test for each failure path in both text and JSON modes.
- **Source**: PRI-162 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-022, ERR-009. 2026-05-24 PR #701: `runtime-internalization-run-once.ts` catch block classified all errors as `config_error` (including runner/orchestrator failures). Fixed by introducing `ConfigResolutionError` class for `instanceof` distinction without message substring guessing.

---

**[ERR-036]** | Provider-endpoint configuration source mismatch sends real calls to wrong target

- **What happened**: In `llm-e2e-config.ts`, the `baseUrl` default was `'https://token.sensenova.cn/v1'` regardless of the `provider` value. When `LLM_E2E_PROVIDER` was overridden to `openrouter` or `minimax-cn`, the config still defaulted to the sensenova endpoint, causing real LLM calls to be sent to the wrong API target.
- **Why it's wrong**: Default endpoint URLs must be scoped to the provider they belong to. A provider-specific default that ignores the provider field is a configuration source mismatch — the same class as ERR-034 (canonical config not consumed by caller) where one config field overrides another's semantics. When the provider changes, all provider-specific defaults must change with it.
- **Correct approach**: Extract the provider variable before computing defaults. Only apply provider-specific defaults (like `baseUrl`) when the provider matches. For non-matching providers, leave the field undefined unless explicitly provided via environment variable.
- **How to prevent**: When a config has a provider-specific default, always guard it with a provider check. Test: override the provider and verify the default does not carry over from a different provider.
- **Source**: PRI-162 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-034

**[ERR-043]** | nextAction wraps entire shell command in quotes, making it unrunnable

- **What happened**: `buildSuccessOutput` for `verified_local_only` generated `Run "C:\path\pd.cmd runtime canary --workspace <path> --json"` — the entire command including arguments was wrapped in a single pair of quotes. A shell would interpret the whole string as the executable name, not a command with arguments.
- **Why it's wrong**: Shell quoting must only wrap the path component when it contains spaces. The arguments (`runtime canary --workspace ...`) must be outside the quotes. This is the same class as ERR-042 (output contract violation) — the output claims to be a runnable command but is not.
- **Correct approach**: Only quote the path portion: `Run "C:\path with spaces\pd.cmd" runtime canary --workspace <path> --json`. Paths without spaces need no quotes: `Run /opt/pd runtime canary ...`. Use `path.includes(' ')` to decide.
- **How to prevent**: When generating shell commands in output, always test that the command is syntactically valid. Add tests that verify: (1) paths without spaces are not quoted, (2) paths with spaces quote only the path, (3) the entire command is never wrapped in a single pair of quotes.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-042

---

**[ERR-037]** | UI action buttons gated only by `status`, ignoring backend actionability field

- **What happened**: Backend correctly returns `isMvpProven: false` for legacy channel records, but the approval-detail-dialog hides approve/reject buttons based solely on `approval.status === "pending"`. A legacy pending record would still show action buttons, which then fail with 403 on submit.
- **Why it's wrong**: The UI must honor the backend's actionability contract. Showing operable UI for a record that the backend will reject creates a broken UX and violates the "inactive/deferred channel should not be exposed as available" acceptance criterion.
- **Correct approach**: Pass `isMvpProven` from API response through to the dialog component. Gate action buttons with `isPending && isMvpProven !== false`. For non-MVP records, show a read-only notice instead.
- **How to prevent**: When a backend model adds an actionability field (e.g., `isMvpProven`, `canOperate`), the UI must consume it immediately. Review: does the UI's action-gating logic match the backend's action-gating logic?
- **Source**: PRI-244 / PR #706
- **Date**: 2026-05-25

---

**[ERR-038]** | Read-only GET paths create writable SqliteConnection; readonly breaks fresh workspace

- **What happened**: `ApprovalsConsoleModel` used a single `SqliteConnection` for both reads and writes. When split to readonly for GET paths, the readonly connection throws on fresh workspaces where `.pd/state.db` doesn't exist yet, causing 500 errors instead of returning empty results.
- **Why it's wrong**: GET/list/detail paths are read-only operations and must never initialize or modify the workspace DB. But `SqliteConnection({ readonly: true })` throws when the DB file doesn't exist (by design — it can't create schema). Both problems existed: (1) original code used writable connections for reads, (2) the fix didn't handle the missing-file case.
- **Correct approach**: Before attempting a readonly connection, check if the DB file exists (`stateDbExists()` gate). If not, return empty results immediately. Use readonly connection only when the DB is already present. Writable connections are reserved for approve/reject mutations.
- **How to prevent**: For any model that splits read/write connections: always add a `stateDbExists()` guard before readonly access. Test: fresh workspace (no .pd directory) GET list must return 200 with empty items, not 500.
- **Source**: PRI-244 / PR #706
- **Date**: 2026-05-25

---

**[ERR-039]** | Test `filter(isRecord)` silently discards malformed items; `if (isRecord)` skips assertions

- **What happened**: Integration tests used `items.filter(isRecord)` to extract array elements, silently discarding malformed items instead of failing. Error response assertions were wrapped in `if (isRecord(body)) { expect(...) }`, which skips the assertion entirely when the response structure is wrong. Both patterns allow tests to pass when the API contract is broken.
- **Why it's wrong**: Tests must fail-loud when the API returns unexpected structure. Silent filtering hides regressions. Conditional assertions mean a broken response format (e.g., returning a string instead of an object) would pass the test because the `if` branch is skipped.
- **Correct approach**: Use `items.every(isRecord)` with an `expect` assertion — any non-record element fails the test. For error responses, use a `requireRecord(body, label)` helper that asserts `isRecord` and returns the record unconditionally, then assert field values without conditional guards.
- **How to prevent**: Rule: never use `.filter(typeGuard)` on response arrays in tests — use `.every(typeGuard)` + `expect`. Never wrap field assertions in `if (isRecord(body))` — use `requireRecord()` that fails the test on structural mismatch. Review all test response assertions for silent-skip patterns.
- **Source**: PRI-244 / PR #706
- **Date**: 2026-05-25