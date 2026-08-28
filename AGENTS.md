# AGENTS.md — OpenAI Codex CLI Instructions

## ⚠️ MVP-First Stage — Read First (2026-05-24)

**PD is in MVP-First stage** (ADR-0014). Goal: invite the first real seed customer within 4-6 weeks. **All architectural expansion is paused.** Product boundary: **PD owns owner-reviewed, reversible behavior internalization; it does not own general task execution, general memory, generic tool repair, or autonomous value decisions.**

Read the strategic documents below before creating or reprioritizing an issue, or changing product scope, architecture, roadmap, ADRs, user journeys, surfaced functionality, activation channels, or public product copy:

0. [`PRODUCT_IDENTITY.md`](docs/product/PRODUCT_IDENTITY.md) (canonical product boundary)
1. [`docs/adr/0014-mvp-first-strategy-and-product-pivot.md`](docs/adr/0014-mvp-first-strategy-and-product-pivot.md) (MVP-First Strategy)
2. [`docs/plans/2026-05-roadmap/07-mvp-first-pivot.md`](docs/plans/2026-05-roadmap/07-mvp-first-pivot.md) (execution doc)
3. [`docs/plans/post-mvp-conditional-roadmap.md`](docs/plans/post-mvp-conditional-roadmap.md) (deferred work restart conditions)

For a narrowly scoped implementation, bug fix, test fix, or CI fix inside an already approved issue, do not reload all strategic documents unless the change crosses one of those boundaries. The product boundary above still applies.

If a Linear issue or earlier doc instructs you to implement **Attribution Pipeline / WorkspaceLearningSummary / Probation Window / BALM / LRAS / GAP / MissionScheduler / Trainer / model_training channel / pre-existing Phase 1C or Phase 1D work**, **STOP** and verify against post-mvp-conditional-roadmap.md whether the restart conditions are met. They almost certainly are not.

### MVP Three Questions (mandatory for every new issue)

Before opening a new Linear issue or starting a non-MVP-listed PR, answer all four (referenced by stable ID `mvp-q-*`):

1. **`mvp-q-1-what-if-skip`** — What happens if we DON'T do this? Will anyone bring it up again 30 days from now? If you cannot answer, the issue is rejected.
2. **`mvp-q-2-how-observed`** — How is it observed? After implementation, how does the user verify it works? UI? CLI command? Log? If there is no observable path, the issue is rejected.
3. **`mvp-q-3-how-disabled`** — How is it disabled? If after deployment we discover it's wrong, what's the disable path? Feature flag? PR revert? **Anything that requires PR revert MUST ship with a feature flag from day one.**
4. **`mvp-q-4-emotional-value`** — What emotional value does it deliver? Read [`docs/product/emotional-value.md`](docs/product/emotional-value.md). Which negative emotion does this feature reduce (失控感 / 疲惫感 / 不信任感 / 信息过载)? What positive feeling does it create (安心感 / 掌控感 / 沉淀感 / 清醒感)? If the feature only proves "it works" but cannot explain how it improves the Owner's psychological state, the feature design is incomplete.

### Emotional Value Alignment

[`docs/product/emotional-value.md`](docs/product/emotional-value.md) is PD's canonical emotional-value design guideline. Every agent working on PD features, PRDs, or spec designs MUST read it before writing proposals or code.

Core promise: **把 Owner 面对 Agent 时的失控感、疲惫感、重复纠正感，转化为安心感、掌控感、沉淀感和清醒感。**

Every feature design or PR must include an emotional-value assessment (see emotional-value.md §7). If this section is missing, the PR is incomplete.

### MVP-Core / MVP-Quiet / MVP-Gone Triage

Every PD subsystem falls into one of three buckets (see ADR-0014 §2.4-§2.6):

- **MVP-Core**: required for story A' using the three already implemented activation paths (`prompt`, `defer_archive`, and `code_tool_hook` / RuleHost). Touch with care.
- **MVP-Quiet**: code remains, but feature flag is **default off** and not surfaced in UI / docs. After 6 months of no activation, becomes MVP-Gone.
- **MVP-Gone**: deleted or archived to reduce code volume.

**Adding a new feature to MVP-Core REQUIRES maintainer's explicit approval.** Default for unsolicited new code is MVP-Quiet (off + flag-registered).

### Feature Flag Registration

The feature flag registry and production loader contract are in place (`feature-flag-contract.ts`, merged via PRI-239 / PRI-304 / PRI-305; loader covered by `feature-flag-contract.test.ts`). The registry is the single source of truth for which subsystems exist and their default on/off state.

