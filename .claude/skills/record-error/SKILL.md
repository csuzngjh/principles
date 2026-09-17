---
name: record-error
description: Record AI coding assistant errors into the structured ERR records tree. Triggers when pr-review finds an AI error, a reviewer points out your mistake, or user says "record error", "log mistake", "记录错误", "add to handbook".
---

# Record Error

Record AI coding assistant errors into `docs/process/error-management/records/` —
the structured ERR records tree that is the single write authority since the
PRI-799 Phase C cutover (2026-09-17). All writes go through
`npm run error:record`. Never hand-edit record files, and never edit the frozen
legacy snapshots `ERROR_EXPERIENCE_HANDBOOK.md` / `ERROR_ARCHIVE.md`.

## Trigger Conditions

1. **pr-review** triage identifies an AI coding error → invoke after fix cycle
2. **Human reviewer** points out an error you made
3. **You discover** your own error (e.g., CI failure from your code)
4. **User asks** to record an error

## Workflow

### Step 1: Similarity Gate (ENFORCED)

Before creating a new pattern, you MUST:

1. Read `docs/process/error-management/ERROR_PATTERN_INDEX.md` — check if any EP card's "Failure mode" matches your incident.
2. If a match exists → you MUST add an occurrence to one of the EP card's "Representative ERRs" (`error:record add-occurrence`), NOT create a new ERR.
3. Only if NO EP card covers the failure mode → consider a new ERR + new EP card.

**Hard rule**: If the incident's prevention rule can be stated as "When <X>, use <Y> instead of <Z>", and an existing ERR already teaches this exact rule → occurrence, not a new pattern.

**Self-check before adding**: "Could a reviewer confuse my new ERR with an existing one?" If yes → do not add. To scan existing patterns: `ls docs/process/error-management/records/patterns/` and grep titles in the `<!-- pd-error-record -->` blocks.

### Step 2: Classify

Assign one category (exact value required by the validator):

`Architecture Boundary Violations` | `Missing Tests & Verification` | `Schema & Type Mistakes` | `Documentation & Spec Drift` | `Security & Safety` | `Process & Workflow`

Also classify the **pattern + invariant**: which EP card (EP-01..EP-13) does this belong to, and what is the short kebab-case invariant name for the specific failure shape (e.g. `test-asserts-source-substring-not-wiring`)? If this is a recurrence of an existing ERR, the pattern is that ERR's EP card.

### Step 3: Assign Number (new ERR only)

There is no statistics counter. Take the next free display id by scanning the records tree: the current max `ERR-NNN` number + 1 (zero-padded to 3 digits). Duplicate display ids fail loud at validation, so a collision can never merge silently.

```bash
ls docs/process/error-management/records/patterns/ | grep -oE 'ERR-[0-9]+' | sort -V | tail -1
```

### Step 4: Linear Comment

Add a comment on the related Linear issue using the narrative format in `references/entry-format.md`. Use the Linear MCP save_comment tool with the issue ID.

### Step 5: Tag Issue

Add `lesson-learned` label via the Linear MCP save_issue tool with `labels: ["lesson-learned"]`.

### Step 6: Write the Record

