# Error Pattern Index

This compact index is the first stop for coding tasks. Use it to select the relevant detailed entries in `docs/ERROR_EXPERIENCE_HANDBOOK.md` instead of loading the full incident log into context by default.

For a task, pick the matching pattern cards, read the listed ERR entries, and state how the implementation avoids recurrence. If a review finding is another instance of an existing pattern, update that pattern or the matching handbook entry's Recurrence field instead of creating a new top-level error class.

## Pattern Cards

### EP-01 Trust Boundary Validation

- **Use when**: handling parsed JSON, LLM output, SQLite rows, CLI options, artifact metadata, YAML, or caught errors — including degradation/fallback/retry-exhausted paths.
- **Failure mode**: `as` casts or typed helper parameters make untrusted runtime values look validated; runtime shape checks validate wrong field names, making checks vacuous; degradation paths emit objects built from validator-rejected candidates.
- **Must check**: values stay `unknown` until runtime guards validate them; required fields fail loud; arrays validate elements; `Object.hasOwn()` is used for untrusted keys; shape checks validate fields that actually exist in the target type; **every output-emitting path (happy, degraded, fallback, exhausted) emits only validated objects — degradation is a content transform, not a trust escape hatch**.
- **Representative ERRs**: ERR-001, ERR-005, ERR-007, ERR-009, ERR-013, ERR-047, ERR-054, ERR-057, ERR-061, ERR-065, ERR-069, ERR-076.
- **Automation target**: static scan for `as Record<string, unknown>`, `as TOutput`, and casts near parse/adapter/DB/CLI boundaries; grep degradation/fallback functions for emit-before-validate.

### EP-02 Production Path Wiring

- **Use when**: adding validators, dispatchers, activation paths, CLI commands, baselines, guards, helper APIs, or PDRuntimeAdapter implementations.
- **Failure mode**: a component exists and has isolated tests, but the real user/operator path never calls it; an adapter hand-builds a return object from a remembered schema instead of the real one, masked by `as`.
- **Must check**: tests exercise the production entry point, not only leaf helpers; new CLI commands are registered in Commander; activation writes are read by the live prompt path; adapter return objects are built from the verbatim Typebox schema (RunHandleSchema/RunStatusSchema), not memory; new public types/functions are re-exported from barrel `index.ts` at every ancestor level.
- **Representative ERRs**: ERR-011, ERR-024, ERR-025, ERR-028, ERR-035, ERR-048, ERR-053, ERR-060, ERR-064, ERR-067, ERR-069, ERR-070.
- **Automation target**: command-tree tests, production-path smoke tests, fixture evidence that names the real dispatcher/facade, and schema-field cross-checks for adapter return shapes.

### EP-03 Fail Loud and Observable Degradation

- **Use when**: adding catch blocks, validators, degraded modes, installer results, JSON output, or fallback behavior.
- **Failure mode**: invalid input, failed cleanup, malformed config, or incomplete delivery silently becomes success or an unexplained fallback.
- **Must check**: every refusal/degradation includes a structured reason and next action; no `catch {}`; no `if (valid) { assert }` tests that pass when data is absent; **every branch of a multi-path degradation (happy / V1-fallback / exhausted) applies the SAME failure guard — an alternate/degraded code path that skips the try/catch its siblings use will throw past a never-throws contract (PRI-428 recurrence: the V1 branch of runAdversarialLoop called createEvaluatorTask unguarded while the V2 branch wrapped it; the loop documented "never throws" but the V1 path could)**; **a concurrency primitive's failure/contention path (lock eviction, retry backoff) is itself a degradation path — it must be hardened so it cannot re-open the data-loss/race class the primitive was added to close (ERR-079: age-based lock eviction stole a live holder's lock after lockStaleMs, re-introducing the lost-update class the lock existed to prevent)**.
- **Representative ERRs**: ERR-002, ERR-009, ERR-010, ERR-014, ERR-016, ERR-017, ERR-029, ERR-033, ERR-041, ERR-044, ERR-046, ERR-062, ERR-070, ERR-071, ERR-072, ERR-074, ERR-079.
- **Automation target**: grep/static guard for empty catch blocks and test assertions hidden behind truthy conditionals; for any function with a documented never-throws/degrades contract, diff-check that EVERY branch (including alternate-type/V1/early-exit branches) wraps the same external calls that the primary branch wraps.

### EP-04 CLI and Operator Contract

- **Use when**: touching `packages/pd-cli`, operator commands, installers, command registration, or JSON mode.
- **Failure mode**: flags parse differently than handlers expect, `process.exit()` falls through, dry-run mutates, JSON stdout is polluted, or nextAction is unusable.
- **Must check**: parser-level tests use the real Commander program; failed paths stop execution and do not mutate state; `--json` emits exactly one parseable object; `--no-<flag>` options are stored as the positive form (e.g., `--no-enqueue-next` → `opts.enqueueNext`), never `opts.noEnqueueNext`.
- **Representative ERRs**: ERR-020, ERR-021, ERR-022, ERR-023, ERR-029, ERR-033, ERR-043, ERR-053, ERR-063, ERR-066.
- **Automation target**: command wiring tests that call `program.parseAsync()` with full command paths.

### EP-05 Loop State Freshness

- **Use when**: implementing retries, repairs, multi-attempt validation, evidence timelines, or iterative LLM repair.
- **Failure mode**: current, next, and recorded state are conflated, so telemetry and repair prompts use stale errors.
- **Must check**: each iteration reads fresh errors; records are written with current-iteration data; next-attempt state is not stored as current-attempt evidence.
- **Representative ERRs**: ERR-015, ERR-018, ERR-019, ERR-067.
- **Automation target**: tests with two distinct failing attempts and assertions on per-attempt recorded errors.