- Do not introduce a new subsystem / hook / writer / reader or expand MVP-Core without explicit maintainer approval.
- Bug fixes, evidence collection, documentation alignment, synthetic validation, and ADR-0012 legacy retirement/cutover may proceed without inventing an unused flag file.
- If a proposed new behavior needs runtime disabling, register the flag instead of ad-hoc gating.

Every new or newly surfaced functional subsystem / hook / writer / reader must be registered in `{workspace}/.pd/config.yaml` (the unified config file; the legacy `.pd/feature-flags.yaml` is no longer read by production runtime — ADR-0016) with:
- `category: core | quiet | gone | legacy_retire`
- `enabled: true | false` (Quiet = false by default)
- `since: <YYYY-MM-DD>` (when added)

Registration counts only when the production loader and a test exercise the flag. PRs introducing functional behavior without registration are rejected.

Additionally (PRI-610): every **quiet** flag MUST carry a `QUIET_FLAG_LIFECYCLE` entry in `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-lifecycle.ts` (Purpose / Default / Rollback / Graduation criteria / Retirement criteria / Exit path) in the same PR — `feature-flag-lifecycle.test.ts` fails CI otherwise. See `docs/process/feature-flag-lifecycle-census.md`.

### Anti-pattern Triggers

The following phrases in an issue or PR description are **automatic stop signals** (referenced by stable ID `antipattern-*`). Verify with maintainer before proceeding:

- `antipattern-future-extensibility` — "为未来铺路" / "for future extensibility"
- `antipattern-completeness` — "为完整性" / "for completeness"
- `antipattern-new-research` — "AHE 论文又出了新进展" / "based on new research"
- `antipattern-adr-accepted` — "这个 ADR 当时是 Accepted" / "this ADR was Accepted"
- `antipattern-review-missing` — "review 时觉得这块缺失" / "during review I noticed X is missing"
- `antipattern-prep-next-phase` — "为下个 Phase 准备" / "prep for next Phase"
- `antipattern-core-io` — "在 core 写 I/O 代码" / "writing I/O code in core" — `packages/principles-core/src/` must be pure logic. New I/O belongs in `openclaw-plugin`. If a core file genuinely needs I/O, add it to `packages/principles-core/io-seam-registry.json` (single source of truth that drives both `architecture-regression.test.ts` and `eslint.config.js`, PRI-450/PRI-462).

These are **maintainer-driven completeness anxiety**, not external user signal. PD does not act on them during MVP stage.

---

## Mandatory Pre-Task Reading

Before starting ANY coding task on this project, you MUST read `docs/process/error-management/ERROR_PATTERN_INDEX.md`. This compact index maps recurring error patterns to the detailed incidents in `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md`.

Then read the specific handbook entries referenced by the relevant pattern(s). Read `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` in full only when recording a new error, auditing the handbook itself, or when the compact index does not cover the task.

### Error Handbook Reading Protocol

**Default: Index-driven loading**
1. Read `docs/process/error-management/ERROR_PATTERN_INDEX.md` (compact, ~110 lines).
2. Match your task to 1-3 EP cards.
3. Read ONLY the detailed entries referenced by those cards (use `grep -n "ERR-XXX" docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` to locate).
4. State which ERR entries you considered and how you avoid them.

**Forbidden: Full-file loading**
Do NOT read `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` in full unless:
- You are recording a new error (record-error skill)
- You are auditing the handbook itself
- The INDEX does not cover your task AND you have confirmed with the user

**Why**: The handbook is 177KB (~44K tokens). Loading it fully consumes ~15% of your context window for marginal benefit — the INDEX already captures all patterns. Full loading degrades your performance on the actual task.

If a code review catches your error, record it in the handbook and tag the Linear issue with `lesson-learned`.

### Error Handbook Gate

Before implementation:

1. Read `docs/process/error-management/ERROR_PATTERN_INDEX.md`.
2. Select the relevant pattern cards for the current task.
3. Read the detailed `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` entries referenced by those cards.
4. List the relevant ERR entries for the current task (minimum 3). Reference specific IDs and titles.
5. State how this PR avoids recurrence of each listed ERR. Write this in your implementation brief.
6. If fixing a bug: note which known ERR class the bug belongs to.

After code review (if a real bug is found):

1. **New error class**: Create a new ERR entry in the handbook with full details.
2. **Recurring error class**: Update the existing entry's Recurrence field with the new date and issue.
3. Tag the Linear issue with `lesson-learned` label.
4. If the finding changes a recurring pattern, update `docs/process/error-management/ERROR_PATTERN_INDEX.md`.
5. Run `npm run check:error-handbook`.
6. Mention handbook updates in the PR body.

