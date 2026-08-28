# Error Experience Handbook

> **INCIDENT LOG.** For ordinary coding tasks, start with `docs/process/error-management/ERROR_PATTERN_INDEX.md` and then read the detailed entries it references. Read this full file when recording a new error, auditing error history, or when the compact index does not cover the task.

---

## How to Record an Error

When a code review catches an AI assistant error, use the `record-error` skill. The skill handles the full workflow automatically:

1. **Add a comment** on the Linear Issue using the entry format below
2. **Tag the issue** with `lesson-learned` label (via Linear MCP tool)
3. **Edit this file** — add a row to the category table AND add a detailed entry in the "Detailed Entries" section
4. **Update statistics** at the bottom of this file
5. **Update `docs/process/error-management/ERROR_PATTERN_INDEX.md`** if the error creates or changes a recurring pattern
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
| ERR-024 | Security validator exists but is not wired into enforcement path — defense is illusory | PRI-210; PR #1358 |
| ERR-040 | Published artifact missing components that source-tree tests assume exist | PRI-247 |
| ERR-041 | Install success reported when delivered components are incomplete | PRI-247 |
| ERR-042 | Output reports requested config instead of actual disk state | PRI-247 |
| ERR-043 | nextAction wraps entire shell command in quotes, making it unrunnable | PRI-247 |
| ERR-045 | Shell interpolation of user-provided paths enables command injection | PRI-247 |
| ERR-048 | Runtime V2 activation write path disconnected from live prompt read path — activation succeeds but principle never injected | PRI-261 |
| ERR-097 | PD writes into host-managed paths/config without checking the host's discovery/trust semantics — backups re-discovered as duplicate plugins, dual-language skill roots silently collapsed, created plugins.allow silently disables other plugins | startup-warning audit 2026-08-16 |
| ERR-100 | Browser UI runtime-imports a Node-oriented package barrel, pulling filesystem/database modules into the client bundle | PRI-552 |
| ERR-105 | Hardcoded light-mode hex colors bypass theme tokens on a dual-theme UI — timeline dots near-invisible in dark mode | PR #1377 (pr-review) |
| ERR-107 | Exception registry used to legitimize new I/O inside a pure core package | PRI-566 / PR #1392 |

---

## Category 2: Missing Tests & Verification

Errors where AI assistants skipped required testing or verification steps.

| ID | Summary | Source |
|----|---------|--------|
| ERR-012 | PR branch based on stale main reverts already-merged telemetry fields | PR #659 |
| ERR-025 | Test coverage proves isolated helper behavior, not real production defense | PRI-209 |
| ERR-066 | CLI --json failure path not structured; raw stack trace dumped to stderr on assembler throw | PRI-397 |
| ERR-070 | New public types/classes not exported from barrel index.ts — module consumers cannot import the new API surface | PRI-424 |
| ERR-071 | Async cleanup not `await`ed in finally; test resources not in try-finally; `process.env` not restored | PRI-428 |
| ERR-073 | Refactoring characterization tests cover shared logic happy path, not call-site-specific behavior equivalence | PRI-431 |
| ERR-077 | API migration silently drops input parameters — characterization tests don't verify parameter parity | PRI-454 |
| ERR-088 | Test assertion uses non-unique signal that cannot distinguish intended behavior from no-op/fail-soft path | PRI-486 |
| ERR-094 | Range-bounds assertion uses `\|\|` instead of `&&` — tautology that always passes for any value when `low <= high` | PR #1218 |
| ERR-096 | Non-interactive mode (`--yes`) hangs on an interactive prompt — handler gated prompting on `jsonMode`/`quiet` instead of the broader `nonInteractive` signal | fix/installer-gateway-lock |
| ERR-099 | Defensive ternary alternate for a contract-impossible empty state shipped uncovered — codecov/patch gate fails; prefer a branch-free join that degrades to the legacy format | PR #1341 |

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
| ERR-013 | `in` operator OR direct indexing on a plain object leaks inherited Object.prototype members (`__proto__`, `constructor`, `toString`) — use `Object.hasOwn` for key checks AND to guard lookup-table value reads | PRI-201 |
| ERR-037 | UI action buttons gated only by `status`, ignoring backend actionability field | PRI-244 |
| ERR-038 | Read-only GET paths create writable SqliteConnection; readonly breaks fresh workspace | PRI-244 |
| ERR-039 | Test `filter(isRecord)` silently discards malformed items; `if (isRecord)` skips assertions | PRI-244 |
| ERR-014 | `formatValidationErrorEntry` string values not truncated — evidence pack unbounded | PRI-200 |
| ERR-016 | maxRepairAttempts not hard-capped — { maxRepairAttempts: 999 } runs 999 calls | PRI-200 |
| ERR-017 | JSON.stringify on unknown values can throw (BigInt, circular) — preview paths crash | PRI-200 |
| ERR-018 | repairAttempts records stale initialValidationErrors instead of per-attempt currentErrors | PRI-200 |
| ERR-019 | schemaCheck failure branch writes next iteration's errors into current attempt's record | PRI-200 |
| ERR-020 | Commander negated boolean `--no-intake` ignored — checking wrong property name | PRI-217 |
| ERR-057 | errMsg helper checks typed narrower parameter instead of unknown caught value — error message extraction always falls through to String(err) | PRI-285 |
| ERR-072 | React component duplicates hook state as local state — desync causes silent feature failure | PR-971 |
| ERR-054 | `as TOutput` cast on untrusted LLM/runtime payload before validation — typed hooks receive unverified data | PRI-302 |
| ERR-060 | Emitted telemetry event not registered in schema — event silently dropped or degraded | PR #808/#809/#810 |
| ERR-061 | Runtime shape check validates wrong field name — guessed structure instead of verifying against actual type | PR #823 |
| ERR-062 | Collapsed details section renders empty-state copy instead of actual data when data exists | PRI-319 / PR #825 |
| ERR-063 | Commander `--no-<flag>` option property accessed via incorrect name — flag silently ignored | PR #844 |
| ERR-064 | CLI subcommand option regressions — Commander flag → opts mapping lost or misrouted during Commander .command() edit | PRI-337 / PR #852 |
| ERR-065 | SQLite INSERT guesses column names instead of reading schema — trust-boundary recurrence (ERR-001/ERR-005/ERR-013) | PRI-394 / PR #926 |
| ERR-067 | Orchestrator treats `retried` status as failure — retry chain breaks at SplitDiagnosticianRunner and diagnose CLI | PRI-405 |
| ERR-069 | Adapter `runHandle` hardcodes `status:'succeeded'` absent from RunHandleSchema (masked by `as`); degradation path trusts validator-rejected candidate — two trust-boundary breaches in ArtificerL2Adapter | PRI-424 |
| ERR-076 | Host-realm type narrowing (`isPlainObject`, `as never`) rejects or bypasses cross-realm VM objects — auto_correct silently broken | PRI-437 / PR #986 |
| ERR-082 | `Object.hasOwn` key-presence check bypassed by present-but-undefined value — wrong branch executes, hallucinated field passes through unstripped | PRI-468 / PR #1063 |
| ERR-106 | Binary ternary collapsed a 4-state review status into approved/pending — rejected/parked principles displayed as "awaiting Owner review" | PR #1377 (pr-review) |
| ERR-109 | Tri-state fact (boolean \| null) collapsed during a merge: one source's definite `false` resolved another source's unknown into an observed-false | PR #1419 review r4 |

---

## Category 4: Documentation & Spec Drift

Errors where AI assistants wrote code contradicting architecture docs or ADRs.

| ID | Summary | Source |
|----|---------|--------|
| ERR-021 | Handler-only tests miss Commander flag→opts mapping bugs | PRI-217 |
| ERR-022 | process.exit(1) without return allows fallthrough to intake on failed diagnosis | PRI-217 |
| ERR-023 | CLI dry-run command opens writable database connection instead of readonly | PRI-218 |
| ERR-029 | CLI unknown input silently dropped instead of failing loud | PRI-240 |
| ERR-030 | Path prefix `startsWith` matches sibling directories as production workspace | PRI-240 |
| ERR-032 | Documentation labels legacy dispatch as MVP-Core, contradicting ADR-0014 | PRI-227 |
| ERR-033 | Operator failure path returns success exit code and breaks JSON contract | PRI-162 |
| ERR-034 | Canonical runtime config not consumed by caller or cache key | PRI-162; PRI-516 |
| ERR-035 | Static guard only covers frozen-basename dynamic imports, misses other legacy paths | PRI-227 |
| ERR-036 | Provider-endpoint configuration source mismatch sends real calls to wrong target | PRI-162 |
| ERR-108 | Governance derivation implemented from the implementer's audit-delta narrative instead of clause-by-clause against the normative spec — precedence order and evidence gates drifted | PRI-584 / PR #1409 |
| ERR-110 | Published security disclosure contradicts shipped code — network capability landed without updating the README that denied it | ClawHub audit 2026-08-26 / PR #1430 |

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
| ERR-079 | Concurrency-primitive hardening gaps (age-based lock eviction, busy-spin retry) silently re-open the data-loss class the primitive was added to prevent | PRI-459 / PR #1045 |
| ERR-080 | Control (size bound / path check) applied to the RAW input form instead of the CANONICAL/transformed form — bound is bypassable (escaped output exceeds budget; path traversal evades a /prefix match) | PRI-467 / PR #1059, PR #1302 |
| ERR-081 | TOCTOU in stat-then-read file size cap — file growth between statSync and readFileSync bypasses oversized check | PRI-467 / PR #1059 |
| ERR-089 | Fix addresses primary failure path but leaves sibling failure branches (catch/!ok/throw) with stale state, wrong command path, or CLI contract violation | PR #1124 |
| ERR-093 | New log sink emits full external identifier despite an established minimization convention | PRI-516 / PR #1230 |
| ERR-103 | Empty or malformed declared enforcement scope is accepted and can degrade into match-all behavior | RuleCode Owner Live Decision SPEC |

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
| ERR-074 | Inner try/catch creates exit tunnel — early returns bypass outer catch cleanup, leaking resources | PR #977 |
| ERR-075 | Hardcoded aria-label bypasses i18n — screen readers read in wrong language for non-English UI | PR #979 |
| ERR-078 | PR body self-report labels CI failure "pre-existing on main" without verifying against main — reviewer inherits false regression classification | PRI-454 / PR #1043 |
| ERR-083 | Changing a shared contract (store guard, type union, service method, default config value, package identity, shared test fixture/env assumption, barrel export) without auditing all same-package AND cross-package consumers (callers, validators, tests, mocks, CI workflows) — downstream packages / sibling tests break | PRI-473 / PR #1066; PRI-491 / PR #1137; PRI-501 / PR #1162; PR #1182; PR #1183; PRI-526 / PR #1319; PR #1358; PRI-612 / PR #1426 |
| ERR-084 | shell:true in spawn() + immediate process.exit() in signal handlers orphans child processes; GitHub Actions not pinned to SHA | PR #1068 |
| ERR-090 | Package.json entry point (main/exports) changed without verifying the referenced file exists in ALL build paths (tsc vs esbuild) — CI fails on paths that don't generate the new entry | PRI-501 / PR #1162 |
| ERR-091 | CI checkout lacks `lfs: true` when tests read LFS-tracked binary assets — assertion fails on 132-byte pointer files | PR #1159 |
| ERR-092 | Module-level cache leaks across workspace instances when not keyed by workspaceDir | PRI-504 / PR #1164 review |
| ERR-095 | Hand-built object transform over a typed schema (envelope key-merge, validator field-by-field reconstruction) silently OVERWRITES or OMITS declared fields — key set never diffed against the target type | PR #1273; PR #1421 (PRI-606) |
| ERR-098 | Destructive cleanup with junction-following recursive delete wiped a shared repo's working tree — cleanup must use `git worktree remove`, never recursive deletes on junction-bearing dirs, never silence errors on critical cleanup | PRI-538; PR #1358 (near-miss: worktree node_modules junctioned into shared repo) |
| ERR-101 | Playwright reuses an unrelated server on a shared fixed port, testing stale UI instead of the current worktree | PRI-553 |
| ERR-102 | Optional governance gate conflates disabled/unavailable/loading states and fails open to the legacy path | PRI-553 |
| ERR-104 | Auth bootstrap redirects overwrite authenticated deep links because splash/onboarding state is not scoped to entry routes | RuleCode Owner Live Decision E2E |

---

## Detailed Entries

**[ERR-001]** | `as string | undefined` type cast on untrusted JSON bypasses runtime validation

