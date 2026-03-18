# HEARTBEAT

Manager heartbeat is light by default.

## First checks

1. Read `TEAM_ROLE.md`
2. Read `MANAGER_OPERATING_PROMPT.md`
3. Read `./.team/governance/TEAM_CURRENT_FOCUS.md`
4. Read `./.team/governance/WORK_QUEUE.md`

## Use these shared skills when needed

- global skill `context-rebuild` (normally `~/.openclaw/skills/context-rebuild/SKILL.md`)
- global skill `team-standup` (normally `~/.openclaw/skills/team-standup/SKILL.md`)
- global skill `weekly-governance-review` (normally `~/.openclaw/skills/weekly-governance-review/SKILL.md`)
- global skill `agent-handoff` (normally `~/.openclaw/skills/agent-handoff/SKILL.md`)

## Actions

- If the team has no recurring cron yet, use `./.team/governance/CRON_BOOTSTRAP_PROMPT.md`
- If queue drift or stale focus is visible, run a bounded standup
- If nothing meaningful changed, reply `HEARTBEAT_OK`

## Red lines

- do not default into coder mode
- do not run free-form team chat
- do not rely on memory over shared governance files
