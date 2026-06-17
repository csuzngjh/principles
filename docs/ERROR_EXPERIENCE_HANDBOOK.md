# Error Experience Handbook

> **INCIDENT LOG.** For ordinary coding tasks, start with `docs/ERROR_PATTERN_INDEX.md` and then read the detailed entries it references. Read this full file when recording a new error, auditing error history, or when the compact index does not cover the task.

---

## How to Record an Error

When a code review catches an AI assistant error, use the `record-error` skill. The skill handles the full workflow automatically:

1. **Add a comment** on the Linear Issue using the entry format below
2. **Tag the issue** with `lesson-learned` label (via Linear MCP tool)
3. **Edit this file** — add a row to the category table AND add a detailed entry in the "Detailed Entries" section
4. **Update statistics** at the bottom of this file
5. **Update `docs/ERROR_PATTERN_INDEX.md`** if the error creates or changes a recurring pattern
6. **Run `npm run check:error-handbook`** to catch duplicate IDs and stale pattern references
7. **Commit and create a PR** with message `docs: add ERR-XXX to error experience handbook`

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
| ERR-024 | Security validator exists but is not wired into enforcement path — defense is illusory | PRI-210 |
| ERR-040 | Published artifact missing components that source-tree tests assume exist | PRI-247 |
| ERR-041 | Install success reported when delivered components are incomplete | PRI-247 |
| ERR-042 | Output reports requested config instead of actual disk state | PRI-247 |
| ERR-043 | nextAction wraps entire shell command in quotes, making it unrunnable | PRI-247 |
| ERR-044 | Structured failure reason hardcoded to console gap regardless of actual failure | PRI-247 |
| ERR-045 | Shell interpolation of user-provided paths enables command injection | PRI-247 |
| ERR-046 | Rollback failure silently swallowed — install result may falsely claim old state restored | PRI-247 |
| ERR-047 | Non-boolean enabled field in feature flags silently treated as disabled | PRI-247 |
| ERR-048 | Runtime V2 activation write path disconnected from live prompt read path — activation succeeds but principle never injected | PRI-261 |

---

## Category 2: Missing Tests & Verification

Errors where AI assistants skipped required testing or verification steps.

| ID | Summary | Source |
|----|---------|--------|
| ERR-012 | PR branch based on stale main reverts already-merged telemetry fields | PR #659 |
| ERR-025 | Test coverage proves isolated helper behavior, not real production defense | PRI-209 |
| ERR-026 | Hand-written test database schema drifts from production, allowing invalid SQL to pass tests | PRI-209 |
| ERR-066 | CLI --json failure path not structured; raw stack trace dumped to stderr on assembler throw | PRI-397 |

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
| ERR-037 | UI action buttons gated only by `status`, ignoring backend actionability field | PRI-244 |
| ERR-038 | Read-only GET paths create writable SqliteConnection; readonly breaks fresh workspace | PRI-244 |
| ERR-039 | Test `filter(isRecord)` silently discards malformed items; `if (isRecord)` skips assertions | PRI-244 |
| ERR-014 | `formatValidationErrorEntry` string values not truncated — evidence pack unbounded | PRI-200 |
| ERR-015 | Repair loop uses stale schema errors across attempts — reduced repair effectiveness | PRI-200 |
| ERR-016 | maxRepairAttempts not hard-capped — { maxRepairAttempts: 999 } runs 999 calls | PRI-200 |
| ERR-017 | JSON.stringify on unknown values can throw (BigInt, circular) — preview paths crash | PRI-200 |
| ERR-018 | repairAttempts records stale initialValidationErrors instead of per-attempt currentErrors | PRI-200 |
| ERR-019 | schemaCheck failure branch writes next iteration's errors into current attempt's record | PRI-200 |
| ERR-020 | Commander negated boolean `--no-intake` ignored — checking wrong property name | PRI-217 |
| ERR-057 | errMsg helper checks typed narrower parameter instead of unknown caught value — error message extraction always falls through to String(err) | PRI-285 |
| ERR-054 | `as TOutput` cast on untrusted LLM/runtime payload before validation — typed hooks receive unverified data | PRI-302 |
| ERR-060 | Emitted telemetry event not registered in schema — event silently dropped or degraded | PR #808/#809/#810 |
| ERR-061 | Runtime shape check validates wrong field name — guessed structure instead of verifying against actual type | PR #823 |
| ERR-062 | Collapsed details section renders empty-state copy instead of actual data when data exists | PRI-319 / PR #825 |
| ERR-063 | Commander `--no-<flag>` option property accessed via incorrect name — flag silently ignored | PR #844 |
| ERR-064 | CLI subcommand option regressions — Commander flag → opts mapping lost or misrouted during Commander .command() edit | PRI-337 / PR #852 |
| ERR-065 | SQLite INSERT guesses column names instead of reading schema — trust-boundary recurrence (ERR-001/ERR-005/ERR-013) | PRI-394 / PR #926 |
| ERR-067 | Orchestrator treats `retried` status as failure — retry chain breaks at SplitDiagnosticianRunner and diagnose CLI | PRI-405 |

---

## Category 4: Documentation & Spec Drift

Errors where AI assistants wrote code contradicting architecture docs or ADRs.

| ID | Summary | Source |
|----|---------|--------|
| ERR-021 | Handler-only tests miss Commander flag→opts mapping bugs | PRI-217 |
| ERR-022 | process.exit(1) without return allows fallthrough to intake on failed diagnosis | PRI-217 |
| ERR-023 | CLI dry-run command opens writable database connection instead of readonly | PRI-218 |
| ERR-027 | Strategic pivot lands but executable docs and issue templates continue dispatching superseded work | PRI-252 |
| ERR-028 | Baseline fixture directly constructs writer instead of routing through production dispatcher | PRI-240 |
| ERR-029 | CLI unknown input silently dropped instead of failing loud | PRI-240 |
| ERR-030 | Path prefix `startsWith` matches sibling directories as production workspace | PRI-240 |
| ERR-031 | Config resolver hard-fails on valid runtime when optional mode flags are absent | PRI-162 |
| ERR-032 | Documentation labels legacy dispatch as MVP-Core, contradicting ADR-0014 | PRI-227 |
| ERR-033 | Operator failure path returns success exit code and breaks JSON contract | PRI-162 |
| ERR-034 | Canonical runtime config not consumed by caller or cache key | PRI-162 |
| ERR-035 | Static guard only covers frozen-basename dynamic imports, misses other legacy paths | PRI-227 |
| ERR-036 | Provider-endpoint configuration source mismatch sends real calls to wrong target | PRI-162 |

---

## Category 5: Security & Safety

Errors where AI assistants introduced security risks or bypassed safety checks.

| ID | Summary | Source |
|----|---------|--------|
| ERR-022 | process.exit(1) without return allows fallthrough to intake on failed diagnosis | PRI-217 |
| ERR-055 | Privacy redaction helper uses ALL-segment logic instead of ANY — composite sensitive keys like github_token pass through unredacted | PRI-285 |
| ERR-056 | Redaction pipeline truncates string values without running path/token/env redactors — secrets in values like buildId or cwd slip through | PRI-285 |
| ERR-049 | Unconditional taskId reinjection bypasses validator mismatch check — malicious LLM lineage fields pass validation | PRI-294 |
| ERR-058 | Inconsistent forbidden-key lists across validation paths — gateway_token passes pi-ai profile validation | PRI-304 |
| ERR-059 | Nullish coalescing dead code — always-defined default shadows user override in effective config merge | PRI-304 |

---

## Category 6: Process & Workflow

Errors in how AI assistants approached the task — not reading context, not following workflow.

| ID | Summary | Source |
|----|---------|--------|
| ERR-006 | Missed Codex PR review comments due to API failure + no retry | PR review |
| ERR-021 | Handler-only tests miss Commander flag→opts mapping bugs | PRI-217 |
| ERR-050 | Modified bundled/generated copy instead of source of truth | PRI-250 |
| ERR-051 | Security redaction inserted into RuleHost input path before evaluation, not just telemetry output path | PRI-297 |
| ERR-052 | Cherry-pick from stacked feature branch cross-contaminates unrelated PR | PRI-299 |
| ERR-053 | New CLI subcommand never registered in Commander program - 4 of 22 wiring tests silently fail | PRI-299 |
| ERR-068 | Used `pnpm install` in an `npm ci` repo — package-lock.json not synced, all CI jobs fail | PRI-419 / PR #953 |

---

## Detailed Entries

**[ERR-001]** | `as string | undefined` type cast on untrusted JSON bypasses runtime validation

