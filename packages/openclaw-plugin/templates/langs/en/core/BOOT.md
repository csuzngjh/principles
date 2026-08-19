# 🔄 BOOT.md - Startup Instructions

Short, explicit instructions for what OpenClaw should do on startup. If the task needs to send a message, use the message tool and then reply `NO_REPLY`.

---

## Startup Checklist

1. **Confirm workspace**: Check current working directory is correct
2. **Read identity files**: `SOUL.md`, `USER.md`, `IDENTITY.md`
3. **Check memory state**: Read today's and yesterday's `memory/YYYY-MM-DD.md`
4. **Check Runtime V2 pain diagnostics**: use `pd candidate list` / ledger state; `.state/.pain_flag` is legacy compatibility only

---

## Boundary

- Do **not** write environment snapshots or runtime state files on startup —
  environment discovery is a host/OpenClaw capability, and PD does not own
  general memory or environment persistence.
- Surface Owner-review items (principle proposals via `pd candidate list`)
  when they exist; otherwise proceed silently.

---

_This file can be customized by user to add specific startup tasks._
