---
name: record-error
description: Record AI coding assistant errors into the Error Experience Handbook. Triggers when pr-review finds an AI error, a reviewer points out your mistake, or user says "record error", "log mistake", "记录错误", "add to handbook".
---

# Record Error

Record AI coding assistant errors into `docs/ERROR_EXPERIENCE_HANDBOOK.md` so all AI assistants learn from past mistakes.

## Trigger Conditions

1. **pr-review** triage identifies an AI coding error → invoke after fix cycle
2. **Human reviewer** points out an error you made
3. **You discover** your own error (e.g., CI failure from your code)
4. **User asks** to record an error

## Workflow

### Step 1: Classify

Read the error category table in `references/categories.md` and assign one of:
1. Architecture Boundary | 2. Missing Tests | 3. Schema & Type | 4. Doc & Spec Drift | 5. Security | 6. Process & Workflow

### Step 2: Assign Number

Read handbook Statistics section. Next = `ERR-{total+1}`, zero-padded to at least 3 digits (ERR-001 through ERR-999). If total exceeds 999, extend to 4 digits (ERR-1000).

### Step 3: Linear Comment

Add comment on the related Linear issue using the entry format in `references/entry-format.md`. Use the Linear MCP save_comment tool with the issue ID.

### Step 4: Tag Issue

Add `lesson-learned` label via the Linear MCP save_issue tool with `labels: ["lesson-learned"]`.

### Step 5: Edit Handbook

Edit `docs/ERROR_EXPERIENCE_HANDBOOK.md`:

1. Add row to the relevant category table: `| ERR-XXX | <summary> | <issue ID> |`
2. Add detailed entry in "Detailed Entries" section (use format from Step 3)
3. Update Statistics: increment Total lessons, update Last updated, update Top category if needed, increment Recurring errors if recurrence

### Step 6: Commit & PR

```bash
git checkout -b docs/err-XXX
git add docs/ERROR_EXPERIENCE_HANDBOOK.md
git commit -m "docs: add ERR-XXX to error experience handbook"
git push origin docs/err-XXX
gh pr create --title "docs: add ERR-XXX to error experience handbook" --body "Record error ERR-XXX found during code review."
```

**Do NOT merge the PR.** User merges manually.

## pr-review Integration

When pr-review triage finds an AI error:
1. Complete the pr-review fix cycle first
2. Then invoke record-error to capture the lesson
3. pr-review fixes the immediate issue; record-error prevents recurrence

## Checklist

- [ ] Error classified (category 1-6)
- [ ] ERR-XXX assigned (sequential, zero-padded)
- [ ] Linear comment added (full entry format)
- [ ] `lesson-learned` label applied
- [ ] Category table row added
- [ ] Detailed entry added
- [ ] Statistics updated
- [ ] Commit + PR created (NOT merged)