> **Why this matters**: Without the Handbook Gate, agents repeat the same error classes across sessions (ERR-001/ERR-005/ERR-007/ERR-009 all share the "as bypasses validation" pattern, and ERR-015/ERR-018/ERR-019 all share the "stale loop state" pattern). Explicitly naming ERR entries forces the agent to recognize the pattern group, not just the individual bug.

## Project Overview

**Principles Disciple** — an owner-governed behavior internalization system for AI agents (Node.js/TypeScript monorepo, npm). PD does not own general task execution, memory, tool retries, or broad autonomous self-evolution. Use [`docs/product/PRODUCT_IDENTITY.md`](docs/product/PRODUCT_IDENTITY.md) as the product definition before interpreting older architecture language.

## Critical Rules

1. **Core vs Plugin boundary**: `packages/principles-core/` = pure logic only (no I/O, no fs, no DB, no network). `packages/openclaw-plugin/` = I/O boundary. New pure logic → core. New I/O → plugin.
2. **FROZEN LEGACY (ADR-0005)**: The deprecated god-classes (`nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, `nocturnal-service.ts`) were deleted in PRI-230. Do NOT recreate them.
3. **Architecture regression tests**: `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` — never skip or delete.
4. **ADR compliance**: `docs/adr/` — code contradicting an ADR is a bug.
5. **No `any`**: Use `unknown` for truly unknown types. Strict TypeScript mode.
6. **No AI merge**: Never use `gh pr merge` or auto-merge PRs. User must merge manually.
7. **Conventional commits**: `feat()`, `fix()`, `docs()`, `refactor()`, `test()`, `chore()`.
8. **MANDATORY: Check PR comments first**: When asked to review/fix an existing PR, **FIRST** fetch and read **all PR comments/reviews** before doing ANY work. Retry at least 2 times if GitHub API fails. If no other way, ask user to copy-paste PR comments.

## Runtime Contract Rules

All code that handles untrusted data (parsed JSON, LLM output, DB `diagnosticJson`, artifact metadata) must follow these 9 rules (referenced by stable ID `rc-*`). Each rule maps to real error patterns in the Error Experience Handbook.

| # | ID | Rule | Key constraint | ERR ref |
|---|-----|------|----------------|---------|
| 1 | `rc-1-treat-as-unknown` | Treat parsed JSON / LLM output / DB `diagnosticJson` / artifact metadata as `unknown` | Never use `any`; require runtime validation before use | ERR-001 |
| 2 | `rc-2-no-as-bypass` | Do not use `as` to bypass runtime validation | Use `typeof`, `Array.isArray()`, or type guards for runtime checks | ERR-001, ERR-005 |
| 3 | `rc-3-fail-loud-missing` | Required fields must fail loud when missing or malformed | Use `if (!valid) { error }` pattern, not `if (valid) { skip }` | ERR-009, ERR-010 |
| 4 | `rc-4-validate-array-elements` | Validate array element types | Use `filter(isString)` or element-wise `typeof` on unknown arrays | ERR-005, ERR-007 |
| 5 | `rc-5-object-hasown-not-in` | Use `Object.hasOwn()`, not `in`, for untrusted object keys | `in` matches inherited properties (toString, constructor) | ERR-013 |
| 6 | `rc-6-lineage-consistency` | Lineage and evidence fields must come from the same source; add mismatch tests | sourceTaskId/sourceRunIds/sourcePainId must be internally consistent | ERR-004, ERR-008 |
| 7 | `rc-7-loop-state-freshness` | Retry/repair loops must distinguish current, next, and recorded state | Get fresh errors each iteration; record with current-iteration data | ERR-015, ERR-018, ERR-019 |
| 8 | `rc-8-safe-serialization` | Preview and telemetry paths must be bounded and use safe serialization | Use `safeStringifyPreview`; never raw `JSON.stringify` on unknown values | ERR-014, ERR-016, ERR-017 |
| 9 | `rc-9-no-silent-fallback` | Graceful degradation must include a reason via structured error, notes, telemetry, or logs | Silent fallback = bug. Observability is mandatory. | ERR-002 |

**Enforcement**: Code review must check every rule that applies to the changed code. If a rule is N/A, state why.

## CLI / Operator Command Gate

Apply this gate to every change touching `packages/pd-cli/src/commands/**`, CLI registration, remediation commands, queue/run commands, or operator workflows (referenced by stable ID `cli-*`).

1. **`cli-1-strict-json`** — JSON mode is strict: `--json` output must be exactly one parseable JSON object on stdout. No banners, headings, explanatory text, or mixed stdout logs.
2. **`cli-2-exit-stops`** — Exit paths must stop execution: after `process.exit(...)` inside an async handler, immediately `return` or throw. Tests that stub `process.exit` must prove no later DB/ledger/artifact side effects happen.
3. **`cli-3-negated-flags-parser-tests`** — Negated flags need parser tests: Commander `--no-*` flags must be registered as `--no-name` and read as `opts.name === false`. Add parser-level tests, not only handler tests.
4. **`cli-4-dry-run-confirm-mutex`** — Dry-run/confirm semantics are mandatory: commands that can mutate state must default to dry-run unless the established command contract says otherwise. `--dry-run` and `--confirm` must be mutually exclusive when both exist.
5. **`cli-5-failure-no-mutation`** — Failure paths must not mutate state: failed diagnoses, failed validation, unsupported runners, missing input, and non-succeeded upstream stages must not intake, enqueue, write artifacts, update ledger, or create successors.
6. **`cli-6-output-next-action`** — Operator output needs next action: every degraded/refused/failed CLI result must include a structured reason and next action in JSON output.
7. **`cli-7-test-wiring`** — Test the real command wiring: when behavior depends on Commander options, add a command-registration or parser test that exercises the actual flags.

## Build & Test

```bash
cd packages/principles-core && npm run build && npm run test
cd packages/openclaw-plugin && npm run build && npm run test
npm run lint
```

## BDD Workflow (AI 助手改代码前)

AI 助手在 PD 项目改代码时的新流程:

1. 读 `docs/specs/features/` 找到受影响的 `.feature` 文件
2. 读 `.feature` 确认行为契约
3. 改代码
4. 跑受影响的 `.feature` 场景(`cd packages/<pkg> && npx vitest run tests/bdd/xxx.steps.ts` 或 `npx playwright test tests/bdd/xxx.steps.ts`)
5. 如果场景失败,确认是代码 bug 还是 `.feature` 过时
   - 代码 bug → 修代码
   - `.feature` 过时 → 跟 Owner 确认后改 `.feature`,并在 PR 说明中记录
6. PR Pre-Review Gate 的对抗式自检,优先检查 `.feature` 是否都绿

**关键约束**:
- AI 助手**可以**修改 step definitions(重构真实接口时是必要的)
- AI 助手**不能降低 `.feature` 的可观察结果**——任何 `.feature` 行为变化必须 Owner-visible,并在 PR 描述说明原因
- AI 助手**不能**通过删除 `.feature` 文件或加 `@disabled` 标签让测试绿(除非 PR 描述明确说明行为契约被移除/暂停的原因,且 Owner 已确认)

## Linear Workflow

1. Read the issue (including comments) BEFORE writing code
2. Update status to In Progress when you begin
3. Comment your plan on the issue
4. Update status to In Review when done
5. Leave a summary comment

## Error Recording (MANDATORY)

**Rule: Any code review that discovers a real issue (bug, type safety violation, architecture violation, logic error) MUST invoke the `record-error` skill before closing the review.**

This applies to:
- PR reviews (pr-review skill Phase 6.5)
- Self-review after completing a task
- Any review where you find an error you (or another AI) made

The `record-error` skill handles: classify → number → Linear comment → tag `lesson-learned` → edit handbook → update stats → commit & PR.

**Do NOT skip this step.** Reasons like "the fix was trivial", "I'm tired", or "I'll do it later" are not acceptable. Without recording, the same class of error will recur across sessions. The Error Experience Handbook is the project's institutional memory.

## PR Pre-Review Gate

Before handing off a PR (pushing, creating PR, or reporting completion), execute this checklist:

**PR template (MANDATORY on create)**
- When creating a PR via `gh pr create`, **first** read `.github/PULL_REQUEST_TEMPLATE.md` and fill out all agent-sections (`agent 填`) before passing `--body`.
- **Do NOT** pass a custom body without the template structure. `gh pr create` does NOT auto-inject the template — you must read it and compose the body manually.
- After creation, use `gh pr edit <PR> --body-file <file>` if the body needs correction.

**Review convergence and throughput**
- The implementation agent performs one adversarial self-review before the first handoff. It must check the applicable Runtime Contract and CLI / Operator gates against the whole diff and fix all in-scope P0/P1/P2 findings together.
- The first external review is the only full-scope review pass for the PR. It should report all currently visible in-scope P0/P1/P2 findings in one batch.
- After a fix push, reviewers verify the listed blockers and regression surface only. Do not reopen broad review or request adjacent hardening unless the new change introduces a P0/P1 production or safety regression.
- A finding blocks the current PR only if it is P0/P1, or a P2 violation of this issue's stated acceptance criteria. Improvements outside that boundary become a follow-up Linear issue and do not delay merge.
- Group recurring errors by root cause and perform one Error Handbook update per root cause after the fix cycle. Do not create one handbook entry per review comment.
- Use targeted tests while iterating on review fixes; run the required merge gate once before final handoff. Do not add broad unrelated tests or refactors solely because a neighboring weakness was noticed.

**Self-review/fix loop**
- A PR is not ready just because code was pushed. It is ready only after the fetch → fix → verify → re-fetch loop has no valid unresolved P0/P1/P2 findings and required checks are green.
- After every push that addresses review feedback, fetch PR reviews/comments/checks again. Do not ask the user to relay comments unless GitHub API access fails after at least 2 retries.
- Classify each review comment as: fixed, deferred with reason, duplicate, or misunderstanding with evidence. Put this classification in the PR comment or completion report.
- If a real bug was found, run the Error Recording workflow before final handoff.

**Fetch and resolve PR comments**
- `gh pr view <PR> --json comments,reviews,latestReviews,files,statusCheckRollup`
- `gh api repos/:owner/:repo/pulls/<PR>/comments --paginate`
- `gh api repos/:owner/:repo/issues/<PR>/comments --paginate`
- Fetch ALL comments (not just the first page). Retry at least 2 times on API failure.
- Fix every valid P0/P1/P2 finding. For each handled comment, note the fix.
- If a comment cannot be fixed, explain why in the PR body.

**Check diff scope**
- `gh pr diff <PR> --name-only` (or `git diff origin/main --name-only`)
- Confirm no unrelated files were modified.
- Confirm no stale-main rollback of already-merged code (see ERR-012).

**BDD 影响评估**

- [ ] 本 PR 是否修改了 MVP-Core 用户旅程?如果是,对应 `.feature` 是:
      - [ ] 保持不变(行为契约未变)
      - [ ] 更新(行为契约变化,已在 PR 描述说明原因)
      - [ ] 不适用(说明为什么这条旅程不再适用)
- [ ] 本 PR 是否新增/修改了 CLI 命令?如果是,cli-1~cli-7 对应 `.feature` 是否更新?
- [ ] 本 PR 是否触发了 ERR 类?如果是,是否新增了回归 `.feature` scenario?
- [ ] 本 PR 是否删除了 `.feature` 文件?如果是,是否在 PR 描述说明了"行为契约被移除的原因"?

**Run tests**
- `cd packages/principles-core && npm run test`
- `cd packages/openclaw-plugin && npm run test`
- `npm run lint` (if available)
- `npm run verify:merge` (if available)

**Final summary**
Include in the PR body or completion report:
- Relevant ERR checklist (which ERR entries were considered and how avoided)
- PR comments handled (total fetched, valid fixed, deferred, duplicates/misunderstandings)
- Tests run (which commands, what results)
- For CLI/operator changes: JSON-mode check, exit-path check, flag-wiring tests, and mutation/no-mutation evidence
- Remaining risk (known issues, skipped coverage, trade-offs)

## Key Files

- `docs/process/error-management/ERROR_PATTERN_INDEX.md` — Compact error pattern index (READ FIRST)
- `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` — Detailed error incident log
- `docs/process/DATA_CLEANUP_GUIDELINES.md` — 数据清理守则（READ BEFORE any cleanup：治理资产保护清单 + 流程硬约束，PRI-568）
- `docs/architecture/ARCHITECTURE.md` — Full system architecture
- `docs/adr/` — Architecture Decision Records
- `CLAUDE.md` — Full project guidance (also applies to you)

## Private Docs Access

Private docs live in an **independent private git repo** — they are NOT tracked in this repo and are never committed here.

- **Location**: `$PD_PRIVATE_DOCS_DIR` (env var) if set, otherwise `~/principles-private/docs` (e.g. `D:/Code/principles-private/docs`)
- **Read**: read files directly from that path (e.g. `$PD_PRIVATE_DOCS_DIR/agents/domain.md`). There is **no** `docs/.private/` junction anymore.
- **Search**: private docs are outside this repo tree — `rg`/grep in this repo does NOT cover them. Run searches inside the private docs directory.
- **Edit rule**: modify private docs **only inside the private repo**, then commit + push there (`git -C <private-repo> ...`). Never create copies of private content inside this repo.
- **Privacy**: never paste private doc content into public PRs/issues/commit messages — reference paths only.
- **Verify**: if unsure whether private docs are reachable, run `node scripts/setup-private-docs-symlink.mjs --check` (prints the resolved path, creates nothing).
