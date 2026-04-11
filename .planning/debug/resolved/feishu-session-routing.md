# Feishu Session Routing Issue

**Created:** 2026-04-05
**Status:** Investigating
**Severity:** Major

## Symptom

- Feishu messages reach `agent:main:main` (confirmed in `commands.log`)
- PD hooks never fire on the Feishu user's session
- PD hooks only run on heartbeat/cron boot sessions (`boot-2026-04-05_04-47-*`)
- Agent does not reply to Feishu messages

## Evidence

```
~/.openclaw/logs/commands.log:
  → "agent:main:main" receives Feishu message from ou_cf5c98a...

~/.openclaw/workspace-main/.state/logs/events.jsonl:
  → No ou_cf5c98a entries ever appear
  → Only boot sessions (boot-2026-04-05_*) show hook_execution records

~/.openclaw/workspace-main/memory/logs/SYSTEM.log:
  → SYSTEM_BOOT every 7-12 minutes (heartbeat)
  → PD hooks running on boot sessions only
```

## Root Cause (Suspected)

`dmScope: "main"` in OpenClaw session config causes all Feishu DMs to route to the same `agent:main:main` session. When heartbeat/cron creates boot sessions, they may be occupying or blocking the interactive session.

## Configuration

```json
// ~/.openclaw/openclaw.json
{
  "session": {
    "dmScope": "main"  // Suspected problem: should be "per-peer"
  }
}
```

## Investigation Steps

1. [ ] Confirm `dmScope` value with `openclaw config get session.dmScope`
2. [ ] Try changing to `dmScope: "per-peer"` and restart daemon
3. [ ] Test Feishu DM routing after change
4. [ ] Check if heartbeat can be disabled or reconfigured

## Alternative Causes

- Feishu `dmPolicy: allowlist` with specific sender list may not include the user's session
- Gateway session persistence may be stale/corrupted
- Session cache (1356 sessions) causing lookup failure

## References

- OpenClaw routing: `src/routing/resolve-route.ts`
- Session key building: `src/routing/session-key.ts`
- DM scope options: `dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer"`
