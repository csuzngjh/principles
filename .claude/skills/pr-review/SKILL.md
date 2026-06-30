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

### Phase 7: Report

Summarize:
- Issues found and fixed
- Issues deferred (with reason)
- CI status
- Remaining reviewer comments to address

**Do NOT merge the PR.** User merges manually.

### Phase 8: Proactive Guideline Update（主动 Review Loop）

评审输出使用中文。在 Phase 7 报告后，主动评估是否需要更新治理资产：

1. **发现值得重复的好决策** → 建议创建 exemplar
   - 路径：`docs/.private/exemplars/pr-{name}.md`
   - 格式见 `docs/.private/exemplars/README.md`
   - 引用规则 ID：`rc-*` / `cli-*` / `mvp-q-*` / `antipattern-*`

2. **发现规则缺失或过时** → 建议更新 AGENTS.md 对应段
   - 例如：某场景反复出现但无对应规则 → 提议新增 `rc-*` 或 `antipattern-*`

3. **发现错误** → 触发 `record-error` skill（现有流程，见下方 Integration）

**注意**：Phase 8 是建议性的，不阻塞 PR 合并。仅在报告中提出建议，由 owner 决定是否采纳。

## Integration with record-error

When Phase 2 or 3 identifies an AI coding error:
1. Complete the fix cycle first (Phases 4-6)
2. Then invoke `record-error` skill to capture the lesson
3. This prevents the same AI mistake from recurring

## Checklist

- [ ] PR diff and metadata gathered
- [ ] Reviewer comments triaged
- [ ] Deep diff review completed
- [ ] Real issues fixed with regression tests
- [ ] Build + lint + test pass locally
- [ ] CI gate passes
- [ ] Report delivered
- [ ] If AI error found → `record-error` invoked
- [ ] Phase 8: 评估是否需要创建 exemplar 或更新 guideline（建议性）
