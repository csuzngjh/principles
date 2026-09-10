---
name: linear-cli
description: Operate Linear issues through a local CLI with stable JSON output. Use for the AI development lifecycle (context / start / handoff / reconcile / audit) and for low-level Linear CRUD (read, create, comment, status, label, assign, link, search).
---

# Linear CLI

Use this skill for Linear work instead of MCP. MCP auth can time out or require interactive OAuth; this CLI uses `LINEAR_API_KEY` and prints stable JSON. It auto-retries transient failures (network errors, 5xx, 429) with exponential backoff and a 30s per-request timeout.

## Canonical source — where the code actually lives

**Single maintenance source: `scripts/linear-cli/` in the principles repository.**

```
D:/Code/principles/scripts/linear-cli/
  linear.cjs              # entry + dispatch
  SKILL.md                # this file (canonical copy)
  sync-skill-copies.mjs   # copies the source into the installed skill dirs
  lib/client.cjs          # token resolution + GraphQL transport (retry/timeout)
  lib/linear.cjs          # bounded queries + context assembly + mutations
  lib/github.cjs          # gh / git wrappers for PR verification
  lib/reconcile.cjs       # Linear × GitHub drift rules (pure)
  lib/audit.cjs           # workspace hygiene rules (pure)
```

The installed copies at `~/.workbuddy/skills/linear-cli/` and `~/.agents/skills/linear-cli/` are **derived artifacts**. They used to be two independent hand-edited copies (PRI-722 Reality Audit). Do **not** edit them directly — edit the repository copy and sync:

```bash
node scripts/linear-cli/sync-skill-copies.mjs           # write
node scripts/linear-cli/sync-skill-copies.mjs --check   # detect drift (exit 1)
```

Windows: always forward slashes in the script path.

```powershell
node "C:/Users/Administrator/.agents/skills/linear-cli/scripts/linear.cjs" context PRI-722
```

## API key — do NOT ask the user for it

The key is persisted. `resolveToken()` order:

1. `LINEAR_API_KEY` env var;
2. `~/.linear_api_key` (also `%USERPROFILE%/.linear_api_key`, `~/.config/linear/api_key`);
3. an `export LINEAR_API_KEY=...` line in `~/.bashrc`.

Just run the script. If it returns `missing_linear_api_key`, all three are empty — only then ask.

Windows gotcha: `setx` / a UI-set user env var is not visible to already-running processes, which is why the key-file fallback exists. The Bash tool also spawns a fresh shell per call and does not source `~/.bashrc`.

## Output contract

stdout contains **exactly one JSON object**. Failures:

```json
{ "ok": false, "reason": "machine_readable_reason", "nextAction": "what to do next", "details": {} }
```

Exit code is 1 on failure. `reason` values are stable — branch on them, never on prose.

## Recommended lifecycle

```text
linear context PRI-xxx        ← ALWAYS read this before coding
        ↓
linear start PRI-xxx          ← guarded transition to In Progress
        ↓
investigate / implement / verify
        ↓
create PR (never auto-merged by this CLI)
        ↓
linear handoff PRI-xxx --pr <url>
```

Periodic governance:

```text
linear reconcile              ← DRY RUN by default
linear reconcile --apply      ← only deterministic fixes
linear audit                  ← read-only hygiene report
```

### `context PRI-xxx` — the default read entry point

Returns one bounded task context in a single call instead of a dozen CRUD calls: identifier, title, description (capped), priority, status, assignee, parent, direct children, project + project goal, cycle, blocks/blockedBy/related/duplicates, recent comments, attachments, detected PRs, recommended branch, `canStart`, `blockingReasons`.

```powershell
node "C:/Users/Administrator/.agents/skills/linear-cli/scripts/linear.cjs" context PRI-722
node ".../linear.cjs" context PRI-722 --comments 3 --children 10 --description-chars 800
```

Size control is built in: four small GraphQL queries, each independently capped (`--children`, `--relations`, `--comments`, `--attachments`, `--description-chars`, `--comment-chars`). `meta.truncated` shows which connections were cut. This is deliberate — one giant query trips Linear's complexity limit.

`canStart` / `blockingReasons` are computed from state type and unresolved `blockedBy` relations, not from comment text.

### `start PRI-xxx` — guarded, fail-closed

```text
context → canStart? → no  ⇒ fail closed (no mutation)
                    → yes ⇒ In Progress
```

Refuses `Done` / `Canceled` / `Duplicate` / unresolved blocker (`reason` = `issue_completed`, `issue_canceled`, `issue_duplicate`, `blocked_by_open_issue`).

It **never** overwrites assignee, priority or description, and never clears a blocker. It is idempotent — already-In-Progress is a no-op.

A start comment is **opt-in** (`--comment` / `--comment-file`) because an unconditional comment is ceremony with no content.

### `handoff PRI-xxx --pr <url>` — deliver to review

