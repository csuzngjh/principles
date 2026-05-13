# Issue tracker: Linear

Issues for this repo live in Linear (`Principles_disciple` team).
All operations use the Linear MCP tools (`mcp__plugin_linear_linear__*`).

## Team

- **Team name:** `Principles_disciple`
- **Team ID:** `5e746d13-253f-43fa-a0e5-716b4da7edcd`

## Conventions

- **Create an issue:** `save_issue` with `title`, `team: "Principles_disciple"`, optional `description`, `labels`, `priority`, `project`.
- **Read an issue:** `get_issue` with `id` (e.g. "PRI-126").
- **List issues:** `list_issues` with filters (`team`, `state`, `assignee`, `label`, `project`).
- **Comment on an issue:** `save_comment` with `issueId` and `body`.
- **Apply labels:** `save_issue` with `id` and `labels` array. Note: labels are **append-only** — once applied they cannot be removed via this parameter.
- **Update status:** `save_issue` with `id` and `state` (e.g. "Backlog", "Todo", "In Progress", "Done").
- **Close:** `save_issue` with `id` and `state: "Done"`.

## When a skill says "publish to the issue tracker"

Create a Linear issue via `save_issue` with team `"Principles_disciple"`.

## When a skill says "fetch the relevant ticket"

Call `get_issue` with the issue identifier (e.g. "PRI-126"). Use `list_comments` for full conversation context.
