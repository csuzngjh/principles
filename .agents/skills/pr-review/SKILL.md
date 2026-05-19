---
name: pr-review
description: Deep PR code review with automated issue detection, reviewer feedback integration, and fix-verify-push cycle. Use when asked to "review PR", "code review", "check PR quality", "fix review comments", "ensure CI green", or any PR quality assurance task.
---

# PR Review

Deep PR code review with 7-phase workflow covering parallel info fetch, diff-based review, triage, fix, verify, push, and CI gate check.

## When to Trigger

1. User asks to review a PR ("review this PR", "code review", "check PR quality")
2. User wants to fix review comments on an existing PR
3. User needs CI gate verification before merge
4. User says "ensure CI green" or "fix CI failures"

## Workflow

### Phase 1: Gather

Fetch PR info in parallel:
- PR diff (`gh pr diff`)
- PR metadata (`gh pr view --json`)
- Reviewer comments (`gh api repos/{owner}/{repo}/pulls/{number}/comments`)
- CI status (`gh pr checks`)
- Changed files list

### Phase 2: Triage Review Comments

Classify each reviewer comment:
- **Real bug**: Must fix — code is incorrect or breaks functionality
- **Style preference**: Optional — suggest but don't block
- **Misunderstanding**: Respond with explanation, no code change needed
- **AI coding error**: If the error was made by an AI assistant → invoke `record-error` skill after fixing

### Phase 3: Deep Diff Review

Review the diff against a structured checklist:
- Correctness: Logic errors, off-by-one, null handling
- Security: SQL injection, LLM trust boundary violations, credential leaks
- Type safety: Missing type checks, unsafe casts
- Architecture: Core/plugin boundary violations, ADR compliance
- Performance: N+1 queries, unnecessary re-renders, blocking operations
- Testing: Missing tests for changed behavior

### Phase 4: Fix Real Issues

Fix only real bugs and required changes:
1. Create fix branch from PR branch
2. Apply minimal, targeted fixes
3. Add regression tests for each fix
4. Run local build + lint + typecheck

### Phase 5: Verify

Run the full verification suite:
```bash
npm run build && npm run test && npm run lint
```

If failures: fix and re-verify until green.

### Phase 6: Push & CI Gate

```bash
git push
gh pr checks --watch
```

Wait for CI to pass. If CI fails: read logs, fix, push again.

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
- Issues found and fixed
- Issues deferred (with reason)
- CI status
- Remaining reviewer comments to address

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
- [ ] Real issues fixed with regression tests
- [ ] Build + lint + test pass locally
- [ ] CI gate passes
- [ ] Real issues recorded via `record-error` (Phase 6.5) — or explicitly noted "no real issues"
- [ ] Report delivered
