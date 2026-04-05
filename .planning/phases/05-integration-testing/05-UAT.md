---
status: partial
phase: "05-integration-testing"
source: [05-01-SUMMARY.md]
started: 2026-04-05T00:00:00Z
updated: 2026-04-05T05:00:00Z
---

## Current Test

[testing paused — session routing issue]

## Tests

### 1. TEST-04 — Tool Execution (deep_reflect)
expected: Load the plugin in OpenClaw v2026.4.3. Call `deep_reflect` tool via SDK. Tool executes without errors and returns a valid response.
result: blocked
blocked_by: server
reason: "Feishu messages reach gateway (agent:main:main) but hooks never fire on that session. PD hooks only run on heartbeat/cron boot sessions."

### 2. TEST-05 — Hook Triggering
expected: Trigger agent lifecycle events. Verify hooks fire at correct times with correct context.
result: blocked
blocked_by: server
reason: "Hooks confirmed working (events.jsonl shows successful hook_execution records), but only on boot sessions. Feishu session routing to agent:main:main does not trigger PD hooks."

## Summary

total: 2
passed: 0
issues: 0
pending: 0
skipped: 0
blocked: 2

## Gaps

- truth: "Feishu messages route to agent:main:main but do not trigger PD hooks"
  status: open
  reason: "Session routing: Feishu DM uses dmScope=main, causing competition with heartbeat boot sessions. PD hooks only fire on boot sessions (boot-2026-04-05_*), never on the user's feishu session (agent:main:main)"
  severity: major
  test: 1
  root_cause: "dmScope=main causes all Feishu DMs to route to agent:main:main, which is occupied by heartbeat/cron boot sessions"
  artifacts:
    - path: "~/.openclaw/logs/commands.log"
      issue: "Feishu messages logged at agent:main:main but no corresponding hook_execution in events.jsonl"
  missing:
    - "Change session.dmScope to 'per-peer' so each Feishu DM has its own session"
    - "Or investigate why heartbeat boot sessions are blocking interactive sessions"
  debug_session: ".planning/debug/feishu-session-routing.md"