1. verifies the PR really exists via `gh` (never infers it);
2. verifies the PR belongs to the expected repo;
3. requires the issue key in the PR branch/title, or an existing Linear attachment (override with `--allow-unlinked`);
4. moves the issue to `In Review` (idempotent);
5. adds the PR link as a Linear attachment only if missing;
6. writes a Chinese evidence summary only when supplied via `--summary` / `--summary-file`, and only once per PR (keyed on a machine marker, not on parsed prose).

Never merges. If the GitHub integration already did the state change or the link, it verifies and backfills only what is missing.

```powershell
node ".../linear.cjs" handoff PRI-722 --pr https://github.com/csuzngjh/principles/pull/1595 --summary-file handoff.md
```

### `reconcile` — Linear × GitHub drift

**Dry-run by default.** Only `--apply` writes, and only `deterministicActions`.

Output is split into `deterministicActions` / `warnings` / `manualReview`:

| Situation | Result |
|---|---|
| PR merged, issue not Done (link from attachment) | `deterministicActions` → `Done` |
| PR open, issue still Todo/Backlog | `warnings` — never auto-starts |
| Issue Done, PR still open | `manualReview` (high risk) |
| PR closed unmerged | `manualReview` — never auto-cancels |
| Several PRs for one issue | `manualReview` — conservative |

Issue↔PR linkage comes from Linear attachments (authoritative). Branch/title mentions are heuristic and can **never** justify an automatic write.

### `audit` — hygiene report, read-only

Reports only; mutates nothing. Checks include: active issue without Project, a large issue acting as a Project, Project without a goal, In Review without PR, merged PR but issue not Done, In Progress with unresolved blockers, native priority duplicated by a `priority:*` label, `blocked` label without a real relation, completed issue still acting as the entry point, parent/child project mismatch, and AI-added governance text that is not Chinese.

The Chinese check is heuristic and keys on English function words, so `RuleCode`, `runtimeProfile`, `Prompt`, `GraphQL`, `PR`, `API`, `CLI`, `MCP` are **not** violations. Findings are `severity: low` and say so explicitly.

## Low-level CRUD (unchanged, still available)

```powershell
node ".../linear.cjs" search "diagnostician split" --limit 20
node ".../linear.cjs" issue PRI-365 [--comments]
node ".../linear.cjs" comments PRI-365
node ".../linear.cjs" list --state Todo --limit 30 [--label x] [--assignee me]
node ".../linear.cjs" states
node ".../linear.cjs" labels PRI-365            # labels on an issue
node ".../linear.cjs" labels-all                # all workspace labels
node ".../linear.cjs" label PRI-365 add|remove <name>
node ".../linear.cjs" comment PRI-365 --body-file comment.md
node ".../linear.cjs" status PRI-365 "In Review"
node ".../linear.cjs" priority PRI-365 2        # 0=None 1=Urgent 2=High 3=Medium 4=Low
node ".../linear.cjs" assign PRI-365 me | user@example.com | --remove
node ".../linear.cjs" subissue PRI-451 PRI-453
node ".../linear.cjs" create --title "..." --description-file body.md --priority 2 --label a,b --assignee me --parent PRI-100
```

`label add/remove` resolves by name and preserves other labels (Linear's `labelIds` is replace-semantics, so the CLI does read-modify-write).

## Environment

- `LINEAR_API_KEY` — required.
- `LINEAR_TEAM_ID` — optional, defaults to the Principles_disciple team.
- `LINEAR_GRAPHQL_URL` — optional, defaults to `https://api.linear.app/graphql`.
- `LINEAR_TIMEOUT_MS` — optional, default 30000.
- `PD_GITHUB_REPO` — optional; otherwise parsed from the git `origin` remote.

Requires `gh` (authenticated) for `handoff` / `reconcile` / `audit`. On Windows, `APPDATA` may need to point at the real Roaming directory for `gh` to find its config.

## Error handling

- `missing_linear_api_key` — all three token sources are empty.
- `linear_transient_failed` — 3 retries already exhausted; wait and re-run.
- `linear_graphql_error` — check id, state name, permissions, or Linear status.
- `state_not_found` / `label_not_found` / `assignee_not_found` — run `states` / `labels-all` first.
- `issue_not_found` / `parent_not_found` / `child_not_found` — verify the identifier.
- `pr_not_found` / `pr_repo_mismatch` / `pr_key_not_linked` — PR verification failed; no Linear state was changed.
- `blocked_by_open_issue` / `issue_completed` / `issue_canceled` / `issue_duplicate` — `start` refused; nothing was mutated.

No SDK dependency: the CLI calls the Linear GraphQL API with Node's built-in `fetch`. Do not introduce `@linear/sdk` here — the global 94→95 upgrade belongs to `linear-mcp`, not to this CLI.

Do not paste tokens into commands or docs.
