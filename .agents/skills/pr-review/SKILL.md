---
name: pr-review
description: Deep PR code review with automated issue detection, reviewer feedback integration, and fix-verify-push cycle. Use when asked to "review PR", "code review", "check PR quality", "fix review comments", "ensure CI green", or any PR quality assurance task.
---

# PR Review

Deep PR code review with an iterative fetch → triage → fix → verify → push → re-fetch loop. The goal is to remove the user from the reviewer-comment relay path: once invoked on a PR, the reviewer agent must fetch comments itself, fix every valid P0/P1/P2 issue, push, and re-check until no blocking findings remain.

## When to Trigger

1. User asks to review a PR ("review this PR", "code review", "check PR quality")
2. User wants to fix review comments on an existing PR
3. User needs CI gate verification before merge
4. User says "ensure CI green" or "fix CI failures"

## Workflow

### Phase 1: Gather

Fetch PR info in parallel. Retry GitHub API failures at least 2 times before asking the user to paste comments:
- PR diff (`gh pr diff <PR>`)
- Changed files (`gh pr diff <PR> --name-only`)
- PR metadata (`gh pr view <PR> --json comments,reviews,latestReviews,files,statusCheckRollup,mergeable,headRefName,baseRefName`)
- Review comments (`gh api repos/:owner/:repo/pulls/<PR>/comments --paginate`)
- Issue comments (`gh api repos/:owner/:repo/issues/<PR>/comments --paginate`)
- CI status (`gh pr checks <PR>` or the `statusCheckRollup` payload)

Stop early and report if the PR diff contains unrelated files or stale-main rollback risk.

### Phase 2: Triage Review Comments

Classify each reviewer comment:
- **P0/P1/P2 real bug**: Must fix — code is incorrect, unsafe, unobservable, or breaks project contracts
- **P3/nit/style preference**: Optional — fix if cheap, otherwise defer with reason
- **Duplicate**: Already fixed or covered by another finding
- **Misunderstanding**: No code change; respond with exact code/test evidence
- **AI coding error**: If the error was made by an AI assistant → invoke `record-error` skill after fixing

Maintain a review ledger in the final report:
- total comments fetched
- valid fixed
- deferred with reason
- duplicates/misunderstandings with evidence

### Phase 3: Deep Diff Review

Review the diff against a structured checklist:
- Correctness: Logic errors, off-by-one, null handling
- Security: SQL injection, LLM trust boundary violations, credential leaks
- Type safety: Missing type checks, unsafe casts
- Architecture: Core/plugin boundary violations, ADR compliance
- Performance: N+1 queries, unnecessary re-renders, blocking operations
- Testing: Missing tests for changed behavior

For CLI/operator changes under `packages/pd-cli/src/commands/**` or CLI registration, also apply the CLI gate:
- `--json` emits exactly one parseable JSON object on stdout
- every `process.exit(...)` path immediately `return`s or throws
- failure paths do not continue into DB/ledger/artifact side effects when `process.exit` is stubbed
- Commander `--no-*`, `--dry-run`, and `--confirm` behavior has parser or command-registration tests
- failed/degraded/refused JSON outputs include structured reason and nextAction
- state mutation happens through the intended service path, not direct status flipping

### Phase 4: Fix Real Issues

Fix only real bugs and required changes:
1. Create fix branch from PR branch
2. Apply minimal, targeted fixes
3. Add regression tests for each fix
4. Run local build + lint + typecheck

Do not expand scope. Do not refactor adjacent code unless required to fix the finding. Do not touch frozen legacy files unless the user explicitly approves.

### Phase 5: Verify

Run the relevant verification suite first, then the repository merge gate when available:
```bash
npm run verify:merge
```

If failures: fix and re-verify until green.

For narrow local debugging, run the smallest test command that covers the fix before the full gate.

### Phase 6: Push, Re-fetch, and CI Gate

```bash
git push
gh pr view <PR> --json comments,reviews,latestReviews,files,statusCheckRollup
gh api repos/:owner/:repo/pulls/<PR>/comments --paginate
gh api repos/:owner/:repo/issues/<PR>/comments --paginate
gh pr checks <PR>
```

After every push, re-fetch comments and checks. If new valid P0/P1/P2 comments appear, return to Phase 2. A PR is not ready until:
- no valid unresolved P0/P1/P2 comments remain
- required CI checks are green, or any failing check is explained as unrelated infrastructure
- the final report states that comments were re-fetched after the last push

### Phase 6.5: Record Errors (MANDATORY)

After CI passes and before the final report, you MUST check whether any real issues were found during this review (Phase 2 or Phase 3). If yes, invoke the `record-error` skill for EACH real issue.

**This step is NOT optional.** Even if the fix was already applied, the error must be recorded to prevent recurrence.

Steps:
1. List all real issues found during Phase 2 (reviewer comments) and Phase 3 (deep diff review)
2. For each real issue that represents an AI coding error (type safety bug, logic error, architecture violation, etc.):
   - Invoke `record-error` skill immediately
   - The skill handles: classify → number → Linear comment → tag `lesson-learned` → edit handbook → update stats → commit & PR
3. Do NOT skip this step even if you are tired, rushed, or think the error is "obvious"
4. If no real issues were found, explicitly state "No real issues found — skipping record-error" in your report

**Why this is mandatory:** Without recording, the same class of error will recur across sessions. The Error Experience Handbook is the project's institutional memory.

### Phase 7: Report

Summarize:
- PR URL and issue ID
- Review loop counts: comments fetched, valid fixed, deferred, duplicates/misunderstandings
- Issues found and fixed
- Issues deferred, with reason and follow-up if needed
- Tests and CI status
- For CLI/operator PRs: JSON-only stdout, exit-path, flag-wiring, and failure no-mutation evidence
- Whether `record-error` was invoked, or "No real issues found — skipping record-error"
- Remaining risk

**Do NOT merge the PR.** User merges manually.

## Integration with record-error

When Phase 2 or 3 identifies an AI coding error:
1. Complete the fix cycle first (Phases 4-6)
2. Then invoke `record-error` skill for EACH real issue found (Phase 6.5)
3. This is MANDATORY — do not skip even if the fix was trivial
4. This prevents the same AI mistake from recurring across sessions

## Checklist

- [ ] PR diff and metadata gathered
- [ ] Reviewer comments triaged
- [ ] Deep diff review completed
- [ ] CLI/operator gate applied when relevant
- [ ] Real issues fixed with regression tests
- [ ] Build + lint + test pass locally
- [ ] Changes pushed
- [ ] PR comments and checks re-fetched after the last push
- [ ] CI gate passes
- [ ] Real issues recorded via `record-error` (Phase 6.5) — or explicitly noted "no real issues"
- [ ] Report delivered
