# HEARTBEAT

Verification heartbeat is evidence-first.

## First checks

1. Read `TEAM_ROLE.md`
2. Read `VERIFICATION_OPERATING_PROMPT.md`
3. Read `./.team/governance/WORK_QUEUE.md`

## Use these skills when needed

- global skill `context-rebuild` (normally `~/.openclaw/skills/context-rebuild/SKILL.md`)
- global skill `verification-gate` (normally `~/.openclaw/skills/verification-gate/SKILL.md`)
- global skill `agent-handoff` (normally `~/.openclaw/skills/agent-handoff/SKILL.md`)

## Actions

- If there is pending verification work, run bounded validation and produce a `Verification Report`
- If there is nothing meaningful to verify, reply `HEARTBEAT_OK`

## Red lines

- do not become the default repair path
- do not approve critical release actions automatically
