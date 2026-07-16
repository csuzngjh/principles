# PD Cloud Quality Handoff

Last updated: 2026-07-16

## Purpose

Continue the seed-release quality investigation without widening the MVP
boundary. The release claim to prove is:

> A seed user can complete Owner correction -> diagnosis -> principle proposal
> -> Owner decision -> reversible activation -> observable later behavior change
> with real OpenClaw and the real PD governance surface.

The release gate is score >= 90/100, no P0/P1 defects, and no hard vetoes.
Cloud work is for deterministic review, build, tests, and data-lineage checks.
Final real OpenClaw/provider and browser acceptance stays on the configured local
machine.

## Safety And Product Boundary

1. Read `AGENTS.md`, `docs/product/PRODUCT_IDENTITY.md`, ADR-0014, the MVP
   pivot plan, `docs/product/emotional-value.md`, and the error-pattern index.
2. Never merge a PR with AI tooling. The Owner merges manually.
3. Do not upload local OpenClaw state, session JSONL, browser profiles, API keys,
   private workspaces, or repository context to external model providers.
4. Treat Linear issues and PRs as the detailed requirement and evidence sources;
   do not duplicate their acceptance criteria here.

Suggested skills: `pr-review`, `record-error`, `diagnose`, `bdd`, `linear`, and
`handoff` before the cloud session ends.

## Start Commands

```bash
git fetch origin --prune
git switch main
git pull --ff-only origin main
gh pr list --state open --limit 50
```

## Linear Map

- `PRI-442`: parent seed-release acceptance.
- `PRI-516`: OpenClaw current prompt/history/retry contract.
- `PRI-518`: correction or tool failure to a reviewable candidate with exact
  lineage.
- `PRI-517`: real browser governance journey.
- `PRI-519`: prompt and RuleHost repeatability, deactivation, and restart.

## First: Finish PR #1230

PR: https://github.com/csuzngjh/principles/pull/1230

Branch: `codex/pri-516-openclaw-prompt-contract`

Current head at document creation: `c6938917`.

The branch fixes a P1 data-loss path: a retry run is marked processed only after
turn-index calculation and synchronous signal collection succeed. The regression
is fail -> retry succeeds -> third identical run is skipped. ERR-079 recurrence
is recorded on PRI-516.

Before any change, fetch every PR comment, review thread, and check. Retry GitHub
API failures twice. The historical CodeQL and session-ID logging findings are
resolved. Re-check current status because a new CodeRabbit run was pending when
this document was written.

```bash
git switch codex/pri-516-openclaw-prompt-contract
git pull --ff-only origin codex/pri-516-openclaw-prompt-contract
gh pr view 1230 --json comments,reviews,latestReviews,files,statusCheckRollup,mergeable,mergeStateStatus,headRefName,baseRefName
gh api repos/cszngjh/principles/pulls/1230/comments --paginate
gh api repos/cszngjh/principles/issues/1230/comments --paginate
gh pr checks 1230
```

Run the focused prompt characterization test, changed-file lint, plugin build or
typecheck, error-handbook checker, and the merge gate where the cloud resources
allow it. Only report it as Owner-merge-ready after all required checks are
green and no valid unresolved P0/P1/P2 findings remain. Do not merge it.

## Then: PRI-518 Deterministic Lineage Investigation

Start only after the Owner has merged #1230. Create a fresh branch from latest
main; do not stack on #1230.

Confirmed defects to reproduce with deterministic local fixtures:

- Ambiguous correction cue `不对` can persist with `correction_detected=0` when
  LLM classification is default-off.
- A later LLM confirmation does not update the existing user turn, while evidence
  readers only query `correction_detected=1`.
- Console keyword CRUD is not a real rollback path: callbacks/API persistence and
  production prompt-host consumption are incomplete.

Do not hide this by adding a hard-coded high-precision phrase. That would lack a
runtime disable path and violates the MVP gate.

Cloud-safe proof uses production-shaped before-prompt fixtures, temporary SQLite,
deterministic fake adapters, an isolated local tool-process failure, and exact-ID
lineage assertions. Do not manually insert rows to bypass a broken stage.

Required assertions:

- exact campaign, session, task, and run IDs;
- exact Owner correction and assistant lineage;
- exactly one pain record per correction;
- non-empty Owner and agent evidence;
- same-source pain/task/run lineage;
- terminal state includes a reason and next action;
- a reviewable agent-behavior candidate exists;
- PD-internal or tool-only failure is not represented as a behavior principle.

Generate `lineage-map.json` as a CI artifact. Stop at the first missing
persistence boundary and report it in PRI-518.

## Open PR Triage

- #1228: retain; strengthen pagination identity and ordering assertions.
- #1226, #1223, #1222: do not merge unchanged; dependency/TypeScript upgrades
  previously broke gates and need a deliberate coordinated migration.
- #1218: re-scope after resolving overlap with #1228; repair its test-reality
  gaps.
- #1217: rebuild cleanly from latest main; current history is contaminated by
  already-merged work.
- #1213: reassess after #1230 because it overlaps prompt-path behavior.
- #1214 through #1216: complete their interrupted deep review before declaring
  any merge-ready.

## Cloud Session Return Checklist

- List every PR comment fetched and its disposition.
- State which PRs are merge-ready, which require updates, and which should close.
- Include exact commands and tests run, generated artifacts, and residual risk.
- Update Linear comments and states.
- State explicitly that no AI merge occurred.
- Produce a new local-only handoff for final OpenClaw and browser acceptance.
