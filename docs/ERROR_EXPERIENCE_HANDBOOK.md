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

---

## Category 4: Documentation & Spec Drift

Errors where AI assistants wrote code contradicting architecture docs or ADRs.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Category 5: Security & Safety

Errors where AI assistants introduced security risks or bypassed safety checks.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

---

## Category 6: Process & Workflow

Errors in how AI assistants approached the task — not reading context, not following workflow.

| ID | Summary | Source |
|----|---------|--------|
| *(No entries yet)* | | |

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
- **Recurrence**: Yes - same pattern as ERR-001, ERR-005, ERR-007

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

| Metric | Value |
|--------|-------|
| Total lessons | 12 |
| Last updated | 2026-05-21 |
| Top category | Schema & Type |
| Recurring errors | 5 |
