# MEETING_PROTOCOL

> Purpose: define how the internal team runs recurring meetings in OpenClaw

## Core Rule

A meeting is a workflow, not free chat.

OpenClaw does not provide a native "team meeting" object, so meetings must be implemented with:

- `cron` for scheduling
- `sessions_send` for collecting updates
- shared governance docs for durable truth
- `CRON_BOOTSTRAP_PROMPT.md` as the bootstrap instruction for creating those scheduled jobs

## Meeting Types

### Daily Sync

Owner:

- `main`

Participants:

- `pm`
- `resource-scout`
- `repair` when active work exists
- `verification` when pending validation exists

Goal:

- surface blockers
- synchronize queue state
- update current focus

Outputs:

- update `TEAM_CURRENT_FOCUS.md`
- update `WORK_QUEUE.md`
- write a short report using `MEETING_REPORT_TEMPLATE.md`

### Weekly Governance Review

Owner:

- `main`

Required participants:

- `pm`
- `resource-scout`

Optional participants:

- `repair`
- `verification`

Goal:

- review progress against team OKR
- identify repeated failure patterns
- decide next-week priorities

Outputs:

- update `TEAM_WEEK_STATE.json`
- update `TEAM_WEEK_TASKS.json`
- append weekly review report using `MEETING_REPORT_TEMPLATE.md`

### Incident Review

Trigger examples:

- repeated verification failure
- queue pile-up
- missing role response
- repeated runtime anomaly

Goal:

- stop drift
- assign an owner
- convert the incident into a bounded next action

## Standard Meeting Flow

1. `cron` wakes `main`
2. `main` reads:
   - `TEAM_CURRENT_FOCUS.md`
   - `TEAM_WEEK_STATE.json`
   - `TEAM_WEEK_TASKS.json`
   - `WORK_QUEUE.md`
3. `main` sends targeted update requests to participants
4. participants reply in standard artifact form
5. `main` merges responses into a single meeting result
6. `main` updates shared governance docs

## Required Update Format

Each participant should return:

- current status
- blocker or risk
- recommended next action
- artifact produced, if any

## Failure Handling

### No reply from one participant

- wait a bounded amount of time
- mark participant as absent
- continue the meeting
- record follow-up action in `WORK_QUEUE.md`

### Message send blocked or unavailable

- record the failed contact attempt
- use shared docs as fallback coordination layer
- escalate to `main`

### Meeting started from an isolated cron session

- do not rely on old conversation memory
- rebuild context from shared governance docs only

## Red Lines

- do not let meetings become unbounded free-form agent chat
- do not treat message history as the only record
- do not close high-impact work only based on meeting talk
