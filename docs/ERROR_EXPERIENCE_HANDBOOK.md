# Error Experience Handbook

> **MUST READ before starting any task.** This document records real errors made by AI coding assistants during code reviews. Reading it prevents repeating the same mistakes.

---

## How to Record an Error

When a code review catches an AI assistant error, use the `record-error` skill. The skill handles the full workflow automatically:

1. **Add a comment** on the Linear Issue using the entry format below
2. **Tag the issue** with `lesson-learned` label (via Linear MCP tool)
3. **Edit this file** — add a row to the category table AND add a detailed entry in the "Detailed Entries" section
4. **Update statistics** at the bottom of this file
5. **Commit and create a PR** with message `docs: add ERR-XXX to error experience handbook`

The reviewer (human) only needs to point out the error. The AI assistant invokes `record-error` to handle all recording steps.

---

## Entry Format

```
**[ERR-XXX]** | <one-line summary>

- **What happened**: <what the AI assistant did wrong>
- **Why it's wrong**: <violated constraint, unread doc, or root cause>
- **Correct approach**: <what should have been done instead>
- **How to prevent**: <concrete check or rule>
- **Source**: <Linear issue ID, e.g., PRI-147>
- **Date**: <YYYY-MM-DD>
- **Recurrence**: <if same pattern recurred, note date and issue>
```

---

## Category 1: Architecture Boundary Violations

Errors where AI assistants violated the core/plugin boundary or other architectural constraints.

| ID | Summary | Source |
|----|---------|--------|
| ERR-002 | Catch-and-degrade pattern silently swallows failure reasons | PRI-171 |
| ERR-011 | CLI commands directly import RuntimeStateManager instead of Tier 2 boundary facades | PRI-131 |

---

## Category 2: Missing Tests & Verification

Errors where AI assistants skipped required testing or verification steps.

| ID | Summary | Source |
|----|---------|--------|
| ERR-012 | PR branch based on stale main reverts already-merged telemetry fields | PR #659 |

---

## Category 3: Schema & Type Mistakes

Errors where AI assistants created incorrect schemas, missed type safety, or broke existing type contracts.

| ID | Summary | Source |
|----|---------|--------|
| ERR-001 | `as string` cast on untrusted JSON bypasses runtime validation | PRI-189 |
| ERR-003 | PII sanitizer uses `includes()` substring matching causing false-positive over-sanitization | PRI-171 |
| ERR-004 | `sourceTaskId` set to diagnostician task ID instead of located source task ID | PRI-190 |
| ERR-005 | Invalid salvaged arrays bypass type contract in validate failure path | PRI-191 |
| ERR-007 | Non-string evidenceRefs silently skipped instead of rejected in validator | PRI-192 |
| ERR-008 | Missing lineage field validation allows agent to return trace with wrong attribution | PRI-192 |
| ERR-009 | Validator silently skips missing/malformed required array fields instead of failing loud | PRI-192 |
| ERR-010 | Falsy evaluator return silently passes validation instead of recording failure | PRI-172 |
| ERR-013 | `in` operator on untrusted object matches inherited Object.prototype properties | PRI-201 |
| ERR-014 | `formatValidationErrorEntry` string values not truncated — evidence pack unbounded | PRI-200 |
| ERR-015 | Repair loop uses stale schema errors across attempts — reduced repair effectiveness | PRI-200 |
| ERR-016 | maxRepairAttempts not hard-capped — { maxRepairAttempts: 999 } runs 999 calls | PRI-200 |
| ERR-017 | JSON.stringify on unknown values can throw (BigInt, circular) — preview paths crash | PRI-200 |
| ERR-018 | repairAttempts records stale initialValidationErrors instead of per-attempt currentErrors | PRI-200 |
| ERR-019 | schemaCheck failure branch writes next iteration's errors into current attempt's record | PRI-200 |
| ERR-020 | Commander negated boolean `--no-intake` ignored — checking wrong property name | PRI-217 |

---

## Category 4: Documentation & Spec Drift

Errors where AI assistants wrote code contradicting architecture docs or ADRs.

| ID | Summary | Source |
|----|---------|--------|
| ERR-021 | Handler-only tests miss Commander flag→opts mapping bugs | PRI-217 |
| ERR-024 | Error catch block zeroes partial computation results instead of preserving them | PRI-208 |
| ERR-022 | process.exit(1) without return allows fallthrough to intake on failed diagnosis | PRI-217 |
| ERR-023 | CLI dry-run command opens writable database connection instead of readonly | PRI-218 |

---

## Category 5: Security & Safety

Errors where AI assistants introduced security risks or bypassed safety checks.

