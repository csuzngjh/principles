---
name: record-error
description: Record AI coding assistant errors into the Error Experience Handbook. Triggers when pr-review finds an AI error, a reviewer points out your mistake, or user says "record error", "log mistake", "记录错误", "add to handbook".
---

# Record Error

Record AI coding assistant errors into `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` so all AI assistants learn from past mistakes.

## Trigger Conditions

1. **pr-review** triage identifies an AI coding error → invoke after fix cycle
2. **Human reviewer** points out an error you made
3. **You discover** your own error (e.g., CI failure from your code)
4. **User asks** to record an error

## Workflow

### Step 1: Similarity Gate (ENFORCED)

Before assigning a new number, you MUST:

1. Read `docs/process/error-management/ERROR_PATTERN_INDEX.md` — check if any EP card's "Failure mode" matches your incident.
2. If a match exists → you MUST update recurrence on one of the EP card's "Representative ERRs", NOT create a new ERR.
3. Only if NO EP card covers the failure mode → consider a new ERR + new EP card.

**Hard rule**: If the incident's prevention rule can be stated as "When <X>, use <Y> instead of <Z>", and an existing ERR already teaches this exact rule → UPDATE, do not ADD.

**Self-check before adding**: "Could a reviewer confuse my new ERR with an existing one?" If yes → do not add.

### Step 2: Classify

Read the error category table in `references/categories.md` and assign one of:
1. Architecture Boundary | 2. Missing Tests | 3. Schema & Type | 4. Doc & Spec Drift | 5. Security | 6. Process & Workflow

Also classify the **pattern + invariant**: which EP card (EP-01..EP-13) does this recurrence belong to, and what is the short kebab-case invariant name for the specific failure shape (e.g. `test-asserts-source-substring-not-wiring`)? If the recurrence updates an existing ERR, the pattern is that ERR's EP card.

### Step 3: Assign Number

Read handbook Statistics section. Next = `ERR-{total+1}`, zero-padded to at least 3 digits (ERR-001 through ERR-999). If total exceeds 999, extend to 4 digits (ERR-1000).

### Step 4: Linear Comment

Add comment on the related Linear issue using the entry format in `references/entry-format.md`. Use the Linear MCP save_comment tool with the issue ID.

### Step 5: Tag Issue

Add `lesson-learned` label via the Linear MCP save_issue tool with `labels: ["lesson-learned"]`.

### Step 6: Edit Handbook

Edit `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md`:

1. Add row to the relevant category table: `| ERR-XXX | <summary> | <issue ID> |`
2. Add detailed entry in "Detailed Entries" section (use format from Step 3)
3. Update Statistics: increment Total lessons, update Last updated, update Top category if needed, increment Recurring errors if recurrence
4. **Recurrence truncation**: Keep at most the 3 most recent recurrence descriptions in full. For older recurrences, retain only `date + issue ID + one-sentence summary` (≤ 100 chars). Preserve the total count.
5. **Structured recurrence metadata (MANDATORY for recurrences recorded from 2026-09-10)**: every recurrence line you add or update must be immediately followed by a `recurrence-meta` HTML-comment JSON block, adjacent to its narrative:

```md
- 2026-09-10 PR #1600: one-sentence recurrence narrative.
  <!-- recurrence-meta
  {
    "date": "2026-09-10",
    "pattern": "EP-09",
    "invariant": "test-asserts-source-substring-not-wiring",
    "severity": "P2",
    "escaped": "verify-merge",
    "caughtBy": "pr-review",
    "guard": "none"
  }
  -->
```

Field contract (validated by `npm run check:error-handbook`):
- `date` — YYYY-MM-DD, the recurrence date
- `pattern` — the EP card id (must exist in ERROR_PATTERN_INDEX.md)
- `invariant` — short kebab-case name for the specific failure shape
- `severity` — P0..P3
- `escaped` — which gate the error escaped (e.g. `verify-merge`, `ci`, `none` if caught before any gate)
- `caughtBy` — one of `self-review` | `pr-review` | `ci` | `runtime` | `owner`
- `guard` — `none`, or the guard id that now mechanizes this invariant (e.g. `check:runtime-contract`)

Do NOT bulk-backfill metadata onto historical recurrences — only the ones you record now.

### Step 7: Validate & Escalate

1. Run `npm run check:error-handbook` — it must PASS (it validates your routing/recurrence metadata).
2. Run `npm run error:hotspots` — if your recurrence pushes a pattern+invariant to "ENFORCEMENT DECISION REQUIRED" (≥2 recurrences in 90 days, guard `none`), make an explicit enforcement decision and record it as a follow-up: blocking guard / advisory guard / semantic verification obligation (named in the PR's Task Risk Contract) / not-mechanizable with a written reason. The decision may be a follow-up ticket — it must not silently stay `guard: none` forever, and it must NOT auto-expand the current bug-fix PR with a large scanner (scope discipline).

### Step 8: Commit & PR — Git workflow rules (MANDATORY)

Where the error lesson lands depends on where the finding was discovered. Obey AGENTS.md multi-agent git governance throughout (worktree-per-task, one-writer-per-worktree, lease-before-write, primary checkout readonly).

**Case A — finding discovered inside your own un-merged implementation PR (the common case):**
commit fix + lesson TOGETHER in the same task worktree/branch. Do NOT create a second branch:

```bash
# already inside YOUR task worktree, on your task branch
git add docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md
git commit -m "docs: record ERR-XXX recurrence (current task lesson)"
# continues with your PR's remaining commits
```

**Case B — original PR already merged, current branch cannot legally take the edit, or the error recording IS the task:**
create a dedicated worktree via the repository mechanism (`npm run dev:worktree -- <id> err-XXX`), acquire the lease, then branch/commit there. Never `git checkout -b` inside a worktree you do not own.

```bash
npm run dev:worktree -- adhoc-errXXX err-XXX
cd <worktree-dir> && npm run dev:lease -- acquire --owner "<task> session"
git add docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md
git commit -m "docs: add ERR-XXX to error experience handbook"
git push origin <branch>
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
- [ ] Pattern + invariant classified (EP card + kebab-case invariant)
- [ ] ERR-XXX assigned (sequential, zero-padded)
- [ ] Linear comment added (full entry format)
- [ ] `lesson-learned` label applied
- [ ] Category table row added
- [ ] Detailed entry added
- [ ] Recurrence + `recurrence-meta` structured block added (new recurrences)
- [ ] Statistics updated
- [ ] `npm run check:error-handbook` PASS
- [ ] `npm run error:hotspots` run; escalation decision recorded if flagged
- [ ] Commit landed in the correct worktree (Case A same-branch / Case B dedicated worktree)
- [ ] PR created where applicable (NOT merged)