- **What happened**: In `SqliteSourceTraceLocator.locate()`, the code used `(dj.sourcePainId ?? dj.painId) as string | undefined` to extract the pain ID from a parsed JSON object (`Record<string, unknown>`). The `as` cast silently passes non-string values (e.g., `sourcePainId: 42`), causing `taskPainId === query.sourcePainId` to always fail for non-string types because strict equality between a number and a string is always `false`.
- **Why it's wrong**: `as` is a compile-time assertion with zero runtime validation. When `diagnosticJson` contains `sourcePainId: 42` (a number), the cast silently tells TypeScript it's a string, but the actual runtime value is still `42` (number). The strict equality `42 === "42"` evaluates to `false`, producing a false `not_found` decision instead of a correct match or a type-mismatch diagnostic.
- **Correct approach**: Use `typeof rawPainId === 'string' ? rawPainId : undefined` to validate the type at runtime before using it in comparisons.
- **How to prevent**: Never use `as` type assertions on values from untrusted JSON sources (`Record<string, unknown>`). Always validate with `typeof` checks before using the value. When extracting fields from parsed JSON, treat every field as `unknown` and narrow with runtime type guards.
- **Source**: PRI-189
- **Date**: 2026-05-19
- **Recurrence**: Yes - 2026-05-23 PRI-213 (PR #688): `event.data.toolName as string` and `event.data.score as number` in `groupEventsIntoSessions()` bypassed runtime validation on `RawEventEntry.data` fields. `score: NaN` and `score: Infinity` passed `typeof === 'number'` check. `validatePainSignal()` used `as Record<string, unknown>` instead of type guard. Fixed by excluding malformed entries from scoring arrays and adding `isStringRecord()` type guard. Also 2026-05-25 PRI-239 (PR #702): `(parsed as Record<string, unknown>)[key]` in `feature-flag-loader.ts` bypassed runtime validation on YAML-parsed input. Fixed by replacing `as Record` with `isRecord()` type guard. Also 2026-05-27 PRI-261 (PR #727): `SqliteActivationStateStore.listPromptActivations()` and `PromptActivationReader` used `as` casts on SQLite query results, and `mapRowToRecord()` defaulted malformed required fields to `''` instead of returning null. Fixed by replacing all `as` with `isRecord()` + `Object.hasOwn()` + `typeof` field readers, and making `mapRowToRecord()` return null when any required field is empty or missing. Also 2026-05-27 PR #729 Finding B: `setLanguage((options.lang as 'zh' | 'en') || 'zh')` in `index.ts` used `as` cast to bypass runtime validation on CLI `--lang` input. Invalid values like `--lang en-US` would crash at runtime instead of failing with a clear error. Fixed by adding `isLanguage()` type guard and rejecting invalid values with structured error output (text mode: reason + nextAction; JSON mode: parseable JSON with reason + nextAction, exit 1). Also 2026-05-29 PRI-256 (PR #739): `(r.recommendation_kind as CandidateRecord['recommendationKind']) ?? 'principle'` in `SqliteArtifactStore.getArtifactWithCandidates()` used `as` cast on SQLite column value, bypassing runtime validation. Second recurrence of same class after PR #732 review finding (extractPrincipleId `as Record`). Fixed by extracting `resolveRecommendationKind()` with `VALID_RECOMMENDATION_KINDS` whitelist into shared `recommendation-kind-resolver.ts`, replacing both `as` cast and inline fallback with runtime-validated resolver. Also 2026-06-03 PR #808/#809/#810 review: Scribe/Evaluator/Artificer validators used `as Record<string, unknown>` on untrusted LLM/runtime output instead of `isRecord()` type guard. Nested objects (principleDraft, sourceTrace, evaluation, implementationPlan) also used `as Record` casts. Evaluator validator interface accepted `EvaluatorOutputV1` instead of `unknown`, and evaluator-runner.ts used `as EvaluatorOutputV1` before validation. Fixed by replacing all `as Record` with `isRecord()` type guard, changing EvaluatorValidator.validate() to accept `unknown`, and removing `as EvaluatorOutputV1` in evaluator-runner.ts. Also 2026-06-04 PRI-306 (PR #817): `checkPdLocalReadiness()` used `!apiKeyValue` (truthy check) to validate env var existence, treating empty string `""` as "not set" (same as `undefined`). An empty API key env var is set but invalid — the user should see "set but empty" not "not set". Fixed by replacing `!apiKeyValue` with `apiKeyValue === undefined` (not set) + `apiKeyValue.length === 0` (set but empty) with distinct reason/nextAction for each. Also 2026-06-06 PRI-318 (PR #829): Test file `cr9-tool-pages.test.ts` used `as Record<string, unknown>` on `require()` JSON import results instead of runtime type guard. 7 instances of `as Record<string, unknown>` and `as string` casts on `require("../../src/ui/i18n/en.json")` and `require("../../src/ui/i18n/zh-CN.json")` results and their nested properties. Fixed by replacing all `as` casts with `expectRecord()` runtime guard function that validates `typeof === "object" && value !== null && !Array.isArray(value)` and uses `Object.hasOwn()` for key checks. Also 2026-06-06 PEAT-A (PR #836): `evidence-sanitizer.ts` used `value as Record<string, unknown>` in `sanitizeValue()` and `sanitizeValue(...) as Record<string, unknown>` / `sanitizeValue(...) as string` in `sanitizeToolParams()` — all on untrusted sanitizer input. Fixed by adding `isPlainRecord()` runtime guard and replacing all `as` return casts with `Array.isArray()`/`isPlainRecord()` runtime checks on sanitizeValue() result. Also 2026-06-07 PRI-331 (PR #847): `EvidenceChainConsoleModel.ts` used `isString(event.id)` to extract SQLite row ID, but SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` returns `number`, not `string`. This caused `pain_` (empty ID) instead of `pain_1`, breaking task-to-pain linking. The `as Record<string, unknown>[]` cast on `.all()` results also bypassed runtime validation. Fixed by adding `coerceToString()` that handles both `string` and finite `number`, and adding `if (!eventId) continue` guard for empty IDs. Also 2026-06-10 PRI-363 (PR #892): `classifyToolCallOutcome()` in `after-tool-call-helpers.ts` used `event.result as Record<string, unknown>` and `resultObj.details as Record<string, unknown>` without runtime type guards. `event.result` from OpenClaw hook is untrusted — could be array, null, or non-object. Fixed by adding `typeof === 'object' && !Array.isArray()` runtime guards before `as Record<string, unknown>` casts. Also 2026-06-14 PRI-394 (PR #926): SQLite INSERT guess column names in malformed-row test — same trust-boundary pattern on DB schema instead of JSON. Also 2026-06-15 PRI-395 (PR #928): `JSON.parse(diagnosticJson) as Record<string, unknown>` in `IntakeToInternalizationBridge.buildDreamerTaskSeed()` bypassed runtime validation on parsed diagnostic JSON when merging lineage fields into the metadata envelope. Even though diagnosticJson came from `createPITaskDiagnosticJson()` (a trusted internal factory), the `as Record` cast violates Rules 1 and 2. Fixed by eliminating the JSON.parse round-trip entirely - `buildDreamerTaskSeed()` now builds the complete diagnostic JSON as a single `JSON.stringify()` call that includes both the PI metadata envelope and the top-level lineage fields in one pass. Also 2026-06-17 PRI-408 (PR #960): `RuleHost._loadFromActivationsTable()` used `as Array<{...}>` on SQLite query results and `as RuleHostMeta` on untrusted module exports, bypassing runtime validation on DB rows and compiled rule metadata. Also used `this.workspaceDir!` non-null assertion. Test code had TS2532 (`result[0].channel` without guard after `toHaveLength`). Fixed by: (1) casting `.all()` to `unknown` + `Array.isArray()` guard + per-row `typeof` field validation; (2) adding `isRuleHostMeta()` type guard validating all 4 required string fields; (3) passing `workspaceDir` as explicit parameter instead of `!` assertion; (4) extracting `result[0]` with guard clause in test.

---

**[ERR-002]** | Catch-and-degrade pattern silently swallows failure reasons

- **What happened**: `buildFullTraceSafe()` catch block caught all exceptions and returned `null` with no observability — no logging, no error propagation, no ambiguity notes.
- **Why it's wrong**: Downstream diagnostician receives `fullTrace: null` and cannot distinguish between "no painId provided" and "trace construction crashed". Degradation is correct design, but degradation ≠ silence. Silent degradation hides bugs and makes debugging impossible.
- **Correct approach**: Catch blocks in degrade patterns must propagate the failure reason through at least one channel: `ambiguityNotes`, telemetry, or logging.
- **How to prevent**: Every catch-and-degrade pattern must expose the failure reason via `ambiguityNotes` / telemetry / logging. Review all catch blocks that return fallback values and verify they communicate why the fallback was triggered.
- **Source**: PRI-171
- **Date**: 2026-05-19
- **Recurrence**: Yes - 2026-05-24 PRI-240 (PR #699): `cleanupTempWorkspace` had `catch { void 0; }` that silently swallowed cleanup failures with no observability. Fixed by outputting structured `[pd-cli] cleanup warning:` to stderr. Also 2026-05-25 PRI-239 (PR #702): canary `gfi_snapshot` returned `healthy` when GFI disabled but `featureFlags.warnings.length > 0` (malformed YAML/override). Degraded config was not surfaced. Fixed by returning `degraded` with structured details when warnings present. Also 2026-05-25 PRI-245 (PR #711): PainPage `GfiGauge` component showed persistent skeleton when `useAutoRefresh` fetch failed — `gfi.data` was null and `gfi.error` was set, but `GfiGauge` only checked `!gfi` and rendered skeleton forever with no error visibility. Fixed by passing `error` and `onRetry` props to `GfiGauge` and rendering error state with retry button when `error && !gfi`. Also 2026-05-25 PRI-246 (PR #715): Initial code_tool_hook implementation returned overall `passed` when `ActivationDispatcher.dispatch()` returned `queued_for_approval`. The `approveAndReactivate` function created a second dispatcher without `approvalQueueStore`, which hit the `!this.approvalQueueStore` guard and returned `refused` — but the outer `runChannelOutcome` classified this as `degraded` and `computeDemoStatus` still returned `passed` when no stages outright failed. The demo declared the story passed when RuleHost was never actually activated. Fixed by rewriting `approveAndReactivate` to directly call `writer.activate()` + `stateStore.recordActivation()` after real `SqliteApprovalQueueStore.approve()`, completing the full queued→approved→activated chain with observable activation evidence. Also 2026-05-26 PRI-247 (PR #721): `readEnabledChannelsFromDisk()` silently returned `[]` when feature-flags.yaml was malformed, unreadable, or had invalid structure. The installer would then report channels from the install options instead of actual disk state, creating operator observability gap. Fixed by returning `null` with reason when disk read fails, and having the installer distinguish "no file" from "file present but broken". Also 2026-06-07 PRI-331 (PR #847): `EvidenceChainConsoleModel.ts` catch block for `principle_candidates` table read silently swallowed `isMissingTableError` — when the table didn't exist, no degraded reason or nextAction was added. This caused candidate/internalization chain links to disappear without any observability. Fixed by adding degraded reason + nextAction for missing candidates table, matching the pattern used for missing pain_events and tasks tables. Also 2026-05-27 PR #729 Finding A: `smoke-packaged-install.test.ts` used `try { ... } catch { smokeAvailable = false; }` in `beforeAll` to silently convert `npm pack` failures into skipped tests, and `it.skipIf(!smokeAvailable)` evaluated at registration time (before `beforeAll`), making all smoke tests permanently skipped. Fixed by removing the catch-and-skip pattern and making `beforeAll` throw on pack/setup failure (fail loud). Also 2026-06-13 PRI-385 (PR #918) P1-1: `determineNextAction` emitted `pd pain retry --workspace "<ws>"` with no `--pain-id`, so operators who followed the nextAction hit a CLI that requires `--pain-id` (and refuses without `--runtime`). The recovery command was non-executable — an operator-facing degradation with no usable action. Fixed by deriving the retry painId from the real `linkedTaskId` via the `diagnosis_<painId>` convention (round-trip verified; sub-run ids fall back to `pd diagnose run --task-id`), always including `--workspace`, and adding a required `--runtime` placeholder. Same class as the PRI-331 EvidenceChainConsoleModel nextAction recurrence. Also 2026-06-14 PRI-392 (PR #922): `handleRuntimeRecoveryFailedTasks` silently incremented `recoveredCount` and set status to `recovered` even if `recoverFailedTask` returned `null` due to concurrent modification, leading to false positive success tracking. Fixed by checking the return value and treating `null` as skipped with a structured reason and nextAction.

---

**[ERR-028]** | Baseline fixture directly constructs writer instead of routing through production dispatcher

- **What happened**: `proven-channel-baseline.ts` directly constructed `PromptWriter`, `RuleHostWriter`, and `DeferArchiveWriter` instances and called `canActivate()`/`activate()` on them, then claimed the results proved production continuity. But the real production path routes through `ActivationDispatcher.dispatch()`, which performs writer selection, gate evaluation, approval queue routing, and idempotency checks.
- **Why it's wrong**: A baseline that bypasses the production dispatcher proves the writer works in isolation, not that the production activation path works. This is the same class as ERR-024/ERR-025 (validator/helper tested in isolation but not wired into production path). The baseline would pass even if the dispatcher was broken.
- **Correct approach**: Baseline fixtures must route through the same `ActivationDispatcher.dispatch()` path used by production, with in-memory read models. The fixture's `evidenceSource` must reference `ActivationDispatcher.dispatch` to prove the real path was exercised.
- **How to prevent**: For any baseline/continuity fixture, the test must exercise the same entry point as production code. If production uses a dispatcher/facade/mediator, the fixture must use it too. Never test the leaf component and claim the tree is healthy.
- **Source**: PRI-240 / PR #699
- **Date**: 2026-05-24
- **Recurrence**: Yes - same class as ERR-024, ERR-025

---

**[ERR-029]** | CLI unknown input silently dropped instead of failing loud

- **What happened**: `parseChannels()` in the CLI handler silently dropped unrecognized channel names from `--channels` input. When all tokens were invalid, it returned `undefined`, causing the runner to fall back to all MVP channels. A typo like `--channels code-hook` would yield a successful full-baseline run instead of an input error.
- **Why it's wrong**: Silent fallback on invalid input violates the CLI Command Gate (rule 1: JSON mode strict, rule 6: degraded/refused result must include reason + nextAction). Operators get misleading continuity results for a channel set they did not actually request. This is the same class as ERR-009 (silently skip invalid instead of failing loud).
- **Correct approach**: `parseChannels()` must return both valid channels and unknown tokens. The CLI handler must pass unknowns to the runner, which must fail loud with a structured error containing `failureReason` and `nextAction`.
- **How to prevent**: For any CLI input parser, never silently drop invalid tokens. Return them separately and fail loud. Add parser-level tests that verify unknown inputs produce structured failures.
- **Source**: PRI-240 / PR #699
- **Date**: 2026-05-24
- **Recurrence**: Yes - same class as ERR-009, ERR-010

---

**[ERR-030]** | Path prefix `startsWith` matches sibling directories as production workspace

- **What happened**: `isProductionWorkspace()` used `normalized.startsWith(prefix.toLowerCase())` to check if a workspace directory is a production path. This matched sibling directories like `~/.openclaw/workspace-backup` or `D:\.openclaw\workspace-extra`, incorrectly blocking safe non-production directories.
- **Why it's wrong**: `startsWith` on paths does not respect segment boundaries. A path that shares a prefix but is not a descendant should not match. This is the same class as ERR-003 (substring matching causing false positives) and ERR-013 (`in` operator matching inherited properties).
- **Correct approach**: Use `normalized === prefix || normalized.startsWith(prefix + path.sep)` to match either the exact path or a descendant (path separator after prefix). This respects filesystem segment boundaries.
- **How to prevent**: When matching filesystem paths by prefix, always include the path separator in the prefix check. Add tests for sibling paths (same prefix + suffix without separator) and descendant paths (prefix + separator + more).
- **Source**: PRI-240 / PR #699
- **Date**: 2026-05-24
- **Recurrence**: Yes - same class as ERR-003, ERR-013

---

**[ERR-031]** | Config resolver hard-fails on valid runtime when optional mode flags are absent

- **What happened**: `resolvePDConfig()` required `--openclaw-local` or `--openclaw-gateway` when `runtimeKind === 'openclaw-cli'`, but the `run-once` command and `--runtime config` path don't always expose these flags. This made previously supported `openclaw-cli` runtime paths unreachable.
- **Why it's wrong**: Making optional mode flags mandatory breaks backward compatibility and violates the principle that config resolution should succeed when the runtime kind is valid. The mode can be resolved later by the consumer. This is the same class as ERR-009 (required field check that's too strict for the actual use case).
- **Correct approach**: When `runtimeKind === 'openclaw-cli'` and neither mode flag is set, set `openclawMode = undefined` instead of failing. The mode is optional metadata that the consumer can resolve. Only fail when both flags are set (mutually exclusive).
- **How to prevent**: When adding validation to a config resolver, distinguish between "required for the resolver to produce a valid config" and "required for the consumer to operate". The resolver should produce the config; the consumer should validate its own requirements. Add tests for each runtime kind without optional flags.
- **Source**: PRI-162 / PR #700
- **Date**: 2026-05-24
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
- **Recurrence**: Yes - 2026-05-23 PRI-209 (PR #689): `extractPIMetadata()` used `as Record<string, unknown>` on `JSON.parse` result. `dependencyTaskIds` non-string elements passed through without filtering. Fixed by replacing `as Record` with `readOwnProperty` helper and `Array.from().filter()` for element-wise validation. Also 2026-05-23 PRI-225 (PR #693): `result.dependencyTaskIds = depIds as string[]` on already-validated array bypassed type system. Fixed by constructing `validatedDependencyTaskIds: string[]` with element-wise `typeof` check and push, no `as` assertion. Also 2026-05-25 PRI-239 (PR #702): `feature-flag-loader.ts` used `(parsed as Record<string, unknown>)[key]` to read YAML-parsed values at input trust boundary. Same class as all prior — `as` bypasses runtime narrowing on untrusted data. Fixed by adding `isRecord()` type guard. Also 2026-05-27 PRI-261 (PR #727): same `as Record<string, unknown>` pattern on SQLite query results in both `SqliteActivationStateStore` and `PromptActivationReader`. Fixed by replacing with `isRecord()` + `Object.hasOwn()` + per-field `typeof` validation. Also 2026-05-27 PR #729 Finding B: `options.lang as 'zh' | 'en'` and `options.workspace as string` and `options.force as boolean` in `index.ts` used `as` casts to bypass runtime validation on Commander-parsed CLI inputs. Fixed by adding `isLanguage()` type guard for `--lang` and replacing `as` casts with runtime type checks. Also 2026-05-29 PRI-256 (PR #739): `(r.recommendation_kind as CandidateRecord['recommendationKind']) ?? 'principle'` in `SqliteArtifactStore` used `as` cast on SQLite column value. Second recurrence of same class after PR #732 review finding (extractPrincipleId `as Record`). Fixed by extracting `resolveRecommendationKind()` with `VALID_RECOMMENDATION_KINDS` whitelist into shared `recommendation-kind-resolver.ts`. Also 2026-06-03 PR #808/#809/#810 review: All three validators used `as unknown[]` casts on array elements (risks, applicability, antiPatterns, strengths, concerns, requiredChanges, changes, tests) in `.every()` calls, bypassing element-wise runtime validation. Fixed by replacing `as unknown[]` with typed callbacks `(e: unknown) => typeof e === 'string'`. Also 2026-06-14 PRI-394 (PR #926): SQLite INSERT guess column names in malformed-row test — same trust-boundary pattern on DB schema instead of JSON.

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
- **Recurrence**: Yes - 2026-05-23 PRI-209 (PR #689): `result_ref` points to an artifact whose `task_id` differs from the owning task, but the read model only checked artifact kind-level existence instead of per-dependency lineage. This caused dependency B's missing artifact to be misclassified as `lineage_mismatch` when dependency A had a matching artifact. Fixed by implementing true `lineage_mismatch` detection (query `SELECT task_id FROM artifacts WHERE artifact_id = ?` and compare with owning task's `task_id`) and distinguishing from `missing_dreamer_pi_artifact` (no artifact found at all) and `result_ref_missing_artifact` (result_ref points to nonexistent artifact). Also 2026-05-23 PRI-225 (PR #693): Malformed metadata was re-interpreted as topology failure — philosopher with `dependencyTaskIds: ['dreamer-1', 42]` and existing dreamer-1 got `philosopher_dependency_unverifiable` because the dependency check only accepted `status === 'parsed'`. Fixed by using `bestEffortParentIds` for topology verification when metadata is malformed, while still emitting `metadata_malformed`. Also 2026-05-29 PRI-272: `taskId` was a lineage field in `DiagnosticianOutputV1Schema` that LLM could fabricate. Removed `taskId` from schema, deleted REQ-2.3c validator check, added `stripLineageFields` to free-form adapter path, ensuring downstream consumers get taskId from RunnerContext/TaskRecord only.

---

**[ERR-009]** | Validator silently skips missing/malformed required array fields instead of failing loud

- **What happened**: In `validateTraceRefinerAgentOutput()`, the `refinedTrace` shape validation used `if (Array.isArray(rt.sourceRunIds)) { ... }` pattern — when the field was missing, `undefined`, or non-array, the validator silently skipped it instead of reporting an error. Same for `evidenceRefs` and `keyEvents`. Additionally, `keyEvent` objects that were non-objects were skipped with `continue`, and `keyEvent.evidenceRefs` non-arrays were silently skipped.
- **Why it's wrong**: This allows structurally invalid `refinedTrace` objects (e.g., `{ sourceRunIds: "not-array", evidenceRefs: undefined, keyEvents: undefined }`) to pass validation and be cast as `RefinedTracePayload`. Even in shadow mode, downstream telemetry or analysis consumers would receive objects that don't conform to the contract. This is the same class as ERR-001/ERR-005/ERR-007 — validators must fail loud, not skip silently.
- **Correct approach**: For every required field in a validator, check that it exists and has the correct type. If it's missing or wrong type, add an error. Use `if (!Array.isArray(x)) { error } else { validate elements }` instead of `if (Array.isArray(x)) { validate elements }`.
- **How to prevent**: When writing validators for untrusted data, never use `if (hasCorrectType) { validate }` — always use `if (!hasCorrectType) { error } else { validate }`. The "skip on wrong type" pattern is always wrong for required fields.
- **Source**: PRI-192 / PR #638 (reviewer feedback)
- **Date**: 2026-05-19
- **Recurrence**: Yes - same pattern as ERR-001, ERR-005, ERR-007. Recurred 2026-05-23 in PRI-207 (PR #680): `extractJsonObject` fenced-code path parsed valid non-object JSON (array/null/string/number/boolean) but fell through to brace scan instead of returning null, allowing array payloads to be treated as objects. Same root cause: validator (fenced parse) silently skips invalid type instead of failing loud. Recurred 2026-05-24 PR #701: `proven-channel-baseline.test.ts` used `if (output) { assert }` pattern for JSON stdout assertions — when `output` was undefined/empty, the test silently passed instead of failing. Fixed by replacing with `expect(output).toBeDefined()` + `expect(typeof output).toBe('string')` before `JSON.parse`. Also 2026-06-15 PRI-395 (PR #928): `IntakeToInternalizationBridge.buildDreamerSeedFromCandidate()` used `candidate.taskId?.trim() || undefined` (and analogously for artifactId, sourceRunId) to pass lineage fields - when all three were empty/blank, the seed was still created with empty `dependencyTaskIds` and weak `candidate://` refs instead of failing loud. Fixed by adding a `lineageFields.every(f => !f)` check that returns `{ decision: 'invalid_candidate', reason: '...no diagnostician lineage...' }` when all three lineage fields are empty, ensuring Runtime Contract Rule 3.

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
- **Recurrence**: Yes - same class as ERR-001/ERR-005/ERR-007 where runtime semantics bypass validation intent. Also 2026-05-25 PRI-239 (PR #702): `computeEffectiveFlags()` used `Object.hasOwn()` for override reads but lacked dangerous-key rejection (`__proto__`, `constructor`, `prototype`). `feature-flag-loader.ts` also lacked dangerous-key guard on parsed YAML keys. Fixed by adding `DANGEROUS_KEYS` set + filtering in both contract and loader, with regression tests. Also 2026-06-03 PR #808/#809/#810 review: Scribe/Evaluator/Artificer validators checked required fields with direct property access (`obj.taskId`, `obj.sourcePhilosopherArtifactId`) instead of `Object.hasOwn()`. Prototype-inherited properties like `toString` on `taskId` would pass validation. Fixed by adding `Object.hasOwn()` checks for all required fields in all three validators, with regression tests proving prototype-inherited values are rejected. Also 2026-06-14 PRI-394 (PR #926): SQLite INSERT guess column names in malformed-row test — same trust-boundary pattern on DB schema instead of JSON.

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
- **Recurrence**: Recurred 2026-06-14 PRI-392 (PR #922): In `packages/pd-cli/src/commands/task.ts`, `process.exit(1)` was called in error/not-found paths without a subsequent `return`, allowing execution to continue if `process.exit` is stubbed or bypassed.

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

**[ERR-024]** | Security validator exists but is not wired into enforcement path — defense is illusory

- **What happened**: `isPathWithinWorkspace()` and `validateProposedPathBounds()` were added to core as path boundary validation functions, but they were only called by tests and barrel exports. The real live auto-correct apply path in `gate.ts` still used `validateCorrectionProposal()` alone and directly applied `proposal.proposedParams` without checking path boundaries. An out-of-bounds path correction would be applied despite the validator existing.
- **Why it's wrong**: A validator that is not called from the enforcement path provides zero runtime defense. Tests against the validator prove the validator works, but they do not prove the system is defended. This is the same class as ERR-002 (catch-and-degrade without observability) — the defense exists in code but not in the actual execution path.
- **Correct approach**: When adding a security or validation function, it MUST be wired into the actual enforcement path, not just tested in isolation. The PR that introduces the validator must also modify the production code path to call it. If the enforcement wiring is out of scope, the PR must explicitly state this and the validator must not be presented as providing defense.
- **How to prevent**: For every new validation/security function, the PR must include: (1) a test proving the production path calls the function, (2) a test proving the production path rejects/defends when the function returns invalid. If neither exists, the validator is not actually defending anything. Review trigger: any PR that adds a validation function without modifying the code that handles the untrusted input.
- **Source**: PRI-210 / PR #690
- **Date**: 2026-05-23
- **Recurrence**: Yes - 2026-05-24 PRI-227 (PR #698): Nocturnal entrypoint guard had `if (isFrozenImport) continue;` that allowed non-frozen callers to import frozen modules without allowlist entry. The guard existed but the `continue` bypass made it fail-open — any file importing a frozen module would pass because the check was skipped for frozen module references. Fixed by removing the bypass entirely; non-frozen callers must now appear in ALLOWED_NOCTURNAL_IMPORTS.

---

**[ERR-025]** | Test coverage proves isolated helper behavior, not real production defense

- **What happened**: `broken-artifact-simulation.ts` was added with `decideDownstreamGate()` and 54 tests, but no production code called it. The real `InternalizationChainIntegrityReadModel` and `InternalizationIntegrityRemediation` were completely untested. Tests proved the helper's logic, but the production system had no defense against the scenarios the helper covered.
- **Why it's wrong**: Tests that exercise a standalone helper without verifying that production code calls it create a false sense of security. All tests pass, but the production path remains unprotected. This is the same class as ERR-024 (validator without enforcement) and ERR-002 (degradation without observability) — the mechanism exists but is not connected to the real system.
- **Correct approach**: When adding a feature that is supposed to defend against a class of failures, tests must exercise the REAL production path (read model, remediation, CLI command), not just a standalone helper. If the helper is a contract specification, it must be wired into production code within the same PR. If the production wiring is out of scope, the PR must explicitly state that the system is NOT yet defended.
- **How to prevent**: For every PR that adds defensive logic, verify that at least one test exercises the production path that would invoke the defense. If no production path calls the new code, the PR must not claim to provide defense. Review trigger: any PR where the diff adds a new module but does not modify any existing production code to call it.
- **Source**: PRI-209 / PR #689
- **Date**: 2026-05-23
- **Recurrence**: Yes - 2026-05-23 PRI-209 (PR #689): Healthy baseline test used `expect(['ok', 'degraded']).toContain(overallStatus)`, allowing `degraded` to pass. This meant a regression that introduced new warning-level broken links in the healthy path would not be caught. The test proved the code didn't crash, but not that the healthy path remained healthy. Fixed by tightening to `expect(overallStatus).toBe('ok')`. Also 2026-05-23 PRI-225 (PR #693): `bestEffortParentIds` was added to `PIMetadataParseResult.malformed` but not wired into the philosopher dependency check. The dependency check only accepted `status === 'parsed'`, so malformed metadata with extractable parent IDs still produced `philosopher_dependency_unverifiable`. Test proved `bestEffortParentIds` was populated correctly, but not that the production path used it for topology verification. Fixed by adding `else if (philMeta.status === 'malformed')` branch in the dependency check. Also 2026-05-24 PRI-240 (PR #699): RuleHost fixture test only asserted inside `if (result.status === 'passed')` conditional branches, so if the fixture returned `failed`, all assertions were skipped and the test passed vacuously. Fixed by adding unconditional `expect(['passed', 'degraded', 'failed']).toContain(result.status)` before the conditional branches. Also 2026-05-25 PRI-245 (PR #711): Navigation tests only checked source-code string patterns (e.g., `toContain('href: "/overview"')`) but missed that the Diagnostics Overview nav item had `href: "/"` instead of `href: "/overview"`, and the `isActive` function used `startsWith` which caused `/` to match all paths. Tests proved the strings existed in source, but not that the nav-to-route mapping was correct. Fixed by extracting `isNavActive` to a testable utility with unit tests, and adding nav-to-route mapping tests that verify every sidebar href has a corresponding App route. Also 2026-05-25 PRI-246 (PR #715): Initial Story A' demo was a "带叙事包装的 activation synthetic fix[... 2201 chars truncated for brevity]... Also 2026-05-27 PRI-247 (PR #721): Static/string tests claimed delivery success but real `npm pack` + clean install was broken. Tests checked source code patterns (e.g., `toContain('CORE_REQUIRED')`, `toContain('installBundledCore')`) but never ran `npm pack` → install to clean temp HOME → verify `@principles/core` resolves. Two specific failures: (1) `@principles/core` was referenced as `file:./core.tgz` in bundled package.json but `core.tgz` was corrupted/missing in the installed location because npm cannot resolve nested tarball `file:` references across directory boundaries; (2) console health test used `process.env.HOME` instead of the temp HOME directory where the installer actually deployed files. Root cause: same class as ERR-025 — tests proved isolated behavior (source patterns exist, functions are defined) but not production defense (real tarball install succeeds, real console starts on loopback). Fixed by: (a) switching from `file:./core.tgz` to `file:./core` directory reference (npm resolves directory symlinks reliably), (b) adding `smoke-packaged-install.test.ts` that runs `npm pack` → install to clean temp HOME → `--json` install → assert all components verified → start console → hit `/api/health` on 127.0.0.1 → verify loopback-only + rollback on failure injection. Also 2026-05-27 PR #729: Production code in `packages/create-principles-disciple` was refactored (extracted `rebuildNativeModules`/`verifyNativeModules`, replaced inline `npm rebuild` with function calls, added `isPdOwnedShim` ownership check), but the package's own tests in `tests/mvp-config.test.ts` were not updated to match. Monorepo CI (`verify:merge`) passed because it only runs type-check and lint at the repo level, not the package's `npm run test`. Three tests failed: (1) Native module test searched for old `npm rebuild` string instead of new `rebuildNativeModules()` call; (2) Story A test substring range was too broad, including `verifyPdCliShim()`'s legitimate `shell: 'cmd'` on Windows; (3) No regression test existed for the new shim ownership check. Root cause: same class as ERR-025 — modifying production code without running/maintaining the package's direct tests. The monorepo CI gate does not cover package-level test execution, so package test regressions are invisible until someone runs `cd packages/create-principles-disciple && npm run test`. Fixed by updating tests to match refactored code and adding shim ownership regression tests. Also 2026-05-27 PR #729 Finding A: Real packaged-install smoke tests were permanently skipped because `it.skipIf(!smokeAvailable)` evaluated at test registration time (before `beforeAll` ran), and `npm pack` failures were silently caught and converted to skips instead of failing loud. Root cause: same class as ERR-025 (test claims coverage but never executes) + ERR-002 (silent fallback). Fixed by removing `smokeAvailable` mutable state and `it.skipIf`, restoring plain `it()` execution, and making `beforeAll` throw on pack/setup failure. Also 2026-06-05 PR #823: CR8 data contract tests asserted the implementation's own return shapes instead of the G.1 contract defined in `01-shared-constraints.md`. Four endpoints (governance/queue, approvals/grouped, activations, lifecycle) returned shapes that diverged from the canonical contract: `stagnationSignals` was `number` instead of `Array<{type, principleId, daysSince}>`, approvals returned `pendingCount/channels` instead of `principleTitle/status/records`, activations returned `activationId/sourcePrincipleId` instead of `id/principleId/status`, lifecycle returned flat `adherenceRate/insufficientData` instead of nested `adherence: {insufficientData, rate, note}`. Tests proved the implementation shapes were self-consistent, but not that they matched the contract that CR3/CR4/CR6/CR7 would consume. Fixed by rewriting all four Model response interfaces and route handlers to match G.1, and updating tests to assert G.1 shapes. Also 2026-06-13 PRI-385 (PR #918) P1-2: the validator test named "distinguishes evidence_only from pain_recorded" gave BOTH records `state: 'recorded-only'` and asserted both were `'recorded-only'` — a vacuous test that could not fail when the contract later collapsed `evidence_only` and `store_signal` into the same `recorded-only` state. The collapse itself meant tool_call/hook observations grouped into `active_chain`, misleading owners. Fixed by restoring a distinct `evidence-only` state (union/schema/validators/PainPage grouping) and rewriting the test so the two records carry different states with a `not.toBe` assertion.

---

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

**[ERR-032]** | Documentation labels legacy dispatch as MVP-Core, contradicting ADR-0014

- **What happened**: `LEGACY_ENTRYPOINT_CENSUS.md` and test comments described evolution-worker heartbeat, sleep-cycle orchestrator, and queue-io sleep_reflection enqueue as `mvp_core_dependency` / "ADR-0014 core". But ADR-0014 defines MVP-Core as only three activation paths: `prompt`, `code_tool_hook / RuleHost`, `defer_archive`. The idle/night/sleep-reflection/nocturnal dispatch paths are retirement targets, not core.
- **Why it's wrong**: Labeling legacy dispatch as MVP-Core creates confusion about what can be deleted vs what must be preserved. It also references invalid issue numbers (PRI-232/233/234) that have been superseded or semantically drifted. This is the same class as ERR-027 (executable docs continue dispatching superseded work) — documentation contradicts the active strategy.
- **Correct approach**: MVP-Core labels must strictly follow ADR-0014: only `prompt`, `code_tool_hook / RuleHost`, `defer_archive`. All idle/night/sleep-reflection/nocturnal dispatch must be labeled as `retirement / live cutover / delete blocker`. Retirement issue references must use current valid numbers (PRI-228, PRI-229, PRI-119, PRI-230, PRI-231), not canceled or reused numbers.
- **How to prevent**: When a strategy ADR defines a precise scope (like MVP-Core), all documentation and test comments must be audited to align with that scope. Any label that claims something is "core" must trace directly to the ADR's definition. Review trigger: any PR that introduces or modifies `mvp_core_dependency` labels must cross-reference ADR-0014's explicit MVP-Core list.
- **Source**: PRI-227 / PR #698
- **Date**: 2026-05-24
- **Recurrence**: Yes - same class as ERR-027

---

**[ERR-033]** | Operator failure path returns success exit code and breaks JSON contract

- **What happened**: In `pain-record.ts`, when `result.failureCategory === 'config_missing'` and `resolveRuntimeConfig()` returns a `RuntimeConfigError`, the code only printed diagnostic text to stderr and returned — without calling `process.exit(1)` and without outputting JSON in `--json` mode. Automation treated the failure as success, and JSON CLI contract was broken.
- **Why it's wrong**: CLI commands that fail must exit non-zero (CLI Command Gate rule 5: failure paths must not mutate state or appear to succeed). `--json` mode must always output exactly one parseable JSON object (CLI Command Gate rule 1). A `return` without `process.exit(1)` lets the caller continue as if the operation succeeded. This is the same class as ERR-022 (process.exit without return) and ERR-009 (silently skip invalid instead of failing loud).
- **Correct approach**: Every failure path in a CLI command must: (1) call `process.exit(1)`, (2) in `--json` mode output a structured JSON result with `status: 'failed'`, `failureCategory`, `message`, and `configError` (if applicable), (3) include `nextAction` per CLI Command Gate rule 6.
- **How to prevent**: After writing any CLI failure path, check: does it call `process.exit(1)`? Does `--json` mode output a parseable JSON result? Does the JSON include a `nextAction`? Add a test for each failure path in both text and JSON modes.
- **Source**: PRI-162 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-022, ERR-009. Recurred 2026-05-24 PR #701: `runtime-internalization-run-once.ts` catch block classified all errors as `config_error`, including runner/orchestrator/artifact failures that are not configuration errors. The `ConfigResolutionError` class was introduced so the catch block can distinguish config resolution failures (decision: `config_error`) from runtime execution failures (decision: `runtime_error`) via `instanceof`, without message substring guessing.

---

**[ERR-034]** | Canonical runtime config not consumed by caller or cache key

- **What happened**: Two related issues: (1) `diagnose.ts` forced a pre-check requiring `--openclaw-local` or `--openclaw-gateway` CLI flags before calling `resolveRuntimeConfig()`, preventing file-config-only paths from working. After `resolveRuntimeConfig()` succeeded, the code still used `configResult.openclawMode ?? (opts.openclawLocal ? 'local' : 'gateway')` — guessing the mode instead of consuming the canonical validated result. (2) `pain-signal-runtime-factory.ts` bridge cache key was `${workspaceDir}:${runtimeKind}` without `openclawMode`, causing the same workspace switching from local to gateway to reuse the wrong bridge/adapter.
- **Why it's wrong**: The whole point of `resolveRuntimeConfig()` is to be the single source of truth for runtime configuration. When callers second-guess the result or bypass it with pre-checks, the canonical config is undermined. Cache keys that omit discriminating fields cause stale data reuse. This is the same class as ERR-031 (config resolver hard-fails on valid runtime) and ERR-004 (lineage fields from wrong source).
- **Correct approach**: (1) Remove pre-checks that duplicate what `resolveRuntimeConfig()` already validates. (2) After calling `resolveRuntimeConfig()`, use only `configResult.openclawMode` — never fall back to CLI flag guessing. (3) Include all discriminating fields in cache keys. (4) `invalidatePainSignalBridge()` must clear all mode variants.
- **How to prevent**: When a canonical config resolver exists, callers must not duplicate its validation logic. After calling the resolver, consume its result directly — no fallback guessing. Cache keys must include all fields that change behavior. Test: file-config-only path, flag-override path, cache isolation between modes.
- **Source**: PRI-162 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-031, ERR-004. Recurred 2026-05-24 PR #701: first fix removed pre-check and changed `?? (opts.openclawLocal ? 'local' : 'gateway')` to `?? 'local'`, but (1) `resolveRuntimeConfig()` still did not accept `requestedRuntimeKind`, so `--runtime openclaw-cli --openclaw-gateway` without a workflow policy returned default pi-ai config and the `?? 'local'` fallback silently overrode the user's gateway intent; (2) `runtime=config` still fell through to compatibility fallback instead of failing loud. Fixed by adding `requestedRuntimeKind` to resolver input and removing all `??` fallbacks. Also recurred 2026-05-24 PR #701: `resolveRuntimeConfig()` silently preferred `openclawLocal` when both `openclawLocal` and `openclawGateway` were true, instead of failing loud with `conflicting_openclaw_mode`. The resolver must itself guard mutually-exclusive inputs; callers cannot be expected to pre-validate flag combinations before calling the canonical resolver. Fixed by adding an explicit conflict check at both the no-policy and has-policy code paths. Recurred 2026-06-08 PRI-336 PR #850: `pain-signal-runtime-factory.ts` called `resolveOutputLanguage()` but then bypassed `resolvedLang.outputLanguage` when `degradationWarning` was absent, reading `opts.effectiveConfig?.config.principles?.outputLanguage` instead. When the raw input was `undefined` (user not configured), `resolveOutputLanguage(undefined)` returned `{ outputLanguage: 'zh-CN' }` (default), but the bypass caused `undefined` to be passed to the runner, dropping the default. Fixed by always using `resolvedLang.outputLanguage` as the canonical value — never re-reading the raw input after calling the resolver.

---

**[ERR-035]** | Static guard only covers frozen-basename dynamic imports, misses other legacy paths

- **What happened**: `nocturnal-entrypoint-guard.test.ts` `findImportLines()` only checked dynamic imports against `FROZEN_NOCTURNAL_MODULES` basenames. A dynamic import like `import('../service/sleep-cycle.js')` or `import('../service/idle-detector.js')` would not be detected because `sleep-cycle` and `idle-detector` are not in the frozen set. PRI-227's goal is to prevent new legacy nocturnal callers, not just frozen module callers.
- **Why it's wrong**: The guard's purpose is to catch any new entrypoint into the legacy nocturnal/sleep/idle subsystem, regardless of whether the specific file is in the frozen set. Limiting dynamic import detection to frozen basenames creates a blind spot where new callers of non-frozen legacy modules pass the guard undetected. This is the same class as ERR-024/ERR-025 (validator exists but doesn't cover the real attack surface).
- **Correct approach**: Dynamic import detection must use path-pattern matching (e.g., `nocturnal-`, `sleep-cycle`, `sleep_reflection`, `idle`) rather than exact basename matching against a frozen set. The frozen set check remains for static imports; dynamic imports need broader pattern coverage.
- **How to prevent**: When writing a guard that prevents new callers of a subsystem, ensure the detection covers all naming patterns used by that subsystem, not just a specific subset. Test: add a test case for a dynamic import of a non-frozen-basename legacy module and verify it's detected.
- **Source**: PRI-227 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-024, ERR-025. Recurred 2026-05-24 PR #701: first fix added `idle` to the dynamic import extractor (`findImportLines`), but the actual enforcement logic (the `isNocturnalKeyword` check that decides whether to validate against the allowlist) still only checked `nocturnal`, `sleep_reflection`, and `sleep-cycle` — not `idle`. The new extractor tests proved extraction worked, but not that the real scan would reject an unallowed idle caller. Fixed by adding `idle` to the `isNocturnalKeyword` check and adding an enforcement test. Also recurred 2026-05-24 PR #701: adding `lowerLine.includes('idle')` to `isNocturnalKeyword` caused false positives on `HybridLedgerStore` (hybr**idle**dgerstore contains the substring `idle`). The `legacyPathPatterns` `/idle/` regex had the same issue. Fixed by using word-boundary regex `/(?:^|[-_/.])idle(?:[-_/.]|$)/i` that matches `idle` only at path/identifier segment boundaries, not as a substring within `hybrid`.

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

**[ERR-044]** | Structured failure reason hardcoded to console gap regardless of actual failure

- **What happened**: `buildSuccessOutput` always set `reason: 'owner_review_console_not_deliverable'` when `isComplete` was false, even when the actual failure was `plugin: 'failed'` or `cli: 'failed'`. A user seeing `reason: owner_review_console_not_deliverable` would investigate the console, but the real problem was a broken CLI or plugin.
- **Why it's wrong**: The `reason` field is a contract with the caller for diagnostics and automated remediation. An incorrect reason misdirects troubleshooting. This is the same class as ERR-002 (silent degradation hides failure reason) and ERR-042 (output does not reflect actual state).
- **Correct approach**: Compute the reason from the actual component statuses: `plugin_failed`, `cli_failed`, `console_not_deliverable`. When multiple components fail, comma-separate the reasons. Never hardcode a single reason when multiple failure modes exist.
- **How to prevent**: When a function has multiple failure paths, the output must distinguish them. Add tests that: (1) each failure mode produces a distinct reason, (2) the reason does not mention unrelated components, (3) multiple failures produce a combined reason.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-002, ERR-042

---

**[ERR-045]** | Shell interpolation of user-provided paths enables command injection

- **What happened**: Story A verification used `execSync(\`"${pdCmd}" demo story-a --json --workspace "${options.workspaceDir}"\`, { shell: 'cmd' })`. The `workspaceDir` is user-provided and enters a shell string via template literal interpolation. A workspace path containing shell metacharacters (e.g., `&`, `|`, `$(...)`) would be interpreted by cmd.exe, enabling command injection.
- **Why it's wrong**: Any user-provided path that flows into a shell command string is an injection vector. Even with quoting, cmd.exe has complex escaping rules that make safe interpolation nearly impossible. This is a security vulnerability, not just a reliability issue.
- **Correct approach**: Use `execFileSync(process.execPath, [entry, ...args])` which passes arguments as an array without shell interpretation. No shell = no injection. This also eliminates the `.cmd` wrapper dependency for verification.
- **How to prevent**: Never use `execSync` with `shell` option for commands that include user input. Always prefer `execFileSync` with array arguments. When shell is unavoidable, validate/sanitize inputs first.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-024 (security mechanism exists but is bypassed)

---

**[ERR-046]** | Rollback failure silently swallowed — install result may falsely claim old state restored

- **What happened**: `restoreBackup()` caught its own errors and only logged them. The install catch block then returned `success: false` with `nextAction: 'Previous install has been restored if it existed'` — but if rollback failed, the previous install was NOT restored and the user received misleading guidance.
- **Why it's wrong**: After a failed install + failed rollback, the system is in an uncertain state. Telling the user "previous install restored" when it wasn't is worse than no message at all — it prevents the user from taking corrective action. This is the same class as ERR-002 (silent degradation hides failure reason).
- **Correct approach**: `restoreBackup` returns `{ restored: boolean; error?: string }`. The install catch block distinguishes: (1) install failed, rollback succeeded → normal failure with restored state; (2) install failed, rollback failed → CRITICAL, state uncertain, manual intervention required. JSON output `reason` includes `install_failed_rollback_failed` for the second case.
- **How to prevent**: Any function that can fail must report its outcome. When composing operations (install + rollback), each failure mode must be distinguishable in the output. Never assume a recovery action succeeded without confirmation.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-002, ERR-044

---

**[ERR-047]** | Non-boolean enabled field in feature flags silently treated as disabled

- **What happened**: `readEnabledChannelsFromDisk()` checked `flag.enabled === true` but did not validate that `enabled` was a boolean. YAML values like `enabled: "true"` (string), `enabled: 1` (number), or `enabled: null` were silently treated as disabled, since strict equality `=== true` fails for non-boolean types.
- **Why it's wrong**: A user writing `enabled: "true"` in YAML expects the channel to be enabled. Silently treating it as disabled violates the principle of least surprise and violates Runtime Contract Rule 3 (required fields must fail loud when malformed). This is the same class as ERR-001/ERR-005 (using `===` comparison instead of runtime type validation).
- **Correct approach**: Validate `typeof flag.enabled === 'boolean'` before comparing. Non-boolean values throw a structured error with the configPath, channel name, actual type, and remediation instructions.
- **How to prevent**: When validating configuration fields, always check the type first, then the value. Never rely on strict equality to implicitly reject wrong types — it silently accepts the wrong behavior instead of failing loud.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-001, ERR-005

---

**[ERR-048]** | Runtime V2 activation write path disconnected from live prompt read path — activation succeeds but principle never injected

- **What happened**: Runtime V2 `ActivationDispatcher` writes activation records to the `activations` SQLite table (`channel='prompt', action='prompt_activate'`), but the live OpenClaw prompt hook (`handleBeforePromptBuild`) only reads from the legacy `evolutionReducer.getActivePrinciples()`. The activation write path and the prompt read path are completely separate systems — activation dispatch never calls `evolutionReducer.promote()`, so activated principles never appear in agent prompts and never change agent behavior.
- **Why it's wrong**: This is the same class as ERR-024/ERR-025 (defense exists but is not enforced; test proves isolated behavior not production path). The activation dispatcher and its tests prove that activation records are written correctly, but the production prompt injection path never consumes those records. The MVP value chain is broken: owner approves → activation record written → principle NOT injected → agent behavior unchanged. The two systems evolved independently (Runtime V2 activation is new; legacy evolutionReducer predates it) and were never connected.
- **Correct approach**: The live prompt hook must directly consume Runtime V2 activation records as a first-class source, independent of the legacy evolution reducer. A `PromptActivationReader` reads `activations` table (channel='prompt') → resolves artifact content → returns injectable principles. The prompt hook merges these with legacy principles, deduplicating by principleId. Feature flag gating is checked. Malformed/missing data fails loud with structured warnings.
- **How to prevent**: When adding a new write path (activation dispatch), immediately verify the corresponding read path (prompt injection) consumes it. Never assume two independently-evolved systems are connected without an explicit binding test. The TDD RED→GREEN cycle (write failing test first that proves the disconnect, then implement the binding) prevents this class of error.
- **Source**: PRI-261
- **Date**: 2026-05-27
- **Recurrence**: Same class as ERR-024, ERR-025. Recurred in PRI-261 PR review: initial implementation also missed validation_status guard, action filter, budget limit, and used `as` type bypass + hand-rolled YAML parser.

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

---

---


**[ERR-065]** | SQLite INSERT guesses column names instead of reading schema — trust-boundary recurrence (ERR-001/ERR-005/ERR-013)

- **What happened**: In the malformed consumed candidate row test for `mainline-snapshot-assembler`, raw SQL INSERT into `principle_candidates` was written with guessed column names: `INSERT INTO principle_candidates (candidate_id, task_id, status, created_at) VALUES ('', ?, 'consumed', ?)`. This hit `SqliteError` three times: first `no column named updated_at`, then `NOT NULL constraint failed: artifact_id`, then `NOT NULL constraint failed: title`.
- **Why it's wrong**: The SQLite schema was treated as "known" without reading it. This is the same trust-boundary violation as ERR-001 (using `as` on untrusted JSON instead of runtime validation), ERR-005 (bypassing type contract on salvaged arrays), and ERR-013 (using `in` on untrusted objects). A database schema is an external data source — guessing column names is no different from using `as Record<string, unknown>` on parsed JSON.
- **Correct approach**: Before writing raw SQL INSERT statements, read the actual CREATE TABLE schema from `sqlite-connection.ts` to confirm all column names, types, and NOT NULL constraints.
- **How to prevent**: When writing raw SQL against a database not authored by the same code: (1) grep the CREATE TABLE statement to verify column names and constraints; (2) include all NOT NULL columns; (3) prefer typed mapper functions over ad-hoc INSERT strings.
- **Recurrence of**: ERR-001, ERR-005, ERR-013
- **Source**: PRI-394 / PR #926
- **Date**: 2026-06-14

---

| Metric | Value |
|--------|-------|
| Total lessons | 65 |
| Last updated | 2026-06-15 |
| Top category | Schema & Type |
| Recurring errors | 27 |

---

**[ERR-040]** | Published artifact missing components that source-tree tests assume exist

- **What happened**: The installer's `syncPdCli()` function expected `pd-cli/dist/index.js` to exist in the package root, but `bundle-plugin.mjs` only copied the OpenClaw plugin — not pd-cli. The `package.json files` array didn't include `pd-cli`. Source-tree tests passed because pd-cli existed in the monorepo, but the published npm tarball would be missing it entirely.
- **Why it's wrong**: Tests that run against the monorepo source tree do not prove the published artifact works. When the bundle script and `files` array don't include a required component, the published package is broken but CI passes. This is the same class as ERR-025 (tests prove isolated behavior, not production defense) and ERR-026 (test environment drifts from production).
- **Correct approach**: For any package that bundles artifacts from other packages, the bundle script must copy ALL required components, the `files` array must include them, and a tarball content contract test must verify the published package contains every expected file.
- **How to prevent**: Add a tarball content contract test that: (1) reads `package.json files` array, (2) asserts required directories are listed, (3) after `npm pack`, asserts the tarball contains expected files. Run this test in CI, not just locally.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-025, ERR-026. Also 2026-06-02 PRI-250 (PR #794): Three separate missing-component issues in the published installer: (1) `js-yaml` and `semver` were in `devDependencies` instead of `dependencies`, so npm publish stripped them — installer crashes on startup with `ERR_MODULE_NOT_FOUND`; (2) console's bundled `agents.js` imports `better-sqlite3` directly but console's `package.json` didn't declare it — `npm file:../core` creates a symlink that does not hoist transitive dependencies; (3) `installBundledCore` copies core/ but never runs `npm install`, so core has no `node_modules` and native modules are unavailable. Fixed by moving runtime deps to `dependencies`, adding `better-sqlite3` to console deps, and adding `installCoreDependencies` step with native rebuild + verify. Also 2026-06-03 PRI-299 (PR #800): @principles/pd-cli directly imported better-sqlite3 but lacked the dependency declaration in its package.json. Fixed by adding better-sqlite3 and types to pd-cli package.json, and adding pd-cli-smoke.test.ts to verify dependency completeness on startup.

---

**[ERR-041]** | Install success reported when delivered components are incomplete

- **What happened**: `install()` returned `success: true` and printed "Ready." when `components.console` was `not_deliverable`. The interactive output said the installation was complete, but a core product surface (owner review console) was missing. This created a contradiction: the installer claimed success while explicitly noting a release-blocking gap.
- **Why it's wrong**: `success: true` means the full product contract is met. If any required component is not deliverable, the install is not successful. Reporting success with an undeliverable component misleads both users and automation. This is the same class as ERR-002 (catch-and-degrade swallows failure) and ERR-009 (silently skip invalid instead of failing loud) — the system claims everything is fine when it's not.
- **Correct approach**: `success` must require ALL required components to be verified/delivered. If any component is `not_deliverable` or `failed`, `success` must be `false`. Interactive output must clearly distinguish full success ("Ready.") from partial success ("Runtime + CLI verified, but console is not yet deliverable"). The README must explicitly state what the installer delivers and what is a known gap.
- **How to prevent**: When defining a component delivery contract, `success` must be a conjunction of ALL required component statuses. If any component is not verified, success is false. Add tests that verify: (1) each component failure makes success=false, (2) all components verified makes success=true, (3) interactive output matches the actual success state.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-002, ERR-009. Recurred 2026-05-26 PRI-247 (PR #721): `bundle-plugin.mjs` silently skipped missing artifacts without exit(1). If `templates/` or `openclaw.plugin.json` was absent, the bundle would produce an incomplete tarball that passes CI but fails at runtime. Fixed by adding PLUGIN_REQUIRED/PD_CLI_REQUIRED arrays with process.exit(1) on missing items, and PLUGIN_OPTIONAL for items that skip with warning.

---

**[ERR-042]** | Output reports requested config instead of actual disk state

- **What happened**: The installer returned `enabledChannels: options.channels` in its result, but the actual feature-flags.yaml on disk might have different channels enabled (e.g., from a previous install). When rerunning with `--channels prompt`, the output said `enabledChannels: ['prompt']` but the disk still had all three MVP channels enabled because `generateFeatureFlagsConfig()` skipped writing when the file already existed.
- **Why it's wrong**: The output is a contract with the caller. If it says `enabledChannels: ['prompt']` but the disk has `['prompt', 'code_tool_hook', 'defer_archive']`, the caller cannot trust the output. This is the same class as ERR-034 (canonical config not consumed by caller) — the output should reflect the source of truth (disk), not the input parameters.
- **Correct approach**: (1) When `--channels` is specified, always rewrite `feature-flags.yaml` to match (no early return on existing file). (2) After writing, read the actual enabled channels from disk and return those in the output. (3) If preserving existing config, explicitly report `configuration_preserved` and read from disk.
- **How to prevent**: When a function returns state that should reflect disk, always read from disk after writing — never return the input parameters as if they were the result. Add tests that: (1) write config, (2) modify config, (3) verify output matches disk, not input.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-034

---

**[ERR-055]** | Privacy redaction helper uses ALL-segment logic instead of ANY — composite sensitive keys pass through unredacted

- **What happened**: `isSensitiveKey()` required EVERY segment of a composite key to match `SENSITIVE_KEY_SEGMENTS`. This meant `github_token` (segments: `["github", "token"]`) was NOT flagged because "github" is not in the sensitive set. Only keys where ALL segments were sensitive (e.g., `auth_token` where both "auth" and "token" are in the set) were caught.
- **Why it's wrong**: The privacy guarantee is that any key containing a sensitive segment should be redacted. Using ALL-segment logic inverts this — it only redacts when the entire key name is composed of sensitive words. This is a security vulnerability: `db_password`, `github_token`, `api_key`, `aws_secret` all pass through unredacted.
- **Correct approach**: A key should be sensitive if ANY of its segments matches a sensitive segment. Change the logic from "all segments must match" to "at least one segment must match". Keep the empty-segment guard to avoid false positives on empty strings.
- **How to prevent**: When implementing a membership check on composite keys, the safety-correct default is ANY-match (flag if any part is sensitive). Use ALL-match only when the requirement is explicitly "all parts must be sensitive" (which is almost never the right choice for security). Add tests with real composite key names (`github_token`, `db_password`, `aws_secret_key`).
- **Source**: PRI-285 / PR #767
- **Date**: 2026-06-01
- **Recurrence**: Same class as ERR-024 (security check exists but is not wired into enforcement path)

---

**[ERR-056]** | Redaction pipeline truncates string values without running path/token/env redactors — secrets slip through

- **What happened**: In `redactSensitiveFields()`, the `t === 'string'` branch only truncated strings to `REDACT_MAX_STRING` without running them through `redactAbsolutePaths()`, `redactTokenLikeValues()`, and `redactEnvLikeValues()`. Similarly, `render-github-url.ts` used `shortSummary` with only truncation but no redaction before putting it into the URL body.
- **Why it's wrong**: The redaction pipeline has two layers: (1) key-based redaction (redact entire values for sensitive keys), and (2) value-based redaction (redact secrets embedded in any string value regardless of key name). Layer 2 was not applied to the string branch. This means secrets embedded in non-sensitive-key values (e.g., `buildId` containing a token, `cwd` containing an absolute path) slip through. Same class as ERR-014/ERR-016/ERR-017 (previews and serialization not bounded/safe).
- **Correct approach**: Every string value that passes through the redaction pipeline must be run through the full set of string redactors (path, token, env) BEFORE truncation. Truncation should be the last step. The same applies to any renderer that embeds user-provided text into output (markdown, email, GitHub URL body).
- **How to prevent**: When adding a new branch to a redaction pipeline, check that ALL existing string redactors are applied before any truncation. Add tests that verify secrets in values (not just in keys) are redacted.
- **Source**: PRI-285 / PR #767
- **Date**: 2026-06-01
- **Recurrence**: Same class as ERR-014, ERR-016, ERR-017. Also 2026-06-06 PEAT-A (PR #836): `sanitizeString()` in `evidence-sanitizer.ts` only ran `convergePath()` on the full string value — absolute paths embedded inside longer strings (e.g. `"cd D:\\Code\\principles && git status"`, `"error in C:\\Users\\Administrator\\secret.txt"`) passed through unredacted. Fixed by adding `ABSOLUTE_PATH_IN_STRING_RE` regex that detects Windows drive (`[A-Za-z]:\\`), POSIX (`/path/segments`), and UNC (`\\server\\share`) absolute paths embedded anywhere in a string, and `replacePathsInString()` that converges them to repo-relative or `<path:basename>`. Also 2026-06-06 PEAT-A CI breakage: `convergePath()` initially used `nodePath.basename()` which on Linux (POSIX) does not split on `\`, so `D:\Code\principles` was preserved verbatim in CI output. Fixed by replacing `nodePath.basename()` with `platformAgnosticBasename()` that splits on both `\` and `/` character classes. This is a cross-platform portability variant of the same class — a path operation that works on the developer's Windows machine but silently fails on the CI runner's Linux environment.

---

**[ERR-057]** | errMsg helper checks typed narrower parameter instead of unknown caught value — error message extraction always falls through

- **What happened**: `errMsg(e: { code?: string } | undefined, err: unknown)` was designed to extract a readable message from caught errors. The first parameter `e` is a typed narrower (`err as { code?: string }`) used for `code === 'ENOENT'` checks. The second parameter `err` is the raw `unknown` caught value. But the function body checked `e` for a `.message` property — which `e` (typed as `{ code?: string }`) never has. This meant the function always fell through to `String(err)`, producing less useful error messages like `[object Object]`.
- **Why it's wrong**: The parameter naming was confusing and led to checking the wrong variable. The typed narrower is for `code` checks (done by the caller before calling errMsg), not for message extraction. Message extraction should operate on the raw `unknown` value.
- **Correct approach**: Check the `unknown` parameter (second argument) for `.message` property, not the typed narrower. Or better: restructure to a single-parameter function that takes `unknown` and extracts the message, since the typed narrower is only needed by the caller for `code` checks.
- **How to prevent**: When a helper function takes two parameters with confusingly similar names (`e` and `err`), add a comment explaining what each is for. Use descriptive names like `typedNarrower` and `rawError` instead of single-letter names. Add unit tests that verify the function correctly extracts messages from Error objects, string errors, and non-Error objects.
- **Source**: PRI-285 / PR #767
- **Date**: 2026-06-01
- **Recurrence**: Same class as ERR-001, ERR-005 (runtime type check operates on wrong value)

---

**[ERR-049]** | Unconditional taskId reinjection bypasses validator mismatch check — malicious LLM lineage fields pass validation

- **What happened**: When fixing `stripLineageFields` removing `taskId` from LLM output (PRI-272), I used unconditional assignment `(output as unknown as Record<string, unknown>).taskId = taskId` in all 7 peer runners (Dreamer, Philosopher, Scribe, Artificer, Evaluator, RolloutReviewer, Trainer). This overwrote any LLM-supplied `taskId` — including wrong or malicious values — before `DefaultDreamerValidator.validate()` could check for mismatches. The `output.taskId !== taskId` check became dead code.
- **Why it's wrong**: The validator's taskId mismatch check is a security boundary (ERR-008 lineage protection). It prevents LLM-supplied lineage fields from poisoning downstream artifacts. Unconditional reinjection bypasses this check entirely — a malicious or buggy LLM that returns `taskId: "injected-id"` would have it silently overwritten with the correct value, and the artifact would be written as if the LLM output was trustworthy.
- **Correct approach**: Only inject runner-owned lineage when the property is **absent** via `Object.hasOwn(output, 'taskId')`. Present but invalid/falsy values (`''`, `0`, `false`, `null`, wrong string) must NOT be overwritten — they must reach the validator and fail loud (Runtime Contract Rule 3). Use the `injectRunnerLineageIfAbsent(output, 'taskId', taskId)` helper from `peer-runner-contracts.ts` to centralize this logic across all 7 runners. The helper performs a runtime type guard (`output !== null && typeof output === 'object'`) before calling `Object.hasOwn`.
- **How to prevent**: When re-injecting fields stripped by a security mechanism, always use `Object.hasOwn` — never truthiness checks (`!value`). Truthiness treats `''`, `0`, `false`, `null` as "missing" and silently overwrites them, hiding validation failures. Required regression tests per runner: missing taskId → injected; `taskId: ''` → not overwritten, validation fails; `taskId: 0` → not overwritten, validation fails; `taskId: false` → not overwritten, validation fails; `taskId: 'wrong-id'` → not overwritten, validation fails. Static regression test: verify no runner contains the old `!(output as unknown as Record<string, unknown>).taskId` pattern.
- **Source**: PRI-294 / PR #790
- **Date**: 2026-06-02
- **Recurrence**: Same class as ERR-008 (lineage fields must not be trusted from LLM output)

---

**[ERR-050]** | Modified bundled/generated copy instead of source of truth — fix overwritten on next build

- **What happened**: During PR #794, `better-sqlite3` was added to `packages/create-principles-disciple/console/package.json` (a bundled copy generated by `bundle-plugin.mjs`) instead of the source `packages/pd-console/package.json`. The next `prepack`/`prepublishOnly` would run `bundle-plugin.mjs` and overwrite the fix, silently losing the dependency.
- **Why it's wrong**: `packages/create-principles-disciple/console/` is a generated artifact — `bundle-plugin.mjs` copies from `packages/pd-console/` and rewrites `@principles/core` to `file:../core`. Editing the generated copy is the same class as editing `dist/` output: it works until the next build. This is a process error: the agent did not trace the file's provenance before editing.
- **Correct approach**: Always trace a file's provenance before editing. If the file is generated (by a bundle script, build step, or codegen), edit the SOURCE and re-run the generator. For this case: add `better-sqlite3` to `packages/pd-console/package.json`, then run `node scripts/bundle-plugin.mjs` to sync.
- **How to prevent**: Before editing any `package.json` (or any file), check if it's listed in a bundle/build script's copy/rewrite step. If the file has a source of truth, edit the source and re-run the generator. Add a comment in generated files: `// GENERATED — edit packages/pd-console/ and re-run bundle-plugin.mjs`.
- **Source**: PRI-250 / PR #794
- **Date**: 2026-06-02
- **Recurrence**: Same class as ERR-040 (published artifact missing components) — editing a generated artifact instead of its source.


---
**[ERR-051]** | Security redaction inserted into RuleHost input path before evaluation, not just telemetry output path

- **What happened**: PRI-297 added security redaction to _extractParamsSummary() in gate.ts, which is called before RuleHost.evaluate() receives the params. This meant raw exec commands containing Authorization: Bearer or LINEAR_API_KEY= were redacted before RuleHost implementations could match against input.action.paramsSummary.command. A live rule intended to block a command by URL/argument after an auth header would fail to match. The EventLog.record() chokepoint correctly redacted before persistence, but the gate.ts source-level redaction was premature.
- **Why it's wrong**: Security redaction must happen at the persistence boundary (before event log write), not at the enforcement boundary (before RuleHost evaluation). Redacting before RuleHost evaluation silently degrades rule matching accuracy — rules that match on command strings stop working for commands containing secrets. This is the same class as ERR-002 (silent degradation) — the mechanism exists, but it's applied at the wrong layer, creating a hidden behavior change.
- **Correct approach**: Apply redaction only in EventLog.record() as a chokepoint before JSON persistence. Leave _extractParamsSummary() raw — it feeds into RuleHost evaluation for command-matching rules. If a future requirement needs redacted versions in both places, two separate calls are needed: one for RuleHost input (preserving structure), one for EventLog (redacting).
- **How to prevent**: When adding security/privacy transformations, identify the data flow boundaries first: (1) enforcement boundary (where conditions are matched), (2) persistence boundary (where data is written). Always apply transformations at the persistence boundary. If enforcement needs sanitized data, create a separate cleaned copy — never mutate the enforcement input. Add a test that proves the enforcement path receives raw data.
- **Source**: PRI-297 / PR #797
- **Date**: 2026-06-03
- **Recurrence**: Same class as ERR-002 (silent degradation at wrong layer)
---

**[ERR-052]** | Cherry-pick from stacked feature branch cross-contaminates unrelated PR

- **What happened**: When creating PR #800 (PRI-300 console-launcher) from the `feat/pri-300-console-launcher` branch, a cherry-pick from `feat/pri-299-config-doctor` was used to bring in the ERR-050 handbook entry. This cherry-pick also brought in the `pd config doctor` CLI source files from PRI-299, which were completely unrelated to the console launcher PR. PR #800's diff included config-doctor code that belonged in PR #801 (PRI-299).
- **Why it's wrong**: Cherry-picking from a stacked feature branch carries all commits on that branch, not just the intended one. This cross-contaminates PRs with unrelated code, making reviews confusing and creating merge conflicts when both PRs target main. The reviewer sees changes that don't belong and must investigate whether they're intentional.
- **Correct approach**: When a new PR needs a handbook entry from another branch, create the entry fresh on the new branch instead of cherry-picking. For code dependencies between stacked branches, use `git rebase` or create the dependent branch from the tip of the first branch. Never cherry-pick from a feature branch that contains unrelated work.
- **How to prevent**: Before cherry-picking, inspect the source branch's full commit list (`git log main..source-branch`). If it contains commits unrelated to the target, create the needed changes manually instead. Add a pre-cherry-pick checklist: (1) list source commits, (2) verify all are relevant, (3) if not, create fresh.
- **Source**: PRI-299 / PR #800
- **Date**: 2026-06-03
- **Recurrence**: None

---

**[ERR-053]** | New CLI subcommand never registered in Commander program - 4 of 22 wiring tests silently fail

- **What happened**: `pd config doctor` subcommand was implemented in `config-doctor.ts` with full handler logic, but the subcommand was never registered in `packages/pd-cli/src/index.ts`. The Commander program had no `.command('config')` or `.command('doctor')` registration, so `pd config doctor` would fail with "unknown command". Meanwhile, 4 of 22 CLI wiring tests in `cli-wiring-registration.test.ts` were silently failing because they tested registration existence without asserting the command actually runs.
- **Why it's wrong**: A CLI subcommand that is not registered is completely unreachable to users. The implementation exists but the wiring is missing - same class as ERR-024 (security validator not wired into enforcement path) and ERR-048 (activation write path disconnected from read path). The silently failing tests are the same class as ERR-025 (tests prove isolated behavior, not production defense).
- **Correct approach**: When adding a new CLI subcommand, the implementation checklist must include: (1) handler file, (2) Commander registration in `index.ts`, (3) wiring test that calls `program.parseAsync(['node', 'pd', 'config', 'doctor', ...])` and asserts it reaches the handler, (4) no test should silently pass when the command is unregistered.
- **How to prevent**: Add a mandatory "Commander registration" checklist item for every new CLI subcommand. The wiring test must call `program.parseAsync()` with the full command path, not just test handler existence. Add a global test that enumerates all registered commands and verifies each has a corresponding handler file.
- **Source**: PRI-299 / PR #801
- **Date**: 2026-06-03
- **Recurrence**: Same class as ERR-024, ERR-048 (code exists but is not wired into production path)

---

**[ERR-054]** | `as TOutput` cast on untrusted LLM/runtime payload before validation — typed hooks receive unverified data

- **What happened**: `BasePeerRunner.fetchAndParseOutput()` cast `result.payload` as `TOutput` (generic type parameter) without runtime validation. The `run()` template method then called `postFetchTransform()` and `checkLineageIntegrity()` with this unverified typed data BEFORE calling `validateOutput()`. This meant untrusted LLM/runtime output entered typed runner hooks as if it were validated.
- **Why it's wrong**: Violates Runtime Contract Rule 1 (ERR-001: treat parsed JSON/LLM output as `unknown`) and Rule 2 (ERR-005: do not use `as` to bypass runtime validation). The `as TOutput` cast is a type-system lie — the payload has not been validated at that point. Typed hooks receiving unverified data could access properties that don't exist, leading to silent undefined behavior or crashes.
- **Correct approach**: `fetchAndParseOutput()` must return `unknown`. Pre-validation hooks (`postFetchTransform`) must accept `unknown`. Only after `validateOutput()` confirms the payload shape should data be cast to `TOutput`. Post-validation hooks (`checkLineageIntegrity`, `emitSuccessTelemetry`, `succeedTask`) receive the validated typed data.
- **How to prevent**: Any function that returns data from an external source (LLM, runtime adapter, network) must return `unknown`. The trust boundary is the validation step — no data should be typed before crossing it. Review checklist: (1) Does this function return data from an untrusted source? (2) If yes, does it return `unknown`? (3) Is the `as` cast AFTER a validation step?
- **Source**: PRI-302 / PR #806
- **Date**: 2026-06-03
- **Recurrence**:
  - (1) First occurrence in BasePeerRunner.fetchAndParseOutput (PR #806).
  - (2) ArtificerRunner.validateOutput used `result.errorCategory as PDErrorCategory | undefined` instead of `isPDErrorCategory()` runtime check (PR #810, 2026-06-03). Same root cause: `as` cast used instead of runtime validation, violating Runtime Contract Rule 2. PhilosopherRunner already had the correct `isPDErrorCategory()` pattern but ArtificerRunner migration did not align to it.
  - (3) 2026-06-03 PR #809 review: EvaluatorValidator.validate() interface accepted `EvaluatorOutputV1` instead of `unknown`, and evaluator-runner.ts line 203 used `output as EvaluatorOutputV1` before passing to the validator. Same class: typed parameter at trust boundary bypasses the purpose of runtime validation. Fixed by changing the interface to accept `unknown` and removing the `as EvaluatorOutputV1` cast.


---

**[ERR-060]** | Emitted telemetry event not registered in schema — event silently dropped or degraded

- **What happened**: After migrating Scribe/Evaluator/Artificer runners to BasePeerRunner, the runners emit events like `artificer_implementation_plan_generated`, `scribe_principle_draft_generated`, etc. via `this.emitEvent()`. BasePeerRunner prefixes these with the runner name (e.g., `artificer_implementation_plan_generated`). But `telemetry-event.ts` TelemetryEventType union did not include any `artificer_*`, `evaluator_*`, or `scribe_*` event literals. Events not in the schema are silently dropped or degraded by the telemetry pipeline.
- **Why it's wrong**: The telemetry schema is the contract for what events are valid. If an emitted event is not registered, it's silently lost — no error, no warning, no observability. This is the same class as ERR-024 (mechanism exists but is not wired) and ERR-002 (silent degradation). The runner believes it's emitting telemetry, but the pipeline discards it. Operators cannot observe runner behavior through the telemetry dashboard.
- **Correct approach**: When adding a new runner that emits events via BasePeerRunner.emitEvent(), register ALL possible event literals (including BasePeerRunner lifecycle events prefixed with the runner name) in the TelemetryEventType union in telemetry-event.ts. Add a test that proves the schema accepts each event type.
- **How to prevent**: When creating a new BasePeerRunner subclass, the PR checklist must include: (1) list all events the runner can emit, (2) verify each is in TelemetryEventType, (3) add a test proving the schema accepts each event. Review trigger: any PR that adds a new runner or new emitEvent() call must also update telemetry-event.ts.
- **Source**: PR #808/#809/#810
- **Date**: 2026-06-03
- **Recurrence**: Yes - 2026-06-11 PR #902 (PRI-371): `diagnostician_core_grounding_result` telemetry event emitted by DiagnosticianRunner.succeedTask() but not registered in TelemetryEventType union in telemetry-event.ts. Event would be silently dropped and replaced with `degradation_triggered` fallback by StoreEventEmitter. Same class as original: new event literal added to runner but telemetry schema not updated.

---

**[ERR-063]** | Commander `--no-<flag>` option property accessed via incorrect name — flag silently ignored

- **What happened**: When changing `--enqueue-next` to `--no-enqueue-next` (inverting the default), the CLI registration used `.option('--no-enqueue-next', ...)` but the `.action()` handler accessed `opts.noEnqueueNext`. Commander's `--no-` prefix convention stores the option as the *positive* form: `--no-enqueue-next` → `opts.enqueueNext`. Since `opts.noEnqueueNext` is always `undefined`, `!opts.noEnqueueNext` is always `true`, meaning the `--no-enqueue-next` flag was silently ignored and enqueue always happened regardless of the flag.
- **Why it's wrong**: The Commander.js `--no-` prefix negation convention is well-documented but non-obvious. The property name is derived by removing the `--no-` prefix and camelCasing the remainder, NOT by camelCasing the full flag name. Using `opts.noEnqueueNext` (the full flag name camelCased) accesses a non-existent property that is always `undefined`. This makes `--no-enqueue-next` a no-op — the most dangerous kind of bug because the flag appears to work (no error thrown) but has no effect.
- **Correct approach**: When using Commander's `--no-<flag>` negation, the option value is stored as `opts.<flag>` (positive form). For `--no-enqueue-next`, access `opts.enqueueNext`. Always verify Commander property names by testing with `console.log(JSON.stringify(opts))` or writing a parser-level test that calls `program.parseAsync()` with the flag.
- **How to prevent**: When registering `--no-<flag>` Commander options, immediately write a parser-level test that verifies the option value is correctly parsed with AND without the flag. The test should assert `opts.<positiveForm> === false` when the flag is present and `opts.<positiveForm> === true` when absent. Review trigger: any PR that uses Commander's `--no-` prefix must include a parser test.
- **Source**: PR #844
- **Date**: 2026-06-07
- **Recurrence**: None

---

**[ERR-062]** | Collapsed details section renders empty-state copy instead of actual data when data exists

- **What happened**: In the FocusPage `<details>` collapsed section (Layer 3: full trajectory), the content inside the `<details>` element always rendered `{t("pages.focus.emptyDeviation")}` regardless of whether data was available. When `deviationCount > 0`, the user would expand the details section expecting to see deviation evidence, but instead saw the empty-state message "No behavior deviations captured yet."
- **Why it's wrong**: The `<details>` section was implemented as a copy of the empty-state branch without updating the content to render actual data. The conditional branch `deviationCount > 0` correctly showed the count and disclaimer, but the nested `<details>` inside it always showed the empty-state i18n key. This violates EP-03: degraded content shown when actual data is available is a form of misleading degradation.
- **Correct approach**: The `<details>` section content must be conditionally rendered: show actual data (e.g., pending group titles and record counts) when data is available, and show the empty-state message only as a fallback. Each conditional branch in a component must be reviewed for content correctness, not just structural correctness.
- **How to prevent**: When implementing nested conditional rendering (e.g., a `<details>` inside a conditional branch), verify that each branch renders content appropriate to its condition. Add a visual or test check that the expanded details section shows actual data when data exists. Review trigger: any PR that adds a `<details>` or collapsed section must include a test or manual check that the expanded content matches the data condition.
- **Source**: PRI-319 / PR #825
- **Date**: 2026-06-05
- **Recurrence**: None

---

**[ERR-061]** | Runtime shape check validates wrong field name — guessed structure instead of verifying against actual type

- **What happened**: When fixing a P0 review finding (ERR-001 recurrence: `as` cast bypassing validation in `ConsoleLifecycleDatasource.loadLedger()`), the AI replaced the `as LedgerTreeStore` cast with a runtime shape check. However, the shape check validated `nodes` (an array field) instead of `principles` (a record field). The actual `LedgerTreeStore` interface is `{ principles: Record<string, LedgerPrinciple>, rules: Record<string, LedgerRule>, implementations: Record<string, Implementation>, metrics: Record<string, PrincipleValueMetrics>, lastUpdated: string }` — it has no `nodes` field at all. The check `!Array.isArray(tree.nodes)` always evaluated to `true`, causing `loadLedger()` to throw "ledger tree is malformed" for every valid ledger, which made all lifecycle route tests return 500 instead of 200/404.
- **Why it's wrong**: The AI guessed the structure instead of reading the actual `LedgerTreeStore` interface definition. The fix replaced one form of invalid validation (`as` cast) with another form of invalid validation (checking the wrong field). Both bypass the purpose of runtime validation: ensuring the data matches the expected shape. A shape check that validates a non-existent field is equivalent to no shape check at all — it rejects valid data and provides a false sense of security.
- **Correct approach**: When writing a runtime shape check, read the actual type/interface definition first. The check should validate the most discriminating required field(s) of the actual type. For `LedgerTreeStore`, the correct check is `isRecord(tree.principles)` (the `principles` field is the primary discriminator — a valid ledger must have a `principles` record). Always verify the shape check matches the actual type definition, not an assumed one.
- **How to prevent**: Before writing a runtime shape check, read the target type's interface definition. The shape check must validate at least one required field that exists in the actual type. Add a test that proves the shape check passes for valid data and fails for malformed data. Review trigger: any PR that adds or modifies a runtime shape check must include a test proving the check works against the actual type structure.
- **Source**: PR #823
- **Date**: 2026-06-05
- **Recurrence**: None

---

**[ERR-058]** | Inconsistent forbidden-key lists across validation paths — gateway_token passes pi-ai profile validation

- **What happened**: `validateOpenClawProfile` and `validatePdLocalProfile` each defined their own local `forbiddenKeys` arrays for rejecting secret-bearing fields. The openclaw list included `gatewayToken` and `gateway_token`, but the pd-local list only had `apiKey`, `api_key`, `token`, `secret`, `password`, `auth`. This inconsistency meant `gateway_token` and `gatewayToken` would pass validation in pi-ai profiles, potentially allowing secret values through.
- **Why it's wrong**: When security deny-lists are defined in multiple places, any inconsistency creates a bypass path. The openclaw validator would correctly reject `gateway_token`, but the pi-ai validator would accept it. A user or LLM could place secrets in a pi-ai profile under `gateway_token` and they would pass validation.
- **Correct approach**: Define forbidden-key lists as a single shared constant (e.g., `FORBIDDEN_SECRET_KEYS`) and reference it from all validation paths. When adding a key to one list, it must appear in all lists that serve the same security purpose.
- **How to prevent**: When implementing security validation that rejects dangerous fields by name, (1) define the list as a shared constant, (2) reference it from all validation paths, (3) add a test that each forbidden key is rejected in every validation path that uses the list. Review checklist: (1) Are there multiple lists serving the same security purpose? (2) Are they identical? (3) Is there a test for each list × forbidden key combination?
- **Source**: PRI-304 / PR #811
- **Date**: 2026-06-03
- **Recurrence**: First occurrence

---

**[ERR-059]** | Nullish coalescing dead code — always-defined default shadows user override in effective config merge

- **What happened**: In `computeEffectivePdConfig()`, the else branch for agents without user override used `defaultBinding.runtimeProfile ?? userConfig.internalAgents.defaultRuntime`. Since `getDefaultInternalAgents()` always sets `runtimeProfile` to `'openclaw.default'` for every agent, the `??` operator never reached the right-hand side. This meant agents without explicit override always got the hard-coded `'openclaw.default'` instead of the user's configured `defaultRuntime`.
- **Why it's wrong**: When a function always returns a defined value for a field, using `??` with a fallback for that field is dead code. The intent was "use the user's defaultRuntime as fallback", but the always-defined `defaultBinding.runtimeProfile` prevented the fallback from ever being reached. This is a logic error that silently breaks the user's expectation.
- **Correct approach**: When merging user config with defaults, distinguish between (1) user-provided values, (2) hard-coded defaults, and (3) user-configured defaults. For agents without explicit override, the correct behavior is to use the user's `defaultRuntime`, not the hard-coded default's `runtimeProfile`.
- **How to prevent**: When writing `a ?? b`, verify that `a` can actually be null/undefined. If `a` is always defined (e.g., from a function that always returns a value), the `?? b` is dead code. Test the fallback path explicitly: set the user's default to a non-default value and verify agents without override use it.
- **Source**: PRI-304 / PR #811
- **Date**: 2026-06-03
- **Recurrence**: First occurrence

---

**[ERR-064]** | CLI subcommand option regressions — Commander flag → opts mapping lost or misrouted during edit

- **What happened**: During PRI-337 implementation, the pd pain retry command lost its --baseUrl, --maxRetries, --timeoutMs, and --force options. These options ended up on a bogus top-level pd canary command that incorrectly called handlePainRetry instead of handleRuntimeCanary. Separately, pd pain evidence was hardcoded to read .state/logs/SYSTEM_*.log instead of the actual SystemLogger path <workspace>/memory/logs/SYSTEM_YYYY-MM-DD.log.
- **Why it's wrong**: CLI commands with lost options silently stop working. Wrong command handlers produce confusing behavior. Wrong log paths return empty results with no error, making operators think the system is broken.
- **Correct approach**: (1) Every time you add/remove a Commander .option() call, verify ALL options are present by parsing the full command registration. (2) After any index.ts edit that touches .command(), run a parser-level test that confirms each option routes correctly. (3) For log path code, always read the actual SystemLogger source code to verify the format/format/location, never guess.
- **How to prevent**: (1) Add parser-level tests for EVERY CLI option on every subcommand — these are trivial to write (10 lines each) and catch regression immediately. (2) When editing Commander registration, diff against the handler's actual option usage, not against the previous registration. (3) When reading log files, trace the exact SystemLogger path resolution before writing reader code.
- **Source**: PRI-337 / PR #852
- **Date**: 2026-06-08
- **Recurrence**: First occurrence (similar but distinct from ERR-053 which is about missing registration entirely)
[ERR-064]: docs/ERROR_EXPERIENCE_HANDBOOK.md#ERR-064

---

**[ERR-066]** | CLI --json failure path not structured; raw stack trace dumped to stderr on assembler throw

- **What happened**: PRI-397's `pd mvp smoke --json` and `pd task list --json` handlers did not wrap their work in try/catch. On any assembler/state-manager throw (e.g., fresh post-PRI-398 workspace, missing `.pd/state.db`, corrupt config), the throw bubbled to the top of the async function, the test runner saw a raw stack trace on stderr, and the exit code was non-zero with no JSON output on stdout. This violated EP-04 Rules 1 (single parseable JSON object on stdout) and 6 (failure paths must carry reason + nextAction). The handler was shipped untested for the failure path. I marked my self-review Phase 6.5 as "no real issues" without running the failure path through a test or even a manual `pd mvp smoke --workspace <nonexistent>` against the production binary.
- **Why it's wrong**: The first operator run after a workspace reset (the explicit PRI-398 motivation for `pd mvp smoke`) is precisely when the database is missing or unreadable — i.e., when the failure path triggers. A CLI that emits a raw stack trace on the most common first-failure scenario defeats the entire purpose of the command. The bug is a process failure as well: I trusted the success-path tests as proof of completeness, when the failure path was the load-bearing one.
- **Correct approach**: For every new --json handler, add a test that calls the handler with a workspace that will fail (nonexistent dir, corrupt DB) and asserts: (1) exit code is 1, (2) stdout contains exactly one parseable JSON object, (3) the object has `ok: false`, `reason: string`, `nextAction: string`. Use a structured error classifier (e.g., `classifySmokeError(err)`) that names the specific next action (e.g., "Run pd runtime internalization integrity-repair --confirm") rather than a generic "retry" hint. When writing the self-review, run the production binary with a bad workspace and confirm the JSON output looks right end-to-end.
- **How to prevent**: (1) The CLI/Operator Contract gate already requires this — apply it as a hard checklist before claiming "no real issues": for every --json command, run a manual test with a failing workspace, run a real `program.parseAsync` test with a failing workspace, and assert the JSON shape. (2) Add the failure-path test to the same test block as the success-path test so they ship together. (3) Self-review must NEVER mark "no real issues" without first running the failure path through a real test or a real production binary invocation. (4) Prefer shared registration helpers (e.g., `registerMvpCommands(program)`) so the failure-path test runs the same registration as production — a hand-rebuilt command tree can pass tests while production is broken.
- **Source**: PRI-397 / PR #932
- **Date**: 2026-06-15
- **Recurrence**: First occurrence (related to EP-04 missing tests; same pattern as ERR-021, ERR-029, ERR-033, ERR-053)
[ERR-066]: docs/ERROR_EXPERIENCE_HANDBOOK.md#ERR-066

---

**[ERR-067]** | Orchestrator treats `retried` status as failure — retry chain breaks at SplitDiagnosticianRunner and diagnose CLI

- **What happened**: When a sub-runner (e.g., DiagRootCauseRunner) returns `status: "retried"` from `retryOrFail()`, the SplitDiagnosticianRunner treats it as failure (since `resultA.status !== "succeeded"`) and immediately marks the parent task as failed. The retry mechanism in BasePeerRunner works correctly (marks task as `retry_wait`, increments attemptCount), but the orchestrator doesn't wait for or trigger the retry. Similarly, `diagnose run` CLI command checks `result.status !== "succeeded"` and exits with code 1, never giving the retry a chance. This means `output_invalid` errors from LLM schema non-compliance (e.g., qwen3.6-27b-mtp missing `rootCauseCategory`) are never retried, even though `output_invalid` is not in `permanentErrorCategories` and `shouldRetry()` returns true.
- **Why it's wrong**: The retry mechanism was designed to handle transient LLM failures (schema non-compliance, truncated output, etc.), but the orchestrator layer defeats it by treating `retried` as a terminal failure. This makes the entire retry infrastructure useless for the split pipeline — the most important use case where LLM schema compliance is hardest to guarantee.
- **Affected code**:
  1. `SplitDiagnosticianRunner.run()` — Lines 126-137, 180-191, 240-251: `if (resultA.status !== "succeeded")` treats `retried` as failure
  2. `diagnose.ts` CLI — Lines 389-407: `if (result.status !== "succeeded")` exits with code 1 on `retried`
  3. `SplitDiagnosticianRunner.run()` — Lines 106-113: resets `attemptCount: 0` on `retry_wait` tasks, losing retry progress
- **Correct approach**: (1) SplitDiagnosticianRunner should distinguish `retried` from `failed`: on `retried`, wait for the retry backoff period and re-run the stage, up to maxAttempts. (2) `diagnose run` CLI should loop: on `retried`, sleep for the backoff period and call `runner.run()` again until `succeeded` or `failed`. (3) SplitDiagnosticianRunner should NOT reset `attemptCount: 0` on `retry_wait` tasks — this loses retry progress and makes `shouldRetry()` always return true.
- **How to prevent**: (1) Any orchestrator that calls `runner.run()` must handle all three terminal statuses: `succeeded`, `retried`, `failed`. (2) Tests for orchestrators must include a `retried` → retry → `succeeded` scenario. (3) Never use `status !== "succeeded"` as a failure check — explicitly check `status === "failed" || status === "max_attempts_exceeded"`. (4) Never reset `attemptCount` on `retry_wait` tasks.
- **Source**: PRI-405
- **Date**: 2026-06-16
- **Recurrence**: First occurrence (EP-05 Loop State Freshness + EP-02 Production Path Wiring)
[ERR-067]: docs/ERROR_EXPERIENCE_HANDBOOK.md#ERR-067

**[ERR-068]** | Used the wrong package manager (pnpm) in a repo whose CI runs `npm ci`, leaving `package-lock.json` out of sync

- **What happened**: Adding the `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` dependencies via `pnpm install` updated `pnpm-lock.yaml` only. The repo's CI workflows all run `npm ci` (which reads `package-lock.json`). Because `package-lock.json` was not updated, every CI job failed with `Missing: @earendil-works/pi-agent-core@0.79.4 from lock file` and `Invalid: lock file's typebox@1.1.34 does not satisfy typebox@1.1.38`. Local pre-push `verify:merge` passed because it does not re-resolve the lockfile.
- **Root cause**: Did not check which package manager CI uses before installing dependencies. The repo root has both `package.json` (`packageManager: pnpm@11.1.1`) and `package-lock.json`, but CI workflows exclusively use `npm ci`. pnpm and npm maintain separate lockfiles; updating one does not sync the other.
- **Fix**: `git checkout pnpm-lock.yaml` (revert the wrong lockfile), then `npm install --ignore-scripts` to regenerate `package-lock.json` with the new deps. Commit 3a7780e.
- **Prevention**: Before adding/removing dependencies, check CI workflows (`grep -r "npm ci\|pnpm install" .github/workflows/`) to identify the canonical lockfile. Run the install command matching CI's package manager, then commit the lockfile CI reads. EP-06 "package runtime dependencies are declared in the package that imports them" extends to: the lockfile CI consumes must be the one updated.
- **Recurrence**: 2026-06-16, PRI-419 / PR #953.