| ID | Summary | Source |
|----|---------|--------|
| ERR-022 | process.exit(1) without return allows fallthrough to intake on failed diagnosis | PRI-217 |

---

## Category 6: Process & Workflow

Errors in how AI assistants approached the task — not reading context, not following workflow.

| ID | Summary | Source |
|----|---------|--------|
| ERR-021 | Handler-only tests miss Commander flag→opts mapping bugs | PRI-217 |

---

## Detailed Entries

**[ERR-001]** | `as string | undefined` type cast on untrusted JSON bypasses runtime validation

- **What happened**: In `SqliteSourceTraceLocator.locate()`, the code used `(dj.sourcePainId ?? dj.painId) as string | undefined` to extract the pain ID from a parsed JSON object (`Record<string, unknown>`). The `as` cast silently passes non-string values (e.g., `sourcePainId: 42`), causing `taskPainId === query.sourcePainId` to always fail for non-string types because strict equality between a number and a string is always `false`.
- **Why it's wrong**: `as` is a compile-time assertion with zero runtime validation. When `diagnosticJson` contains `sourcePainId: 42` (a number), the cast silently tells TypeScript it's a string, but the actual runtime value is still `42` (number). The strict equality `42 === "42"` evaluates to `false`, producing a false `not_found` decision instead of a correct match or a type-mismatch diagnostic.
- **Correct approach**: Use `typeof rawPainId === 'string' ? rawPainId : undefined` to validate the type at runtime before using it in comparisons.
- **How to prevent**: Never use `as` type assertions on values from untrusted JSON sources (`Record<string, unknown>`). Always validate with `typeof` checks before using the value. When extracting fields from parsed JSON, treat every field as `unknown` and narrow with runtime type guards.
- **Source**: PRI-189
- **Date**: 2026-05-19
- **Recurrence**: None

---

**[ERR-002]** | Catch-and-degrade pattern silently swallows failure reasons

- **What happened**: `buildFullTraceSafe()` catch block caught all exceptions and returned `null` with no observability — no logging, no error propagation, no ambiguity notes.
- **Why it's wrong**: Downstream diagnostician receives `fullTrace: null` and cannot distinguish between "no painId provided" and "trace construction crashed". Degradation is correct design, but degradation ≠ silence. Silent degradation hides bugs and makes debugging impossible.
- **Correct approach**: Catch blocks in degrade patterns must propagate the failure reason through at least one channel: `ambiguityNotes`, telemetry, or logging.
- **How to prevent**: Every catch-and-degrade pattern must expose the failure reason via `ambiguityNotes` / telemetry / logging. Review all catch blocks that return fallback values and verify they communicate why the fallback was triggered.
- **Source**: PRI-171
- **Date**: 2026-05-19
- **Recurrence**: None

---

**[ERR-003]** | PII sanitizer uses `includes()` substring matching causing false-positive over-sanitization

- **What happened**: `SECRET_KEY_NAMES.includes()` performed substring matching, causing keys like `tokenizer` and `tokenCount` to be incorrectly sanitized because they contain the substring `"token"`.
- **Why it's wrong**: `includes('token')` matches any string containing "token" as a substring, not just the exact key "token". This causes false-positive over-sanitization, stripping diagnostic context data that the diagnostician needs to operate correctly.
- **Correct approach**: Use segment-exact matching: `keyLower === p || keyLower.endsWith('_' + p)` to match only the full key name or the key as a segment after an underscore.
- **How to prevent**: PII sanitizer key matching must use exact match or segment-boundary match. Never use `includes()` for key matching. Every sanitization rule must have a negative test case to verify it does not over-sanitize.
- **Source**: PRI-171
- **Date**: 2026-05-19
- **Recurrence**: None

---

**[ERR-004]** | `sourceTaskId` set to diagnostician task ID instead of located source task ID

- **What happened**: In `buildFullTraceV2()`, `sourceTaskId` was destructured as `{ taskId: sourceTaskId }` from `dt` (the DiagnosticianTaskRecord), which gives the *diagnostician* task's ID. But `sourceRunIds` and `timeline` come from runs fetched for the *source* candidate task (`result.candidate.taskId`). This mismatch means `sourceRefs[0]` points to the wrong task.
- **Why it's wrong**: The FullTrace V2 contract requires `sourceTaskId/sourceRunIds/timeline` to be internally consistent — all pointing to the same source execution. Using `dt.taskId` breaks this invariant and would cause downstream TraceRefiner to attach evidence to the diagnostician task instead of the actual source task.
- **Correct approach**: `locateSourceRuns()` should return `{ sourceTaskId, runs }` preserving the candidate's `taskId`, and `buildFullTraceV2()` should accept that `sourceTaskId` explicitly rather than deriving it from `dt`.
- **How to prevent**: When building a payload where field X must match data from source Y, always pass both together or derive X from Y — never mix sources. Trace the data lineage: if `sourceRunIds` come from `result.candidate.taskId`, then `sourceTaskId` must also come from `result.candidate.taskId`.
- **Source**: PRI-190
- **Date**: 2026-05-19
- **Recurrence**: None

