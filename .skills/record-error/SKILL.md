---
name: record-error
description: Record AI coding assistant errors found during code review into the Error Experience Handbook. Use when a code review (especially pr-review skill) catches an AI assistant mistake, when user says "record error", "log mistake", "记录错误", "错误记录", "add to handbook", or when you discover you made an error that a reviewer pointed out. Integrates with pr-review skill — triggered automatically when pr-review triage identifies an AI coding error.
---

# Record Error

## Overview

Record AI coding assistant errors into the project's Error Experience Handbook (`docs/ERROR_EXPERIENCE_HANDBOOK.md`). This skill ensures every mistake is systematically captured so all AI assistants (Claude Code, Codex CLI, Gemini CLI, etc.) learn from past errors and avoid repeating them.

## When to Trigger

This skill is triggered when:

1. **pr-review skill** finds an AI coding error during its triage phase — invoke `record-error` immediately after triage
2. **Human reviewer** points out an error you made during code review
3. **You discover** your own error after the fact (e.g., CI failure caused by your code)
4. **User explicitly asks** to record an error ("记录错误", "record this error", "add to handbook")

## Workflow

### Step 1: Classify the Error

Determine which category the error belongs to:

| Category | Description | Examples |
|----------|-------------|----------|
| 1. Architecture Boundary | Violated core/plugin boundary or architectural constraints | Put I/O logic in core, put pure logic in plugin |
| 2. Missing Tests & Verification | Skipped required testing or verification steps | Didn't run tests, didn't add regression test |
| 3. Schema & Type Mistakes | Incorrect schemas, missed type safety, broke type contracts | Used `any`, wrong interface shape |
| 4. Documentation & Spec Drift | Code contradicts architecture docs or ADRs | Ignored ADR-0005, wrote code against documented decision |
| 5. Security & Safety | Introduced security risks or bypassed safety checks | Hardcoded secrets, skipped auth check |
| 6. Process & Workflow | Didn't read context, didn't follow workflow | Skipped handbook, didn't check graphify first |

### Step 2: Assign ERR-XXX Number

Read `docs/ERROR_EXPERIENCE_HANDBOOK.md` and check the Statistics section for the current total. The next number is `ERR-{total+1}` (zero-padded to 3 digits, e.g., ERR-001, ERR-002).

### Step 3: Add Linear Comment

Add a comment on the related Linear issue using this format:

```markdown
**[ERR-XXX]** | <one-line summary>

- **What happened**: <what the AI assistant did wrong>
- **Why it's wrong**: <violated constraint, unread doc, or root cause>
- **Correct approach**: <what should have been done instead>
- **How to prevent**: <concrete check or rule>
- **Source**: <Linear issue ID, e.g., PRI-147>
- **Date**: <YYYY-MM-DD>
- **Recurrence**: <if same pattern recurred, note date and issue>
```

Use `mcp_linear_save_comment` with the issue ID.

### Step 4: Tag the Issue

Add the `lesson-learned` label to the Linear issue using `mcp_linear_save_issue` with the issue ID and `labels: ["lesson-learned"]`.

### Step 5: Edit the Handbook

Edit `docs/ERROR_EXPERIENCE_HANDBOOK.md`:

1. **Add a row** to the relevant category table:
   ```
   | ERR-XXX | <one-line summary> | <Source issue ID> |
   ```

2. **Add a detailed entry** at the bottom of the "Detailed Entries" section using the full format from Step 3.

3. **Update Statistics**:
   - Increment `Total lessons` by 1
   - Update `Last updated` to today's date
   - Update `Top category` if this category now has the most entries
   - Increment `Recurring errors` if this is a recurrence of a previous error

### Step 6: Commit and Create PR

```bash
git checkout -b docs/err-XXX
git add docs/ERROR_EXPERIENCE_HANDBOOK.md
git commit -m "docs: add ERR-XXX to error experience handbook"
git push origin docs/err-XXX
gh pr create --title "docs: add ERR-XXX to error experience handbook" --body "Record error ERR-XXX found during code review."
```

**Do NOT merge the PR.** The user must merge manually.

## Integration with pr-review

When using the `pr-review` skill and its triage phase identifies an AI coding error:

1. Complete the pr-review fix cycle first
2. Then invoke `record-error` to capture the lesson
3. Both skills work together: pr-review fixes the immediate issue, record-error prevents recurrence

## Checklist

Before finishing, verify:

- [ ] Error classified into correct category (1-6)
- [ ] ERR-XXX number assigned (sequential, zero-padded)
- [ ] Linear comment added with full entry format
- [ ] `lesson-learned` label applied to the issue
- [ ] Category table row added in handbook
- [ ] Detailed entry added in handbook
- [ ] Statistics updated in handbook
- [ ] Commit created with conventional commit message
- [ ] PR created (NOT merged)