### EP-06 Source of Truth and Generated Artifacts

- **Use when**: editing bundled packages, generated copies, package manifests, installer payloads, lockfiles, or files under `packages/create-principles-disciple`.
- **Failure mode**: fixes are applied to generated copies or source-tree tests pass while the published artifact is incomplete; or the wrong package manager's lockfile is updated so CI's install step fails.
- **Must check**: edit the source of truth and rerun the generator; package runtime dependencies are declared in the package that imports them; the lockfile CI consumes is the one updated; smoke tests install from packed output.
- **Representative ERRs**: ERR-040, ERR-041, ERR-050, ERR-068.
- **Automation target**: generated-artifact checks plus clean `npm pack` install smoke tests; CI lockfile-consistency gate.

### EP-07 Runtime State Source Alignment

- **Use when**: returning config, reading disk state, resolving runtime/provider endpoints, lineage, or artifact source IDs.
- **Failure mode**: output reports requested inputs instead of actual state, or fields from different sources are mixed into one lineage/config result.
- **Must check**: returned state is read from the canonical source after writes; lineage and evidence fields come from the same source; config resolver output is consumed by callers.
- **Representative ERRs**: ERR-004, ERR-008, ERR-031, ERR-034, ERR-036, ERR-042, ERR-049, ERR-059.
- **Automation target**: mismatch tests where requested state differs from disk/canonical state.

### EP-08 Security Boundary Placement

- **Use when**: adding redaction, command blocking, path handling, shell execution, or security validators.
- **Failure mode**: a security control is placed at the wrong layer, matches the wrong scope, or is bypassed by interpolation/substrings.
- **Must check**: enforcement input is not prematurely redacted; persistence output is redacted; shell arguments are passed as argv; path checks use segment boundaries; **size bounds on content that undergoes a length-increasing transformation (XML/HTML escaping, URL encoding, base64) are applied to the POST-transformation output, not the pre-transformation input (ERR-080: bounding raw content then escaping it lets entity expansion `&`→`&amp;` 5x blow the budget)**.
- **Representative ERRs**: ERR-003, ERR-024, ERR-030, ERR-045, ERR-051, ERR-055, ERR-056, ERR-058, ERR-080.
- **Automation target**: tests for composite sensitive keys, value-based redaction, raw enforcement input, and sibling path false positives; regression test with expandable chars (`&`.repeat(N)) for any escape-then-bound pipeline.

### EP-09 Test Reality Gap

- **Use when**: changing tests, fixtures, baselines, smoke tests, database schemas, package installs, or UI route/action state.
- **Failure mode**: tests prove strings, helper behavior, or hand-written schemas instead of the real behavior users rely on.
- **Must check**: fixtures match production schema; tests fail if expected output is absent; package tests are run when package code changes; UI tests verify route/action contracts, not just source substrings.
- **Representative ERRs**: ERR-025, ERR-026, ERR-037, ERR-038, ERR-039, ERR-040, ERR-073, ERR-077.
- **Automation target**: production schema fixtures and real-path smoke tests.

### EP-10 Workflow and Branch Hygiene

- **Use when**: reviewing/fixing PRs, cherry-picking, recording errors, or working on stacked branches.
- **Failure mode**: comments are missed, stale main rolls back merged code, unrelated commits contaminate a PR, **or a PR body self-reports a CI failure as "pre-existing/unrelated/flaky" without verifying it against the base branch (ERR-078)** — the false classification then ships a real regression under a false exoneration.
- **Must check**: fetch PR reviews/comments with retries; inspect source branch commit list before cherry-pick; compare diff scope against target branch; **for any "pre-existing on main" claim in a PR body, reproduce the failing test on `origin/main` (or prove the changed files can't reach the failing code) before accepting the claim — flag-flips that change `DEFAULT_FEATURE_FLAGS` defaults re-route execution paths in mocked tests**.
- **Representative ERRs**: ERR-006, ERR-012, ERR-027, ERR-032, ERR-052, ERR-078.
- **Automation target**: PR pre-review checklist and `git log main..source-branch` before cherry-pick; reviewer check that reproduces each "pre-existing" failure claim against the merge-base.

### EP-11 i18n and Accessibility String Consistency

- **Use when**: adding any user-facing string (visible text, `aria-label`, `title`, `placeholder`, `alt`) in a component that already uses an i18n translation function (`t()`, `useTranslation`, `i18next`).
- **Failure mode**: new strings are hardcoded in the source language (usually English) while the rest of the component routes text through `t()`, causing screen readers, tooltips, and visible text to read in a different language than the active UI locale.
- **Must check**: every new string attribute in an i18n-enabled component uses `t()` with a translation key; corresponding keys are added to all locale files (`en.json`, `zh-CN.json`, etc.); interpolation parameters (e.g., `{{count}}`) are passed through `t()` options.
- **Representative ERRs**: ERR-075.
- **Automation target**: grep for `aria-label={`, `aria-label="`, `title="`, `placeholder="` in `.tsx` files that import `useTranslation`/`t()`; any match not using `t(...)` is a finding.

## Maintenance Rules

- Every ERR in a pattern card must exist in `docs/ERROR_EXPERIENCE_HANDBOOK.md`.
- Every detailed ERR must be mapped to at least one pattern card. If an error is genuinely novel, add a new EP card before recording the ERR.
- Prefer updating a pattern card or Recurrence field over adding a new top-level error class for the same root cause.
- Run `npm run check:error-handbook` after editing this file or the handbook.
