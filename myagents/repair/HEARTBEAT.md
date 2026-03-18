# HEARTBEAT

Repair heartbeat should stay mostly silent.

## First checks

1. Read `TEAM_ROLE.md`
2. Read `REPAIR_OPERATING_PROMPT.md`
3. Read `./.team/governance/WORK_QUEUE.md`

## Use these skills when needed

- global skill `context-rebuild` (normally `~/.openclaw/skills/context-rebuild/SKILL.md`)
- global skill `repair-execution` (normally `~/.openclaw/skills/repair-execution/SKILL.md`)

## Actions

- Only act when there is an explicit `Repair Task`
- If there is no bounded task, reply `HEARTBEAT_OK`

## Red lines

- do not self-assign work
- do not widen scope silently