- **What happened**: In `SqliteSourceTraceLocator.locate()`, the code used `(dj.sourcePainId ?? dj.painId) as string | undefined` to extract the pain ID from a parsed JSON object (`Record<string, unknown>`). The `as` cast silently passes non-string values (e.g., `sourcePainId: 42`), causing `taskPainId === query.sourcePainId` to always fail for non-string types because strict equality between a number and a string is always `false`.
- **Why it's wrong**: `as` is a compile-time assertion with zero runtime validation. When `diagnosticJson` contains `sourcePainId: 42` (a number), the cast silently tells TypeScript it's a string, but the actual runtime value is still `42` (number). The strict equality `42 === "42"` evaluates to `false`, producing a false `not_found` decision instead of a correct match or a type-mismatch diagnostic.
- **Correct approach**: Use `typeof rawPainId === 'string' ? rawPainId : undefined` to validate the type at runtime before using it in comparisons.
- **How to prevent**: Never use `as` type assertions on values from untrusted JSON sources (`Record<string, unknown>`). Always validate with `typeof` checks before using the value. When extracting fields from parsed JSON, treat every field as `unknown` and narrow with runtime type guards.
- **Source**: PRI-189
- **Date**: 2026-05-19
- **Recurrence**: Yes — `as`-bypass at trust boundaries (JSON parsing, SQLite rows, CLI inputs, LLM/runtime outputs, DOM values, test fixtures).
  - 2026-08-21 PR #1371 (RuleCode owner live-decision): `openclaw-promotion-checks.ts` narrowed untrusted `hostContract` config with `as unknown as HostLivenessContract` — a known-typed-interface variant (the index-signature-silencer flavor, cf. PR #1104). The cast masked reader-visible fields (`outOfBandControls`, `protectedCapabilities`, `neutralProbes`) that could be missing/malformed, bypassing runtime validation. Fixed by building the typed object explicitly through `isRecord()`/`isNonEmptyString` guards, copying and validating each field, and returning `null` on any shape violation — no cast, extendable to any future field (rc-2-no-as-bypass).
  - 2026-07-23 PR #1251 (PRI-518, self-review + CodeRabbit): two sibling instances of trusting a TS type declaration instead of validating the runtime object. (a) `SqliteDiagnosticianCommitter.commit` dereferenced `input.output.recommendations` directly — when `input.output` was null/undefined/non-object (malformed runtime input), it threw a native `TypeError` instead of the documented `PDRuntimeError('input_invalid')`. The TS type `DiagnosticianOutputV1` made the deref look safe. Fixed with an explicit `typeof input.output === 'object' && !== null` guard first (rc-1-treat-as-unknown, rc-3-fail-loud-missing). (b) `DefaultDiagnosticianValidator` verbose mode: the new empty-recommendations check pushed an error but did not return, so execution fell through to `for (const rec of output.recommendations)` — when `recommendations` was undefined/non-array this threw `X is not iterable` (EP-09 sibling: the verbose path was never tested with malformed recommendations). Fixed by guarding the loop with `Array.isArray(...) ? ... : []`. Lesson: when adding a new validation check that records an error but continues (verbose mode), audit EVERY downstream deref/iteration of the same field — the old "field is always a valid array" assumption no longer holds on the continue path.
  - 2026-07-12 PR #1211: Two new test files (`principle-injector.test.ts`, `trajectory-store.test.ts`) accessed array indices directly (`result[0].id`, `result[0].sampleId`, `const sample = result[0]; sample.field`) without optional chaining, producing 38 TS2532/TS18048 errors that blocked all 5 build/lint CI checks. Same `noUncheckedIndexedAccess` root cause as PR #1170. Additional sibling: `better-sqlite3`'s `.get()` returns `{}`, so `row.review_status` triggered TS2339 — fixed with `as { field: type } | undefined` assertions on 6 query results. Also: an "undefined priority defaults to P1" test was invalidated because a `makeP` helper's `opts.priority ?? 'P1'` fallback masked the absent-priority branch (EP-09 sibling). Lesson: in `noUncheckedIndexedAccess: true` projects, explicitly handle `undefined` from every array index access: use `?.` only when absence is acceptable; otherwise guard and fail or skip. Also verify test helpers don't silently fill in the field the test intends to leave absent.
  - 2026-07-03 PR #1170: `architecture-regression.test.ts` read `m[2]`/`im[1]` from `RegExpExecArray` indices and used them as `string` directly. Under `noUncheckedIndexedAccess`, these return `string | undefined` — `tsc` failed with TS2345/TS2532, blocking Lint/Release Build Parity/Performance Benchmark CI. Fixed by array destructuring + `if (sqlBody === undefined) continue` guard. Variant: not an `as` cast, but same root cause — TypeScript index access returns `T | undefined` under strict mode and must be guarded (rc-2-no-as-bypass, rc-3-fail-loud-missing).
  - 2026-07-01 PR #1149 (PRI-494): `makeHostInput()` test fixture used `as unknown as RuleHostInput['action']` — silently used invalid enum `bashRisk: { level: 'low' }`. Fixed by constructing the real shape directly (rc-2-no-as-bypass).
  - Earlier 2026-06 recurrences (PR #1098–#1146, compressed): same `as`-bypass across JSON parsing, SQLite rows, DOM events, LLM adapter output, test fixtures — fixed with `isRecord()` guards, `typeof` checks, `Object.hasOwn()`, or removing the cast. See git history for PR#688–#1072 and PR#1098–#1146.

---

**[ERR-002]** | Catch-and-degrade pattern silently swallows failure reasons

- 2026-08-25 update Phase 2a self-review (no Linear issue): blank `stderr` won over the real CLI probe timeout message. Fixed with `unknown`/own-field validation, blank rejection, bounded message fallback, and a 30s cold-asset probe. Prevention: normalize diagnostic candidates before fallback and test packaged cold starts.

- 2026-08-13 PRI-523 C1.3 (consolidated, full text in git history): SQLite schema checks escaped the guarded boundary + iterative corrections missed canonical partial-index predicate — gate now validates every column/predicate/statement before enrichment, failures return bounded warning + nextAction.
- 2026-08-11 PR #1298 (CodeRabbit #3759264782, fixed in PR #1300): `OpenClawHostInstaller.writeInstallRecord` in `openclaw-host-installer.ts` catch block treated all non-ENOENT read errors (EACCES/EIO/malformed JSON) as fallthrough — the code continued to overwrite `~/.openclaw/plugins/installs.json` with a PD-only record, destroying other plugins' `installRecords`. The `if (code !== 'ENOENT') { // skip merge, will overwrite below }` comment explicitly documented the intent to overwrite, violating rc-9. CodeRabbit caught it in the final review pass before merge. Fixed in PR #1300 by returning early on non-ENOENT errors and non-record parse results, preserving the original file. Same structural sibling as the 2026-07-04 PR #1182 recurrence — catch-and-overwrite instead of catch-and-observable.
  - Earlier recurrences (compressed 2026-08-16, see git history for full text):
    - 2026-07-04 PR #1182: core version read failed via missing ./package.json export, catch silently returned 'unknown' (fixed: exports + stderr log)
    - 2026-07-04 feedback-pipeline spec: 3 silent-catch recurrences (dispatcher/worker/pain emit) — all gained reason+logs+persistence
    - 2026-07-03 PRI-442 PR #1177: config ok:false fallback unobserved — added warn + ok:false test
    - 2026-07-01 PR #1146: onboarding localStorage/clipboard failures swallowed while UI implied success
    - 2026-06-29 PR #1122: parse/assemble degradation to text_principle_only silently — fail-fast structured errors
    - 2026-06-28 PRI-483 PR #1098: _buildRuleContextIfEnabled ignored ok:false — added guard + warn
    - 2026-06-19 PRI-408/PR#972, PRI-431/PR#975: approval/catch paths missing reason+nextAction
    - Earlier PR#699-#966: catch→skip / malformed yaml→[] / false success — every fallback now emits reason+nextAction
  - 2026-08-24 PRI-577 / PR #1407: dual-directory telemetry counted a source before successful enumeration and returned no structured reason when neither source was readable. Fixed by counting only successfully enumerated directories and surfacing `shadow_telemetry_source_unavailable`; regression covers an existing path that is not a readable directory.

---

**[ERR-029]** | CLI unknown input silently dropped instead of failing loud

- **What happened**: `parseChannels()` in the CLI handler silently dropped unrecognized channel names from `--channels` input. When all tokens were invalid, it returned `undefined`, causing the runner to fall back to all MVP channels. A typo like `--channels code-hook` would yield a successful full-baseline run instead of an input error.
- **Why it's wrong**: Silent fallback on invalid input violates the CLI Command Gate (rule 1: JSON mode strict, rule 6: degraded/refused result must include reason + nextAction). Operators get misleading continuity results for a channel set they did not actually request. This is the same class as ERR-009 (silently skip invalid instead of failing loud).
- **Correct approach**: `parseChannels()` must return both valid channels and unknown tokens. The CLI handler must pass unknowns to the runner, which must fail loud with a structured error containing `failureReason` and `nextAction`.
- **How to prevent**: For any CLI input parser, never silently drop invalid tokens. Return them separately and fail loud. Add parser-level tests that verify unknown inputs produce structured failures.
- **Source**: PRI-240 / PR #699
- **Date**: 2026-05-24
- **Recurrence**: Yes — same class as ERR-009, ERR-010.
  - 2026-06-19 PRI-408 (PR #972): `--include-deactivated` not threaded to store query; invalid `--channel` degraded to all-channels instead of failing loud

---

**[ERR-030]** | Path prefix `startsWith` matches sibling directories as production workspace

- **What happened**: `isProductionWorkspace()` used `normalized.startsWith(prefix.toLowerCase())` to check if a workspace directory is a production path. This matched sibling directories like `~/.openclaw/workspace-backup` or `D:\.openclaw\workspace-extra`, incorrectly blocking safe non-production directories.
- **Why it's wrong**: `startsWith` on paths does not respect segment boundaries. A path that shares a prefix but is not a descendant should not match. This is the same class as ERR-003 (substring matching causing false positives) and ERR-013 (`in` operator matching inherited properties).
- **Correct approach**: Use `normalized === prefix || normalized.startsWith(prefix + path.sep)` to match either the exact path or a descendant (path separator after prefix). This respects filesystem segment boundaries.
- **How to prevent**: When matching filesystem paths by prefix, always include the path separator in the prefix check. Add tests for sibling paths (same prefix + suffix without separator) and descendant paths (prefix + separator + more).
- **Source**: PRI-240 / PR #699
- **Date**: 2026-05-24
- **Recurrence**:
  - Yes - same class as ERR-003, ERR-013.
  - 2026-07-03 / PRI-442 / PR #1164: `handleFrictionTrackingForFailure` used `workspaceDir.includes('e2e-workspace')` to decide whether to admit shell-tool failures as pain signals. A production workspace whose absolute path happens to contain the substring `e2e-workspace` (e.g. `D:\ci\e2e-workspace-prod\owner-1`) would silently get E2E behavior in production. Fixed by replacing the substring test with an explicit env-var signal (`process.env.PD_E2E_MODE === '1'`) set only by the E2E harness. The generalization: when gating behavior by environment/context, use explicit signals (env vars / config flags), never path-substring matching — path substrings cannot distinguish a sibling directory from a true descendant.

---

**[ERR-100]** | Browser UI runtime-imports a Node-oriented package barrel, pulling filesystem/database modules into the client bundle

- **What happened**: PRI-552 initially reused `OwnerGovernanceViewSchema` in the browser validator by runtime-importing `@principles/core/runtime-v2`. That barrel also exports Node-only Runtime modules, so esbuild attempted to resolve `fs`, `path`, `crypto`, `better-sqlite3`, and other server dependencies and the Console UI build failed.
- **Why it's wrong**: A package barrel is a runtime dependency boundary, not merely a convenient symbol index. Browser consumers cannot safely import a barrel whose export graph includes Node I/O, even when they need only one pure schema.
- **Generalized failure mode**: When browser code imports a shared package at runtime, assistants must inspect the selected export graph and prove it is browser-safe; otherwise a pure-looking symbol can transitively pull Node-only modules into the client bundle.
- **Correct approach**: Keep the UI runtime validator browser-local and import the shared shape with `import type`, which is erased. Keep the authoritative TypeBox output validation on the server boundary. A dedicated browser-safe subpath could be introduced only as an explicitly approved package contract, not ad hoc in this feature.
- **How to prevent**: For every new runtime import in `src/ui`, run the UI bundler and inspect whether the imported entry point exports Node built-ins or native packages. Prefer type-only imports across mixed-runtime packages.
- **Regression guard**: `npm run build:ui` now passes, while `governance-projection-validator.test.ts` verifies the browser-local validator accepts the frozen view and rejects corrupt nested values.
- **Related ERRs**: ERR-025, ERR-040, ERR-070
- **Source**: PRI-552
- **Date**: 2026-08-20
- **Recurrence**: None

---

**[ERR-101]** | Playwright reuses an unrelated server on a shared fixed port, testing stale UI instead of the current worktree

- **What happened**: PRI-553's browser BDD reused an already-running installed PD Console on port 3100 because `reuseExistingServer` was enabled outside CI. The API route mock responded, but the loaded JavaScript bundle came from the installed extension rather than the current worktree, so the new governance card was absent and the test reported a misleading product failure.
- **Why it's wrong**: A real-browser test is valid only when its server and assets come from the revision under test. Reusing any process that happens to answer a health URL makes the test environment depend on unrelated local state and can produce false failures or, worse, false passes against stale code.
- **Generalized failure mode**: When an E2E harness uses a fixed/shared port, assistants must not reuse an unidentified existing server; otherwise the browser can exercise a different checkout or installed product than the code under test.
- **Correct approach**: Make the E2E port explicitly configurable, use a non-production default, pass the same port to Playwright and the spawned server, and set `reuseExistingServer: false` so a collision fails loud instead of silently changing the tested revision.
- **How to prevent**: In under 30 seconds, inspect Playwright `webServer`: require `reuseExistingServer: false`, a test-only configurable port, and one shared base URL consumed by the launcher and request clients.
- **Regression guard**: `principle-governance-projection.test.ts` statically asserts the isolation settings; the two real-browser governance BDD scenarios pass while an unrelated installed Console remains bound to port 3100.
- **Related ERRs**: ERR-025, ERR-078, ERR-084
- **Source**: PRI-553
- **Date**: 2026-08-20
- **Recurrence**: None

---

**[ERR-102]** | Optional governance gate conflates disabled/unavailable/loading states and fails open to the legacy path

- **What happened**: The Principle Detail page disabled legacy approval actions only when a validated governance view explicitly said no Owner action was required. If the enabled projection endpoint failed validation or storage access, the page showed an unavailable card but left legacy approval/edit/reject controls authorized from the separate approval-group response.
- **Why it's wrong**: The governance projection is the authority for whether a strong current pending approval exists. Once enabled, its absence cannot authorize a mutation; falling back to a less constrained reader turns a degraded read path into a privilege bypass.
- **Generalized failure mode**: When an optional authority gates existing behavior, code handles explicit deny but not authority-unavailable or still-loading, so those states fall through to the legacy decision (mutation allow, or firing the legacy read path).
- **Correct approach**: Distinguish feature-disabled from enabled-but-unavailable and from still-loading. Preserve legacy behavior only when the feature is resolved-disabled; hold loading behavior until the gate resolves; when enabled, show mutation controls only for a validated `owner_required` projection and hide them for deny or unavailable states.
- **How to prevent**: For every optional authority gate, test all four states: resolved-off uses legacy behavior, still-loading fires nothing, validated allow exposes the action, and validated deny/unavailable hides or refuses it. Never model unavailable or loading as equivalent to feature-disabled.
- **Regression guard**: `principle-governance-projection.test.ts` locks the fail-closed decision-control predicate; the browser BDD covers strong approval and flag-off rollback; PR #1409's `governance-experience.spec.ts` caps queue requests during flag-on focus loads (transient legacy fetch regression).
- **Related ERRs**: ERR-009, ERR-024, ERR-033
- **Source**: PRI-553
- **Date**: 2026-08-20
- **Recurrence**: 2026-08-21 RuleCode Owner Live Decision formal SPEC review (no Linear issue): the initial feature-flag design said flag-off restored the existing Console presentation but did not state that every promotion entry point, especially CLI, must refuse promotion. That left room for the stricter Owner decision authority to disappear while the legacy unchecked mutation remained available. The same review also found that local no-auth Console had been allowed to write `reject-after-shadow`, incorrectly granting governance authority to a break-glass operator. Fixed before implementation by making feature-off refuse promotion across Console and CLI, requiring both paths to use one application service, and restricting unauthenticated authority to inspect/deactivate/global-pause only. Regression requirement: disabled, unavailable, validated-deny, and authenticated-allow must be exercised at every promotion entry point; no-auth tests must prove governance writes are refused. 2026-08-25 PR #1409 (PRI-586): READ-side sibling — `featureFlags?.enabled === true` gating made the still-loading state indistinguishable from flag-off, so FocusPage fired the legacy `/governance/queue` request before flipping to experience mode (wasted call + legacy-panel flash). Fixed by gating the data load on flags-resolved; loading ≠ disabled extends the same three-state rule to read paths.

---

**[ERR-103]** | Empty or malformed declared enforcement scope is accepted and can degrade into match-all behavior

- **What happened**: `RuleHostWriter.canActivate()` validated executable code and GoldenTrace but accepted `affectedTools: []` and arrays containing no valid tool names. Downstream interpretation could therefore treat the missing effective scope as broadly applicable.
- **Why it's wrong**: Enforcement scope is a safety authority boundary. Empty, wildcard, malformed, or protected-control scope must fail before shadow/live admission; risk scoring cannot substitute for a hard validation gate.
- **Generalized failure mode**: When a generated policy declares the resources it may govern, assistants validate execution shape but omit the non-empty bounded-scope invariant, allowing missing scope to become implicit global authority.
- **Correct approach**: Normalize declared scope, require at least one explicit valid member, reject wildcard/global aliases, and reject protected recovery/control capabilities before sandbox acceptance or activation.
- **How to prevent**: In under 30 seconds, review every generated enforcement schema for four tests: empty, all-invalid, wildcard/global, and protected-control scope; every case must fail before activation.
- **Regression guard**: `rule-host-writer.test.ts` exercises empty, all-invalid, wildcard, and protected-capability scope through the production writer.
- **Related ERRs**: ERR-024, ERR-051, ERR-080, ERR-102
- **Source**: RuleCode Owner Live Decision SPEC (no Linear issue)
- **Date**: 2026-08-21
- **Recurrence**: None

---

**[ERR-104]** | Auth bootstrap redirects overwrite authenticated deep links because splash/onboarding state is not scoped to entry routes

- **What happened**: The authenticated RuleCode Owner browser E2E opened `#/activation`, signed in, and then could not find the Owner review card. `AuthRoutes` initialized `showSplash=true` even when the splash route was not mounted, and its onboarding effect later navigated every authenticated route to `/focus` or `/welcome`. A valid deep link to the emergency and Owner decision surface was therefore either left behind the login route or overwritten after authentication.
- **Why it's wrong**: Authentication and onboarding bootstrap may choose an entry page, but they must not replace an already selected protected route. Treating a global lifecycle boolean as authority over every route made the safety control surface inaccessible through direct navigation even though authentication succeeded.
- **Correct approach**: Derive splash state from the actual splash route, and scope the onboarding redirect to entry routes (`/`, `/login`, `/splash`). Preserve any other authenticated route verbatim.
- **How to prevent**: For every authenticated Console feature, run a real-browser test that starts unauthenticated, signs in, then directly opens the protected deep link and asserts a feature-specific element. Do not treat a successful health request or generic shell rendering as proof that the requested route survived bootstrap.
- **Regression guard**: `packages/pd-console/tests/e2e-owner/rulecode-owner-governance.spec.ts` logs in with the configured Owner token, opens `#/activation`, and completes exact RuleCode promote/reject decisions through the rendered cards.
- **Related ERRs**: ERR-072, ERR-088, ERR-101
- **Source**: RuleCode Owner Live Decision browser E2E (no Linear issue)
- **Date**: 2026-08-21
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
- **Recurrence**: Yes — lineage/source fields come from the wrong task or are racy across a read-then-write.
  - 2026-08-20 PRI-550/PRI-551: a revision task rejected by canonical-lineage validation could still be referenced by generic dependency relations, and cross-channel dependencies could collapse independent frontiers. Fixed by deriving every downstream relation from the same validated strong-task set and channel partition, with conflict and cross-channel regressions.
  - 2026-08-20 PRI-550 final review: cycle/overflow detection downgraded only aggregate lineage while still emitting affected task facts as `strong`, and direct-root-only artifact collection omitted valid descendant approvals/activations. Fixed by propagating task-graph confidence to every affected fact and computing transitive validated artifact lineage before authority folding.
  - 2026-08-13 PRI-523 C1.3 quality review: a supplied host event ID could override canonical identity, so its lineage no longer matched a changed payload/outcome. Fixed by binding workspace/source/session/tool/sanitized payload/outcome and supplied ID into one digest, with collision and exact-retry regressions.
  - 2026-06-20 PRI-435 (PR#982): `resolveSourcePainIdFromDiagnostician()` lacked `taskKind === 'diagnostician'` guard — added kind guard + corruption regression
  - 2026-06-19 PRI-408 (PR#972): `assembleRuleArtifact` set `sourcePrincipleId: undefined`; `sqlite-approval-store.edit()` read-then-write race → atomic `SET previous_artifact_id`
  - Pattern: lineage from unverified task or non-atomic read-then-write. Fix: verify task kind; atomic writes; mismatch regression tests.

---

**[ERR-005]** | Invalid salvaged arrays bypass type contract in validate failure path

- **What happened**: In `refineFullTrace()` validation failure path, `sourceRunIds`, `ambiguityNotes`, `sanitizationNotes` only checked `Array.isArray()` then used `as string[]` cast without validating element types. For invalid FullTrace JSON like `sourceRunIds: [42]`, this returned a `RefinedTracePayload` whose arrays violated the `string[]` contract, reintroducing the same untrusted-JSON problem the FullTrace contract was meant to avoid.
- **Why it's wrong**: `as string[]` is a compile-time assertion with zero runtime validation. When parsing untrusted JSON, a cast alone doesn't make elements strings. This would have caused downstream consumers expecting `string[]` to fail silently or incorrectly.
- **Correct approach**: When salvaging arrays from invalid JSON, filter elements with `(v): v is string => typeof v === 'string'` to keep only valid strings, otherwise return empty array.
- **How to prevent**: Never use `as` array type casts on untrusted JSON arrays without validating element types first. Always apply element-wise type guards when preserving data from invalid payloads.
- **Source**: PRI-191
- **Date**: 2026-05-19
- **Recurrence**: Yes — `as Record`/`as T[]` on parsed JSON, YAML, SQLite rows, CLI args, or LLM output bypasses element/type narrowing.
  - 2026-06-25 PRI-466 (PR#1056): `(err as Error).message` on caught `unknown` — replaced with `instanceof Error` guard
  - 2026-06-23 PRI-446 (PR#1028): `input.consecutiveErrors as number` post-`Number.isFinite` — replaced with `typeof` narrowing
  - Earlier recurrences (PR#689-#1027): same `as`-on-untrusted-value pattern across recommendation_kind, language, SQLite rows, YAML, depIds. See git history.

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
- **Recurrence**: Yes — agent-output lineage fields can be fabricated/misattributed by the LLM.
  - 2026-08-16 PRI-531 (PR #1328 review): prompt.ts presence-ledger call paired an injected-subset `principleIds` array with the FULL `dedupedV2.map(p => p.activationId)` list by raw index — budget truncation dropped principles so activation_ids misattributed to the wrong presence rows. Fixed with `alignActivationIds` (key-based subset alignment, 3 unit tests). Adjacent pre-existing instance in the `runtime_v2_prompt_activations_injected` observability event filed as PRI-537.
  - 2026-05-29 PRI-272: `taskId` in `DiagnosticianOutputV1Schema` was LLM-fabricatable — removed from schema, added `stripLineageFields` to free-form adapter
  - 2026-05-23 PRI-209 (PR #689): `result_ref` lineage checked at kind-level only — implemented true per-dependency `lineage_mismatch` detection via `SELECT task_id FROM artifacts`
  - 2026-05-23 PRI-225 (PR #693): malformed metadata reinterpreted as topology failure — used `bestEffortParentIds` while still emitting `metadata_malformed`
  - Pattern: lineage fields must be verified against source, not trusted from agent output. Fix: strip lineage from LLM schema; verify per-dependency; emit malformed separately.

---

**[ERR-009]** | Validator silently skips missing/malformed required array fields instead of failing loud

- **What happened**: In `validateTraceRefinerAgentOutput()`, the `refinedTrace` shape validation used `if (Array.isArray(rt.sourceRunIds)) { ... }` pattern — when the field was missing, `undefined`, or non-array, the validator silently skipped it instead of reporting an error. Same for `evidenceRefs` and `keyEvents`. Additionally, `keyEvent` objects that were non-objects were skipped with `continue`, and `keyEvent.evidenceRefs` non-arrays were silently skipped.
- **Why it's wrong**: This allows structurally invalid `refinedTrace` objects (e.g., `{ sourceRunIds: "not-array", evidenceRefs: undefined, keyEvents: undefined }`) to pass validation and be cast as `RefinedTracePayload`. Even in shadow mode, downstream telemetry or analysis consumers would receive objects that don't conform to the contract. This is the same class as ERR-001/ERR-005/ERR-007 — validators must fail loud, not skip silently.
- **Correct approach**: For every required field in a validator, check that it exists and has the correct type. If it's missing or wrong type, add an error. Use `if (!Array.isArray(x)) { error } else { validate elements }` instead of `if (Array.isArray(x)) { validate elements }`.
- **How to prevent**: When writing validators for untrusted data, never use `if (hasCorrectType) { validate }` — always use `if (!hasCorrectType) { error } else { validate }`. The "skip on wrong type" pattern is always wrong for required fields.
- **Source**: PRI-192 / PR #638 (reviewer feedback)
- **Date**: 2026-05-19
- **Recurrence**: Yes — validator/test silently passes when data is absent/malformed instead of failing loud. Same class as ERR-001/005/007.
  - 2026-08-13 PRI-523: structural guards accepted blank/relative route fields and incompatible results. Added semantic route validation and fail-loud tables.
  - 2026-07-23 PRI-518: `DiagnosticianOutputV1Schema.recommendations` was `Type.Array(...)` with no `minItems`, and `DefaultDiagnosticianValidator` iterated `for (const rec of output.recommendations)` with no length check, so a structurally valid output with `recommendations: []` committed ZERO owner-reviewable candidates and marked the diagnosis task SUCCEEDED with no structured reason. This was the root cause of the Story A "4 pain records, 8 leased tasks, 0 candidates" symptom. Fixed by adding `minItems: 1` to the schema + an explicit validator length check + a committer guard (defense-in-depth). An intentional "no action" decision MUST be expressed as a `{ kind: 'defer', ... }` recommendation. The convention already existed on sibling schemas (`dreamer-output.candidates`, `artificer-output.affectedTools` both use `minItems: 1`) but was missed on `recommendations`.
  - 2026-06-25 PRI-459 (PR#1045): `createRule`/`createImplementation` silently overwrote existing id (orphaning parent link)
  - 2026-06-23 PR#1026: 4 review `as`-bypass violations (`(err as Error)`, `this.token as string`, etc.)
  - Earlier recurrences (PR#680-#966): same silent-skip pattern across `parseInt` w/o NaN check, `?.trim()||undefined`, `?? 'fallback'` defaulting, `if(output){assert}`. See git history.

**[ERR-011]** | CLI commands directly import RuntimeStateManager instead of Tier 2 boundary facades

- **What happened**: `runtime-canary.ts`, `runtime-diagnostics-export.ts`, and `runtime-recovery.ts` directly imported and instantiated `RuntimeStateManager` from the Store layer, bypassing the Read Model / Service facade boundary established by ADR-0001. Additionally, `createInternalizationQueueReadModel` did not support a `readonly` option, forcing read-only CLI commands (canary, diagnostics-export) to open writable database connections.
- **Why it's wrong**: ADR-0001 mandates that CLI commands use Read Models and Service facades, never directly access Store classes. Direct Store imports create tight coupling between CLI and database schema, making it impossible to evolve the store layer independently. Opening writable connections for read-only operations is a safety risk — a bug in the CLI could accidentally mutate state.
- **Correct approach**: Create Tier 2 boundary facades (`createRecoverySweepService`, `createInternalizationQueueReadModel` with `readonly` support) that encapsulate `RuntimeStateManager` lifecycle. CLI commands import only these facades, never the Store directly.
- **How to prevent**: Every new CLI command that needs database access must use an existing Read Model or Service facade from `@principles/core/runtime-v2`. If no suitable facade exists, create one first. Architecture regression tests must assert that CLI command files do not import `RuntimeStateManager`. Read-only operations must pass `readonly: true` to the facade.
- **Source**: PRI-131 (Tier 2)
- **Date**: 2026-05-21
- **Recurrence**: Yes — same boundary violation pattern as PRI-129 (trace.ts) and PRI-131 Tier 1 (health.ts, runtime-pruning.ts, runtime-internalization-queue.ts). 2026-08-13 PRI-523 C1.1 review: the shared prompt reader opened the Runtime V2 database through the normal bootstrapping connection path, so a logically read-only prompt build could create/migrate the database and checkpoint WAL state. Fixed by using the existing validated store APIs over a file-must-exist read-only connection with bootstrap and close-time checkpoint disabled; a production test proves a missing database yields a structured warning without changing the workspace filesystem.

---

**[ERR-012]** | PR branch based on stale main reverts already-merged telemetry fields

- **What happened**: PR #659 was created from a branch that did not include the latest `origin/main` after PRI-174 merged. The PR was mostly documentation/tests, but its diff would have removed `rulehostAutoCorrectApplied` from daily stats types, initialization, update logic, and tests.
- **Why it's wrong**: A retrospective or test PR must not silently roll back code from already-merged feature work. This would have broken RuleHost auto-correct observability right after Phase 1A declared it complete.
- **Correct approach**: Before opening or reviewing a PR after related merges, rebase or merge latest `origin/main`, then inspect `git diff origin/main..HEAD --name-only` for unintended product-file regressions.
- **How to prevent**: Treat unexpected deletions in already-merged source/test files as a blocking review finding. For doc/test PRs, verify the PR diff does not include product-code rollback unless explicitly intended.
- **Source**: PR #659
- **Date**: 2026-05-21
- **Recurrence**: Yes — feature branch base drifts from `origin/main` so PR diff surfaces unrelated/deleted files.
  - 2026-06-23 PRI-451 (PR#1033): graphify+lefthook auto-committed prior session's WIP (153 files) into new branch — caught via `git diff origin/main..HEAD`
  - 2026-06-23 PRI-446 (PR#1028): branch based on local main drifted ahead by one stray commit — fixed with `git rebase --onto`
  - Earlier recurrence (PRI-444 PR#1027): `subagent.ts` deleted but stale route in `hooks/AGENTS.md`. See git history.

---

**[ERR-013]** | `in` operator OR direct indexing on a plain object leaks inherited Object.prototype members (`__proto__`, `constructor`, `toString`)

- **What happened**: Two variants of the same prototype-chain leakage. **Variant A (`in` operator, PRI-201):** in `validateCorrectionProposal()`, the cross-check for `correctedFields[].field` against `proposedParams` used `cf.field in proposal.proposedParams`. The `in` operator traverses the prototype chain, so inherited properties like `toString`, `constructor`, `valueOf` would match even though they are not actual keys in `proposedParams`. A `correctedFields` entry with `field: 'toString'` would incorrectly pass validation. **Variant B (lookup-table value read, PRI-480 PR #1089):** `canonicalizeToolKind()` indexed a hardcoded `TOOL_ALIAS` plain-object table via `TOOL_ALIAS[toolName]` and checked `hit !== undefined`. For inherited keys (`__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf`), the lookup returns the corresponding `Object.prototype` member (the prototype object itself, the Object constructor function, the `toString` method, etc.) — none of which are `=== undefined`, so the function returned a non-`CanonicalKind` value (`Object.prototype` for `__proto__`, the Object constructor for `constructor`) and violated its closed-enum return contract. `Record<string, T>` typing does NOT model the prototype chain, so `noUncheckedIndexedAccess` does not catch this.
- **Why it's wrong**: Plain JavaScript objects inherit from `Object.prototype` unless created via `Object.create(null)`. Both `in` (key existence) and `table[key]` (value read) traverse that chain. For untrusted keys this means an attacker- or caller-supplied string like `__proto__` / `constructor` resolves to an `Object.prototype` member instead of `undefined`. This is the same class as ERR-001/ERR-005/ERR-007: runtime semantics bypass the developer's intent because of a primitive mismatch the type system does not surface.
- **Correct approach**: For key-existence checks use `Object.hasOwn(obj, key)`. For lookup-table value reads, guard with `Object.hasOwn(table, key)` BEFORE indexing: `if (!Object.hasOwn(TOOL_ALIAS, toolName)) return 'other'; const hit = TOOL_ALIAS[toolName]; return hit !== undefined ? hit : 'other';`. For maps keyed entirely by external input, prefer `new Map()` or `Object.create(null)` so no prototype chain exists. `Map` is immune (no prototype chain on entries); `Object.create(null)` is immune (null prototype).
- **How to prevent**: Two rules. (1) When checking key existence in untrusted objects (LLM output, parsed JSON, `Record<string, unknown>`), always use `Object.hasOwn()` — never `in`. Add a test case with an inherited property name (e.g., `toString`) to every validator that checks key existence. (2) **30-second PR-review test for lookup tables:** when a plain-object table is indexed by external input, mentally run `table['__proto__']` and `table['constructor']` — if either returns something other than `undefined`, the lookup needs an `Object.hasOwn` guard or a `Map`. Add a regression test asserting all five inherited keys (`__proto__`, `constructor`, `prototype`, `toString`, `hasOwnProperty`) resolve to the default/`other` branch.
- **Source**: PRI-201 / PR #663 (Codex review, variant A); PRI-480 / PR #1089 (CodeRabbit review, variant B)
- **Date**: 2026-05-21 (variant A); 2026-06-28 (variant B)
- **Recurrence**: Yes — same class as ERR-001/ERR-005/ERR-007 where runtime semantics bypass validation intent.
  - 2026-08-28 PRI-609 / PR #1423 review: `enabledOfOverride()` read an inherited `enabled` property from an alias override object, allowing prototype data to override the registered flag. Fixed with an `Object.hasOwn()` guard and an `Object.create({ enabled: true })` regression test.
  - 2026-08-13 PRI-523 C1.3 self-review: the first shared PostToolUse enrichment validator used direct property reads after only checking that the value was object-like, so inherited enrichment fields could be treated as host-owned facts. Fixed by reading own data descriptors only and adding a regression where an inherited event ID cannot deduplicate two distinct canonical events.
  - 2026-06-28 PRI-480 (PR #1089) variant B: `canonicalizeToolKind()` lookup-table indexing returned `Object.prototype` for `__proto__` — fixed with `Object.hasOwn` guard
  - 2026-06-14 PRI-394 (PR #926): SQLite INSERT guessed column names — same trust-boundary pattern on DB schema
  - Earlier recurrences (PR#702-#810): variant A — `computeEffectiveFlags()` lacked dangerous-key rejection; Scribe/Evaluator/Artificer validators used direct property access. See git history.

---

**[ERR-014]** | `formatValidationErrorEntry` string values not truncated — evidence pack unbounded

- **What happened**: In `formatValidationErrorEntry()`, the `actualPreview` field returned raw string values without truncation: `typeof value === 'string' ? value : ...`. Only non-string values went through `truncatePreview()`. This violated the "bounded preview" design goal of the evidence pack — a very long string value (e.g., a 10KB error message) would bloat the evidence pack and could leak sensitive content.
- **Why it's wrong**: The evidence pack is designed to be observable and bounded. All preview fields must be size-limited. Leaving string values unbounded creates an asymmetry where `actualPreview` for strings can be arbitrarily large while non-string previews are capped at 100 chars. This is the same class as ERR-001/ERR-005 where type-specific handling creates validation gaps.
- **Correct approach**: Apply `truncatePreview(value, 100)` to the string branch as well, so all `actualPreview` values are uniformly bounded.
- **How to prevent**: When implementing "bounded preview" or "truncated" fields, verify ALL code paths that produce the field value apply the same truncation logic. Add a test case with a long string value to verify truncation.
- **Source**: PRI-200 / PR #665 (CodeRabbit review)
- **Date**: 2026-05-21
- **Recurrence**: Yes — same class as ERR-001/ERR-005 (type-specific branches bypass validation).
  - 2026-08-16 PRI-531 (PR #1328 review): `auto_correct_applied` ledger digest embedded raw `original`/`applied` values via JSON.stringify with no bound — a correction on a large field (e.g. file content) would bloat the row unbounded. Fixed with `.slice(0, 200)` on the digest (rc-8).
  - 2026-06-18 PRI-428 (PR #966): `demo-rule-compiler.ts` used `JSON.stringify(result).slice(0, 100)` on `unknown` — raw stringify can throw on circular refs. Fixed with `safeStringifyPreview(result)` (BigInt-safe, circular-ref-safe, bounded).

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
- **Recurrence**: Yes — 2026-06-23 PR #1020 (PRI-443): `validatePainSignal()` used `JSON.stringify(hydrated.context).length` without try-catch — throws on circular/BigInt, crashing validator. Fixed with try-catch returning structured error + 2 regression tests.

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
- **Recurrence**: Yes — handler-only tests miss Commander wiring for new CLI commands.
  - 2026-06-29 PR #1121 (CodeRabbit review): `pd activation promote` command had 3 handler-level tests in `runtime-activation.test.ts` but no parser-level wiring test, violating `cli-7-test-wiring`. Fix: extracted `registerRuntimeActivationPromoteCommand` helper (mirrors `registerRunRuleHostCommand` pattern) and added `runtime-activation-promote-flag-wiring.test.ts` with 14 parser tests covering option registration, `--no-*` negation absence, required-option rejection, and `-w` shorthand parsing.
  - Same PR also surfaced a sibling CLI gate violation (Finding 2): `resolveWorkspaceDir()` was called outside the `try` block in `handleRuntimeActivationPromote`, violating `cli-2-exit-stops` — if workspace resolution threw, the exception escaped the catch and broke the `--json` single-object contract. Fix: moved workspace resolution + `RuntimeStateManager` construction inside `try`, used `stateManager?.close()` in `finally`.
  - 2026-08-13 PR #1309 (self-review): new `maxTokens` pi-ai config was wired through `RuntimeConfig`/adapter but had NO Commander `--maxTokens` flag and NO flag-wiring test — asymmetric with `maxRetries`/`timeoutMs` which have both. Handler tests for the retry path existed but none exercised `parseAsync` with the new flag. Fix: added `.option('--maxTokens <n>', ...)` to `registerPainRetryCommand`, threaded `opts.maxTokens ?? policyConfig?.maxTokens`, added `pain-retry-maxTokens-flag.test.ts` (3 parser tests: numeric parse, parseInt path, omitted→undefined). Also caught the numeric-validation error message omitting `maxTokens` (message now lists all three numeric options).

---

**[ERR-022]** | process.exit(1) without return allows fallthrough to intake on failed diagnosis

- **What happened**: In `handleDiagnoseRun()`, the `result.status !== 'succeeded'` branch called `process.exit(1)` without a subsequent `return`. When `process.exit` is stubbed in tests (or when the handler is called from embedded contexts), execution continues past the exit call into the candidate intake code, potentially writing ledger entries for a failed diagnosis.
- **Why it's wrong**: `process.exit()` is not guaranteed to halt execution — it can be stubbed, intercepted, or the code may run in a non-Node context. Every `process.exit()` must be followed by `return` to ensure the function exits cleanly even if `process.exit` is no-op'd.
- **Correct approach**: Always add `return;` after `process.exit()`. This is a defensive coding pattern that prevents fallthrough regardless of whether `process.exit` is intercepted.
- **How to prevent**: Add an ESLint rule or lefthook check that flags `process.exit()` without a subsequent `return`. Alternatively, use a shared `fatalExit(code)` helper that always throws after exit.
- **Source**: PRI-217 / PR #677
- **Date**: 2026-05-22
- **Recurrence**: Yes — `process.exit(1)` without `return` allows fallthrough when exit is stubbed.
  - 2026-06-19 PRI-431 (PR #975): `diagnose.ts` line 197 `process.exit(1)` in `--openclaw-local`/`--openclaw-gateway` mutex check had no `return` — same `handleDiagnoseRun()` as original
  - 2026-06-14 PRI-392 (PR #922): `task.ts` `process.exit(1)` in error/not-found paths without `return`
  - See git history for full incident detail.

---

**[ERR-023]** | CLI dry-run command opens writable database connection instead of readonly

- **What happened**: `pd runtime internalization enqueue-successors` defaulted to dry-run mode but constructed `RuntimeStateManager` without `readonly: true`. This meant the dry-run path opened a writable SQLite connection, potentially mutating the database (schema migration, WAL files) even though the command was only supposed to report what it would do.
- **Why it's wrong**: Dry-run/default mode must never mutate state. Opening a writable DB connection violates the CLI dry-run contract (Command Gate rule 4: commands that can mutate state must default to dry-run). Even if no explicit write operations occur, the DB connection itself can trigger schema migration or WAL creation.
- **Correct approach**: When constructing `RuntimeStateManager` in a CLI command, always pass `readonly: isDryRun`. Dry-run/default mode must use `readonly: true`; only `--confirm` mode should use `readonly: false`.
- **How to prevent**: Add a "readonly wiring test" checklist item for every CLI command that uses `RuntimeStateManager`. Test that: (1) no flags / `--dry-run` → `readonly: true`; (2) `--confirm` → `readonly: false`.
- **Source**: PRI-218 / PR #681
- **Date**: 2026-05-23
- **Recurrence**: 2026-06-27 PR #1079 — `migrate-illegal-expected-decision.ts` docstring claimed "默认 dry-run" but `parseArgs()` defaulted to write mode (no `--write` flag required). Operator running the script with no flags would mutate the DB. Fixed by flipping to `--write` opt-in.
  - 2026-08-21 RuleCode Owner promotion self-review (no Linear issue): the shared decision service initially had no explicit dry-run result, and the first real readiness wiring opened `RuntimeStateManager` in writable mode even though no promotion commit was intended. Future completion of all readiness checks could therefore have made `--dry-run` ambiguous, while initialization itself could migrate schema or create WAL state. Fixed by adding a first-class `would_promote` service result that never calls the atomic commit port and by constructing the manager with `readonly: true` for dry-run; production CLI tests assert the real constructor option and zero legacy mutation. Lesson: dry-run safety must cover both business mutation and connection/bootstrap side effects.

---

**[ERR-024]** | Security validator exists but is not wired into enforcement path — defense is illusory

- **What happened**: `isPathWithinWorkspace()` and `validateProposedPathBounds()` were added to core as path boundary validation functions, but they were only called by tests and barrel exports. The real live auto-correct apply path in `gate.ts` still used `validateCorrectionProposal()` alone and directly applied `proposal.proposedParams` without checking path boundaries. An out-of-bounds path correction would be applied despite the validator existing.
- **Why it's wrong**: A validator that is not called from the enforcement path provides zero runtime defense. Tests against the validator prove the validator works, but they do not prove the system is defended. This is the same class as ERR-002 (catch-and-degrade without observability) — the defense exists in code but not in the actual execution path.
- **Correct approach**: When adding a security or validation function, it MUST be wired into the actual enforcement path, not just tested in isolation. The PR that introduces the validator must also modify the production code path to call it. If the enforcement wiring is out of scope, the PR must explicitly state this and the validator must not be presented as providing defense.
- **How to prevent**: For every new validation/security function, the PR must include: (1) a test proving the production path calls the function, (2) a test proving the production path rejects/defends when the function returns invalid. If neither exists, the validator is not actually defending anything. Review trigger: any PR that adds a validation function without modifying the code that handles the untrusted input.
- **Source**: PRI-210 / PR #690
- **Date**: 2026-05-23
- **Recurrence**: Yes — component (validator, handler, optional dep, or field) exists with isolated tests but is not wired into the production construction/enforcement path.
- 2026-08-26 PRI-606: axiom builders tested in isolation but `prompt.ts` injected via `evolutionReducer` (empty on fresh installs); barrel missed re-export — T-01..T-10 never injected. Fixed: registry-direct + barrel + empty-reducer regression test.
  - 2026-08-24 PR #1389 review round 2 (dormant consumer activation — mirror of the PRI-510 flavor): to forward two NEW telemetry events, `createPainSignalBridge` started passing `eventEmitter` into `new PainSignalBridge({...})` — an option the factory had NEVER passed on main, so the bridge's four PRE-EXISTING emission sites (`candidate_admission_decision`, `candidate_dreamer_task_seeded`, `candidate_not_internalizable`, `candidate_dreamer_task_seed_failed`) were dormant in production. The unconditional forwarding wrapper woke all four: routine admission decisions got re-emitted as `degradation_triggered` (semantic mislabeling of the degradation channel), and flag-off behavior changed despite the PR contract "flag off = zero effective surface". Fixed by extracting `mapBridgeTelemetryToStoreEvent`, which forwards ONLY the two persistence events; a negative-control test asserts the four pre-existing event names map to null (dormancy preserved). Rule of thumb: when STARTING to pass a previously-dormant optional dependency/handler into a construction path, grep ALL of the dependency's consumption sites (`this.eventEmitter?.…`), not just the newly added ones — every dormant site inherits the new wiring's channel and semantics. Route each site intentionally or filter to the intended events, and ship a negative-control test proving the unintended sites stay dormant.
  - 2026-08-19 PR #1358 external review round 5 (verdict drift, compressed; full text → ERROR_ARCHIVE.md): crash-recovery re-consulted the LLM instead of the durably persisted `runnerDecision`, overwriting verdicts whose side effects had already materialized; fixed with the atomic `completionIntent` authority protocol + `maybeResumePendingIntent` resume gate. Rule of thumb: every re-entry path must treat a durably recorded decision as the authority — never re-consult a non-deterministic advisor for a decision already recorded but not yet applied; enumerate every branch that persists the decision and every side effect that changes consumable governance state.
  - 2026-08-19 PR #1358 final-review blocker (compressed; full text → ERROR_ARCHIVE.md): succeeded-transition reconciliation was gated on a resource constructed after an early return, so the idle path never ran the budget; construct the budget's dependency before all early returns.
  - 2026-07-04 PRI-510 (PR#1188, compressed; full text → ERROR_ARCHIVE.md): EvaluatorRunnerDeps optional deps passed at only 2 of the construction sites — repair loop was dead code at runtime; centralize dep construction in one helper.
  - 2026-08-20 PR #1358 authority-reset: retry edge predated the completionIntent authority protocol and silently resumed the OLD verdict; fixed as ONE atomic authority-reset patch; enumerate every decision RESET/re-entry path, and merge multi-write Owner mutations into one store patch. (full text archived)
  - 2026-06-25 PRI-467 (PR#1059, compressed; full text → ERROR_ARCHIVE.md): `truncateInjectionToBudget()` `blocks` param omitted `intentBlockContent` — size guard couldn't strip INTENT by priority. Fixed by adding to `blocks` + Step 1.5 strip
  - 2026-06-19 PRI-408 (PR#972, compressed; full text → ERROR_ARCHIVE.md): `activateArtifact()` accepted `rolloutDecision='approved'` without verifying approval record — require `approvalId` + independent verification
  - Fix: when adding optional deps/fields/handlers to a constructor/service interface, grep ALL construction sites and update each one; add a test exercising the production construction path (not just the helper in isolation).

---

**[ERR-025]** | Test coverage proves isolated helper behavior, not real production defense

- **What happened**: `broken-artifact-simulation.ts` was added with `decideDownstreamGate()` and 54 tests, but no production code called it. The real `InternalizationChainIntegrityReadModel` and `InternalizationIntegrityRemediation` were completely untested. Tests proved the helper's logic, but the production system had no defense against the scenarios the helper covered.
- **Why it's wrong**: Tests that exercise a standalone helper without verifying that production code calls it create a false sense of security. All tests pass, but the production path remains unprotected. This is the same class as ERR-024 (validator without enforcement) and ERR-002 (degradation without observability) — the mechanism exists but is not connected to the real system.
- **Correct approach**: When adding a feature that is supposed to defend against a class of failures, tests must exercise the REAL production path (read model, remediation, CLI command), not just a standalone helper. If the helper is a contract specification, it must be wired into production code within the same PR. If the production wiring is out of scope, the PR must explicitly state that the system is NOT yet defended.
- **How to prevent**: For every PR that adds defensive logic, verify that at least one test exercises the production path that would invoke the defense. If no production path calls the new code, the PR must not claim to provide defense. Review trigger: any PR where the diff adds a new module but does not modify any existing production code to call it.
- **Source**: PRI-209 / PR #689
- **Date**: 2026-05-23
- **Recurrence**: Yes — tests assert shapes/strings/isolated helper behavior instead of the real production contract, or vacuously pass when data is absent.
  - 2026-08-27 PR #1413 review (release-update SPEC, no Linear issue): direct module tests did not prove installer/Console/Companion production wiring, so scope was corrected to foundation/shadow and production-entry BDD remains follow-up. The first post-fix CI run then proved the version fixture also differed from the official install (`~/.pd/bin` exists; manifest is at the extension root, not only `extension/plugin/`), causing clean install rejection. Fixed with a production-shaped fixture, root-manifest priority, nested-layout compatibility, and fail-loud corrupt-manifest behavior. Prevention: every shipped entry point needs a real smoke; helper fixtures are diagnostic only.
  - 2026-08-14 PRI-523 (PR#1315 review): `CodexHostInstaller.resolvePdHookPath()` only used `createRequire` from the installer package. Resolution succeeded in the dev worktree (workspace-sibling node_modules) and in tests that mock `module`, but the documented end-user flow (`npm install -g @principles/codex-adapter` + `npx create-principles-disciple install --host codex`) dead-ended: the npx cache is not an ancestor of the global npm root, so the adapter was never resolvable even after following the failure nextAction. Fixed by probing `npm root -g` as a fallback with injectable-deps tests covering fallback/preference/fail-loud. Same class: the production consumer path was never the thing under test.
  - 2026-08-11 PR #1298 (CodeRabbit #3758794691): `mvp-config.test.ts` used `content.indexOf('runHostInstallers')` to locate the substring extraction boundary for asserting the `!hasHostFailures` guard. But `runHostInstallers` first appears in a JSDoc comment and function declaration (lines 1105-1114), while the intended `return {` block with `!hasHostFailures` is at line 1322. The `indexOf` matched the wrong occurrence, so the extracted `returnBlock` did NOT contain the actual `!hasHostFailures` guard — the test passed vacuously. Fixed by using `await runHostInstallers(` (function call pattern) as the boundary anchor, which uniquely identifies the call site, not the declaration. Same class as ERR-026 (test environment drifts from production) — the test boundary drifted from the real code structure.
  - 2026-06-25 PRI-467 (PR#1059): mock stubbed `readActivations()` but prod calls `readActivatedPrinciples()` — TypeError catch-and-continue masked it
  - 2026-06-25 PRI-459 (PR#1045): ledger no-lost-update test was sequential (passes without lock); fails-LOUD lock contract untested
  - 2026-07-17 PRI-518: the OpenClaw CLI adapter's mocked test asserted a remembered `--message @file` convention, while the checked OpenClaw source accepts multiline payloads through `--message-file <path>`. The real replay therefore sent the diagnostician a literal path and repeatedly received schema-invalid output. Fixed by emitting the source-backed flag and asserting the exact spawned argument contract.
  - Earlier recurrences (PR#689-#1004): same vacuous-pass pattern across MVP smoke, repair loop, package tests, nav tests, RuleHost fixtures. See git history.

---

**[ERR-032]** | Documentation labels legacy dispatch as MVP-Core, contradicting ADR-0014

- **What happened**: `LEGACY_ENTRYPOINT_CENSUS.md` and test comments described evolution-worker heartbeat, sleep-cycle orchestrator, and queue-io sleep_reflection enqueue as `mvp_core_dependency` / "ADR-0014 core". But ADR-0014 defines MVP-Core as only three activation paths: `prompt`, `code_tool_hook / RuleHost`, `defer_archive`. The idle/night/sleep-reflection/nocturnal dispatch paths are retirement targets, not core.
- **Why it's wrong**: Labeling legacy dispatch as MVP-Core creates confusion about what can be deleted vs what must be preserved. It also references invalid issue numbers (PRI-232/233/234) that have been superseded or semantically drifted. This is the same class as ERR-027 (executable docs continue dispatching superseded work) — documentation contradicts the active strategy.
- **Correct approach**: MVP-Core labels must strictly follow ADR-0014: only `prompt`, `code_tool_hook / RuleHost`, `defer_archive`. All idle/night/sleep-reflection/nocturnal dispatch must be labeled as `retirement / live cutover / delete blocker`. Retirement issue references must use current valid numbers (PRI-228, PRI-229, PRI-119, PRI-230, PRI-231), not canceled or reused numbers.
- **How to prevent**: When a strategy ADR defines a precise scope (like MVP-Core), all documentation and test comments must be audited to align with that scope. Any label that claims something is "core" must trace directly to the ADR's definition. Review trigger: any PR that introduces or modifies `mvp_core_dependency` labels must cross-reference ADR-0014's explicit MVP-Core list.
- **Source**: PRI-227 / PR #698
- **Date**: 2026-05-24
- **Recurrence**: Yes - same class as ERR-027

  - 2026-08-20 PRI-553: the first Governance Status Card exposed raw task/approval source IDs because a child issue's provenance wording was followed more broadly than the frozen design authority. SPEC §16 explicitly keeps source references in diagnostics/tests and forbids them in the Phase 1 default card. Fixed by retaining references in the validated view while removing them from visible card/timeline copy and adding browser assertions that technical IDs are absent.
  - 2026-08-20 PRI-551/PRI-553: final acceptance/review found exact-contract drifts: a synonymous lease reason code, wrong flag-off API code, regex-only impossible timestamps, an ignored `verdict_missing` relation, and a second/replacement timeline that could hide durable history. Fixed with exact schema/API/derivation assertions and by embedding governance events into the existing trajectory.

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

**[ERR-034]** | Canonical runtime config not consumed by caller or cache key

- **What happened**: Two related issues: (1) `diagnose.ts` forced a pre-check requiring `--openclaw-local` or `--openclaw-gateway` CLI flags before calling `resolveRuntimeConfig()`, preventing file-config-only paths from working. After `resolveRuntimeConfig()` succeeded, the code still used `configResult.openclawMode ?? (opts.openclawLocal ? 'local' : 'gateway')` — guessing the mode instead of consuming the canonical validated result. (2) `pain-signal-runtime-factory.ts` bridge cache key was `${workspaceDir}:${runtimeKind}` without `openclawMode`, causing the same workspace switching from local to gateway to reuse the wrong bridge/adapter.
- **Why it's wrong**: The whole point of `resolveRuntimeConfig()` is to be the single source of truth for runtime configuration. When callers second-guess the result or bypass it with pre-checks, the canonical config is undermined. Cache keys that omit discriminating fields cause stale data reuse. This is the same class as ERR-031 (config resolver hard-fails on valid runtime) and ERR-004 (lineage fields from wrong source).
- **Correct approach**: (1) Remove pre-checks that duplicate what `resolveRuntimeConfig()` already validates. (2) After calling `resolveRuntimeConfig()`, use only `configResult.openclawMode` — never fall back to CLI flag guessing. (3) Include all discriminating fields in cache keys. (4) `invalidatePainSignalBridge()` must clear all mode variants.
- **How to prevent**: When a canonical config resolver exists, callers must not duplicate its validation logic. After calling the resolver, consume its result directly — no fallback guessing. Cache keys must include all fields that change behavior. Test: file-config-only path, flag-override path, cache isolation between modes.
- **Source**: PRI-162 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-031/ERR-004 — canonical resolver output not consumed, or `??`/compatibility fallback silently overrides user intent.
  - 2026-07-15 PRI-516: prompt retry deduplication initially keyed only by OpenClaw `runId`, although protocol run IDs may be reused after termination. Fixed by including the stable logical session identity (`sessionKey`, falling back to `sessionId`) and workspace in the bounded cache identity, plus a regression proving the same run ID remains valid in another session.
  - 2026-06-18 PRI-429 (PR#966): run-rulehost ignored effective `code_rule_capability` flag + reused one diagnostician adapter for 4 agents — resolved 5 bindings independently
  - 2026-06-08 PRI-336 (PR#850): `pain-signal-runtime-factory` bypassed `resolvedLang.outputLanguage` (read raw input) — always use resolver output
  - Earlier recurrence (PR#701, 2026-05-24): `resolveRuntimeConfig()` didn't accept `requestedRuntimeKind`; `?? 'local'` overrode gateway intent. See git history.

---

> PRI-523 C2 recurrence for ERR-034 (2026-08-13): The Codex hook initially preferred inherited `PD_WORKSPACE_DIR` over codex-cli 0.147.0's validated `cwd`, so stale process-global compatibility state could route one Workspace's hook into another Workspace's business state. The fix treats hook `cwd` as authoritative and resolves its nearest ancestor `.pd/config.yaml`; executable regressions cover nested-cwd selection and flag-off/no-mutation behavior.

**[ERR-035]** | Static guard only covers frozen-basename dynamic imports, misses other legacy paths

- **What happened**: `nocturnal-entrypoint-guard.test.ts` `findImportLines()` only checked dynamic imports against `FROZEN_NOCTURNAL_MODULES` basenames. A dynamic import like `import('../service/sleep-cycle.js')` or `import('../service/idle-detector.js')` would not be detected because `sleep-cycle` and `idle-detector` are not in the frozen set. PRI-227's goal is to prevent new legacy nocturnal callers, not just frozen module callers.
- **Why it's wrong**: The guard's purpose is to catch any new entrypoint into the legacy nocturnal/sleep/idle subsystem, regardless of whether the specific file is in the frozen set. Limiting dynamic import detection to frozen basenames creates a blind spot where new callers of non-frozen legacy modules pass the guard undetected. This is the same class as ERR-024/ERR-025 (validator exists but doesn't cover the real attack surface).
- **Correct approach**: Dynamic import detection must use path-pattern matching (e.g., `nocturnal-`, `sleep-cycle`, `sleep_reflection`, `idle`) rather than exact basename matching against a frozen set. The frozen set check remains for static imports; dynamic imports need broader pattern coverage.
- **How to prevent**: When writing a guard that prevents new callers of a subsystem, ensure the detection covers all naming patterns used by that subsystem, not just a specific subset. Test: add a test case for a dynamic import of a non-frozen-basename legacy module and verify it's detected.
- **Source**: PRI-227 / PR #701
- **Date**: 2026-05-24
- **Recurrence**: Same class as ERR-024/ERR-025 — static guard/extractor added but real enforcement path not updated, or pattern matches substring not segment.
  - 2026-06-23 PRI-450 (PR#1022): core I/O guard missed sub-path imports (`fs/promises`) and side-effect `import 'fs'` — added `fs/*`,`node:fs/*` to ESLint + `extractImportPaths()` helper
  - 2026-05-24 PR#701: added `idle` to extractor but enforcement check still only covered `nocturnal`/`sleep_reflection`/`sleep-cycle`; substring match hit `HybridLedgerStore` (hybr**idle**) → word-boundary regex
  - Fix: update enforcement check when adding guarded items; match at segment boundaries, never substrings.

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

**[ERR-045]** | Shell interpolation of user-provided paths enables command injection

- **What happened**: Story A verification used `execSync(\`"${pdCmd}" demo story-a --json --workspace "${options.workspaceDir}"\`, { shell: 'cmd' })`. The `workspaceDir` is user-provided and enters a shell string via template literal interpolation. A workspace path containing shell metacharacters (e.g., `&`, `|`, `$(...)`) would be interpreted by cmd.exe, enabling command injection.
- **Why it's wrong**: Any user-provided path that flows into a shell command string is an injection vector. Even with quoting, cmd.exe has complex escaping rules that make safe interpolation nearly impossible. This is a security vulnerability, not just a reliability issue.
- **Correct approach**: Use `execFileSync(process.execPath, [entry, ...args])` which passes arguments as an array without shell interpretation. No shell = no injection. This also eliminates the `.cmd` wrapper dependency for verification.
- **How to prevent**: Never use `execSync` with `shell` option for commands that include user input. Always prefer `execFileSync` with array arguments. When shell is unavoidable, validate/sanitize inputs first.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-024 (security mechanism exists but is bypassed). Recurred 2026-08-17 (PRI-543 / PR #1349): `resolveGitUserEmail` in `create-principles-disciple/src/installer.ts` used `execSync(\`git -C "${workspaceDir}" config user.email\`, { shell: 'cmd' })` — CodeQL flagged it as command injection; fixed with `execFileSync('git', ['-C', workspaceDir, 'config', 'user.email'])`. Lesson: the argv-array rule applies even for "internal-looking" paths (installer workspace dirs), and any new `execSync`+`shell:` in a diff is a P1 review blocker.
  - 2026-08-21 RuleCode Owner Live Decision self-review: `SqliteActivationSafetyStore.deactivateWithDecision` interpolated an internally selected `actionClause` into SELECT and UPDATE DML. The values were fixed constants, but this still bypassed the repository's no-dynamic-DML guard and left an injection-shaped maintenance seam. Replaced it with two fully static prepared statements for reject-after-shadow versus emergency deactivation. Prevention: SQL structure is code, not a parameter; choose between complete static statements and bind only values.

---

**[ERR-048]** | Runtime V2 activation write path disconnected from live prompt read path — activation succeeds but principle never injected

- **What happened**: Runtime V2 `ActivationDispatcher` writes activation records to the `activations` SQLite table (`channel='prompt', action='prompt_activate'`), but the live OpenClaw prompt hook (`handleBeforePromptBuild`) only reads from the legacy `evolutionReducer.getActivePrinciples()`. The activation write path and the prompt read path are completely separate systems — activation dispatch never calls `evolutionReducer.promote()`, so activated principles never appear in agent prompts and never change agent behavior.
- **Why it's wrong**: This is the same class as ERR-024/ERR-025 (defense exists but is not enforced; test proves isolated behavior not production path). The activation dispatcher and its tests prove that activation records are written correctly, but the production prompt injection path never consumes those records. The MVP value chain is broken: owner approves → activation record written → principle NOT injected → agent behavior unchanged. The two systems evolved independently (Runtime V2 activation is new; legacy evolutionReducer predates it) and were never connected.
- **Correct approach**: The live prompt hook must directly consume Runtime V2 activation records as a first-class source, independent of the legacy evolution reducer. A `PromptActivationReader` reads `activations` table (channel='prompt') → resolves artifact content → returns injectable principles. The prompt hook merges these with legacy principles, deduplicating by principleId. Feature flag gating is checked. Malformed/missing data fails loud with structured warnings.
- **How to prevent**: When adding a new write path (activation dispatch), immediately verify the corresponding read path (prompt injection) consumes it. Never assume two independently-evolved systems are connected without an explicit binding test. The TDD RED→GREEN cycle (write failing test first that proves the disconnect, then implement the binding) prevents this class of error.
- **Source**: PRI-261
- **Date**: 2026-05-27
- **Recurrence**: Same class as ERR-024, ERR-025 — component exists and passes isolated tests, but production code never calls it.
  - 2026-06-19 PRI-408 (PR #972): `ApprovalQueue.enqueue()` never wired into `RuleHostPipelineRunner`; `ApprovalQueue.edit()` unreachable (no CLI/Console route)
  - 2026-07-17 PRI-518: `SqliteContextAssembler` supported the plugin-owned `TrajectoryTurnReader`, but `PainToPrincipleService` and `PainSignalRuntimeFactory` never received or forwarded it. A real Owner correction reached `trajectory.db`, while the diagnostician received empty placeholder turns. Fixed by explicit core port forwarding plus a cross-SQLite regression test that writes plugin trajectory turns and asserts the Runtime V2 context reads them.
  - PRI-261 PR review: initial implementation missed validation_status guard, action filter, budget limit, used `as` bypass + hand-rolled YAML parser
  - See git history for full incident detail.

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

**[ERR-072]** | React component duplicates hook state as local state — desync causes silent feature failure

- **What happened**: `NotificationProvider` maintained its own `audioUnlocked` state in `useState` while also consuming `audioUnlocked` from `useNotificationSound()` hook. The Provider's `handleInteraction` callback called `unlockAudio()` (which sets the hook's internal state) AND `setState({ audioUnlocked: true })` (setting the Provider's local copy). Since `unlockAudio()` is async (calls `ctx.resume()`), the Provider could mark audio as unlocked before the hook's internal state updated, causing `playSound()` to still return early due to its own `audioUnlocked` being `false`.
- **Why it's wrong**: When a hook exposes derived state, the consuming component must use the hook's state as the single source of truth. Duplicating it as local state creates a race condition where the two states can desync, causing silent feature failures (sound not playing despite UI showing it as enabled).
- **Correct approach**: Remove the duplicate `audioUnlocked` from the Provider's `useState`. Use the `audioUnlocked` returned by `useNotificationSound()` directly in effects and pass it through context. The hook owns the state lifecycle; the Provider only consumes it.
- **How to prevent**: When a React hook returns state, never copy it into a parent component's `useState`. If the parent needs to expose it, pass the hook's value directly through context or props. Check: does any `useState` field duplicate a value already returned by a consumed hook?
- **Source**: PR #971
- **Date**: 2026-06-18

---

| Metric | Value |
|--------|-------|
| Total lessons | 108 |
| Last updated | 2026-08-28 |
| Top category | Schema & Type |
| Recurring errors | 58 |

---

**[ERR-040]** | Published artifact missing components that source-tree tests assume exist

- **What happened**: The installer's `syncPdCli()` function expected `pd-cli/dist/index.js` to exist in the package root, but `bundle-plugin.mjs` only copied the OpenClaw plugin — not pd-cli. The `package.json files` array didn't include `pd-cli`. Source-tree tests passed because pd-cli existed in the monorepo, but the published npm tarball would be missing it entirely.
- **Why it's wrong**: Tests that run against the monorepo source tree do not prove the published artifact works. When the bundle script and `files` array don't include a required component, the published package is broken but CI passes. This is the same class as ERR-025 (tests prove isolated behavior, not production defense) and ERR-026 (test environment drifts from production).
- **Correct approach**: For any package that bundles artifacts from other packages, the bundle script must copy ALL required components, the `files` array must include them, and a tarball content contract test must verify the published package contains every expected file.
- **How to prevent**: Add a tarball content contract test that: (1) reads `package.json files` array, (2) asserts required directories are listed, (3) after `npm pack`, asserts the tarball contains expected files. Run this test in CI, not just locally.
- **Source**: PRI-247 / PR #721
- **Date**: 2026-05-26
- **Recurrence**: Same class as ERR-025, ERR-026. 3 most recent full entries below; older recurrences compressed to one lines (full text → ERROR_ARCHIVE.md).
  - 2026-08-27 PR #1413 review (release-update SPEC, no Linear issue): the declared support contract covered 5 OS/architecture targets across Node 22/24/26 (15 combinations), but the so-called full reproducibility workflow exercised only the 5 Node 26 targets and npm publication could proceed independently of it. Fixed by restoring all 15 combinations in a reusable full workflow and making the publish job depend on that workflow, while retaining a single-target quick PR check. Prevention: the publication workflow itself must depend on the complete supported-target matrix; a separately green or manually runnable matrix is not a release gate.
  - 2026-08-25 release-update Phase 2b quality review (no Linear issue): spawning `npm` directly with `execFile` on Windows fails with EINVAL because `npm` resolves to `npm.cmd` (shell shim, not an executable). The release-lock generate/check scripts and the self-contained bundler now spawn npm through `ComSpec /d /s /c` on win32 (same ERR-040 Windows CLI execution family as the PR #1146 pd-shim recurrence). Prevention: on win32 every child-process invocation of an npm-provided binary must go through `process.env.ComSpec`, never the bare command name.
  - 2026-08-25 release-update Phase 2b SPEC review (no Linear issue): the native clean-machine matrix initially ran the repository's TypeScript `build` only, while the release producer requires `openclaw-plugin/dist/bundle.js`, which is emitted by `build:production`. All matrix jobs would therefore have failed before exercising the native asset. Fixed by explicitly running the production plugin bundler before the platform/Node smoke matrix. Prevention: a clean-checkout release workflow must enumerate the exact producer for every required generated artifact; a generic package `build` name is not evidence that production bundle outputs exist.
  - 2026-08-25 release-update SPEC review (compressed; full text → ERROR_ARCHIVE.md): producer copied only dist metadata, release test fabricated `node_modules`, `./governance-audit` export undelivered; every zero-install consumer contract lands with the producer + clean consumer smoke in the same change.
  - 2026-08-22 PRI-561 (compressed; full text → ERROR_ARCHIVE.md): console inline updater missed the host-runtime copy + resolution link; when a package gains a new `@principles/*` dependency, extend EVERY delivery surface (bundle-plugin / installer / updater).
  - 2026-08-21 PR #1371 (compressed; full text → ERROR_ARCHIVE.md): bundle dependency-rewrite map missed the new `@principles/host-runtime` import → packaged console crashed on clean install; extend the rewrite map for every new `@principles/*` package and cover the import in the packaged-install smoke.
  - 2026-08-14 PRI-524 (compressed; full text → ERROR_ARCHIVE.md): Codex plugin scripts re-committed the pd `.cmd` shim spawn EINVAL; resolve the real pd-cli JS entry and spawn via `process.execPath`.
  - 2026-08-13 PRI-523 (compressed; full text → ERROR_ARCHIVE.md): bundled plugin kept an inlined workspace-only dependency; packaging strips and pack-tests it.
  - 2026-07-03 PRI-505 (compressed; full text → ERROR_ARCHIVE.md): `PLUGIN_REQUIRED` checked `dist/` exists, not `dist/bundle.js`; required-file checks must name the exact file.
  - 2026-07-01 PR #1146 (compressed; full text → ERROR_ARCHIVE.md): bare npm `pd` shim fails under Windows `shell:false`; resolve the sibling `dist/index.js` and spawn via `process.execPath`.
  - 2026-06-03 PRI-299 (compressed; full text → ERROR_ARCHIVE.md): pd-cli imported better-sqlite3 without declaring it.
  - 2026-06-02 PRI-250 (compressed; full text → ERROR_ARCHIVE.md): `js-yaml`/`semver` in devDependencies (stripped by publish); undeclared better-sqlite3 for console bundle; `installBundledCore` never ran npm install.

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

- **2026-08-13 PRI-523 C1.3 recurrence**: the shared sanitizer documented ANY-segment key redaction but only applied value-shaped token regexes, allowing `token` and nested `authorization` values through. Fixed in the canonical core sanitizer with nested sensitive-key regressions and verified through persisted host-runtime evidence.

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
- **Recurrence**: Same class as ERR-014, ERR-016, ERR-017 (previews/serialization not bounded/safe).
  - 2026-06-06 PEAT-A (PR #836): `sanitizeString()` only ran `convergePath()` on full string — embedded paths (`"cd D:\\Code\\principles && git status"`) passed through. Fixed with `ABSOLUTE_PATH_IN_STRING_RE` (Windows/POSIX/UNC) + `replacePathsInString()`
  - 2026-06-06 PEAT-A CI breakage: `nodePath.basename()` on Linux doesn't split on `\` — `D:\Code\principles` preserved verbatim. Fixed with `platformAgnosticBasename()` (splits on both `\` and `/`)
  - Cross-platform portability variant: path op works on Windows dev machine but silently fails on Linux CI.

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
- **Recurrence**: 2026-06-18 PR #971 — the notification-sound branch was based on a stacked history and its PR diff included already-merged RuleHost work plus unrelated website assets. Fixed by rebuilding the branch from current `main` and replaying only the seven notification commits. The review guard was strengthened in practice by comparing both `git log origin/main..source-branch` and `gh pr diff --name-only` before resolving conflicts.

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
- **Recurrence**: Yes — `as TOutput` cast on untrusted LLM/runtime payload before validation.
  - 2026-06-03 PR #809: EvaluatorValidator.validate() accepted `EvaluatorOutputV1` instead of `unknown`; evaluator-runner.ts used `output as EvaluatorOutputV1` — fixed by accepting `unknown`
  - 2026-06-03 PR #810: ArtificerRunner.validateOutput used `result.errorCategory as PDErrorCategory | undefined` instead of `isPDErrorCategory()` runtime check
  - Earlier: PR #806 (first occurrence in BasePeerRunner.fetchAndParseOutput). See git history.


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
- **Recurrence**: Yes.
  - 2026-08-25 Phase 0 update safeguards self-review: the unstamped legacy-installer path staged and inspected a tarball, then returned `installer_bundle_stale` before production mutation. Because that return was inside the outer `try`, it bypassed the `catch` cleanup and left the temporary staging directory behind. Fixed by removing the staging directory before the refusal return and adding a real route test that records the tar extraction directory, asserts the stale result, and proves the directory no longer exists. Lesson: every early refusal after temporary-resource creation must either clean that resource locally or use a `finally`; test the refusal path with an observable resource-lifecycle assertion.

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
[ERR-064]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-064

---

**[ERR-066]** | CLI --json failure path not structured; raw stack trace dumped to stderr on assembler throw

- **What happened**: PRI-397's `pd mvp smoke --json` and `pd task list --json` handlers did not wrap their work in try/catch. On any assembler/state-manager throw (e.g., fresh post-PRI-398 workspace, missing `.pd/state.db`, corrupt config), the throw bubbled to the top of the async function, the test runner saw a raw stack trace on stderr, and the exit code was non-zero with no JSON output on stdout. This violated EP-04 Rules 1 (single parseable JSON object on stdout) and 6 (failure paths must carry reason + nextAction). The handler was shipped untested for the failure path. I marked my self-review Phase 6.5 as "no real issues" without running the failure path through a test or even a manual `pd mvp smoke --workspace <nonexistent>` against the production binary.
- **Why it's wrong**: The first operator run after a workspace reset (the explicit PRI-398 motivation for `pd mvp smoke`) is precisely when the database is missing or unreadable — i.e., when the failure path triggers. A CLI that emits a raw stack trace on the most common first-failure scenario defeats the entire purpose of the command. The bug is a process failure as well: I trusted the success-path tests as proof of completeness, when the failure path was the load-bearing one.
- **Correct approach**: For every new --json handler, add a test that calls the handler with a workspace that will fail (nonexistent dir, corrupt DB) and asserts: (1) exit code is 1, (2) stdout contains exactly one parseable JSON object, (3) the object has `ok: false`, `reason: string`, `nextAction: string`. Use a structured error classifier (e.g., `classifySmokeError(err)`) that names the specific next action (e.g., "Run pd runtime internalization integrity-repair --confirm") rather than a generic "retry" hint. When writing the self-review, run the production binary with a bad workspace and confirm the JSON output looks right end-to-end.
- **How to prevent**: (1) The CLI/Operator Contract gate already requires this — apply it as a hard checklist before claiming "no real issues": for every --json command, run a manual test with a failing workspace, run a real `program.parseAsync` test with a failing workspace, and assert the JSON shape. (2) Add the failure-path test to the same test block as the success-path test so they ship together. (3) Self-review must NEVER mark "no real issues" without first running the failure path through a real test or a real production binary invocation. (4) Prefer shared registration helpers (e.g., `registerMvpCommands(program)`) so the failure-path test runs the same registration as production — a hand-rebuilt command tree can pass tests while production is broken.
- **Source**: PRI-397 / PR #932
- **Date**: 2026-06-15
- **Recurrence**: First occurrence (related to EP-04 missing tests; same pattern as ERR-021, ERR-029, ERR-033, ERR-053)
[ERR-066]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-066

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
[ERR-067]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-067

**[ERR-068]** | Used the wrong package manager (pnpm) in a repo whose CI runs `npm ci`, leaving `package-lock.json` out of sync

- **What happened**: Adding the `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai` dependencies via `pnpm install` updated `pnpm-lock.yaml` only. The repo's CI workflows all run `npm ci` (which reads `package-lock.json`). Because `package-lock.json` was not updated, every CI job failed with `Missing: @earendil-works/pi-agent-core@0.79.4 from lock file` and `Invalid: lock file's typebox@1.1.34 does not satisfy typebox@1.1.38`. Local pre-push `verify:merge` passed because it does not re-resolve the lockfile.
- **Root cause**: Did not check which package manager CI uses before installing dependencies. The repo root has both `package.json` (`packageManager: pnpm@11.1.1`) and `package-lock.json`, but CI workflows exclusively use `npm ci`. pnpm and npm maintain separate lockfiles; updating one does not sync the other.
- **Fix**: `git checkout pnpm-lock.yaml` (revert the wrong lockfile), then `npm install --ignore-scripts` to regenerate `package-lock.json` with the new deps. Commit 3a7780e.
- **Prevention**: Before adding/removing dependencies, check CI workflows (`grep -r "npm ci\|pnpm install" .github/workflows/`) to identify the canonical lockfile. Run the install command matching CI's package manager, then commit the lockfile CI reads. EP-06 "package runtime dependencies are declared in the package that imports them" extends to: the lockfile CI consumes must be the one updated.
- **Recurrence**: 2026-06-16, PRI-419 / PR #953.

**[ERR-069]** | Adapter `runHandle` hardcodes `status:'succeeded'` absent from `RunHandleSchema` (masked by `as RunHandle`); degradation path trusts validator-rejected candidate — two trust-boundary breaches in `ArtificerL2Adapter`

- **What happened**: Two defects found in a single self-review of `ArtificerL2Adapter` (PRI-424 Phase 4), both in the same file:
  1. **P1 — phantom schema field**: `runHandle()` returned `{ runId, runtimeKind, startedAt, status: 'succeeded' }` cast via `as RunHandle`. But `RunHandleSchema` (runtime-protocol.ts:68-72) has **no `status` field** — it is `{ runId, runtimeKind, startedAt }`. The bogus field was invented from memory of `RunStatus` (which DOES have `status`) and silently accepted by TypeScript because the `as RunHandle` cast suppressed the shape check. The failure path (no validated candidate across all attempts) returned this handle claiming `succeeded` while `pollRun()` reported `failed` — a contradictory run state. It happened to not break production only because `BasePeerRunner.pollUntilTerminal` reads `pollRun().status`, not `handle.status`.
  2. **P2 — degradation trusted unvalidated candidate**: On validator rejection (malformed V2), the code set `lastValidV2 = candidateWithTaskId` if the candidate was "structurally V2-shaped" (`isArtificerOutputV2` true). But that candidate had **failed validation** — its `implementationPlan`/`sourceTrace`/`generatedAt` were never checked. On exhaustion, `degradeToV1(lastValidV2)` would emit a V1 object built from an unvalidated candidate, relying on the downstream V1 validator to catch it. This violates Runtime Contract Rule 1/3: every emitted object must come from a validated source, including degraded/fallback outputs.
- **Root cause (both)**: Writing the adapter against a *remembered* contract rather than the *actual* schema, and treating degradation as a separate trust zone from the happy path. P1 is the same class as ERR-061 ("guessed structure instead of verifying against actual type") + ERR-054 (`as` cast masking a shape mismatch). P2 is the same class as ERR-001/ERR-005/ERR-013 (EP-01 Trust Boundary) but in a new location: **the degradation/fallback path**, which is often written as an afterthought and skips the validation the happy path enforces.
- **Fix** (commit c396ed92):
  - P1: Removed the phantom `status` field from `runHandle()` (it is not in `RunHandleSchema`). The run's terminal status is reported solely via `pollRun()`. The failure path now `throw new PDRuntimeError('output_invalid', ...)` instead of returning a misleading handle — aligning with Dreamer L2's `L2AgentLoopAdapter` failure pattern, caught by `BasePeerRunner.handlePostLeaseError`.
  - P2: Validator rejection no longer sets `lastValidV2`. Degradation to V1 now only happens when a **validated** V2 candidate existed but sandbox replay failed (legitimate: plan is valid, only the code was wrong). A candidate that never passed validation is never emitted, even degraded.
  - Added 2 regression tests: (a) 3× validator-rejection → throws (no degradation); (b) validated V2 + replay failure → degrades to V1.
- **Prevention**:
  - When implementing a `PDRuntimeAdapter`, read `RunHandleSchema` / `RunStatusSchema` from `runtime-protocol.ts` and copy field names verbatim — do not rely on memory. The two objects differ only by `status`, which is easy to conflate.
  - Treat every output-emitting path (happy, degraded, fallback, retry-exhausted) as a trust boundary: each must emit only objects that passed validation. Degradation is a *content* transformation (strip code fields), not a *trust* escape hatch.
  - Prefer `throw PDRuntimeError` over returning a contradictory state object on total failure — it surfaces in `handlePostLeaseError` with a structured reason, rather than relying on the caller to cross-check handle vs pollRun.
- **Recurrence**: 2026-06-21 PR #993 — Artificer prompt requested retired `implementationPlan` while validator required `implementationSummary` (coding against remembered contract). Fixed by aligning prompt+schema on V2 + negative assertions for retired V1 field. Original found in self-review (commit c396ed92).

**[ERR-070]** | New public types/classes not exported from barrel `index.ts` — module consumers cannot import the new API surface

- **What happened**: In PR #963 (PRI-424 RuleHost MVP Activation), multiple new V2 types (`ArtificerOutputV2`, `EvaluatorOutputV2`, `AdversarialCase`, `AdversarialFailedCase`, `EvaluatorCodeReview`, `EvaluatorAdversarialResult`, `GoldenTraceCaseInput`) and the `ArtificerL2Adapter` class were added to internal module files (`artificer-output.ts`, `evaluator-output.ts`, `artificer-l2-adapter.ts`, `golden-trace.ts`) but were not re-exported from the barrel `index.ts` files (`runtime-v2/internalization/index.ts` and `runtime-v2/index.ts`). Downstream consumers importing from the package's public API would get "module has no exported member" errors.
- **Why it's wrong**: TypeScript barrel exports (`index.ts`) define the module's public API surface. Adding new types to internal files without updating the barrel means the types exist but are unreachable from outside the module. This is the module-level equivalent of ERR-060 (capability added but not registered in the proper surface).
- **Generalized failure mode**: When adding new public types, functions, or classes to internal module files, assistants must update the corresponding barrel `index.ts` exports, otherwise downstream consumers cannot access the new API surface.
- **Correct approach**: After adding any new export to an internal file, immediately verify whether the barrel `index.ts` at each level (sub-module root, package root) needs a corresponding re-export. Use `grep -r "export.*from" index.ts` to see current exports and add any missing ones.
- **How to prevent**: During PR review, for every new `export` keyword added to a non-index file: (1) check if the nearest ancestor `index.ts` re-exports it; (2) check if the package-level `index.ts` re-exports it; (3) if the type is used in tests but not barrel-exported, the test may pass via direct path import while external consumers fail.
- **Regression guard**: A TypeScript consumer-import test that does `import { NewType } from '@principles/core'` (package root) and asserts the type is defined.
- **Related ERRs**: ERR-060 (capability not registered in proper surface)
- **Source**: PRI-424 / PR #963
- **Date**: 2026-06-18
- **Recurrence**: First occurrence.

---

**[ERR-071]** | Async cleanup not `await`ed in finally; test resources not wrapped in try-finally; `process.env` not restored — resource leaks and test pollution

- **What happened**: Three cleanup-hygiene defects found in PR #966 review (PRI-428), all in the `pd-cli` package:
  1. **P1 — missing `await` on async cleanup**: `rulehost-pipeline-runner.ts` called `stateManager.close()` in a `finally` block without `await`. Since `close()` is `async` (returns `Promise<void>`), the function returned before SQLite connections and transactions were properly closed, potentially leaking resources in CLI scenarios.
  2. **P1 — test resource not in try-finally**: `rulehost-pipeline-e2e.test.ts` called `sm2.initialize()` and ran assertions without a `try-finally`. If any `expect()` threw, `sm2.close()` was never called, leaving SQLite files locked and subsequent tests polluted.
  3. **P2 — `process.env` not restored**: `rulehost-pipeline-e2e.test.ts` set `process.env[config.apiKeyEnv] = config.apiKey` in test setup but never restored the original value in `afterEach`, causing global state pollution that could affect other test files.
- **Why it's wrong**: Async cleanup that is not `await`ed may not complete before the process moves on, leaving file handles, SQLite connections, or transactions open. Test resources not wrapped in `try-finally` leak when assertions fail. Global state (`process.env`) not restored in `afterEach` pollutes subsequent tests, causing flaky or order-dependent test failures. All three are cleanup-hygiene defects that are invisible when tests pass but cause cascading failures when they don't.
- **Generalized failure mode**: When async cleanup methods are called in `finally` blocks without `await`, or test resource initialization is not wrapped in `try-finally` with cleanup in `finally`, or tests modify global state without restoration, assistants risk resource leaks and test pollution that are hard to diagnose.
- **Correct approach**: (1) Always `await` async cleanup methods in `finally` blocks. (2) Wrap test resource initialization (`new RuntimeStateManager` + `initialize()`) in `try-finally` with `close()` in `finally`. (3) Track original `process.env` values in setup and restore them in `afterEach`.
- **How to prevent**: During PR review, grep for `finally` blocks and verify every async call inside them is `await`ed. Grep for `new RuntimeStateManager` or similar resource-creating calls in tests and verify they are wrapped in `try-finally`. Grep for `process.env[...] =` in test files and verify a corresponding restoration in `afterEach`.
- **Regression guard**: (1) Static check: grep `finally` blocks for non-`await`ed async calls. (2) Test: run the test suite with `--no-cache` and in random order to detect pollution. (3) Test: intentionally fail an assertion after `sm2.initialize()` and verify `sm2.close()` is still called.
- **Related ERRs**: ERR-002 (silent cleanup failure — PRI-240 recurrence), ERR-015/ERR-018/ERR-019 (stale state from incomplete cleanup)
- **Source**: PRI-428 / PR #966 (CodeRabbit review)
- **Date**: 2026-06-18
- **Recurrence**: 2026-06-21 PR #994 — timeout cleanup killed only the direct CLI process on Unix, allowing descendant processes and inherited handles to survive. Fixed by launching a detached process group and terminating the whole group on timeout. Also 2026-06-21 PR #989 — short-lived SQLite queues returned without their owning connection; 2026-06-18 PRI-429 / PR #966 — cleanup failures were discarded; 2026-06-18 PR #971 — `AudioContext` instances leaked on unmount.

  - 2026-07-17 PRI-518 self-review: a new cross-SQLite E2E test called `RuntimeStateManager.close()` in `afterEach` without `await`. Fixed before handoff by making the hook async and awaiting close before removing the temporary workspace.
  - 2026-08-13 PRI-523: a registration-test timer could mutate real home config. Mocked the writer, authorized the fake config, cleaned timers, and isolated packed-bundle HOME.
  - 2026-08-28 PRI-612 / PR #1426 review: a pd-cli test registered a process-wide `unhandledRejection` listener and never removed it, leaking debug behavior into later tests in the same worker. Fixed by removing the listener; the focused suite now proves the intended rejection behavior without global instrumentation.
  - 2026-08-13 PRI-523 C1.3 self-review (corrected classification, consolidated): the OpenClaw host-owned diagnosis continuation must remain best-effort so the PostToolUse hook returns after durable shared SQLite persistence, but the first implementation used bare `void emitPainDetectedEvent(...)` with no lifecycle-owned rejection handling or test drain. The first corrective scheduler still allowed a never-settling continuation to keep the pending set and lifecycle drain open forever. Fixed with an explicit scheduler that attaches immediate resolution/rejection handlers, enforces a finite 30-second timeout, emits bounded reason/nextAction, clears its timer on every terminal path, removes settled or timed-out promises, and exposes a test-only drain. Rejected and never-settling continuation regressions prove observability and bounded cleanup without extending hook latency; the original promise remains rejection-observed even if it settles after the timeout.

---

**[ERR-073]** | Refactoring characterization tests cover shared logic happy path, not call-site-specific behavior equivalence

- **What happened**: When extracting the shared `resolveRuntimeAdapterFromConfig` resolver from `diagnose.ts` and `run-once.ts` (PRI-431), the characterization tests verified the shared resolver's behavior in isolation but did not verify behavior equivalence with the original call-site code for the `configOptional: true` option. The original `diagnose.ts` never called `validateRuntimeConfig` — it only did a manual missing-field check on merged values (provider, model, apiKeyEnv). The shared resolver called `validateRuntimeConfig(configResult)` on the raw config BEFORE merging CLI overrides, which rejected configs missing `baseUrl` for non-built-in providers even when the user passed `--baseUrl` on the CLI. This was a behavior regression: a user with `provider: openrouter` in config but no `baseUrl` in config (passing `--baseUrl` on CLI) would get an error from the resolver that they didn't get before.
- **Why it's wrong**: Characterization tests for a refactoring must prove behavior equivalence between the original code and the extracted shared logic, not just prove the shared logic works in isolation. When call-site-specific options (like `configOptional`) alter the behavior, the tests must cover the behavior difference. Testing only the shared logic's happy path leaves behavior regressions undetected.
- **Correct approach**: When `configOptional=true` (diagnose.ts's behavior), skip `validateRuntimeConfig` entirely and always do the manual missing-field check on merged values — matching the original diagnose.ts behavior. The `configOptional` flag signals "be lenient like diagnose.ts", so validation should match diagnose.ts's original leniency.
- **How to prevent**: For each call-site-specific option in a shared resolver, add a characterization test that verifies the shared logic matches the original call-site behavior when that option is set. Specifically: (1) list all call-site-specific options, (2) for each option, document the original call-site behavior, (3) add a test that verifies the shared logic reproduces that behavior. The test must assert behavior equivalence, not just "the shared logic doesn't crash."
- **Source**: PRI-431 / PR #975
- **Date**: 2026-06-19
- **Recurrence**: None

---

**[ERR-074]** | Inner try/catch creates exit tunnel — early returns bypass outer catch cleanup, leaking resources

- 2026-08-25 update Phase 2a quality review (no Linear issue): target/ABI/dependency checks ran after gateway, backup, and copies. Fixed by preflighting identity, manifest digests, dependencies, and native loads before every side effect; tests assert no gateway/rm/cp/rename. Prevention: place refusal guards above the first production mutation.

- **What happened**: In `doApplyUpdate()` (packages/pd-console/src/server/routes/update.ts, PR #977), an inner `try/catch` was added around the download step (step 3) to clean up `tempDir` on download failure. However, the outer `try` block had early `return` statements for invalid registry data/version/tarball (steps 1) that occurred AFTER backup creation (step 2) but BEFORE the file-copy stage (step 4). These early returns bypassed the outer `catch` block's backup cleanup logic (gated by `!appliedChanges`), leaving orphaned `.pd-backup-*` directories on disk.
- **Why it's wrong**: In JavaScript, early `return` statements skip the `catch` block entirely — `catch` only runs for thrown exceptions. When a function has a stage-dependent cleanup strategy (`appliedChanges` flag) with cleanup only in `catch`, any early return after resource creation but before the stage flag is set leaks those resources silently. The inner `try/catch` created a "tunnel" where only thrown errors reached the outer catch, not early returns.
- **Correct approach**: Remove the inner `try/catch` around the download step. Let all download failures propagate to the outer `catch`, which already handles both `tempDir` and backup cleanup uniformly via the `appliedChanges` flag. The outer catch's `if (fs.existsSync(tempDir))` guard makes tempDir cleanup safe regardless of whether it was created.
- **How to prevent**: When adding error handling (inner `try/catch`) in a multi-step function with stage-dependent cleanup, audit ALL exit paths (early returns, not just thrown errors) to verify they reach the appropriate cleanup. If cleanup is only in `catch`, early returns will bypass it. Prefer a single `catch` with stage flags over nested `try/catch` blocks for resource cleanup. If inner `try/catch` is needed for specific cleanup, ensure the outer `catch` still covers early returns — or use `try/finally` to guarantee cleanup regardless of exit path.
- **Regression guard**: Static check: grep for functions with both (a) inner `try/catch` blocks and (b) early `return` statements in the outer `try` block. Verify each early return reaches appropriate cleanup.
- **Related ERRs**: ERR-071 (async cleanup not awaited in finally — resource leaks), ERR-022 (process.exit without return allows fallthrough)
- **Source**: PR #977 (self-review during pr-review)
- **Date**: 2026-06-19
- **Recurrence**: None


---

**[ERR-075]** | Hardcoded aria-label bypasses i18n — screen readers read in wrong language for non-English UI

- **What happened**: In `app-sidebar.tsx` (PR #979), the assistant added `aria-label={`${pendingCount} pending approvals`}` and `aria-label={`${degradedCount} degraded signals`}` as hardcoded English strings. The file already imported `useTranslation` and used `t()` for visible text (e.g., `t(item.labelKey)`), but the assistant failed to apply the same i18n convention to the new accessibility attributes.
- **Why it is wrong**: In a bilingual (zh-CN/en) application, all user-facing strings — including accessibility attributes like `aria-label`, `title`, and `placeholder` — must go through the i18n translation function. Hardcoding English strings causes screen readers to read in English while the visual UI displays in Chinese, creating a mixed-language accessibility barrier for non-English users.
- **Generalized failure mode**: When adding any user-facing string (visible text, aria-label, title, placeholder) in a component that already uses i18n, assistants must use `t()` for the new string, otherwise assistive technologies will read in the wrong language.
- **Correct approach**: Use `t("components.sidebar.pendingApprovalsAria", { count: pendingCount })` and `t("components.sidebar.degradedSignalsAria", { count: degradedCount })`, with corresponding keys added to both `en.json` and `zh-CN.json`.
- **How to prevent**: When adding any string attribute (aria-label, title, placeholder, alt) to a JSX element in a file that imports `useTranslation`/`t()`, verify the new string uses `t()` with a translation key. Grep for `aria-label={` and `aria-label="` in i18n-enabled components to find hardcoded strings.
- **Regression guard**: Static check: grep for `aria-label=\{?\` or `aria-label="` in `.tsx` files under `packages/pd-console/src/ui/` that also import `useTranslation`. Any match that does not use `t(...)` is a finding.
- **Related ERRs**: None
- **Source**: PR #979 (CodeRabbit review)
- **Date**: 2026-06-20
- **Recurrence**: Yes — same EP-11 pattern (i18n-enabled component gets hardcoded source-language strings for new UI elements).
  - 2026-07-01 PR #1143: Three signal-keywords components (KeywordListSection, PendingTermsSection, KeywordEditDialog) hardcoded PHASE2_TOOLTIP, table headers (Term/Category/Precision/Weight/Reason/Actions), category labels, and "X terms" count in English while the component already imported useTranslation — 15 i18n keys added in fix commit b566e886
  - 2026-08-20 PRI-553: newly added zh-CN governance strings used bare `Owner` and `Console`, creating mixed-language visible copy. The existing CR10 locale audit caught all five values; fixed with `拥有者` and `控制台`, and the full Console suite verifies recurrence.
  - 2026-08-20 PRI-553 final review: collector degradation codes (`metadata_malformed`, `timestamp_invalid`, `source_unavailable`) and the new `verdict_missing` attention reason had no locale entries, so visible degraded paths fell back to raw machine identifiers. Added both-locale keys and registry coverage assertions.
  - 2026-08-21 RuleCode Owner Live Decision self-review: the first Console implementation hardcoded Chinese and English labels, action text, toasts, and placeholder copy inside an existing `useTranslation` page. Replaced every new string with paired `en.json` / `zh-CN.json` keys before handoff.
  - 2026-08-22 PRI-558 / PR #1377: six newly added zh-CN timeline strings used bare `Owner`/`Agent` (one value was entirely English: `Owner Approved`), failing the CR10 locale governance gate and redding `Test pd-console` on CI. Fixed with 拥有者/智能体 in aa6a881b. Same prevention rule, new flavor: keys WERE added to both locales (parity held) but the zh values violated the locale term policy — run `cr10-i18n-governance.test.ts` before pushing any i18n change.

---

**[ERR-076]** | Host-realm type narrowing (`isPlainObject`, `as never`) rejects or bypasses cross-realm VM objects — auto_correct silently broken

- **What happened**: In `correction-proposal.ts` (PRI-437), `isPlainObject()` used `Object.getPrototypeOf(value) === Object.prototype` to validate correction proposals from VM-executed RuleCode. Objects created inside `vm.createContext(Object.create(null))` have prototypes from the VM realm, not the host realm, so `isPlainObject` returned `false` and `validateCorrectionProposal` rejected all valid `auto_correct` proposals with "proposal must be a plain object". This made the entire `auto_correct` decision path silently non-functional in production. Additionally, `_recordUnhealthy()` in `rule-host.ts` used `this.logger as never` to bypass a type mismatch between `RuleHostLogger` (only `warn`) and `PluginLogger` (has `error`, `info`, `warn`), which would cause a `TypeError` if `EventLog` called `this.logger.error()`.
- **Why it is wrong**: `node:vm` creates a separate V8 realm. Objects created inside the VM context have `[[Prototype]]` pointing to the VM's `Object.prototype`, not the host's. `Object.getPrototypeOf() === Object.prototype` is a host-realm assumption that fails for cross-realm objects. Using `as never` to bypass type incompatibility hides the real issue (interface mismatch) and creates a latent runtime crash risk.
- **Generalized failure mode**: When validating objects created inside `node:vm` contexts, type narrowing that checks `Object.getPrototypeOf()` against host-realm prototypes will reject all valid VM-created objects. When interfaces don't match, using `as never` or `as any` to bypass the type error creates a latent crash risk instead of fixing the interface.
- **Correct approach**: Use `isRecordLike` (typeof object + non-null + non-array) without prototype checks for VM-crossing validation. Add explicit `Object.hasOwn()` checks for prototype pollution keys (`__proto__`, `constructor`, `prototype`). When passing a logger with a narrower interface, either pass `undefined` (if the target accepts optional logger) or create an adapter that maps the available methods.
- **How to prevent**: (1) Any validator that runs on VM output must NOT use `Object.getPrototypeOf()` or `instanceof` against host-realm types. Use structural checks (`typeof`, `Object.hasOwn()`, `Array.isArray()`) instead. (2) Never use `as never` or `as any` to bypass type mismatches — fix the interface or pass `undefined`. (3) Test validators with objects created inside `vm.createContext()` to verify cross-realm compatibility.
- **Regression guard**: `rule-host-autocorrect-vm.test.ts` — creates a valid auto_correct proposal inside VM context and verifies it is accepted by the validator. `rule-host-adversarial-output.test.ts` — verifies prototype pollution is rejected.
- **Related ERRs**: ERR-001 (as cast on untrusted), ERR-013 (Object.hasOwn for untrusted keys), ERR-024 (validator not wired into production)
- **Source**: PRI-437 / PR #986 (adversarial self-review)
- **Date**: 2026-06-20
- **Recurrence**: None

---

**[ERR-077]** | API migration silently drops input parameters — characterization tests don't verify parameter parity

- **What happened**: When migrating `gate-block-helper.ts` from Gate A (`evaluatePainDiagnosticGate`) to Gate B (`evaluateEvidenceTriage` + `evaluateTriggerController`) in PRI-454 Step 4a, the assistant passed only `isUnsafeHighConfidence` to `evaluateEvidenceTriage` but omitted `consecutiveErrors` and `isRisky`. Gate A's input included `consecutiveErrors: session?.consecutiveErrors ?? 0`, which drove Rule 3 (consecutiveErrors >= 4 → admit). Gate B's triage call silently dropped this parameter, so non-risky repeated gate blocks (4+ consecutive errors) never triggered diagnosis — Gate B was less sensitive than Gate A.
- **Why it's wrong**: When replacing one API call with another, every input parameter from the old API must have a corresponding parameter in the new API. Silently dropping a parameter changes behavior without any test failure or error signal. The characterization test checked that `evaluateEvidenceTriage` was called but didn't verify which parameters were passed.
- **Generalized failure mode**: When migrating from one API to another, assistants must audit ALL input parameters from the old API and verify each has a corresponding parameter in the new API, otherwise the migration silently drops behavior.
- **Correct approach**: Before completing an API migration, create a parameter audit table: list every input to the old API call, and for each, identify the corresponding parameter in the new API. Any parameter without a corresponding new API input must be explicitly documented as intentionally dropped (with reason) or forwarded. Add a characterization test that asserts the new API receives all forwarded parameters.
- **How to prevent**: For any PR that replaces one function call with another (API migration), add a characterization test that asserts the new function receives all parameters the old function received. The test should grep the source for the new function call and verify each expected parameter name appears in the call arguments.
- **Regression guard**: Static characterization test: for each migration site, assert the new API call includes all parameter names from the old API call. In PRI-454, the test `passes consecutiveErrors and isRisky to evaluateEvidenceTriage in Gate B path` was added as the regression guard.
- **Related ERRs**: ERR-073 (characterization tests don't cover call-site-specific behavior equivalence — same pattern group: migration/refactoring tests must verify behavior parity, not just happy path)
- **Source**: PRI-454 / PR #1043
- **Date**: 2026-06-24
- **Recurrence**: None

---

**[ERR-078]** | PR body self-report labels CI failure "pre-existing on main" without verifying against main — reviewer inherits false regression classification

- **What happened**: During PRI-454 (PR #1043), the assistant's PR body claimed the failing `gate-no-path-write-tool.test.ts` test was "pre-existing on main, unrelated to PRI-454". In reality the failure was introduced by the PR itself: the PR flipped `painEvidenceAdmission`'s default from `enabled:false` to `enabled:true`, which activated the Gate B path in `gate-block-helper.ts`. That path calls `wctx.resolve('PROFILE')`, but the pre-existing test's mock `WorkspaceContext` fixture did not implement `resolve()`, so the block-handling code threw `TypeError: wctx.resolve is not a function`. `gate.ts`'s catch block then degraded to "allow conservatively", silently downgrading the expected block to allow and failing the assertion. On `main`, the flag was OFF so the Gate B branch never ran and the test passed.
- **Why it's wrong**: A "pre-existing on main" claim in a PR body is a load-bearing assertion that downstream reviewers and merge-gate logic rely on. When it is false, a real regression ships with a false exoneration attached. The reviewer cannot distinguish "author verified this on main" from "author guessed" without re-running the verification themselves — which inverts the whole point of the self-report. The root cause is asserting a CI failure's provenance without doing the diff/reproduce step that would have proven it.
- **Generalized failure mode**: When an assistant classifies a CI test failure as "pre-existing", "unrelated", or "flaky" in a PR body, it must verify the claim by (a) confirming the failing test file is NOT in the PR diff, AND (b) reproducing the failure on the base branch (or proving the changed files cannot reach the failing code path) — otherwise the classification is an unverified guess that misleads reviewers.
- **Correct approach**: Before writing "pre-existing on main" in a PR body: (1) `gh pr diff <PR> --name-only` and confirm the failing test file is absent; (2) reproduce the failure on the base branch (`git fetch origin main && git worktree add <path> origin/main && npx vitest run <failing-test>`), or prove by diff that the PR's changed files cannot execute the failing code path; (3) if neither holds, the failure is a PR-introduced regression — fix it instead of labeling it pre-existing. In this incident the flag-flip changed the default execution path of `gate-block-helper.ts`, which is reachable from the failing test — so step (2) would have immediately shown the test passing on main.
- **How to prevent**: Treat any "pre-existing / unrelated / flaky" label in a PR body or self-review as a finding that must be backed by evidence (a base-branch reproduction run, or a proven-unreachable diff), not a conclusion. If a PR flips a feature flag default ON/OFF, assume every test that mocks the gated module's dependencies is potentially affected and re-run the full package test suite before asserting any failure is pre-existing. Add the base-branch reproduction to the PR body as evidence ("verified failing on `origin/main` via `<command>`").
- **Regression guard**: Reviewer checklist — for every "pre-existing" claim in a PR body, run the named failing test against the PR's merge-base; if it passes there, the claim is false and the finding is a PR-introduced regression. Static target: when a PR changes any value in `DEFAULT_FEATURE_FLAGS` (or any `enabled:` default), the self-review must explicitly enumerate which tests mock the gated code paths and confirm they still pass.
- **Related ERRs**: ERR-066 (self-review marked "no real issues" without running the failure path — same pattern group: self-reports must be backed by execution evidence, not assertion), ERR-012 (stale-main rollback), ERR-052 (PR cross-contamination)
- **Source**: PRI-454 / PR #1043
- **Date**: 2026-06-24
- **Recurrence**: None

---

**[ERR-079]** | Concurrency-primitive hardening gaps (age-based lock eviction, busy-spin retry) silently re-open the data-loss class the primitive was added to prevent

- **What happened**: PRI-459 hoisted a cross-process file lock into core to eliminate dual-writer lost updates on `principle_training_state.json`. The initial implementation had two hardening gaps that defeated the lock's own purpose:
  1. **Age-based eviction of a live holder** — `cleanupStaleLock` reclaimed a lock when `isStale || isDead`. Because `lockStaleMs` defaulted to 10s, any write that took longer than 10s would have its lock stolen by a second writer, silently re-introducing the exact lost-update class the PR existed to close. The age signal was treated as an eviction authority when only PID liveness is a safe authority.
  2. **Busy-spin retry sleep** — `sleepSync` polled `Date.now()` in a `while` loop for the entire backoff window (up to 500ms × 50 retries ≈ 25s of pinned CPU under contention). The lock's contention path amplified into a self-inflicted availability/CPU regression.
- **Why it's wrong**: A concurrency primitive whose own implementation re-opens the failure class it guards is worse than no primitive — it provides false confidence. The two gaps share one root cause: writing the primitive against the *happy-path* shape (lock acquired on first try, quick writes) without hardening the *contention/failure* shape (long writes exceeding the stale threshold, CPU cost of repeated retry). This is the concurrency analogue of ERR-069 P2 (the degradation path skips the validation the happy path enforces): the failure path of the primitive was written as an afterthought.
- **Generalized failure mode**: When a concurrency primitive (lock, mutex, retry loop, CAS) is added to close a specific data-loss/race class, its eviction/timeout/backoff logic must be hardened so it cannot re-open that same class under contention or slow-path execution. File age is never a safe lock-eviction authority; only holder liveness is.
- **Correct approach**: (1) `cleanupStaleLock` must reclaim a lock ONLY when the holder PID is dead/unknown — never on age alone. `staleMs` may be kept on the signature for back-compat but must not be the sole eviction signal. (2) `sleepSync` must park the thread (`Atomics.wait` on a `SharedArrayBuffer`) instead of busy-polling, so retry contention does not burn CPU. (3) The lock primitive must be exportable so tests can drive it with a tight retry budget (production mutators use generous defaults).
- **How to prevent**: During PR review of any new lock/mutex/retry primitive: (a) ask "what happens if the holder stays alive longer than the stale/timeout threshold?" — if the answer is "the lock is stolen", the eviction logic is wrong; (b) ask "what happens under N concurrent contenders?" — if the retry loop busy-spins, replace it with a blocking wait; (c) ensure the primitive is unit-testable with a tight retry budget so a real contention + fail-loud regression test exists (not just a sequential "no lost update" test that passes with no lock at all).
- **Regression guard**: `tests/principle-tree-ledger.lock.test.ts` — "a second writer fails LOUD while the lock is held by another owner" (live PID, tight retries, expects `LockAcquisitionError`) and "a live PID whose lock age exceeds lockStaleMs is NOT reclaimed as stale" (backdated mtime + live PID, still throws).
- **Related ERRs**: ERR-069 P2 (degradation path written as afterthought skips the happy-path's rigor — same pattern group applied to concurrency), ERR-001 (`as`-bypass on the lock's caught-unknown error, fixed in the same review), ERR-009 (silent overwrite sibling in the same PR)
- **Source**: PRI-459 / PR #1045
- **Date**: 2026-06-25
- **Recurrence**: 2026-07-16 PR #1230 / PRI-516: retry deduplication claimed a run before turn-index resolution and synchronous signal collection completed, so a trajectory or detector failure caused the next retry to be skipped. Fixed by claiming only after successful detection and adding a fail -> retry success -> duplicate skip regression test.
  - 2026-08-13 PRI-523: config migration first lacked atomic locking, then removed unowned stale-looking locks. It now atomically replaces under an owned lock and fails loud after bounded no-unlink contention.
  - 2026-08-13 PRI-523 C1.3 self-review and quality-review correction: the first shared PostToolUse kernel checked duplicates only when an event had already produced a `pain_events` row, so repeated successful/control host events wrote duplicate `tool_calls` evidence. Its follow-up digest still allowed the supplied host event ID to replace payload/outcome identity. Fixed by making canonical tool evidence the all-outcome dedup claim and binding canonical workspace/source/session/tool/sanitized payload/outcome plus supplied ID into the digest; same ID with different payload/outcome remains distinct while exact cross-runtime retries deduplicate.
  - 2026-08-26 PR #1419 review round 4 (lock-coverage flavor): per-workspace export locks correctly serialized same-workspace exports, but the control state was one SHARED file written WHOLE from a pre-flight read — two different workspaces completing concurrently overwrote each other's entries (lost update), and a concurrent reset could be overwritten by the stale write. The primitive guarded the wrong critical section: only the ms-scale read→merge→write needed a machine-scope state-update lock (fresh read + identity guard inside); the network flight stays concurrent. Tests: overlapping two-workspace flights asserting BOTH entries survive + no identity resurrection; overlap asserted, not assumed.

---

**[ERR-080]** | Control applied to the RAW input form instead of the CANONICAL/transformed form — size bound applied pre-escape (escaped output exceeds budget), or path-prefix check applied to the raw param path instead of normalizedPath (traversal bypasses the match)

- **What happened**: In `buildIntentFrictionBlock()` (`packages/principles-core/src/runtime-v2/intent/intent-friction-block.ts`), the `INTENT_INJECT_MAX_CHARS` bound (4000 chars) was applied to the RAW intent content via `slice()`, and then `escapeXml()` was called on the already-bounded slice. Because XML entity expansion is length-increasing (`&` → `&amp;` = 5x, `<` → `&lt;` = 4x), the escaped output could exceed the budget. A 4000-char raw string of `&` would be bounded to 4000 chars, then escaped to ~20000 chars of `&amp;` — 5x over the budget. The prompt hook's 9000-char `truncateInjectionToBudget` size guard provided a hard upper bound, but the `INTENT_INJECT_MAX_CHARS` contract was silently violated.
- **Why it's wrong**: The bound exists to limit how much untrusted INTENT.md content is injected into the prompt (a prompt-budget / trust-boundary control). Applying the bound to the pre-transformation input defeats the bound because a length-increasing transformation happens after the check. This is the same class as ERR-056 (redaction/truncation applied at the wrong point in the pipeline) and ERR-024 (security validator exists but is not wired into the real enforcement path) — the control exists but is applied at the wrong layer, so it does not protect the actual emitted output.
- **Generalized failure mode**: When bounding text that undergoes a length-increasing transformation (XML/HTML escaping, URL percent-encoding, JSON stringification with escaping, base64 encoding), assistants must bound the POST-transformation output, not the pre-transformation input. Otherwise the transformed output can exceed the budget by the expansion factor (up to 5x for XML escaping of `&`, 3x for URL encoding of some chars). The same root cause applies to SEMANTIC transformations that change which value a control should match, not just length-increasing ones: a path-prefix or path-segment check applied to the RAW tool param (`input.action.paramsSummary.path`) instead of the CANONICAL normalized path (`input.action.normalizedPath`) is bypassable via traversal — `/project/../../etc/passwd` does not match `/etc` as a raw prefix, but normalizes to `/etc/passwd`. General rule: apply the control to the canonical/transformed form, not the raw form.
- **Correct approach**: Escape FIRST, then bound the escaped content to `INTENT_INJECT_MAX_CHARS` (minus the truncation marker length). Append the truncation marker after the budget cut. The marker is short (~60 chars), contains no XML special chars, and the prompt hook's 9000-char size guard provides a hard upper bound on the total block.
- **How to prevent**: During PR review of any size-bounding logic on content that is subsequently transformed (escaped, encoded, stringified): check that the bound is applied to the FINAL output form, not an intermediate form. Ask: "does any transformation between the bound check and the output expand the content?" If yes, move the bound after the transformation. Add a regression test using expandable chars (e.g., 5000 `&` chars) to verify the escaped output respects the budget. For path-based rule logic (PD RuleCode exemplars or production rules that gate on file paths): check that path matching reads `input.action.normalizedPath` (canonical) FIRST, falling back to `input.action.paramsSummary.path` only when normalizedPath is null — a traversal-shaped param path (`/project/../../etc/passwd`) must still match when its normalized form (`/etc/passwd`) does. Review trigger: any rule string containing `paramsSummary.path` without `normalizedPath ?? …` precedence.
- **Regression guard**: `packages/principles-core/src/runtime-v2/intent/__tests__/intent-friction-block.test.ts` — "bounds the ESCAPED content to INTENT_INJECT_MAX_CHARS even with expandable chars" (5000 `&` chars → escaped output must be ≤ `INTENT_INJECT_MAX_CHARS + 2`, must contain truncation marker, must not contain raw unescaped `&`).
- **Related ERRs**: ERR-056 (security transformation applied at wrong point in pipeline), ERR-024 (security validator not wired into real enforcement path), ERR-014 (bounding asymmetry across code paths), ERR-017 (unsafe serialization on unknown values), ERR-081 (same PR, TOCTOU in stat-then-read file size cap).
- **Source**: PRI-467 / PR #1059 (CodeRabbit review)
- **Date**: 2026-06-25
- **Recurrence**: 2026-08-13 PRI-523 C1.2 quality review: RuleCode evaluation ran in a bounded child, but compilation still executed untrusted top-level source in the parent; the timeout applied per rule, so N active rules created an N×timeout gate; active rows/source/output/warnings were uncapped. The control protected one evaluation phase, not the canonical full untrusted workload. Fixed by moving compilation+evaluation into one 32 MiB child batch with one total deadline, bounded SQL/source/output/warnings, and parent-only validation of bounded child JSON. Narrow re-review found the same root cause at the storage/lifecycle boundary: the first SQL query still materialized full artifact JSON before checking its envelope size, and provider deadline timers survived early settlement. Fixed with a metadata-only SQLite byte-length preflight, a bounded second fetch with defensive actual-byte verification, and timer cleanup in `finally`. Regression covers top-level loops, syntax errors, memory/output/source exhaustion, active-rule overflow, multi-rule elapsed time, a small RuleCode inside oversized irrelevant JSON, and early provider resolve/reject timer cleanup. 2026-08-13 PRI-523 C1.1 review: the shared active-principle kernel budgeted compact pre-render lines, then XML-escaped and wrapped them as directives; expandable content could therefore make the final emitted block exceed the 2,000-character contract. Fixed by selecting only whole directives whose fully rendered escaped block fits, with regression coverage for 10 expandable principles, complete tags, truncation metadata, and exact fit. 2026-08-12 PR #1302 (CodeRabbit review, semantic-canonicalization flavor): the demo RuleCode exemplar in `story-a-demo.ts` / `proven-channel-baseline.ts` used `String(input.action.paramsSummary.path ?? input.action.normalizedPath ?? "")` — raw path first, so `/project/../../etc/passwd` bypassed the `/etc` block (demo activations run in the production RuleHost shadow, so this was a real, if low-impact, correctness gap). Fixed by swapping to `normalizedPath ?? paramsSummary.path`; regression test in `story-a-demo.test.ts` ("blocks via normalizedPath even when paramsSummary.path is a traversal").

---

**[ERR-081]** | TOCTOU in stat-then-read file size cap — file growth between statSync and readFileSync bypasses oversized check

- **What happened**: `safeReadIntentDoc()` in `packages/openclaw-plugin/src/core/intent-doc-reader.ts` enforced the `INTENT_MAX_BYTES` (32KB) size cap by checking `fs.statSync(filePath).size` FIRST, then calling `fs.readFileSync(filePath, 'utf8')`. If the INTENT.md file was concurrently rewritten with larger content between the `statSync()` and `readFileSync()` calls, the oversized content would bypass the stat-based check and enter the parse/hash/cache path as `ok: true`, violating the 32KB size cap contract (SPEC §12).
- **Why it's wrong**: A stat-then-read pattern has a Time-Of-Check-to-Time-Of-Use (TOCTOU) window. The size check is performed on file metadata (stat.size), but the actual content is read later. For a size cap to be enforceable, it must be verified on the ACTUAL bytes read, not on metadata that can change between the check and the use. This is the same class as ERR-080 (bound applied to the wrong input — metadata vs. actual content) and ERR-024 (validator exists but can be bypassed).
- **Generalized failure mode**: When enforcing a size cap on file content, a `statSync().size` check followed by `readFileSync()` has a TOCTOU window. The file can grow between the two calls, bypassing the cap. The cap must be re-verified on the actual bytes read using `Buffer.byteLength(raw, encoding)`.
- **Correct approach**: After `fs.readFileSync(filePath, 'utf8')`, re-check `Buffer.byteLength(raw, 'utf8')` against `INTENT_MAX_BYTES`. If the actual bytes exceed the cap, follow the same oversized return path (clear cache, return `reason: 'oversized'`, include actual byte count in `nextAction`).
- **How to prevent**: For any file-read path that enforces a size cap via `statSync().size` before `readFileSync()`: add a post-read `Buffer.byteLength(raw, 'utf8')` re-check. Review trigger: any PR that has `statSync` followed by `readFileSync` with a size check on `stat.size` but no post-read byte verification.
- **Regression guard**: `packages/openclaw-plugin/tests/core/intent-doc-reader.test.ts` — oversized tests verify the `oversized` reason is returned for both stat-based and post-read byte-based paths.
- **Related ERRs**: ERR-080 (same PR — bound applied to wrong input), ERR-024 (validator bypassed by TOCTOU window)
- **Source**: PRI-467 / PR #1059
- **Date**: 2026-06-25
- **Recurrence**: None

---

**[ERR-082]** | `Object.hasOwn` key-presence check bypassed by present-but-undefined value — wrong branch executes, hallucinated field passes through unstripped

- **What happened**: In `DiagRouterRunner.postFetchTransform()` (Stage C of the split Diagnostician), the code branched on `Object.hasOwn(context.rootCauseOutput, 'intentTension')` to decide whether to passthrough Stage A's intentTension or strip an LLM-hallucinated one. `Object.hasOwn` returns `true` even when the value is `undefined`. So when Stage A's output had the property present but `undefined`, the passthrough branch was entered, the inner `if (value !== undefined)` was false, and execution fell through WITHOUT entering the strip branch — leaving the LLM-hallucinated intentTension on the output unstripped. SPEC §18.2 requires Stage C to be additive-only and never generate intentTension when Stage A didn't produce one.
- **Why it's wrong**: `Object.hasOwn(obj, key)` answers "does this key exist on the object", not "did the upstream produce a usable value". When the semantic question is the latter, key-presence is the wrong check: a present-but-undefined value satisfies `hasOwn` but is not a usable value. This creates a logic gap between two branches that both assume the check means "value is usable", allowing invalid data to silently pass through. This is the same trust-boundary family as ERR-013 (wrong key-existence primitive) and ERR-009 (silent skip instead of fail-loud), but the prevention rule is materially different: it's about distinguishing key-presence from value-usability, not about `in` vs `hasOwn` or `if(valid){}` vs `if(!valid){}`.
- **Generalized failure mode**: When a transform/validator branches on "did the upstream produce a usable value", checking key presence (`Object.hasOwn`) instead of value presence (`!== undefined`) creates a logic gap. Present-but-undefined values satisfy the key-presence check but are not usable, causing the wrong branch to execute and invalid/hallucinated data to pass through unstripped. This is especially dangerous in additive-passthrough designs (Stage C must pass through Stage A's value OR strip the LLM's value — never generate) where a logic gap means neither branch runs.
- **Correct approach**: When the question is "is the value usable", check the value directly: `const v = context.rootCauseOutput.intentTension; if (v !== undefined) { passthrough } else if (output.intentTension !== undefined) { strip }`. This collapses absent and present-but-undefined into the same "no usable value" case, which is the correct semantic for additive passthrough.
- **How to prevent**: When writing a branch that decides "did upstream produce this field", ask: am I checking key-presence or value-usability? If the answer should be value-usability, use `!== undefined` (or `!= null`), NOT `Object.hasOwn`. Review trigger: any `Object.hasOwn(x, k)` guard immediately followed by a `!== undefined` inner check — the outer `hasOwn` is redundant and creates a fall-through gap; simplify to a single value check.
- **Regression guard**: `packages/principles-core/src/runtime-v2/internalization/__tests__/diag-router-intent-tension.test.ts` test case 3 ("Stage A has NO intentTension + LLM hallucinated one → Stage C strips it") catches this. The test uses `makeRootCauseOutput()` (no intentTension key at all) which covers the absent case; a present-but-undefined fixture would also catch the gap but is lower priority since schema-validated Stage A output cannot have `intentTension: undefined` (the TypeBox schema makes it `Optional(IntentTensionSchema)` which omits the key when absent).
- **Related ERRs**: ERR-013 (`in` vs `Object.hasOwn` — wrong key-existence primitive), ERR-009 (silent skip instead of fail-loud on missing required fields), ERR-001 (as cast bypasses validation)
- **Source**: PRI-468 / PR #1063
- **Date**: 2026-06-26
- **Recurrence**: None

---

**[ERR-083]** | Changing a shared contract (store guard, type union, service method, default config value, package identity) without auditing all same-package AND cross-package consumers (callers, validators, tests, mocks, CI workflows) — downstream packages break

- 2026-08-25 update Phase 2a quality review (no Linear issue): self-contained builds rewrote source versions from live npm and accepted labels unlike the native build host. Fixed by preserving source identity, rejecting target mismatches, and consuming in-asset identity. Prevention: immutable identity comes from pinned metadata; native outputs use the executed toolchain target.

- **What happened**: In PRI-473, FK validation guards (throw if parent records missing) were added to three `principles-core` store methods (`createArtifact`, `enqueue`, `recordActivation`). Same-package tests seeded parent records, but cross-package callers were NOT audited — `pd-cli`, `pd-console`, and `openclaw-plugin` tests called these methods without seeding parents, causing 5 CI failures across 4 packages. In PRI-491 (PR #1137), two contract changes were not propagated to all consumers: (1) the `ActivationRecord.status` type union changed from `'active' | 'inactive'` to `'active' | 'deactivated' | 'suspended_by_flag'`, but the UI-side `VALID_ACTIVATION_STATUSES` set, the integration test assertion, and the UI test were not updated; (2) a new `recordRuleHostSkipped` method was added to `EventLogService`, but the mock in `gate-rule-context-v2.vm-e2e.test.ts` was not updated, causing a `TypeError: eventLog.recordRuleHostSkipped is not a function` and a stale assertion expecting the old skip-message format. In PRI-501 (PR #1162), the shared default runtime profile in `pd-config-defaults.ts` was changed from `openclaw.default` to `pd.default` (pi-ai placeholder), but `resolve-runtime-config-from-pd-config.test.ts` AC3/AC5 tests still asserted null config resolves to `openclaw-cli` success — principles-core CI failed because the new placeholder returns `needs_setup` error.
- **Why it's wrong**: Changing a shared contract (adding a `throw` guard, changing a type union, adding a service method, **changing a shared default value, or changing the package identity (name field)**) tightens or shifts the contract: every existing consumer — callers, validators, tests, mocks, AND CI workflow `--workspace=<name>` references — must satisfy the new shape. Same-package tests don't prove cross-package paths still work. EP-02 family — isolated tests pass while real paths break.
- **Generalized failure mode**: When changing ANY shared contract (store guard, type union, service method signature, new service method, shared default config value, **or package identity (name field)**) that crosses package boundaries, assistants must audit ALL cross-package consumers (callers, validators, tests, mocks, AND CI workflow references), otherwise downstream packages break at runtime/CI.
- **Correct approach**: Before changing a shared contract: (1) grep all cross-package call sites AND consumers (validators, tests, mocks); (2) verify each consumer satisfies the new shape; (3) run cross-package tests. For type-union changes: grep for `Set<string>` validators and `as` narrowing in UI layers. For new service methods: grep all `vi.mock` of that service and add the new method. **For shared default config value changes: grep for tests that assert the old default (e.g., `resolve-runtime-config-from-pd-config.test.ts` AC3/AC5) and update their expectations.**
- **How to prevent**: When changing a contract consumed by other packages, the PR must grep all same-package AND cross-package consumers (callers, validators, tests, mocks, CI workflows), confirm each satisfies the new contract, and run tests in each consuming package. Review triggers: (a) new `throw` in `sqlite-*-store.ts`; (b) type-union change on a shared interface — grep `Set<string>` validators and `as` narrowing; (c) new method on a service that has `vi.mock` in tests — grep `vi.mock('../../src/core/<service>.js')` and update each mock; (d) shared default value or constant change in `pd-config-defaults.ts` (or any `*-defaults.ts`), OR in any module that exports a shared constant array/object (e.g., `PRODUCTION_WORKSPACE_PATHS` in `production-workspace-guard.ts`) — grep for tests that hardcode the old value (e.g., `'D:\\.openclaw\\workspace'`) and replace with a constant mirroring the production default; **(e) package identity (name field) change in any `package.json` — grep `--workspace=<old-name>` in `.github/workflows/*.yml`, root `package.json` scripts, and all package.json scripts, and update every reference. CI workspace resolution uses the `name` field, not the directory name.** **(f) shared test fixture / environment assumption change in a test file (beforeEach setup, HOME/path redirection, mock wiring) — audit EVERY test in that file for the same dependency: in-process handler tests read env/filesystem DIRECTLY while subprocess tests inherit the injected env; then re-verify under the CLEAN environment condition (e.g., `HOME=<bogus>` locally), because a dev machine's real artifacts (a real `~/.openclaw` install) mask the failure that CI will hit.**
- **Regression guard**: Cross-package CI tests now seed parent records in `pd-cli`, `pd-console`, and `openclaw-plugin`. Tests fail if FK guard is re-added without caller updates. For PRI-491: `ActivationValidators.ts` `VALID_ACTIVATION_STATUSES` set includes the new enum values; vm-e2e mock includes `recordRuleHostSkipped`. For PRI-501: AC3/AC5 now assert `needs_setup` error for null config.
- **Related ERRs**: ERR-070, ERR-077, EP-02
- **Source**: PRI-473 / PR #1066; PRI-491 / PR #1137; PRI-501 / PR #1162; PR #1182
- **Date**: 2026-06-26
- **Recurrence**: Yes
  - 2026-08-26 PRI-595~603 / PR #1419 (build-order + test-env recurrence): host-runtime gained a new runtime dep on `@principles/install-layout` but the root build chain and several CI jobs still built host-runtime before install-layout — clean CI checkouts failed with TS2307 while local runs were masked by leftover `dist` (same class as the 2026-08-24 PRI-583 recurrence). Separately, the new pd-cli telemetry test isolated the machine-scope consent store with `USERPROFILE` only, a no-op on Linux CI (`os.homedir()` reads `HOME`) — passed on Windows, failed on Linux (same class as the 2026-08-15 PRI-526 recurrence). Fixed by dependency-first build ordering in every CI chain and setting both `HOME` and `USERPROFILE` in the test.
  - 2026-08-24 PRI-583 / PR #1406 (install-layout/delivery flavor): a new shared `@principles/install-layout` contract was wired into selected source consumers but not the clean-CI build order, npm publication workflow, Console updater, host-set manifest merge, or host-scoped uninstall lifecycle. Local residual `dist` files masked missing dependency builds. Fixed by auditing every producer/consumer/delivery/cleanup path, adding dependency-first CI/publish wiring, and exercising clean packaged installation plus host-union/uninstall regressions. Related published-artifact aspect: ERR-040.
  - 2026-08-27 PRI-612 / PR #1426 (vi.mock factory variant): a new barrel export (`PD_TASK_STATUSES` on `@principles/core/runtime-v2`) was consumed by an existing pd-cli command whose test file replaces the WHOLE barrel with a bare `vi.mock` factory — the factory lacked the new export, vitest's strict mock threw "No export is defined on the mock", and 19 tests failed on CI. The local pre-push run missed it because a neighboring (wrong) test directory was executed instead of the exact mocking test path. Fixed by spreading `importOriginal` in the factory (pure constants stay authentic, only stateful classes mocked). Prevention trigger (g): when adding ANY new export to a barrel that production importers consume, grep `vi.mock('<barrel>'` across all packages and either add the export to each factory or convert the factory to `importOriginal` spread — and run the mocking tests by their exact path, not a directory neighbor.
  - 2026-08-21 RuleCode Owner Live Decision full-suite review (no Linear issue): the new `rulecode-safety-circuit.ts` correctly belonged to the OpenClaw plugin I/O boundary, but the implementation updated neither duplicated plugin-core anti-growth allowlist. Core and plugin full suites failed even though targeted safety tests passed. Fixed by classifying the file in both architecture guards with the same I/O rationale. Prevention: every new plugin-core file must update and run both `principles-core` architecture regression and `openclaw-plugin` anti-growth tests.
  - 2026-08-26 PRI-595~603 / PR #1419 (build-order + test-env recurrence): host-runtime gained a new runtime dep on `@principles/install-layout` but the root build chain and several CI jobs still built host-runtime before install-layout — clean CI checkouts failed with TS2307 while local runs were masked by leftover `dist` (same class as the 2026-08-24 PRI-583 recurrence). Separately, the new pd-cli telemetry test isolated the machine-scope consent store with `USERPROFILE` only, a no-op on Linux CI (`os.homedir()` reads `HOME`) — passed on Windows, failed on Linux (same class as the 2026-08-15 PRI-526 recurrence). Fixed by dependency-first build ordering in every CI chain and setting both `HOME` and `USERPROFILE` in the test.
  - 2026-08-24 PRI-583 / PR #1406 (install-layout/delivery flavor): a new shared `@principles/install-layout` contract was wired into selected source consumers but not the clean-CI build order, npm publication workflow, Console updater, host-set manifest merge, or host-scoped uninstall lifecycle. Local residual `dist` files masked missing dependency builds. Fixed by auditing every producer/consumer/delivery/cleanup path, adding dependency-first CI/publish wiring, and exercising clean packaged installation plus host-union/uninstall regressions. Related published-artifact aspect: ERR-040.
  - 2026-08-21 RuleCode Owner Live Decision full-suite review (no Linear issue): the new `rulecode-safety-circuit.ts` correctly belonged to the OpenClaw plugin I/O boundary, but the implementation updated neither duplicated plugin-core anti-growth allowlist. Core and plugin full suites failed even though targeted safety tests passed. Fixed by classifying the file in both architecture guards with the same I/O rationale. Prevention: every new plugin-core file must update and run both `principles-core` architecture regression and `openclaw-plugin` anti-growth tests.
  - 2026-08-21×3 RuleCode Owner Live Decision reviews: architecture-guard classification missed for new plugin-core file; empty optional note string broke the shared SQLite read contract; structured identity narrowed to enums. Each fixed with contract round-trip/anti-growth regressions.
  - 2026-08-15 PRI-526: test-file env fixture refactor missed an in-process sibling reading real HOME; fix sets HOME/USERPROFILE in-test and verifies under clean condition.
  - 2026-08-18 PR #1358: environment-sensitive assertion expected one specific error subclass; fix = skipIf on missing precondition or accept failure-class family.
  - 2026-08-13 PRI-523×5: shared kernel wiring omitted host-owned exclusion/enrichment and changed sync→async convention; fixes return host-neutral metadata + preserve exact reasons; audit covers sync/async semantics too.
  - 2026-07-01~04 PR #1137/#1162/#1182/#1183: status enum, default profile name, package rename, and homedir-based path defaults each missed same/cross-package validators and tests pinned to old values.

---

**[ERR-084]** | shell:true in spawn() + immediate process.exit() in signal handlers orphans child processes; GitHub Actions not pinned to SHA

- **What happened**: In `packages/pd-console/scripts/e2e-start.mjs` (PR #1068), `spawn('npx', [...], { shell: true })` launched a tsx server. Signal handlers called `child.kill()` then `process.exit(0)`. On CI, `shell: true` wraps in `/bin/sh`, so `child.kill()` only kills the shell — tsx is orphaned with port 3100 bound. `process.exit(0)` prevents `child.on('exit')` cleanup. Also, `.github/workflows/pd-console-e2e.yml` used `@v4` tags instead of commit SHAs, violating zizmor policy.
- **Why it's wrong**: `shell: true` inserts a shell between parent and command; signals reach the shell, not the subprocess. `process.exit()` in handlers short-circuits `child.on('exit')`. Actions version tags are mutable; SHA pinning prevents supply-chain attacks.
- **Generalized failure mode**: When spawning child processes for test lifecycle, assistants must NOT use `shell: true` with `child.kill()`, must NOT call `process.exit()` in signal handlers, and must pin all GitHub Actions `uses:` to commit SHAs matching existing conventions.
- **Correct approach**: (1) `shell: process.platform === 'win32'`. (2) Let `child.on('exit')` drive parent exit. (3) Pin Actions to commit SHAs.
- **How to prevent**: (1) Remove `shell: true` unless platform-required. (2) Verify signal handlers don't call `process.exit()`. (3) `grep "uses: actions/" .github/workflows/ci.yml` before creating new workflows.
- **Regression guard**: Playwright E2E CI job verifies clean shutdown. zizmor catches unpinned Actions.
- **Related ERRs**: ERR-022, ERR-045, ERR-068
- **Source**: PR #1068
- **Date**: 2026-06-26
- **Recurrence**: None
  - 2026-08-14 PRI-524 (PR #1316 review): the plugin hook wrapper's fail-open path called process.exit(0) immediately after process.stdout.write('{}') — stdout on a pipe is asynchronous, so the exit can drop the very object the fail-open contract promises. Fixed with fs.writeSync(1/2). Rule of thumb: before any process.exit, stdout/stderr writes must be fs.writeSync or the code must return and let the loop drain (process.exitCode assignment).

---

**[ERR-088]** | Test assertion uses non-unique signal that cannot distinguish intended behavior from no-op/fail-soft path

- **What happened**: In PRI-486 Phase 7 E2E tests (PR #1109), two test cases used non-unique assertion signals:
  1. `rule-context-v2.perf.test.ts` empty-history baseline measured timing of `buildProductionRuleContext` without verifying the returned context was `available` — a fail-soft `unavailable` result would also pass the timing assertion.
  2. `gate-rule-context-v2.vm-e2e.test.ts` K3 test asserted `result === undefined` to verify "flag OFF → v2 rule fail-soft allow", but `result === undefined` is also produced when the rule is never loaded from SQLite — the test could not distinguish "rule executed fail-soft" from "rule never loaded".
- **Why it's wrong**: An assertion signal that is produced by multiple code paths cannot prove which path executed. The test passes on the unintended path (fail-soft / never-loaded) without proving the claimed invariant (rule executed and chose to allow). This is the test-side sibling of ERR-009/ERR-010 (production falsy values silently passing validation) — same root cause, opposite side of the contract.
- **Generalized failure mode**: When writing tests that verify behavior via indirect/non-unique signals (return value `undefined`, timing metrics, absence of thrown error, side-effect count of 0), assistants must ensure the asserted signal is uniquely produced by the intended behavior path. If a fail-soft / no-op / never-executed path also produces the same signal, the test cannot distinguish intended behavior from accidental pass.
- **Correct approach**: (1) Perf test: assert `expect(sample.history.status).toBe('available')` before the timing loop to prove the rule actually executed and returned a usable context. (2) K3 test: use a probe rule `V2_RULE_CODE_K3_PROBE` that returns `requireApproval` (not `allow`), then assert `recordRuleHostRequireApproval` was called with `reason: expect.stringContaining('K3 probe')` — this signal is only produced when the rule actually executed and reached the requireApproval branch.
- **How to prevent**: For any test that asserts an indirect signal (undefined return, timing, absence of error, zero count), ask: "What other code path produces this same signal?" If a fail-soft / no-op / never-executed / cached-empty path also produces it, add a positive assertion that uniquely identifies the intended path (status field, side-effect with distinguishing payload, probe rule with unique reason string).
- **Regression guard**: `packages/openclaw-plugin/tests/core/rule-context-v2.perf.test.ts` (status assertion before timing loop); `packages/openclaw-plugin/tests/hooks/gate-rule-context-v2.vm-e2e.test.ts` (K3 probe rule + `recordRuleHostRequireApproval` assertion with `reason` containing 'K3 probe').
- **Related ERRs**: ERR-025 (test proves isolated helper, not real production defense — same EP-09 group), ERR-077 (characterization tests don't verify parameter parity — same EP-09 group), ERR-009/ERR-010 (production-code sibling: falsy values silently passing validation).
- **Source**: PRI-486 / PR #1109 (CodeRabbit review)
- **Date**: 2026-06-29
- **Recurrence**: 2026-08-13 PRI-523 C1.1 spec review: the production OpenClaw BDD seeded a Runtime V2 activation only, then asserted its unique text appeared once. That signal could not exercise or prove the legacy/Runtime V2 overlap branch, so the test stayed green while shared exclusion metadata misreported `all_deduped_against_legacy` as `no_validated_activations`. Fixed by seeding the identical ID/text in the real legacy probation reducer and Runtime V2 SQLite, asserting one combined prompt occurrence, absence of a duplicate Runtime V2 directive, and the persisted exact skip reason/next action. 2026-07-22 PRI-520 / PR #1249 (CodeRabbit review): `SplitDiagnosticianRunner` terminal-state persistence tests asserted only generic substrings (`failed to persist parent task failure`, `Root-cause output was invalid`) without asserting the injected persistence error text (`database write failed`) or the preserved original stage category (`Original stage outcome: output_invalid`). A refactor that dropped the persist error message or the preserved stage outcome would still pass. Fixed by adding assertions for the injected error text and the preserved category string. Lesson: when a fail-loud fix contract is "surface error X AND preserve original outcome Y", the regression test must assert BOTH the surfaced error and the preserved outcome — asserting only the banner substring lets a future refactor silently drop the detail that made the fix meaningful. 2026-07-15 PRI-516 / PR #1230: `makeCtx({ sessionGfi })` accepted and destructured an override it never applied, while tests separately mutated the actual session mock through `setSessionGfi`; fixed by removing the dead override. 2026-07-04 PR #1182: (1) `sqlite-dead-letter-store.markRetried` UPDATE-by-painId is non-unique with single-row seed — fixed via latest-row subquery + multi-row seed; (2) `failed-tasks` `tasks.length===0` signal also produced when paginated past end — fixed via `total===0` + past-end case. (Earlier compressed: 2026-06-30 PR #1131 BDD non-unique stdout/activation/seed signals; 2026-07-01 PR #1146 onboarding source-string tests passed while Windows path broken; 2026-07-02 codex/website-homepage-redesign OG image dimension contract only checked non-empty; 2026-07-03 PR #1170 SEC-BASE-5 `expect(true).toBe(true)` tautology after flag check.)

  - 2026-08-28 PRI-614 / PR #1428 review: the gateway recovery test counted a restart but did not prove it happened after the tar step failed, so an early or unrelated restart produced the same signal. Fixed with strict call-order assertions and a negative-control run that fails when the ordering predicate is inverted.

  - 2026-08-20 PRI-553: governance BDD treated non-empty body text as proof the SPA was ready. That signal was true before the initial `#/focus` redirect settled, so the delayed redirect could overwrite detail navigation; fixed by waiting for the canonical focus URL and then asserting the detail URL.

---

**[ERR-089]** | Fix addresses primary failure path but leaves sibling failure branches with stale state, wrong command path, or CLI contract violation

- **What happened**: In PR #1124 (Bug-O/Q/M/P cascade fix), the assistant fixed 4 bugs across `runtime-activation.ts`, `pain-record.ts`, `ApprovalsConsoleModel.ts`, and `diagnose.ts`. CodeRabbit review found 10 inline issues (4 P1 + 4 P2 + 2 P3) where the fixes introduced new defects:
  1. `pain-record.ts` --json failure path emitted text to stderr instead of structured JSON + missing `return` after `process.exit(1)` (cli-1/cli-2/cli-5).
  2. `runtime-activation.ts` `resolveWorkspaceDir()` called outside `try`, bypassing --json error routing (cli-1).
  3. `runtime-activation.ts` `completeApproval` failure left approval in 'approved' state with no activation — no rollback to 'pending' (cli-5-failure-no-mutation).
  4. `runtime-activation.ts` catch-block rollback-failure branch still used wrong command path `pd runtime activation dispatch` instead of registered `pd activation dispatch` — the !ok branch was fixed but the catch (throw) branch was missed.
  5. `ApprovalsConsoleModel.ts` ledger upgrade used pre-read `existing.artifactId` instead of post-approve `approvalResult.record.artifactId` (data consistency).
  6. `ApprovalsConsoleModel.ts` `upgradeLedgerPrinciple` let read-side exceptions (getArtifactById, missing table) propagate and fail the approval flow after activation was committed (rc-9-no-silent-fallback).
  7. `diagnose.ts` dreamer_seeded/dreamer_seed_failed intake statuses invisible in TTY output and JSON nextAction (observability gap).
  8. Tests only called handler directly, no Commander parser test (cli-7-test-wiring).
- **Why it's wrong**: When fixing a bug that touches a multi-branch failure path (happy / !ok / catch-throw), fixing only the primary branch leaves sibling branches with stale state, wrong command paths, or CLI contract violations. The fix appears complete (primary path works) but reviewers find the sibling branches still broken. This is the fix-side sibling of ERR-074 (inner try/catch exit tunnel bypasses outer cleanup) — same root cause (incomplete branch coverage), opposite side (fix vs. original code).
- **Generalized failure mode**: When fixing a bug in a function with multiple failure branches (happy / !ok / catch-throw / degraded), assistants must audit ALL sibling branches for the same defect, not just the primary failure path that triggered the bug report. Each branch must satisfy the same CLI contract (--json / exit / return / no-mutation) and use the same post-state source of truth.
- **Correct approach**: (1) After fixing the primary branch, grep for sibling branches (other `if (!ok)`, `catch`, `throw` paths) and apply the same fix. (2) For nextAction strings, verify the command path matches the actual Commander registration (grep `program.command` in index.ts). (3) For post-mutation reads, use the result returned by the mutation, not a pre-read value. (4) Wrap read-side lookups in try/catch when they run after an already-committed write. (5) Add a Commander parser test (buildXxxCommand + exitOverride + parseAsync) covering required options.
- **How to prevent**: When fixing a multi-branch failure path, enumerate all branches (happy / !ok / catch / throw / degraded) and verify each one: (a) emits structured JSON on --json, (b) stops execution after exit (return or throw), (c) does not leave stale state (rollback to pending if needed), (d) uses post-mutation source of truth, (e) has the correct command path in nextAction. Add a regression test per branch.
- **Regression guard**: `packages/pd-cli/tests/commands/runtime-activation.test.ts` AP-06/AP-06b/AP-06c (rollback success/throw/failure) + AP-07 (Commander parser wiring); `packages/pd-cli/tests/commands/pain-record.test.ts` RL-04 (--json failure path); `packages/pd-console/tests/integration/governance-approve-activation.test.ts` (ledger upgrade + warning on missing artifact).
- **Related ERRs**: ERR-022 (process.exit without return — cli-2 sibling), ERR-029 (CLI unknown input silently dropped — cli-1 sibling), ERR-074 (inner try/catch exit tunnel — same "incomplete branch coverage" root cause), ERR-033 (operator failure path returns success — cli-5 sibling).
- **Source**: PR #1124 (CodeRabbit review, 10 inline comments)
- **Date**: 2026-06-29
- **Recurrence**: Yes — same "incomplete coverage" root cause, call-site flavor (not failure branches). 3 most recent full entries below; older ones compressed to one lines (full text → ERROR_ARCHIVE.md).
  - 2026-08-26 PR #1421 (self-review, guard-placement flavor): PRI-606 fix relocated the `wctx.config` lazy-read + language mapping OUTSIDE the `prompt.ts` try/catch that previously guarded the whole block; a failing `wctx.config` lazy-init (e.g. invalid language 'fr') would throw uncaught and crash the entire prompt hook — a weaker defensive posture than the original code. Caught in pr-review Phase 3 self-review before handoff; fixed by moving the 4 lines back inside try + 2 regression tests (invalid-language degrades to zh-CN with T-01 still injected; `config.get` throws → hook survives with empty injection). Lesson: when a fix ADDS reads to a previously-guarded block, keep them inside the same guard; moving a read OUT of try/catch is a fix-side guard-coverage regression (the inverse of "sibling branch left stale", same EP-03 family) — audit the guard boundary of every line touched, not just happy-path behavior.
  - 2026-08-21 RuleCode Owner decision implementation (nextAction contract flavor): the CLI list path correctly omitted `--confirm` from `pd activation deactivate`, but the sibling Console model still generated the unsupported flag for live and suspended activations. Both CLI and Console also advertised a direct `pd activation promote --confirm` mutation for shadow rules while promotion had become an authenticated, evidence-bound Owner decision. Fix: audited every user-facing promotion/deactivation hint across CLI, Console, and RuleHost; removed the invalid deactivate flag and replaced direct-promotion hints with the Owner decision prerequisites. Added CLI and Console regression assertions. Lesson: a lifecycle authority change requires a repository-wide audit of user-facing next actions, not only mutation handlers; generated commands are part of the operator contract.
  - 2026-08-21 PR #1371 review (parallel-implementation flavor): the default-OFF era suppressed the "core flag explicitly disabled" warning for `rulecode_owner_live_decision` in ALL THREE loader paths (`feature-flag-contract.ts`, `pd-config-effective.ts`, `pd-config-feature-flags.ts`). The rollout flip to default ON removed the suppression from two of them and added a pd-config test asserting the disable is observable — but missed the sibling `computeEffectiveFlags` path in `feature-flag-contract.ts:307`, leaving that loader's emergency-disable unobservable with no covering test. Caught by external review; fixed by removing the leftover special case + adding a mirror regression test in feature-flag-contract.test.ts. Lesson: when one behavior is implemented in N parallel loader/validation paths, enumerate all N sites in the fix commit message itself (or via a shared helper) — "grep the pattern" must cover the exact same expression in every file, not just the files the failing test points at.

---

**[ERR-090]** | Package.json entry point (main/exports) changed without verifying the referenced file exists in ALL build paths (tsc vs esbuild) — CI fails on paths that don't generate the new entry

- **What happened**: In PR #1162 (PRI-501), to fix an esbuild packaging issue, `packages/openclaw-plugin/package.json` `main` and `exports["."].default` were changed from `./dist/index.js` to `./dist/bundle.js`. esbuild.config.js generates `dist/bundle.js`, but the CI test step uses `tsc` build (which generates `dist/index.js` from `src/index.ts`), NOT esbuild. After `tsc` build, `dist/bundle.js` did not exist, so pd-cli CI failed when importing the plugin entry point. The fix: revert `main`/`exports` back to `./dist/index.js`, and add a re-export shim in `esbuild.config.js` (`writeFileSync('dist/index.js', "export * from './bundle.js';\n")`) so the entry point resolves correctly under both build paths.
- **Why it's wrong**: A package's `package.json` `main`/`exports` field is the entry point ALL consumers (CI, npm publish, IDE, runtime) use. Different build tools generate different output files: `tsc` generates `dist/<src-file>.js` (mirroring src structure), while `esbuild` generates a single `bundle.js`. Changing the entry point to reference a file that only one build tool generates breaks all other build paths. EP-06 family — source-of-truth (package.json entry) drifts from generated artifacts (tsc output).
- **Generalized failure mode**: When changing a `package.json` entry point (`main`/`exports`/`types`), assistants must verify the referenced file exists in ALL build paths (tsc, esbuild, webpack, rollup), otherwise CI fails on paths that don't generate the new entry.
- **Correct approach**: (1) Before changing `package.json` entry points, list all build tools that produce output in `dist/` and verify each generates the referenced file. (2) If build tools produce different filenames, add a re-export shim or build-step copy so the entry point resolves under all paths. (3) Run BOTH `npm run build` (tsc) AND the bundler build (esbuild/webpack) locally before pushing, then verify `node -e "require('./<entry>')"` succeeds after each.
- **How to prevent**: When changing `package.json` `main`/`exports`, the PR must: (a) grep build scripts in `package.json` (`scripts.build`, `scripts.prepack`, `scripts.prepare`) to identify all build tools; (b) verify each tool generates the referenced file; (c) if not, add a re-export shim or post-build copy step. Review triggers: (a) `package.json` `main` field changed; (b) `exports["."].default` field changed; (c) new bundler config (`esbuild.config.js`, `webpack.config.js`) that outputs a different filename than `tsc`.
- **Regression guard**: `packages/openclaw-plugin/esbuild.config.js` now generates `dist/index.js` as a re-export shim of `dist/bundle.js` after esbuild build, so `package.json` `main: ./dist/index.js` resolves correctly under both tsc-only and esbuild build paths. CI runs `tsc` build then tests import via `./dist/index.js`.
- **Related ERRs**: ERR-040 (published artifact missing components — same EP-06 family), ERR-050 (modified bundled copy instead of source — same EP-06 family), ERR-068 (wrong package manager lockfile — same EP-06 family), EP-06
- **Source**: PRI-501 / PR #1162
- **Date**: 2026-07-02
- **Recurrence**: Yes — the platform-semantics flavor this design SPEC (§16) maps to this entry: path/atomicity behavior verified under one OS's semantics and assumed portable.
  - 2026-08-25 release-update Phase 2b quality review (no Linear issue): two Windows-only defects in the release publish path. (1) A containment guard decided "is the parent a directory" with `lstatSync().isDirectory()` — on Windows a directory junction (and on POSIX a directory symlink) reports `isSymbolicLink()` via lstat, so the guard skipped path canonicalization and a junction alias of the input directory defeated the lexical containment check (`--archive <input-alias>/asset.tar` wrote the archive INTO the input). Fixed by deciding directory-ness with `statSync` (follows links) before `realpathSync` canonicalization, with a junction-alias regression test. (2) The final atomic publication `renameSync(staging, output)` failed EPERM because antivirus/indexer handles from the just-written ~270k-file payload transiently deny directory renames; fixed with a bounded retry (attempt stays one atomic rename; immutable-destination re-checked each attempt; fail loud with next action after the window). Prevention: on Windows, directory-ness checks that gate canonicalization must use stat-following semantics, and any single-rename atomic publication after a mass write needs a bounded EPERM/EACCES retry adapter (see also the atomic record adapters in the update-system SPEC Phase 4a).

---

**[ERR-091]** | CI checkout lacks `lfs: true` when tests read LFS-tracked binary assets — assertion fails on 132-byte pointer files

- **What happened**: PR #1159 added homepage-demo-{zh,en}.mp4 and homepage-demo-poster-{zh,en}.webp as Git LFS-tracked binary assets under `packages/website/public/`. The `verify-merge` CI job's `actions/checkout` step used the default `lfs: false`, so the LFS-tracked assets were checked out as 132-byte pointer files instead of real binary content. The `homepage-contract.test.mjs` test asserts `asset.size > 100_000` (`must contain a rendered video`); with 132-byte pointers, the assertion failed: `homepage-demo-zh.mp4 must contain a rendered video`. The "Verify Merge Gate" CI check failed, blocking merge.
- **Why it's wrong**: When tests in CI read the content of LFS-tracked binary assets, the checkout step MUST enable `lfs: true`; otherwise `actions/checkout` writes pointer files (132 bytes) instead of the actual binary content. Size/content assertions that pass locally (where LFS smudges the real file) fail in CI with no obvious connection to the checkout configuration. The test itself was correct — it caught the missing wiring — but the CI workflow was misconfigured.
- **Generalized failure mode**: When adding LFS-tracked binary assets that any CI test reads (size, content, format, dimension), assistants must ensure every `actions/checkout` step in every CI job that runs those tests has `lfs: true`. Additionally, any pre-deploy LFS-pointer guard must be extended to cover the new asset paths.
- **Correct approach**: (1) Add `lfs: true` to the `actions/checkout` step in `.github/workflows/ci.yml` for the `verify-merge` job (and any other job whose tests read LFS assets). (2) Extend pre-deploy LFS-pointer guards (e.g., in `deploy-website.yml`) to cover new LFS-tracked asset paths. (3) The size/content assertion in the contract test is the correct regression guard — keep it.
- **How to prevent**: When adding LFS-tracked binary assets that tests read in CI: (1) `grep "actions/checkout" .github/workflows/*.yml` and ensure every job running those tests has `lfs: true`. (2) Extend any LFS-pointer guard loop to include the new file glob. (3) Run `npm run verify:merge` locally before pushing — but note that local LFS smudge hides the CI-only pointer-file failure, so CI is the real guard.
- **Regression guard**: `packages/website/tests/homepage-contract.test.mjs` asserts `asset.size > 100_000` for each LFS-tracked video asset — this test catches the missing `lfs: true` wiring (it fails in CI when pointers are checked out instead of real content).
- **Related ERRs**: ERR-068 (wrong package manager in CI — same "CI consumes different artifact than local" pattern), ERR-084 (GitHub Actions workflow wiring — same EP-06 category), ERR-040 (published artifact missing components — same "test environment differs from CI/production" class)
- **Source**: PR #1159
- **Date**: 2026-07-02
- **Recurrence**: None

---

**[ERR-092]** | Module-level cache leaks across workspace instances when not keyed by workspaceDir

- **What happened**: `SystemLogger` in `packages/openclaw-plugin/src/core/system-logger.ts` used three module-level `let` variables (`cachedLogFile`, `cachedLogDate`, `lastCleanupDate`) to cache the current log file path. These variables were NOT keyed by `workspaceDir` — they were single-valued. When multiple workspaces were used in the same Node.js process (e.g., PRI-442 E2E isolation tests), the first workspace to call `log()` set `cachedLogFile` to its own log path. All subsequent calls from other workspaces used the same cached path, writing their logs to the FIRST workspace's log file. The cache only invalidated on date change (midnight), not on workspace change.
- **Why it's wrong**: Module-level mutable state that caches per-input-derived values (file paths, DB connections, service instances) MUST be keyed by the input that determines the value. A single-valued cache silently leaks state across callers with different inputs. This is especially dangerous in multi-workspace processes (E2E tests, long-running services handling multiple workspaces) where the leak corrupts observability data — logs from workspace B end up in workspace A's log file, making audit trails and E2E acceptance evidence unreliable.
- **Generalized failure mode**: When a module caches a value derived from an input parameter (workspaceDir, stateDir, sessionId, userId), the cache MUST be keyed by that input (typically a `Map<string, T>`). A single-valued `let` cache that only tracks "last seen" input (via `if (lastX !== currentX)`) is the broken anti-pattern — it works for single-caller processes but leaks under multi-caller use.
- **Correct approach**: Replace single-valued `let` caches with `Map<string, T>` keyed by `path.resolve(workspaceDir)` (path normalization defends against `./a/b` vs `/abs/a/b` key mismatches). Add `disposeX(workspaceDir)` and `disposeAllX()` exports for test isolation. The codebase already has this pattern in `evolution-engine.ts:551-577` (Pattern B with `path.resolve()` keying) and `evolution-logger.ts:319-357` (Pattern A with Map + get/dispose/disposeAll).
- **How to prevent**: When reviewing a module that has `let cachedX` or `let lastX` at module scope: (1) check if the cached value is derived from a function parameter; (2) if yes, the cache MUST be a `Map<param, value>` not a single slot; (3) key by `path.resolve()` if the parameter is a filesystem path; (4) add dispose functions for test cleanup. Anti-pattern to reject: `let config = null; let lastStateDir = null; if (lastStateDir !== stateDir) { config = new...; lastStateDir = stateDir; }` — this only works for single-caller processes.
- **Regression guard**: `packages/openclaw-plugin/tests/core/system-logger.test.ts` — writes from two distinct temp workspaces, asserts each workspace's logs land in its own `SYSTEM_YYYY-MM-DD.log` file (no cross-contamination).
- **Related ERRs**: EP-07 (Runtime State Source Alignment — output points to wrong state source, related but different: EP-07 is about reading stale state, this is about writing to wrong state). Also related to the "anti-pattern D" documented in `src/core/AGENTS.md` — `config-service.ts`, `dictionary-service.ts`, `detection-service.ts` all use the same broken `let lastStateDir` single-slot pattern and may need the same fix.
- **Source**: PRI-504 / PR #1164 review
- **Date**: 2026-07-03
- **Recurrence**: Yes.
  - 2026-08-16 PRI-532 (PR #1330 self-review): `isSelfReportEnabled` in `principle-application-ledger.ts` used a single-valued `let selfReportFlagCache` with a `workspaceDir === cached.workspaceDir` last-seen check — the exact anti-pattern this entry documents (written the same day the entry was re-read; pattern knowledge alone does not prevent the mistake). No correctness leak here (the key check prevented cross-workspace use) but multi-workspace processes would thrash to a disk read every turn. Fixed with `Map<string, T>` keyed by `path.resolve(workspaceDir)` per this entry's guidance; review also caught that the first fix forgot the path normalization step.

---

**[ERR-093]** | New log sink emits full external identifier despite an established minimization convention

- **What happened**: PRI-516 added duplicate-run and missing-runId logs that interpolated the complete OpenClaw `sessionId`, while the same prompt hook already truncated session identifiers to 20 characters before logging.
- **Why it's wrong**: External session identifiers can encode channel or sender identity. Logging the full value creates unnecessary disclosure and contradicts the module's existing data-minimization boundary.
- **Generalized failure mode**: When adding a log sink for an external user, channel, session, or request identifier, assistants must apply the surrounding module's established truncation or redaction convention before emission, otherwise operational observability can leak identity-bearing values.
- **Correct approach**: Preserve the full identifier only for internal correlation and persistence contracts; emit a bounded prefix or redacted form in logs. Here both new messages use `sessionId.substring(0, 20)` without changing the deduplication key.
- **How to prevent**: For every new interpolated log field, grep the same module for prior logging of that identifier and reuse its minimization helper or bound. Reject a new full-value log when a truncated/redacted precedent exists.
- **Regression guard**: CodeQL/CodeRabbit sensitive-log analysis plus review grep for ``sessionId=${`` in changed log calls; compare each occurrence with the module's 20-character convention.
- **Related ERRs**: ERR-055 (sensitive-key recognition), ERR-056 (value redaction omitted on an output path), ERR-058 (inconsistent security lists across paths).
- **Source**: PRI-516 / PR #1230 (CodeRabbit review)
- **Date**: 2026-07-15
- **Recurrence**: None

---

**[ERR-094]** | Range-bounds assertion uses `||` instead of `&&` — tautology that always passes for any value when `low <= high`

- **What happened**: In PR #1218, `packages/principles-core/src/quality-scorecard/__tests__/quality-scorecard.test.ts` line 797 verified that `row.created_at` falls inside the `[before, after]` timestamp window captured around the call. The assertion was written as `expect(row.created_at >= before || row.created_at <= after).toBe(true)`. Because `before` is captured before `after`, `before <= after` always holds. For any value `A`, either `A >= before` OR `A < before` — and when `A < before <= after`, the second clause `A <= after` is true. So `(A >= before) || (A <= after)` is a tautology true for every string `A`, including epoch zero, far-future dates, empty strings, or unrelated values. The test could never fail, even if `validatePrincipleEventRow` set `created_at` to a constant or garbage.
- **Why it's wrong**: The test claimed to verify a range invariant (`created_at ∈ [before, after]`) but the `||` operator made the predicate unsatisfiable-false-proof. This is the test-side sibling of ERR-088 (non-unique signal) — here the signal is "always true" rather than "produced by multiple paths", but the effect is identical: the test gives false confidence that behavior is verified when in fact no behavior is constrained. A regression changing `created_at` to any fixed value would still pass.
- **Generalized failure mode**: When asserting a value falls within a range `[low, high]`, the correct boolean operator is `&&` (both bounds must hold), not `||` (either bound). `(A >= low) || (A <= high)` is a tautology whenever `low <= high` — which is the normal case for range checks. The inverse mistake `(A >= low) && (A <= high)` is the only form that actually constrains `A`. This is a special case of EP-09 (Test Reality Gap): the asserted signal is non-unique because every possible input produces it.
- **Correct approach**: Use `&&`: `expect(row.created_at >= before && row.created_at <= after).toBe(true)`. Equivalently split into two assertions: `expect(row.created_at >= before).toBe(true)` and `expect(row.created_at <= after).toBe(true)`. For numerical ranges, the same rule applies — `expect(value >= low && value <= high).toBe(true)`.
- **How to prevent**: For any range/bounds assertion `expect(A >= low OP A <= high).toBe(true)`, verify the operator is `&&` not `||`. Mental check: ask "is there any value of `A` that makes this false?" — if the answer is "no" (given `low <= high`), the assertion is a tautology. Add a negative test seeding an out-of-range value (e.g., `created_at = '1970-01-01T00:00:00Z'`) and confirm the assertion fails on the buggy `||` version. Reviewer trigger: any `expect(... || ...).toBe(true)` or `expect(... || ...).toBeTruthy()` in a test file, especially near comparison operators.
- **Regression guard**: `packages/principles-core/src/quality-scorecard/__tests__/quality-scorecard.test.ts` line 797 (the fixed `&&` assertion). The test now actually constrains `created_at` to the captured window.
- **Related ERRs**: ERR-088 (non-unique test signal — same EP-09 group, "always true" flavor), ERR-025 (test proves isolated helper, not production defense — same EP-09 group), ERR-073 (characterization tests don't verify call-site behavior — same EP-09 group).
- **Source**: PR #1218 (self-review before merge)
- **Date**: 2026-07-16
- **Recurrence**: None

---

**[ERR-095]** | Additive envelope/`contentJson` merge uses a key that collides with an existing output-schema field — silently overwrites the legitimate field

- **What happened**: In PR #1273 (Layer 0 internalization summary envelope), `BasePeerRunner.buildArtifactContentJson` merged the `ArtifactSummary` envelope into a runner's output via `{ ...output, summary: envelope.summary }`. But two of the 8 `SummaryRunnerKind` outputs already declare a top-level `summary` string field in their output schema: `DiagRootCauseOutputV1.summary` (the root-cause symptom statement) and `DiagnosticianOutputV1.summary` (the router's route summary). The spread-then-assign pattern unconditionally wrote the envelope object under the `summary` key, silently **overwriting** the legitimate output field with the `ArtifactSummary` envelope object. Any downstream reader expecting the string `summary` would receive an object instead. design §7 explicitly promises "不删不改任何既有字段" (never delete or modify any existing field) — this violated it. The flag defaults off, so no production data was corrupted before discovery, but enabling it would have silently broken diag_rootcause and diag_router artifacts.
- **Why it's wrong**: "Additive" is not automatically safe at the field-name level. A merge written as `{ ...existing, newKey: value }` only preserves `existing.newKey` when `newKey` is not already a key of `existing`. When the same name is reused, the later assignment wins — a silent overwrite indistinguishable from intentional replacement. The implementer checked that the envelope was *structurally* additive (two new sibling keys) but did not check whether those key names were *already in use* by the very output schemas the envelope attaches to. The 8 `SummaryRunnerKind` outputs have heterogeneous schemas; a key name that is "new" for dreamer/philosopher/scribe/artificer is "existing" for diag_rootcause/diag_router.
- **Generalized failure mode**: When transforming a typed schema object by hand (attaching an additive envelope via key-merge, or reconstructing a validated output field-by-field), the implementation must diff its key set against every field the target type declares — reusing an existing field name is an overwrite, and omitting a declared field is a silent drop. "Additive" and "validated" are properties of the *name space*, not just the *intent*. This applies to any contentJson envelope, telemetry annotation merge, `{...x, k}` spread, or validator that rebuilds the object it validated, where the implementer does not fully own the target schema.
- **Correct approach**: Before merging, check `Object.hasOwn(output, envelopeKey)`. On collision, either (a) skip writing the envelope key and emit a structured degradation with a `*_key_collision` reason (rc-9 — the self-summary remains derivable on the read side from the unchanged output), or (b) namespace the envelope under a key guaranteed unused (e.g. `__layer0_summary`). The fix in PR #1273 chose (a): detect collision, skip the envelope `summary`, emit `artifact_summary_skipped` with reason `output_summary_key_collision`, still attach `predecessorSummary` (which does not collide).
- **How to prevent**: For every `{ ...output, newKey }` (or equivalent merge) where `output` is a typed schema object the writer does not own, audit the target schema for an existing `newKey` field. The audit is one grep: `grep -rn "newKey" <output-schema-files>`. If any schema declares it as a top-level field, either skip-on-collision or rename. Reviewer trigger: any PR introducing an "envelope" / "annotation" / "metadata wrapper" merged onto an existing structured output via spread — ask "does any of the target outputs already have a field with this name?". Mirror rule for validators that RECONSTRUCT their output field-by-field: the reconstructed object's key set must cover every declared field of the target interface (including optional sections like `principles`), and a round-trip test must assert each declared field survives validation → effective-config.
- **Regression guard**: `packages/principles-core/src/runtime-v2/internalization/__tests__/summary-envelope-writer.property.test.ts` — "P1 regression: output already declaring a top-level `summary` field is NOT overwritten" asserts the legitimate `output.summary` string is preserved verbatim and a `output_summary_key_collision` degradation is emitted.
- **Related ERRs**: ERR-009 (silent skip of invalid data — same data-integrity family, different root cause: that one *accepts* invalid input silently, this one *overwrites* valid input silently), ERR-083 (shared-store contract change without cross-package caller audit — same "the writer doesn't own the full field-name space" theme).
- **Source**: PR #1273 (CodeRabbit review + self-review)
- **Date**: 2026-08-02
- **Recurrence**: 2026-08-27 / PR #1421 (PRI-606, self-review during implementation): `validatePdConfig` reconstructed the validated `PdConfig` field-by-field and never extracted the `principles` section — `principles.outputLanguage` (canonical language SSOT since PRI-336) was silently dropped between raw YAML and `effective.config` for every `loadPdConfigForPlugin` consumer. The SSOT only *appeared* to work because pd-cli (`config-reader.ts`) and pd-console (`pd-config-store.ts`) re-read the raw YAML in parallel shadow paths. Fixed by extracting/validating `principles` (strict `outputLanguage` via `isValidOutputLanguage`) into the returned config; regression guard `pd-config-principles.test.ts`; prompt.ts now reads the language through this canonical path.

---

**[ERR-096]** | Non-interactive mode (`--yes`) hangs on an interactive prompt — handler gated prompting on `jsonMode`/`quiet` instead of the broader `nonInteractive` signal

- **What happened**: In the `create-principles-disciple` installer gateway pre-flight, `install()` showed a 3-way interactive `@inquirer/prompts` `select` (stop / proceed / abort) when the OpenClaw gateway was running. Prompting was gated on `!quiet`, where `quiet` is `install()`'s mode parameter set to `jsonMode` (true only under `--json`). The CLI also exposes `--yes` / `--non-interactive`, which are non-interactive but NOT `--json`. So a `--yes` run with the gateway up had `quiet=false` → `interactive=true` → `install()` invoked `select` and **hung waiting for stdin**, breaking the `--yes` non-interactive contract and any CI/script relying on `--yes`. Caught in adversarial self-review before PR handoff; no `--yes` user was affected.
- **Why it's wrong**: Two distinct concerns — "suppress human output/spinner" (`jsonMode`) and "allow interactive prompting" (`nonInteractive` = `--yes` || `--non-interactive` || `--json`) — were collapsed into one boolean. They differ exactly for `--yes` (human output ON, prompting OFF). Gating prompts on the subset flag (`jsonMode`) is wrong because `--yes` sits in the "no prompts" set but outside the "no output" set. Same shape as ERR-034: the caller consumed a subset/proxy signal instead of the canonical one.
- **Generalized failure mode**: When a CLI handler's behavior depends on whether prompting/interaction is allowed, it must consume the real `nonInteractive` signal threaded from the CLI — never a proxy like `jsonMode`/`quiet` that covers only a subset of non-interactive modes. A single CLI commonly has several non-interactive modes that share "don't prompt" but differ on "emit human output" (or vice versa); collapsing them into one boolean silently breaks the modes that lie in only one of the two sets.
- **Correct approach**: Thread the actual `nonInteractive` flag from the CLI layer into the handler, separate from `jsonMode`. In the installer this became `InstallRunMode { quiet?: boolean; nonInteractive?: boolean }` with `nonInteractive` defaulting to `quiet` (jsonMode always implies non-interactive); `index.ts` passes `{ quiet: jsonMode, nonInteractive: Boolean(nonInteractive) }`. Prompt-gating uses `!nonInteractive`; spinner/output suppression uses `quiet`.
- **How to prevent**: When gating ANY interactive behavior (`inquirer` `select`/`confirm`/`input`, TTY reads, interactive prompts) on a CLI mode flag, enumerate every non-interactive invocation mode (`--json`, `--yes`, `--non-interactive`, CI/embedded callers) and confirm the gating flag is true for ALL of them — not just `--json`. Reviewer trigger: any new `inquirer`/`select`/`confirm`/`prompt` call inside a function also reachable from `--yes` or `--json` — ask "is this skipped under `--yes` too, or only under `--json`?".
- **Regression guard**: `packages/create-principles-disciple/tests/installer.test.ts` — "--yes mode (quiet=false, nonInteractive=true) aborts without prompting when the gateway is running" asserts that `{ quiet: false, nonInteractive: true }` + gateway running + no `--stop-gateway` returns `reason: 'gateway_running_aborted: ...'` without invoking the prompt or `stopOpenClawGateway`.
- **Related ERRs**: ERR-034 (canonical signal not consumed by caller — same "subset/proxy instead of the full signal" shape; different domain: runtime-config resolver vs CLI prompt-gating), ERR-063 / ERR-021 (CLI flag→handler wiring family — but those are parser-wiring gaps; ERR-096 is in-handler flag semantics, not parsing).
- **Source**: fix/installer-gateway-lock (self-review before PR)
- **Date**: 2026-08-12
- **Recurrence**: None

---

**[ERR-097]** | PD writes into host-managed paths/config without checking the host's discovery/trust semantics — backups re-discovered as duplicate plugins, dual-language skill roots silently collapsed, created plugins.allow silently disables other plugins

- **What happened**: Three shipped behaviors violated OpenClaw host contracts because each was designed from PD's side only, treating the host environment as passive storage. (1) The pd-console updater and the installer stored update backups INSIDE `~/.openclaw/extensions/` (`.pd-backup-<ts>` and `<extDir>.backup.<ms>` siblings of the live plugin). OpenClaw plugin discovery scans every extensions/ child directory (its ignore list matches `.bak` / `.backup-` / `.disabled`, NOT `.pd-backup-`), so every backup was re-discovered as a second `principles-disciple` plugin — "duplicate plugin id detected" config warning on EVERY gateway start; 21 stale backup dirs had accumulated on the owner machine. (2) `openclaw.plugin.json` declared BOTH `templates/langs/en/skills` and `templates/langs/zh/skills`. OpenClaw publishes plugin skills by NAME (first declared root wins, no i18n mechanism), so all 23 same-named zh skills were silently dropped with 23 "plugin skill name collision" warnings per startup, and every published skill was English although PD's default language is zh. (3) `OpenClawHostInstaller.install()` created `plugins.allow: ["principles-disciple"]` when the key was absent. Once non-empty, OpenClaw's allowlist gate silently DISABLES every discovered non-bundled plugin not on it (entries.enabled=true does NOT bypass), so installing PD on a machine that auto-loads feishu/tavily would silently disable those plugins.
- **Why it's wrong**: The host actively interprets everything in its directories and config keys: extensions/ children are plugin candidates, manifest arrays are publication instructions with name-uniqueness semantics, plugins.allow is a hard activation gate. Writing into these without reading the host's loader semantics means PD's own files and config writes become duplicate entities, suppressed content, or silently disabled host features. ERR-074 (same update flow) fixed backup LEAK paths but kept the backup LOCATION — the location itself was the remaining defect.
- **Generalized failure mode**: When PD places artifacts inside a host-managed directory or writes/creates a host config key, the author must first verify the HOST's interpretation of that path/key (discovery scan rules and ignore conventions, publication-by-name uniqueness, activation/trust gates) from the host's loader code or docs, and place PD's data where the host's contract says it belongs — otherwise PD's own writes turn into duplicate plugins, silently dropped content, or silently disabled user plugins.
- **Correct approach**: Backups go to `<openclawHome>/pd-backups` (outside every plugin discovery root), with a one-time migration moving legacy backups out of extensions/ at console server startup and before every update/install. The plugin manifest declares exactly ONE skill root (zh, the product default); en templates stay in the package as translations, undeclared. The installer only APPENDS to an existing plugins.allow and never creates one; when the key is absent the install result explains why (creating it would disable other discovered plugins).
- **How to prevent**: PR-review trigger — any new file/directory created under `~/.openclaw/` (or any host-managed root), or any write to an `openclaw.json` key PD does not own: the PR description must name the host rule that interprets it (discovery scan, ignore list, publication-by-name, allowlist gate). If the author cannot cite the host rule, the write has not been checked. Shared host collections (allow lists) are append-only for PD.
- **Regression guard**: `packages/pd-console/tests/server/utils/pd-backups.test.ts` and `packages/create-principles-disciple/tests/backup-location.test.ts` (backups land outside extensions/, legacy migration moves `.pd-backup-*` / `*.backup.*` siblings out, rollback accepts the backups root); `packages/openclaw-plugin/tests/manifest-skills.test.ts` (exactly one skills root, declared dirs inside package root, no cross-root skill-name collisions); `packages/create-principles-disciple/tests/openclaw-host-installer.allow.test.ts` (allow never created when absent, appended id list preserves other ids, malformed allow fails loud).
- **Related ERRs**: ERR-074 (early-return backup leak in the same update flow — sibling failure mode, different root cause: exit-tunnel leak vs artifact placement), ERR-040 / ERR-041 (published-artifact vs source-tree blind spot family), ERR-047 (config field semantics assumed instead of verified).
- **Source**: startup-warning audit 2026-08-16 (owner-reported gateway startup log; fix branches fix/pd-backup-outside-extensions-scan, fix/plugin-manifest-single-skill-lang, fix/installer-allow-append-only)
- **Date**: 2026-08-16
- **Recurrence**: None

---

**[ERR-098]** | Destructive cleanup with junction-following recursive delete wiped a shared repo's working tree — cleanup must use `git worktree remove`, never recursive deletes on junction-bearing directories, and must not silence errors on critical cleanup steps

- **What happened**: During PR review verification (PRs #1332-1335, 2026-08-16), the assistant created temporary git worktrees and junctioned their node_modules into the SHARED main repo (`D:\Code\principles`) to reuse dependencies. During cleanup, junction removal used `-ErrorAction SilentlyContinue` (removal failed silently due to file locks from still-running vitest/node processes), then `Remove-Item -Recurse -Force` was run on the worktree directories. PowerShell 7's Remove-Item FOLLOWS junction/reparse points during recursive deletion, so the shared repo's working tree (1,865 tracked files across packages/*/src) and all node_modules were deleted.
- **Why it's wrong**: A destructive recursive delete was executed on a directory that contained reparse points pointing INTO a shared repository, and the failure of the preceding junction-removal step was hidden by silent error suppression. Shared-repo hygiene demands verification-baseline discipline; the assistant optimized for speed (junction reuse) instead of safety, then compounded it with a known PowerShell footgun and silent errors.
- **Generalized failure mode**: When cleaning up temporary verification scaffolding (worktrees, junctions, symlinks) that references a shared repository, assistants must use repository-native removal (`git worktree remove`), must never run recursive filesystem deletes (`Remove-Item -Recurse`, `rm -rf`) on directories that may contain reparse points, must not silence errors on critical cleanup steps, and must snapshot a `git status` baseline before and verify it after cleanup — otherwise shared-repo working trees and dependencies get deleted in bulk.
- **Correct approach**: (1) Clean up temp worktrees with `git worktree remove <path> --force` only (git never follows symlinks/junctions). (2) If junctions were created, remove them FIRST with junction-safe removal (`cmd /c rmdir <junction>` or `Remove-Item` WITHOUT `-Recurse`), and VERIFY each removal succeeded (check exit code / `Test-Path`) — never `-ErrorAction SilentlyContinue` on critical cleanup. (3) Never `Remove-Item -Recurse` / `rm -rf` on any directory containing or plausibly containing reparse points. (4) Record `git status` baseline before starting, assert it is unchanged after cleanup. (5) Prefer installing deps inside the worktree or running `vitest --root <worktree>` from the main repo over junctioning node_modules into a shared repo.
- **How to prevent**: Before ANY deletion-capable command (`Remove-Item -Recurse`, `rm -r/-rf`, `git clean -fdx`): (a) scan the target for reparse points (`Get-ChildItem -Recurse | where Attributes -match ReparsePoint`, or `dir /AL /S`); (b) confirm the target does not link into a shared repo; (c) if junctions exist, use git-native or link-safe removal only; (d) never suppress errors on cleanup steps that precede a delete. Operator trigger: destructive command + junction/symlink-capable target → abort and use `git worktree remove`.
- **Regression guard**: Runtime V2 rule candidate (triggerPattern `Remove-Item\s+-Recurse|rm\s+-r|rm\s+-rf`; action: scan for reparse points before delete, refuse or switch to `git worktree remove`, require explicit confirmation for high-risk deletes) + workspace TOOLS.md/AGENTS.md rule: "禁止对含 junction/symlink 的目录使用 Remove-Item -Recurse / rm -rf；临时 worktree 清理只用 git worktree remove；关键清理步骤不得静默吞错" + operational checklist: git-status baseline before/after cleanup.
- **Related ERRs**: ERR-071 (cleanup hygiene family — async cleanup/finally leaks; different prevention rule: resource cleanup vs destructive-op safety), ERR-074 (update-flow backup leak cleanup family; different root cause), ERR-050 (wrong-target file operations family).
- **Source**: PRI-538 (pr-review session 2026-08-16, PRs #1332-1335 verification cleanup)
- **Date**: 2026-08-16
- **Recurrence**: Yes — shared-repo reparse-point hazard re-encountered (caught before damage this time).
  - 2026-08-19 PR #1358 session (near-miss, no damage): the `principles-mvp-core-loop` worktree's `node_modules` was itself a JUNCTION into the main repo's shared `D:\Code\principles\node_modules` (leftover of the same junction-reuse pattern). Symptom: workspace package resolution silently hit the MAIN checkout's packages (different branch → `mergePITaskMetadata` "not a function" in spawned pd-cli while vitest imports passed). Nearly ran `npm ci` in the worktree — npm's rimraf of existing node_modules FOLLOWS the junction and would have deleted the main repo's entire node_modules. Safe recovery: `cmd /c rmdir node_modules` (removes the link only, verified main intact), then a fresh `npm ci` INSIDE the worktree so it owns a real node_modules with junctions to its own packages. Extra hazard observed: MSYS `ln -sfn` on Windows silently falls back to DEEP-COPYING the target (2000+ partial `Cu*` temp dirs when it hit the huge `packages/website`) — use PowerShell `New-Item -ItemType Junction` instead. Reinforces rule (5) of Correct approach: never junction a worktree's node_modules into a shared repo; install inside the worktree.

---

**[ERR-099]** | Defensive ternary alternate for a contract-impossible empty state shipped uncovered — codecov/patch gate fails; prefer a branch-free join that degrades to the legacy format

- **What happened**: In PR #1341 (issue #1337), the fix surfaced `gateResult.reasons` in the `RuleHostWriter.canActivate` refusal via a ternary with an empty-reasons alternate (`gateReasonDetail.length > 0 ? enriched : bare`). Every `evaluateRefinerRuleHostGate` rejection path initializes `reasons` with at least one string, so the bare alternate was unreachable through any production seam (the writer only injects `gateDeps`, not the gate result itself). The two new regression tests covered only the enriched branch, so codecov/patch reported 66.66% of diff hit (target 79.52%) and the check failed.
- **Why it's wrong**: (a) A conditional alternate that no production path can reach is dead code that coverage gates still demand to be covered or removed. (b) Writing defensive handling for an impossible state instead of branch-free graceful degradation adds untestable surface and fails the CI gate on a PR that was otherwise green.
- **Generalized failure mode**: When adding a conditional branch whose alternate handles a state the upstream contract guarantees cannot occur, assistants must either write the code branch-free (a single join/fold that degrades to the legacy format for the empty case) or cover the alternate with a test through a real seam — otherwise the coverage gate fails on the dead alternate and dead defensive code accumulates.
- **Correct approach**: Prefer a construction with no branch: `const reasonParts = [prefix, ...gateResult.reasons.slice(0, 3)]; reason: reasonParts.join(' — ')` — an empty reasons array degrades to the exact legacy single-segment string with zero extra branches (PR #1341 commit 5d4fe743). If the two sides genuinely need different shapes, add a test per branch BEFORE pushing.
- **How to prevent**: For every new conditional in a PR diff, ask: "Which production seam makes each side true?" If none exists for one side, remove the branch or restructure branch-free. Before handoff, run `npx vitest run --coverage --coverage.include='src/<changed-file>.ts'` locally and assert the new hunk has no uncovered statement/branch; also watch `codecov/patch` in `gh pr checks`.
- **Regression guard**: PR #1341 commit 5d4fe743 (`rule-host-writer.ts` branch-free `reasonParts.join`) + codecov/patch as the standing CI gate that catches the pattern.
- **Related ERRs**: ERR-089 (incomplete branch coverage when fixing — sibling-branch flavor of the same EP-02 group), ERR-025 (tests prove isolated helper behavior, not production path), ERR-088 (non-unique assertion signals — same EP-09 verify-the-right-thing group).
- **Source**: PR #1341 (self-review, GitHub issue #1337)
- **Date**: 2026-08-17
- **Recurrence**: Yes
  - 2026-08-28 PRI-615 / PR #1432 (self-review round 1): a new fail-loud guard branch (`max_attempts` validation in `sqlite-task-store.rowToFailedTaskSummary`) shipped with only the happy path covered — the throw block's 2 lines were flagged by the codecov patch comment (the gate itself passed at 91.67%, but the uncovered-branch pattern recurred). Unlike the original incident the branch is NOT contract-impossible (a corrupted DB column reaches it), so the fix was the "add a test per branch" arm of the rule: a corrupt-row regression that writes `max_attempts = 0` below the `TaskRecordSchema` bound via a bound `UPDATE` and asserts `listFailedTasks` throws. Lesson flavor: fail-loud validation guards are legitimate branches, but each one must ship with a corrupt-input regression in the same PR — "the sibling guard was also uncovered" is the file's existing convention, not a license.

---

**[ERR-105]** | Hardcoded light-mode hex colors bypass theme tokens on a dual-theme UI — timeline dots near-invisible in dark mode

- **What happened**: In PR #1377 (PRI-558), the assistant added timeline status dots to `PrinciplesPage.tsx` as raw hex literals (`STATUS_DOT = { pending: "#1e3a5f", approved: "#4d6b52", rejected: "#8b3a3a", parked: "#6b7280" }`) applied via inline `style={{ backgroundColor }}`. These values are exactly pd-console's LIGHT-theme token values (`--color-gov/green/danger` in `globals.css`). pd-console ships a dark theme (`[data-theme="dark"]`) where those variables flip to light tints (`#9db9d8`, `#90b892`, `#d28b8b`), so in dark mode the dots render dark-navy-on-dark and are nearly invisible. The same PR body claimed "reuses existing design tokens only".
- **Why it's wrong**: The UI color system is a two-layer token contract: CSS variables re-declared per theme, consumed through Tailwind utilities (`bg-gov`) that resolve at runtime. Hardcoded hex bypasses the second layer, so any themed surface drifts when the theme flips; inline styles also escape the Tailwind pipeline entirely.
- **Generalized failure mode**: When adding visual styling (colors, shadows, radii) to a component in a multi-theme UI, assistants must use theme-token utilities or CSS variables — never raw hex/rgb literals — otherwise one of the themes renders with wrong or low-contrast styling.
- **Correct approach**: Map each state to literal utility-class strings in a typed Record (`const STATUS_DOT_BG: Record<ReviewStatus, string> = { pending: "bg-gov", ... }`) so Tailwind JIT sees them; verify by grepping built CSS for the class rules (PR #1377 fix commit aa6a881b).
- **How to prevent**: In review, grep new diffs for `#[0-9a-fA-F]{3,8}` and `rgb(` inside `.tsx` files / `style={{` props of themed packages (pd-console, Companion). Each hit must map to an existing design token or carry an explicit both-themes justification. Also check dark mode once per visual PR (`data-theme="dark"`).
- **Regression guard**: Static scan for hex/rgb literals in style props under `packages/pd-console/src/ui/`; fix commit aa6a881b is the reference implementation of the token-class map.
- **Related ERRs**: ERR-075 (same shape — new UI element skips an established consistency layer; strings there, tokens here)
- **Source**: PR #1377 (pr-review 2026-08-22)
- **Date**: 2026-08-22
- **Recurrence**: None

---

**[ERR-106]** | Binary ternary collapsed a 4-state review status into approved/pending — rejected/parked principles displayed as "awaiting Owner review"

- **What happened**: In PR #1377 (PRI-558), the governance decision badge on `PrinciplesPage.tsx` was rendered as `isApproved ? govApproved : govPending`. `ReviewStatus` has four members (pending/approved/rejected/parked), so rejected and parked principles showed "⏳ 等待拥有者审查" directly beneath a status badge reading 已拒绝 — contradictory, false information on a governance page whose entire purpose is showing the Owner true decision state.
- **Why it's wrong**: A binary ternary silently folds every non-matching enum member into its default branch. For enums with more than two states this fabricates state the data does not contain; TypeScript cannot catch it because both branches are valid strings.
- **Generalized failure mode**: When deriving display copy or styling from a status enum with N > 2 members, assistants must use an exhaustive `Record<Status, Copy>` map so TypeScript forces one case per member — otherwise unhandled states inherit a default that misrepresents them.
- **Correct approach**: `const GOV_DECISION: Record<ReviewStatus, { glyph: string; labelKey: string }>` covering all four states, reusing existing per-status i18n keys for rejected/parked (fix commit aa6a881b applied the same pattern to the impact copy via `BLOCK_IMPACT_KEY`).
- **How to prevent**: Any new conditional over a union-typed status in UI code: if branch count < union member count, require explicit justification in the PR; prefer `Record<Union, …>` maps (missing member = compile error) over ternary chains.
- **Regression guard**: TS exhaustiveness via `Record<ReviewStatus, …>` (adding a fifth status breaks compile until mapped); pd-console `principle-review.test.ts` suite covers the page contract.
- **Related ERRs**: ERR-099 (misleading/dead conditional branches family), EP-02 must-check on shared type unions
- **Source**: PR #1377 (pr-review 2026-08-22)
- **Date**: 2026-08-22
- **Recurrence**: None

---

**[ERR-107]** | Exception registry used to legitimize new I/O inside a pure core package

- **What happened**: PR #1392 added a filesystem-backed governance audit writer under `principles-core/src`, then registered the file in `io-seam-registry.json` so the architecture tests accepted it.
- **Why it's wrong**: The repository contract makes `principles-core` pure logic and directs new I/O to `openclaw-plugin`. The seam registry inventories explicitly approved exceptions; changing the registry does not grant approval. The implementation also created a second audit log instead of the issue-required canonical `events_*.jsonl` stream.
- **Generalized failure mode**: When a repository has both a strict architecture boundary and an exception registry, assistants must treat registry additions as architecture changes requiring explicit approval, not as a way to make a violating implementation pass static checks; otherwise the guard becomes self-authorizing.
- **Correct approach**: Keep event data types and validation pure in core, put persistence in the designated I/O package, reuse the canonical event log, and require explicit maintainer approval for any genuine new seam.
- **How to prevent**: Review every diff to an architecture exception registry. If the new entry lacks an explicit maintainer-approval reference, reject it and move the I/O behind the established boundary.
- **Regression guard**: Architecture checks should reject newly added core I/O seam entries unless the registry entry carries a validated approval reference; ordinary new `fs`/`path`/network imports in core remain forbidden.
- **Related ERRs**: ERR-032 (active architecture contract contradicted), ERR-100 (runtime boundary crossed through an unsafe dependency graph)
- **Source**: PRI-566 / PR #1392
- **Date**: 2026-08-24
- **Recurrence**: None

---

**[ERR-108]** | Governance derivation implemented from the implementer's audit-delta narrative instead of clause-by-clause against the normative spec

- **What happened**: The experience-snapshot derivation (PR #1409, PRI-584) was written to match the implementer's own Phase-0 delta notes rather than re-checking SPEC §7–§9 clauses. Review found four conformance bugs: per-principle classification applied decision-first although §7.3 defines recovery > decision precedence (the UI-priority clause is presentation-only); `queued` counted as processing despite §8.4 requiring active execution evidence; `blocked` emitted a bare count with no evidence refs; and RuleCode/frontier evidence counted raw rows without the §9 linkage requirement.
- **Why it's wrong**: A spec carries its normative semantics in numbered clauses; a delta log records intent summaries. When implementation AND tests are both written from the narrative, they validate each other and the drift passes green — self-referential verification inherits the narrative's blind spots.
- **Generalized failure mode**: When implementation follows a summarized interpretation of a normative spec, assistants must re-verify each numbered clause against the final code diff during adversarial self-review; otherwise precedence lists, forbidden-inference rules, and evidence requirements silently degrade to whatever the summary remembered.
- **Correct approach**: Walk the spec's clauses one by one against the code (never against the delta doc). Express explicit orderings as a single ordered data structure shared by classification. For evidence requirements, assert the presence of linkage references — never accept counts alone.
- **How to prevent**: In review, pick every spec sentence containing an explicit ordering or forbidden inference and name the test that locks it; if that test only asserts the implementation's own output shape, rewrite the test from the clause before handoff.
- **Regression guard**: PR #1409 round-1 tests: within-one-principle recovery>decision lock; pending-only workspace not processing; blocked marker carrying frontier sourceRefs; unlinked shadow activations degrading to data quality instead of inflating needs_decision.
- **Related ERRs**: ERR-099 (tests proving own output shape), ERR-106 (enum folding), ERR-032 (doc/code contradiction family)
- **Source**: PRI-584
- **Date**: 2026-08-25
- **Recurrence**: None

---

**[ERR-109]** | Tri-state fact (boolean | null) collapsed during a merge — one source's definite `false` resolved another source's unknown into an observed-false

- **What happened**: PR #1419 round 3 made telemetry milestones tri-state (`true` = evidence observed, `false` = evaluable-and-empty, `null` = source not evaluable) to honor "Unknown ≠ false". But the `principleObserved` merge over its two evidence populations (pipeline candidates ∪ tree principles) used an "authority-first" variant: `if (a===false || b===false) return false`. A readable-but-empty `principle_candidates` table (`false`) combined with a malformed ledger (`null`) — and the mirror case — collapsed to a definite `false`, silently manufacturing "no principles exist" from one population's emptiness plus another's unreadability.
- **Why it's wrong**: `principleObserved` is an existence claim over the UNION of two distinct populations. One source's evaluated-empty proves ITS population empty; it says nothing about whether the other population contains evidence. Resolving that open question with the definite value of a DIFFERENT source fabricates a measurement. This survived round 3 because the reviewer-facing tests only covered true+unknown and unknown+unknown, never false+unknown — the collapse lived precisely in the untested Kleene row.
- **Generalized failure mode**: When merging availability-bearing facts (tri-state/optional/null-as-unavailable), assistants must implement three-valued logic per operator instead of binary short-circuits: OR keeps null unless a `true` exists; AND mirrors it. A lone definite value resolves a composite claim ONLY when the operator is truth-dominant in that direction.
- **Correct approach**: Implement `kleeneOr(a,b) = a===true||b===true ? true : a===false&&b===false ? false : null` (mirror for AND). Justify any non-Kleene merge in the function doc with WHY one source is a complete authority for the whole claim; if no such proof exists, use Kleene. Add the full 6-row tri-state test matrix at least once per merged fact type, especially the false+null rows.
- **How to prevent**: In review of any merge/coalesce over facts whose null means "unavailable": ask "what does NULL mean here, and which test pins false+null?" If the answer is "treated as false" without an authority proof, reject. Under 30 seconds: grep `=== false ||` / `?? false` adjacent to fields documented as boolean-or-null.
- **Regression guard**: `packages/host-runtime/tests/product-telemetry-units.test.ts` — "one source evaluated empty does NOT collapse the other unknown source to false (Kleene OR)": unreadable db + empty ledger → null; empty-candidates-table + malformed ledger → null; both definitively empty → false stands. Bite-verified red before the fix.
- **Related ERRs**: ERR-106 (binary fold over multi-state), ERR-009 (definite-wrong-value fallback family), ERR-002 (silent degradation without reason)
- **Source**: PR #1419 review round 4
- **Date**: 2026-08-26
- **Recurrence**: None

---

**[ERR-110]** | Published security disclosure contradicts shipped code — a network-capable subsystem landed without updating the README that explicitly denied it

- **What happened**: PR #1419 shipped the consent-gated anonymous product telemetry exporter (HTTPS POST to `principles-website.pages.dev`) inlined into the openclaw-plugin `dist/bundle.js`, but did not update `packages/openclaw-plugin/README.md` — npm-auto-included in every tarball and the surface ClawHub's audit reads — which still stated "The core plugin does not send product telemetry" and "The core plugin performs no network I/O except through Owner-configured provider SDKs". The root READMEs likewise carried "State is stored locally." / "Is it safe? Yes." with zero telemetry mention. ClawHub's audit of the published plugin surfaced the capability (static `suspicious.env_credential_access`, Critical); the telemetry code itself was verified sound (default-off flag, consent-before-network, strict 8-field schema), but the shipped README's absolute denial turned a benign-capability finding into a user-facing trust contradiction.
- **Why it's wrong**: Disclosure is part of the published artifact's contract. Shipping a boundary-crossing capability while the artifact's own security section explicitly denies it is worse than not documenting at all: it converts "undisclosed capability" into "demonstrably false claim", and every other absolute claim in that section becomes unreliable to users and external auditors. Source-tree tests stayed green because nothing read the disclosure.
- **Generalized failure mode**: When a PR adds or changes any capability that crosses a security/privacy boundary (network egress, environment-variable reads, new data flow out of the machine), assistants must update EVERY disclosure surface describing that boundary (published package README, root README, manifest copy) in the same PR and lock it with a regression test, otherwise the published artifact claims things its code refutes and external audits or users catch the lie.
- **Correct approach**: PR #1430 — rewrote the plugin README "Security & data boundaries" section (enumerate both network paths, full telemetry contract: default OFF, consent, exact payload, never-sent list, endpoint, controls, kill switch), fixed root README EN/ZH framing, added `verify-build.mjs` publish-time disclosure markers gate (runs in `prepack`) and `disclosure-contract.test.ts` regression lock.
- **How to prevent**: In review of any diff that touches `fetch`/`http`/network SDK/env-read capability in a shipped package: grep that package's README + the root README for absolute privacy/network claims ("does not send", "no network I/O", "local only", "stays local") in the same review pass. If the capability set changed, the disclosure diff must be in the same PR.
- **Regression guard**: `packages/openclaw-plugin/tests/disclosure-contract.test.ts` (positive markers + negative stale-claim assertions across plugin README, root README EN/ZH, skill scope) plus the `verify-build.mjs` disclosure gate that runs in `prepack` (build:production).
- **Related ERRs**: ERR-040 (published artifact missing components — same EP-06 "artifact ≠ source" family, mirror direction: false claim vs missing file), ERR-032 (docs contradict ADR — internal docs vs published disclosure), EP-06
- **Source**: owner-directed task 2026-08-28 (no Linear issue); ClawHub audit 2026-08-26, plugin v1.222.4; remediation PR #1430
- **Date**: 2026-08-28
- **Recurrence**: 2026-08-28 PR #1430 self-review — the first root README remediation described telemetry as the only outbound path and still omitted Owner-configured LLM provider calls. Fixed the English and Chinese disclosures and strengthened the disclosure contract test to require the provider-network path explicitly.