The record body is Markdown using the `references/entry-format.md` narrative shape (What happened / Why it's wrong / Correct approach / How to prevent / Source / Date). Write the body to a temp file and pass it via `--body-file`.

**New ERR** (new pattern record):

```bash
npm run error:record create-pattern \
  --display ERR-NNN \
  --title "Generalized failure mode, not the incident" \
  --category "Process & Workflow" \
  --ep EP-02 \
  --source "PRI-YYY / PR #ZZZ" \
  --body-file /tmp/err-nnn-body.md
```

**Recurrence of an existing ERR** (add an occurrence to `P-ERR-NNN`):

```bash
npm run error:record add-occurrence \
  --pattern P-ERR-NNN \
  --date YYYY-MM-DD \
  --source "PRI-YYY / PR #ZZZ" \
  --invariant <kebab-invariant> \
  --severity P0|P1|P2|P3 \
  --escaped <gate-that-was-escaped|none> \
  --caughtBy self-review|pr-review|ci|runtime|owner \
  --guard <none|guard-id> \
  --body "one-sentence recurrence narrative"
```

Field contract (validated fail-loud by the writer):
- `--invariant` — short kebab-case name for the specific failure shape
- `--severity` — P0..P3
- `--escaped` — which gate the error escaped (e.g. `verify-merge`, `ci`, `none` if caught before any gate)
- `--caughtBy` — one of `self-review` | `pr-review` | `ci` | `runtime` | `owner`
- `--guard` — `none`, or the guard id that now mechanizes this invariant (e.g. `check:runtime-contract`)

The five structured fields are stored as first-class occurrence metadata (the successor of the legacy `recurrence-meta` HTML blocks) and are what `npm run error:hotspots` aggregates. Do NOT bulk-backfill them onto historical occurrences — only the ones you record now.

**Archive** (lifecycle flip only — never move Markdown by hand):

```bash
npm run error:record archive --pattern P-ERR-NNN
```

Then update the ERR token in `ERROR_PATTERN_INDEX.md` (`ERR-NNN` → `archived-NNN`) if present. Archiving never touches occurrences or narratives.

### Step 7: Validate & Escalate

1. Run `npm run error:record validate` — the whole tree must pass.
2. Run `npm run check:error-handbook` — it validates records + routing integrity and is the merge gate. There is NO size budget: you never need to free bytes before recording.
3. Run `npm run error:hotspots` — if your occurrence pushes a pattern+invariant to "ENFORCEMENT DECISION REQUIRED" (≥2 recurrences in 90 days, guard `none`), make an explicit enforcement decision and record it as a follow-up: blocking guard / advisory guard / semantic verification obligation (named in the PR's Task Risk Contract) / not-mechanizable with a written reason. The decision may be a follow-up ticket — it must not silently stay `guard: none` forever, and it must NOT auto-expand the current bug-fix PR with a large scanner (scope discipline).

### Step 8: Commit & PR — Git workflow rules (MANDATORY)

Where the error lesson lands depends on where the finding was discovered. Obey AGENTS.md multi-agent git governance throughout (worktree-per-task, one-writer-per-worktree, lease-before-write, primary checkout readonly).

**Case A — finding discovered inside your own un-merged implementation PR (the common case):**
commit fix + lesson TOGETHER in the same task worktree/branch. Do NOT create a second branch:

```bash
# already inside YOUR task worktree, on your task branch
git add docs/process/error-management/records/
git commit -m "docs: record ERR-NNN occurrence (current task lesson)"
# continues with your PR's remaining commits
```

**Case B — original PR already merged, current branch cannot legally take the edit, or the error recording IS the task:**
create a dedicated worktree via the repository mechanism (`npm run dev:worktree -- <id> err-NNN`), acquire the lease, then branch/commit there. Never `git checkout -b` inside a worktree you do not own.

```bash
npm run dev:worktree -- adhoc-errNNN err-NNN
cd <worktree-dir> && npm run dev:lease -- acquire --owner "<task> session"
git add docs/process/error-management/records/
git commit -m "docs: add ERR-NNN pattern record"
git push origin <branch>
gh pr create --title "docs: add ERR-NNN to error experience records" --body "Record error ERR-NNN found during code review."
```

**Do NOT merge the PR.** User merges manually.

## pr-review Integration

When pr-review triage finds an AI error:
1. Complete the pr-review fix cycle first
2. Then invoke record-error to capture the lesson
3. pr-review fixes the immediate issue; record-error prevents recurrence

## Checklist

- [ ] Error classified (category from the 6 exact values)
- [ ] Pattern + invariant classified (EP card + kebab-case invariant)
- [ ] Existing-pattern check done → occurrence, not duplicate pattern
- [ ] ERR-NNN assigned only for a genuinely new pattern (records max + 1)
- [ ] Linear comment added (narrative format)
- [ ] `lesson-learned` label applied
- [ ] `npm run error:record create-pattern` or `add-occurrence` (or `archive`) succeeded
- [ ] Structured occurrence fields supplied together (invariant/severity/escaped/caughtBy/guard)
- [ ] `npm run error:record validate` PASS
- [ ] `npm run check:error-handbook` PASS
- [ ] `npm run error:hotspots` run; escalation decision recorded if flagged
- [ ] Commit landed in the correct worktree (Case A same-branch / Case B dedicated worktree)
- [ ] PR created where applicable (NOT merged)
