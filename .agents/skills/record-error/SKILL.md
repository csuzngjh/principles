---
name: record-error
description: Record AI coding assistant errors into the Error Experience Handbook. Triggers when pr-review finds an AI error, a reviewer points out your mistake, or user says "record error", "log mistake", "记录错误", "add to handbook".
---

# Record Error

Record AI coding assistant errors into `docs/ERROR_EXPERIENCE_HANDBOOK.md` so all AI assistants learn from past mistakes. The handbook is a compact pattern library, not an incident log. Prefer updating an existing generalized lesson over adding a new one.

## Trigger Conditions

1. **pr-review** triage identifies an AI coding error → invoke after fix cycle
2. **Human reviewer** points out an error you made
3. **You discover** your own error (e.g., CI failure from your code)
4. **User asks** to record an error

## Workflow

### Step 1: Normalize the Incident

Write the incident in one sentence:

```text
The assistant <action> in <context>, which caused <risk>.
```

Then extract the generalized failure mode:

```text
When <general condition>, assistants must <preventive rule>, otherwise <general risk>.
```

Do not proceed until the failure mode is broader than a single file, function, or PR.

### Step 2: Similarity and Recurrence Gate

Before assigning a new number, read:
- `docs/ERROR_EXPERIENCE_HANDBOOK.md`
- `references/categories.md`
- `references/entry-format.md`

Search existing entries for:
- same violated invariant
- same missing validation pattern
- same workflow failure
- same prevention rule
- same affected boundary or contract

Choose exactly one action:

1. **Update recurrence** — if an existing ERR already teaches the same prevention rule.
2. **Broaden existing entry** — if an existing ERR is too narrow but covers the same root cause.
3. **Add new ERR** — only if the prevention rule is materially different from all existing entries.

New ERR entries are forbidden when they only change the file name, command name, or symptom while sharing the same root cause.

### Step 3: Quality Gate

Every new or updated lesson must pass all checks:

- **Generalized**: title names the failure mode, not just the incident.
- **Actionable**: "How to prevent" can be checked during PR review in under 30 seconds.
- **Testable**: includes a regression test or static guard that would catch recurrence.
- **Bounded**: one root cause per entry; one new ERR per root cause per PR.
- **Linked**: references related ERR IDs when this belongs to a pattern group.
- **Non-duplicative**: explains why this is not covered by an existing ERR, or updates that ERR instead.

If these checks fail, do not add a new ERR. Update recurrence or broaden an existing entry.

### Step 4: Classify

Read the error category table in `references/categories.md` and assign one primary category:
1. Architecture Boundary | 2. Missing Tests | 3. Schema & Type | 4. Doc & Spec Drift | 5. Security | 6. Process & Workflow

If the incident spans categories, choose the category of the prevention rule, not the symptom.

### Step 5: Assign Number (Only for New ERR)

Read handbook Statistics section. Next = `ERR-{total+1}`, zero-padded to at least 3 digits (ERR-001 through ERR-999). If total exceeds 999, extend to 4 digits (ERR-1000).

If updating recurrence or broadening an existing entry, keep the existing ERR number.

### Step 6: Linear Comment

Add comment on the related Linear issue using the entry format in `references/entry-format.md`. Use the Linear MCP save_comment tool with the issue ID.

### Step 7: Tag Issue

Add `lesson-learned` label via the Linear MCP save_issue tool with `labels: ["lesson-learned"]`.

### Step 8: Edit Handbook

Edit `docs/ERROR_EXPERIENCE_HANDBOOK.md`:

For a new ERR:
1. Add row to the relevant category table: `| ERR-XXX | <generalized summary> | <issue ID> |`
2. Add detailed entry in "Detailed Entries" section using `references/entry-format.md`
3. Update Statistics: increment Total lessons, update Last updated, update Top category if needed

For recurrence:
1. Update the existing detailed entry's `Recurrence` field with date, issue, and short note
2. Add the source issue to the category row if useful
3. Update Statistics: Last updated and Recurring errors

For broadening:
1. Rename the summary if needed to make it less incident-specific
2. Update "How to prevent" to cover the broader rule
3. Add the new incident to Recurrence

Do not create multiple entries for several comments that share one root cause. Group them into one generalized entry.

### Step 9: Commit & PR

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
2. Group all review findings by root cause
3. Invoke record-error once per root cause, not once per comment
4. Prefer recurrence updates over new ERR entries when the prevention rule already exists
5. pr-review fixes the immediate issue; record-error prevents recurrence

## Checklist

- [ ] Incident normalized into a generalized failure mode
- [ ] Existing ERR entries checked for same root cause/prevention rule
- [ ] Decision made: recurrence update, broaden existing, or new ERR
- [ ] Quality gate passed (generalized, actionable, testable, bounded, linked, non-duplicative)
- [ ] Error classified by prevention rule (category 1-6)
- [ ] ERR-XXX assigned only if new entry is justified
- [ ] Linear comment added (full entry format)
- [ ] `lesson-learned` label applied
- [ ] Category table row added or existing row updated
- [ ] Detailed entry added or recurrence/broadening updated
- [ ] Statistics updated
- [ ] Commit + PR created (NOT merged)
