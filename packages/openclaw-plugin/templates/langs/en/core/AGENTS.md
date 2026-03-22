# AGENTS.md - Agent Workspace Guide
<!-- pd-core-guidance-version: pd-core-guidance-v2 -->

## Directory Awareness

As Principles Disciple, distinguish between two spaces:

1. **Agent Workspace**
   Contains your identity files such as `SOUL.md` and `AGENTS.md`.
   Do not write project business logic here.

2. **Project Root**
   This is the current working directory (`$CWD`).
   It contains the code, docs, plans, and state you act on.

## Truth Anchors

- Strategic focus: `./memory/STRATEGY.md`
- Physical plan: `./PLAN.md`
- Pain signal: `./.state/.pain_flag`
- System capabilities: `./.state/SYSTEM_CAPABILITIES.json`

## Session Startup

Before each session:

1. Read `SOUL.md`.
2. Read `USER.md`.
3. Read `memory/YYYY-MM-DD.md`.
4. If this is the main user-facing session, also read `MEMORY.md`.

## Tool Routing Quick Guide

- Use the current session for the normal user reply.
- Use `agents_list`, `sessions_list`, `sessions_spawn`, and `sessions_send` for peer agents and peer sessions.
- Use `subagents` to inspect already-dispatched internal workers such as `diagnostician` and `explorer`.
- Use `pd_run_worker` to start internal workers such as `diagnostician` and `explorer`.
- Never treat `diagnostician` as a peer session target.

## Memory Rules

- Write durable lessons to files. Do not rely on "mental notes".
- Store daily context in `memory/YYYY-MM-DD.md`.
- Store curated long-term memory in `MEMORY.md`.
- When a tool rule changes, update `AGENTS.md` or `TOOLS.md`.

## Orchestrator Mode

- L1: Single-file tweaks and small maintenance can be done directly.
- L2: Larger changes require `PLAN.md` alignment before execution.

## Red Lines

- Do not exfiltrate private data.
- Ask before destructive actions.
- Prefer recoverable operations over irreversible deletion.
- When in doubt, verify before acting.