---

**[ERR-005]** | Invalid salvaged arrays bypass type contract in validate failure path

- **What happened**: In `refineFullTrace()` validation failure path, `sourceRunIds`, `ambiguityNotes`, `sanitizationNotes` only checked `Array.isArray()` then used `as string[]` cast without validating element types. For invalid FullTrace JSON like `sourceRunIds: [42]`, this returned a `RefinedTracePayload` whose arrays violated the `string[]` contract, reintroducing the same untrusted-JSON problem the FullTrace contract was meant to avoid.
- **Why it's wrong**: `as string[]` is a compile-time assertion with zero runtime validation. When parsing untrusted JSON, a cast alone doesn't make elements strings. This would have caused downstream consumers expecting `string[]` to fail silently or incorrectly.
- **Correct approach**: When salvaging arrays from invalid JSON, filter elements with `(v): v is string => typeof v === 'string'` to keep only valid strings, otherwise return empty array.
- **How to prevent**: Never use `as` array type casts on untrusted JSON arrays without validating element types first. Always apply element-wise type guards when preserving data from invalid payloads.
- **Source**: PRI-191
- **Date**: 2026-05-19
- **Recurrence**: Yes - similar pattern to ERR-001 where `as` bypassed validation

---

**[ERR-006]** | Missed Codex PR review comments due to API failure + no retry

- **What happened**: When asked to use `pr-review` skill on an existing PR, GitHub API calls timed out and I skipped checking for PR comments completely. Missed critical Codex review feedback on type safety issues that were already identified on the PR.
- **Why it's wrong**: The PR already had the review information available, but I failed to persistently retrieve it. This caused duplicate work and delayed fixing an issue that was already found.
- **Correct approach**: When working on an existing PR, **ALWAYS** try multiple ways to get PR comments/reviews (retry API, ask user, check git log). Never skip this critical step.
- **How to prevent**: Added Rule #8 in AGENTS.md. When asked to review/fix an existing PR, FIRST fetch all comments/reviews before doing any work. Retry API at least twice, or ask user to paste comments.
- **Source**: PRI-191 / PR #637
- **Date**: 2026-05-19
- **Recurrence**: No

---

**[ERR-007]** | Non-string evidenceRefs silently skipped instead of rejected in validator

- **What happened**: In `validateTraceRefinerAgentOutput()`, the `refinedTrace.evidenceRefs` and `refinedTrace.keyEvents[].evidenceRefs` validation used `if (typeof ref === 'string' && !allowedSourceRefs.has(ref))` — when `ref` was not a string, it was silently skipped instead of being rejected as invalid.
- **Why it's wrong**: This allows structurally invalid output (e.g., `evidenceRefs: [42, null, {}]`) to pass validation and be cast as `RefinedTracePayload` via `as`. This is the same class of error as ERR-001/ERR-005 where `as` casts on untrusted data bypass runtime validation.
- **Correct approach**: When validating untrusted data, every element must be either validated or rejected. Use `if (typeof ref !== 'string') { error } else if (!allowedSourceRefs.has(ref)) { error }` pattern.
- **How to prevent**: In any validator that iterates over `unknown[]` arrays, never use `typeof x === 'string' && condition` — this silently skips non-string elements. Always handle the non-string case explicitly as an error.
- **Source**: PRI-192 / PR #638 (CodeRabbit review)
- **Date**: 2026-05-19
- **Recurrence**: Yes - same pattern as ERR-001 and ERR-005

---

**[ERR-008]** | Missing lineage field validation allows agent to return trace with wrong attribution

- **What happened**: `validateTraceRefinerAgentOutput()` validated evidenceRefs and sourceRefs anti-forgery, but did not validate that `refinedTrace.sourceTaskId`, `sourcePainId`, and `sourceRunIds` match the deterministic refined trace. An agent could return a refined trace with completely different lineage fields and the validator would accept it.
- **Why it's wrong**: The agent contract promises `preserveSourceRefs: true`, but the validator didn't enforce that the refined trace's lineage fields match the deterministic trace. This could lead to attribution errors where a refined trace is associated with the wrong task/pain.
- **Correct approach**: When validating agent output, always check that identity/lineage fields match the input. The agent can refine the content but must not change the attribution.
- **How to prevent**: For any agent contract that processes trace data, add explicit lineage field validation: `sourceTaskId`, `sourcePainId`, `sourceRunIds` must match the deterministic trace.
- **Source**: PRI-192 / PR #638 (Codex review)
- **Date**: 2026-05-19
- **Recurrence**: No

