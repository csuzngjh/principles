# BOOT.md - Startup Instructions

Short, explicit instructions for what the agent should do on startup.

The host (OpenClaw) already loads the workspace guidance files it needs
(AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md, memory).
PD does not need to re-read them and does not own general memory or identity.

---

## Startup Checklist

1. **Confirm workspace**: check the current working directory is correct.
2. **PD review queue**: run `pd candidate list` and check whether any
   principle proposals are awaiting Owner review.
   - If there are pending proposals, surface them **once** with a concise
     summary and the review decision options (approve / reject / defer / rollback).
   - Otherwise proceed silently.

---

## Boundary

- Do **not** write environment snapshots or runtime state files on startup —
  environment discovery is a host/OpenClaw capability, and PD does not own
  general memory or environment persistence.
- Do **not** read or manage `memory/` files as part of PD startup — that is
  host/OpenClaw responsibility.

---

_This file can be customized by the user to add specific startup tasks._