---

**[ERR-009]** | Validator silently skips missing/malformed required array fields instead of failing loud

- **What happened**: In `validateTraceRefinerAgentOutput()`, the `refinedTrace` shape validation used `if (Array.isArray(rt.sourceRunIds)) { ... }` pattern — when the field was missing, `undefined`, or non-array, the validator silently skipped it instead of reporting an error. Same for `evidenceRefs` and `keyEvents`. Additionally, `keyEvent` objects that were non-objects were skipped with `continue`, and `keyEvent.evidenceRefs` non-arrays were silently skipped.
- **Why it's wrong**: This allows structurally invalid `refinedTrace` objects (e.g., `{ sourceRunIds: "not-array", evidenceRefs: undefined, keyEvents: undefined }`) to pass validation and be cast as `RefinedTracePayload`. Even in shadow mode, downstream telemetry or analysis consumers would receive objects that don't conform to the contract. This is the same class as ERR-001/ERR-005/ERR-007 — validators must fail loud, not skip silently.
- **Correct approach**: For every required field in a validator, check that it exists and has the correct type. If it's missing or wrong type, add an error. Use `if (!Array.isArray(x)) { error } else { validate elements }` instead of `if (Array.isArray(x)) { validate elements }`.
- **How to prevent**: When writing validators for untrusted data, never use `if (hasCorrectType) { validate }` — always use `if (!hasCorrectType) { error } else { validate }`. The "skip on wrong type" pattern is always wrong for required fields.
- **Source**: PRI-192 / PR #638 (reviewer feedback)
- **Date**: 2026-05-19
- **Recurrence**: Yes - same pattern as ERR-001, ERR-005, ERR-007. Recurred 2026-05-23 in PRI-207 (PR #680): `extractJsonObject` fenced-code path parsed valid non-object JSON (array/null/string/number/boolean) but fell through to brace scan instead of returning null, allowing array payloads to be treated as objects. Same root cause: validator (fenced parse) silently skips invalid type instead of failing loud.

**[ERR-010]** | Falsy evaluator return silently passes validation instead of recording failure

- **What happened**: In `evaluateInRefinerSandbox`, the code used `if (result)` to guard validation, meaning a null/undefined return from `evaluateCode` was treated as a pass (no failure recorded).
- **Why it's wrong**: A null/undefined evaluator result is a validation failure — the evaluator failed to produce a decision. Silently passing it violates the invariant that every case must have an explicit pass/fail outcome. Same class as ERR-001/ERR-005/ERR-007/ERR-009 where falsy/invalid values bypass validation.
- **Correct approach**: Use `if (!result)` to record a `validation_failed` failure for null/undefined results, then `continue`. Only proceed to `validateCaseDecision` when `result` is truthy.
- **How to prevent**: When writing validation logic, always handle the falsy/null/undefined case explicitly as a failure. Never use `if (value)` to skip validation — use `if (!value)` to record failure.
- **Source**: PRI-172
- **Date**: 2026-05-20
- **Recurrence**: Yes - same pattern as ERR-001, ERR-005, ERR-007, ERR-009

**[ERR-011]** | CLI commands directly import RuntimeStateManager instead of Tier 2 boundary facades

- **What happened**: `runtime-canary.ts`, `runtime-diagnostics-export.ts`, and `runtime-recovery.ts` directly imported and instantiated `RuntimeStateManager` from the Store layer, bypassing the Read Model / Service facade boundary established by ADR-0001. Additionally, `createInternalizationQueueReadModel` did not support a `readonly` option, forcing read-only CLI commands (canary, diagnostics-export) to open writable database connections.
- **Why it's wrong**: ADR-0001 mandates that CLI commands use Read Models and Service facades, never directly access Store classes. Direct Store imports create tight coupling between CLI and database schema, making it impossible to evolve the store layer independently. Opening writable connections for read-only operations is a safety risk — a bug in the CLI could accidentally mutate state.
- **Correct approach**: Create Tier 2 boundary facades (`createRecoverySweepService`, `createInternalizationQueueReadModel` with `readonly` support) that encapsulate `RuntimeStateManager` lifecycle. CLI commands import only these facades, never the Store directly.
- **How to prevent**: Every new CLI command that needs database access must use an existing Read Model or Service facade from `@principles/core/runtime-v2`. If no suitable facade exists, create one first. Architecture regression tests must assert that CLI command files do not import `RuntimeStateManager`. Read-only operations must pass `readonly: true` to the facade.
- **Source**: PRI-131 (Tier 2)
- **Date**: 2026-05-21
- **Recurrence**: Yes — same boundary violation pattern as PRI-129 (trace.ts) and PRI-131 Tier 1 (health.ts, runtime-pruning.ts, runtime-internalization-queue.ts)

---

**[ERR-012]** | PR branch based on stale main reverts already-merged telemetry fields

- **What happened**: PR #659 was created from a branch that did not include the latest `origin/main` after PRI-174 merged. The PR was mostly documentation/tests, but its diff would have removed `rulehostAutoCorrectApplied` from daily stats types, initialization, update logic, and tests.
- **Why it's wrong**: A retrospective or test PR must not silently roll back code from already-merged feature work. This would have broken RuleHost auto-correct observability right after Phase 1A declared it complete.
- **Correct approach**: Before opening or reviewing a PR after related merges, rebase or merge latest `origin/main`, then inspect `git diff origin/main..HEAD --name-only` for unintended product-file regressions.
- **How to prevent**: Treat unexpected deletions in already-merged source/test files as a blocking review finding. For doc/test PRs, verify the PR diff does not include product-code rollback unless explicitly intended.
- **Source**: PR #659
- **Date**: 2026-05-21
- **Recurrence**: None

---

**[ERR-013]** | `in` operator on untrusted object matches inherited Object.prototype properties

- **What happened**: In `validateCorrectionProposal()`, the cross-check for `correctedFields[].field` against `proposedParams` used `cf.field in proposal.proposedParams`. The `in` operator traverses the prototype chain, so inherited properties like `toString`, `constructor`, `valueOf` would match even though they are not actual keys in `proposedParams`. A `correctedFields` entry with `field: 'toString'` would incorrectly pass validation, allowing the semantic-contradiction bug the cross-check was designed to prevent.
- **Why it's wrong**: When checking whether a key exists in an untrusted object (one that came from LLM output), the `in` operator is the wrong tool because it matches inherited properties from `Object.prototype`. This is the same class of error as ERR-001/ERR-005/ERR-007 where runtime semantics differ from the developer's intent due to type-system/primitive mismatches.
- **Correct approach**: Use `Object.hasOwn(obj, key)` which only checks own properties and does not traverse the prototype chain. This is the correct semantics for "is this key present in the data the agent provided".
- **How to prevent**: When checking key existence in untrusted objects (LLM output, parsed JSON, `Record<string, unknown>`), always use `Object.hasOwn()` or `Object.prototype.hasOwnProperty.call()`, never the `in` operator. Add a test case with an inherited property name (e.g., `toString`) to every validator that checks key existence.
- **Source**: PRI-201 / PR #663 (Codex review)
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-001/ERR-005/ERR-007 where runtime semantics bypass validation intent

---

**[ERR-014]** | `formatValidationErrorEntry` string values not truncated — evidence pack unbounded

- **What happened**: In `formatValidationErrorEntry()`, the `actualPreview` field returned raw string values without truncation: `typeof value === 'string' ? value : ...`. Only non-string values went through `truncatePreview()`. This violated the "bounded preview" design goal of the evidence pack — a very long string value (e.g., a 10KB error message) would bloat the evidence pack and could leak sensitive content.
- **Why it's wrong**: The evidence pack is designed to be observable and bounded. All preview fields must be size-limited. Leaving string values unbounded creates an asymmetry where `actualPreview` for strings can be arbitrarily large while non-string previews are capped at 100 chars. This is the same class as ERR-001/ERR-005 where type-specific handling creates validation gaps.
- **Correct approach**: Apply `truncatePreview(value, 100)` to the string branch as well, so all `actualPreview` values are uniformly bounded.
- **How to prevent**: When implementing "bounded preview" or "truncated" fields, verify ALL code paths that produce the field value apply the same truncation logic. Add a test case with a long string value to verify truncation.
- **Source**: PRI-200 / PR #665 (CodeRabbit review)
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-001/ERR-005 where type-specific branches bypass validation

---

**[ERR-015]** | Repair loop uses stale schema errors across attempts — reduced repair effectiveness

- **What happened**: In `attemptStructuredOutputRepair()`, the repair loop always passed the original `schemaErrors` to `formatRepairPrompt()` for every attempt, even after the candidate output had changed. When `maxRepairAttempts > 1`, the second and subsequent repair prompts would contain errors from the original output, not the current candidate. This reduces repair effectiveness because the LLM is asked to fix errors that may no longer exist while missing new errors introduced by the previous repair attempt.
- **Why it's wrong**: The repair loop updates `invalidOutput` to `candidateWithLineage` after each failed attempt, but the prompt still references the original errors. This means the LLM gets a misleading prompt — "fix these errors" — when the actual errors have changed. The `callbacks.schemaErrors` callback was available to get fresh errors but was only used for the `repairAttempts` record, not for the next prompt.
- **Correct approach**: Track `currentErrors` as a mutable variable initialized from `schemaErrors`. After each failed attempt, if `callbacks.schemaErrors` is available, refresh `currentErrors` with the latest errors from the failed candidate. Pass `currentErrors` to `formatRepairPrompt()` on each iteration.
- **How to prevent**: When implementing a retry/repair loop that re-prompts an LLM, always refresh the error context from the latest attempt before building the next prompt. Never assume the errors are static across iterations. Add a test with `maxRepairAttempts > 1` and `callbacks.schemaErrors` returning different errors on each call to verify the prompt uses updated errors.
- **Source**: PRI-200 / PR #665 (CodeRabbit review)
- **Date**: 2026-05-21
- **Recurrence**: No

---

**[ERR-016]** | maxRepairAttempts not hard-capped — { maxRepairAttempts: 999 } runs 999 calls

- **What happened**: The PR contract states "repair loop is bounded: default 1, maximum 2" but `attemptStructuredOutputRepair()` used `cfg.maxRepairAttempts` directly from the spread config without clamping. Passing `{ maxRepairAttempts: 999 }` would run 999 repair calls, violating the contract.
- **Why it's wrong**: The contract's "maximum 2" promise was only documented, not enforced in code. Any caller (including misconfigured adapters) could bypass the bound. This is the same class as ERR-001/ERR-005/ERR-014 where validation exists in prose but not in code.
- **Correct approach**: Add `MAX_REPAIR_ATTEMPTS = 2` as a hard cap constant. Add `normalizeMaxRepairAttempts()` helper that clamps, floors, handles NaN/Infinity/negative, and caps at MAX_REPAIR_ATTEMPTS. Apply normalization when building the config, not just at the loop boundary.
- **How to prevent**: When a contract specifies a numeric bound ("max N"), always enforce it with a constant and a normalization function — never trust caller input. Add tests for extreme values (999, Infinity, NaN, negative, decimal).
- **Source**: PRI-200 / PR #665 (final review)
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-001/ERR-005/ERR-014 where validation is in prose but not in code

---

**[ERR-017]** | JSON.stringify on unknown values can throw (BigInt, circular) — preview paths crash

- **What happened**: Multiple preview paths used `JSON.stringify()` directly on unknown values: `formatRepairPrompt()` used `JSON.stringify(invalidJson, null, 2)`, `attemptStructuredOutputRepair()` used `JSON.stringify(invalidOutput)` for `rawOutputPreview`, and `formatValidationErrorEntry()` used `JSON.stringify(value)`. All of these throw on BigInt values, circular references, or other unstringifiable objects.
- **Why it's wrong**: Evidence pack preview paths must never throw — they exist for observability when things go wrong. If the LLM returns a response containing BigInt or circular refs, the preview formatting would throw, masking the original error with a secondary crash. This violates the "fail-closed but observable" design principle.
- **Correct approach**: Add `safeStringifyPreview(value, maxLen)` helper that wraps `JSON.stringify` in try/catch, handles BigInt explicitly (`${value}n`), and falls back to `[unserializable: ClassName]` for objects and `String(value)` for primitives. Use it everywhere a preview is produced.
- **How to prevent**: Never use raw `JSON.stringify()` on unknown/untrusted values in observability paths. Always wrap in a safe serialization helper. Add tests for BigInt, circular refs, and Object.create(null) to verify no throws.
- **Source**: PRI-200 / PR #665 (final review)
- **Date**: 2026-05-21
- **Recurrence**: No

---

**[ERR-018]** | repairAttempts records stale initialValidationErrors instead of per-attempt currentErrors

- **What happened**: In `attemptStructuredOutputRepair()`, the repair loop computed `initialValidationErrors = buildValidationErrorEntries(schemaErrors)` once before the loop, then used it for ALL repair attempt records across all iterations. When `maxRepairAttempts > 1`, attempt 2+ would record the initial schema errors (e.g., `/confidence`) instead of the current errors from the latest failed candidate (e.g., `/summary`). This made the evidence pack misleading — it showed errors that no longer existed while hiding the actual errors that caused the repair to fail.
- **Why it's wrong**: The evidence pack is the primary observability artifact when repair fails. Recording stale errors defeats its purpose — operators would see "fix /confidence" when the real problem is /summary. The `currentErrors` variable was already tracked for prompt building but not used for the attempt record.
- **Correct approach**: Compute `attemptValidationErrors = buildValidationErrorEntries(currentErrors)` at the top of each loop iteration. All branches use `attemptValidationErrors` for the repairAttempts push. In the schemaCheck-fail branch, use `attemptValidationErrors` for the push, then update `currentErrors = nextErrors` for the next iteration.
- **How to prevent**: When a loop accumulates per-iteration records, never compute the record data outside the loop or reuse a pre-loop snapshot. Always derive record data from the current iteration's state. Add tests with `maxRepairAttempts > 1` where `callbacks.schemaErrors` returns different errors on each call.
- **Source**: PRI-200 / PR #665
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-015 where loop state was not refreshed per iteration

---

**[ERR-019]** | schemaCheck failure branch writes next iteration's errors into current attempt's record — evidence timeline misalignment

- **What happened**: In `attemptStructuredOutputRepair()`, the schemaCheck-fail branch used `buildValidationErrorEntries(nextErrors)` for `repairAttempts.push()`. This wrote the NEXT iteration's errors into the CURRENT attempt's `validationErrors` field. For example, when attempt 1 had `/confidence` errors and `schemaErrors()` returned `/summary` for the failed candidate, attempt 1's record would show `/summary` instead of `/confidence`. This is a timeline misalignment — the evidence pack says "attempt 1 was trying to fix /summary" when it was actually fixing `/confidence`.
- **Why it's wrong**: The evidence pack is the primary observability artifact when repair fails. Each repairAttempt must record the errors that THIS attempt was trying to fix, not the errors the NEXT attempt will face. Writing nextErrors into the current record conflates "what this attempt saw" with "what the next attempt will see", making the timeline impossible to follow during incident analysis.
- **Correct approach**: Use `attemptValidationErrors` (computed from `currentErrors` at the top of each iteration) for the `repairAttempts.push()` call. `nextErrors` should only be used to update `currentErrors` for the next iteration. The sequence should be: push with `attemptValidationErrors` → update `invalidOutput` → update `currentErrors = nextErrors`.
- **How to prevent**: When a loop accumulates per-iteration records, each record must use data derived from the current iteration's state ONLY. Never write state that belongs to the next iteration into the current iteration's record. Add tests that verify each attempt's record contains exactly the errors from that attempt, not from adjacent attempts.
- **Source**: PRI-200 / PR #665
- **Date**: 2026-05-21
- **Recurrence**: Yes - same class as ERR-015/ERR-018 where loop iteration state is incorrectly scoped

---

**[ERR-020]** | Commander negated boolean `--no-intake` ignored — checking wrong property name

- **What happened**: Added a `--no-intake` CLI flag to skip candidate intake in `pd diagnose run`. The code checked `opts.noIntake` to determine whether to skip intake, but Commander.js negated boolean options are exposed without the `no-` prefix — `--no-intake` sets `opts.intake` (not `opts.noIntake`), defaulting to `true` when not passed and `false` when `--no-intake` is passed. Since `opts.noIntake` was always `undefined`, the `--no-intake` escape hatch was completely ineffective.
- **Why it's wrong**: The `--no-intake` flag was documented as an escape hatch for debugging, but it silently did nothing. Users running `pd diagnose run --no-intake` would expect candidates to remain at `pending`, but they would still be consumed and written to the ledger, potentially triggering unintended side effects.
- **Correct approach**: Define the flag as `--intake` (defaulting to `true`), which allows Commander to properly expose `--no-intake` to set it to `false`. Check `opts.intake === false` instead of `opts.noIntake`.
- **How to prevent**: When using Commander.js negated boolean flags (`--no-*`), always check the property without the `no-` prefix. Add a test that verifies the flag actually works by calling the CLI with the flag and asserting the expected behavior.
- **Source**: PRI-217 / PR #677 (Codex review)
- **Date**: 2026-05-22
- **Recurrence**: None

---

**[ERR-021]** | Handler-only tests miss Commander flag→opts mapping bugs

- **What happened**: Added `--no-intake` CLI flag to `pd diagnose run`. All tests called `handleDiagnoseRun()` directly with manually constructed `opts` objects, bypassing Commander entirely. This hid two bugs: (1) Commander negated booleans strip the `no-` prefix, so `opts.noIntake` was always `undefined`; (2) `.option('--intake', ...)` does not auto-create `--no-intake`, so `pd diagnose run --no-intake` threw "unknown option".
- **Why it's wrong**: Handler-level tests prove the handler logic works, but they don't prove the CLI flag actually reaches the handler with the correct property name and value. The gap between Commander parsing and handler invocation was completely untested.
- **Correct approach**: When adding a new CLI flag, always add Commander wiring tests that: (1) parse the flag through Commander and capture the resulting opts; (2) verify the opts property name matches what the handler checks; (3) verify the default value when the flag is not passed.
- **How to prevent**: Add a "Commander wiring test" checklist item to the PR template. Every new `.option()` must have a corresponding test that calls `program.parseAsync()` with the flag and asserts the opts shape.
- **Source**: PRI-217 / PR #677
- **Date**: 2026-05-22
- **Recurrence**: None

---

**[ERR-022]** | process.exit(1) without return allows fallthrough to intake on failed diagnosis

- **What happened**: In `handleDiagnoseRun()`, the `result.status !== 'succeeded'` branch called `process.exit(1)` without a subsequent `return`. When `process.exit` is stubbed in tests (or when the handler is called from embedded contexts), execution continues past the exit call into the candidate intake code, potentially writing ledger entries for a failed diagnosis.
- **Why it's wrong**: `process.exit()` is not guaranteed to halt execution — it can be stubbed, intercepted, or the code may run in a non-Node context. Every `process.exit()` must be followed by `return` to ensure the function exits cleanly even if `process.exit` is no-op'd.
- **Correct approach**: Always add `return;` after `process.exit()`. This is a defensive coding pattern that prevents fallthrough regardless of whether `process.exit` is intercepted.
- **How to prevent**: Add an ESLint rule or lefthook check that flags `process.exit()` without a subsequent `return`. Alternatively, use a shared `fatalExit(code)` helper that always throws after exit.
- **Source**: PRI-217 / PR #677
- **Date**: 2026-05-22
- **Recurrence**: None

---

**[ERR-023]** | CLI dry-run command opens writable database connection instead of readonly

- **What happened**: `pd runtime internalization enqueue-successors` defaulted to dry-run mode but constructed `RuntimeStateManager` without `readonly: true`. This meant the dry-run path opened a writable SQLite connection, potentially mutating the database (schema migration, WAL files) even though the command was only supposed to report what it would do.
- **Why it's wrong**: Dry-run/default mode must never mutate state. Opening a writable DB connection violates the CLI dry-run contract (Command Gate rule 4: commands that can mutate state must default to dry-run). Even if no explicit write operations occur, the DB connection itself can trigger schema migration or WAL creation.
- **Correct approach**: When constructing `RuntimeStateManager` in a CLI command, always pass `readonly: isDryRun`. Dry-run/default mode must use `readonly: true`; only `--confirm` mode should use `readonly: false`.
- **How to prevent**: Add a "readonly wiring test" checklist item for every CLI command that uses `RuntimeStateManager`. Test that: (1) no flags / `--dry-run` → `readonly: true`; (2) `--confirm` → `readonly: false`.
- **Source**: PRI-218 / PR #681
- **Date**: 2026-05-23
- **Recurrence**: None

---

**[ERR-024]** | Error catch block zeroes partial computation results instead of preserving them

- **What happened**: In `pain-flood-simulation-runner.ts`, the catch block for the main simulation loop set all aggregate counters (`inputPainCount`, `acceptedPainCount`, `skippedDuplicateCount`, `candidateCount`, `taskCount`) to zero, even though the `stages` array still contained data from scenarios that completed successfully before the error. This produced internally inconsistent output where `stages` showed completed work but top-level counters reported zero.
- **Why it's wrong**: When an error occurs after partial computation, zeroing aggregate counters fabricates data — it claims nothing happened when some scenarios actually completed. This violates ERR-002 (graceful degradation must include a reason) and makes error output unobservable and internally inconsistent. Consumers that check top-level counters get a misleading picture.
- **Correct approach**: Use the existing `computeFloodTotals(stages)` helper to derive aggregate counters from the actual completed stages, preserving partial results. The error status still signals failure, but the metrics reflect reality.
- **How to prevent**: When writing catch blocks that return error/fallback results, never fabricate default values for metrics that can be derived from partial computation state. Always compute from actual data. Review all catch blocks that set counters/summaries to zero or default values and verify whether partial data is available.
- **Source**: PRI-208 / PR #684
- **Date**: 2026-05-23
- **Recurrence**: None
- **Related**: ERR-002 (silent fallback), ERR-018/ERR-019 (stale loop state)

---

| Metric | Value |
|--------|-------|
| Total lessons | 24 |
| Last updated | 2026-05-23 |
| Top category | Schema & Type |
| Recurring errors | 11 |
