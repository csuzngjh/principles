# TOOLS.md - Tool Conventions

This file is used by the host/OpenClaw for local tool conventions.

Principles Disciple only adds conventions for its own PD-specific commands.
Everything else (editor habits, search preferences, shell workflows) is up to
you — PD does not prescribe general coding behavior.

---

## PD-specific commands

- **Record behavior evidence**: `pd pain record` — manual trigger for
  owner-relevant behavior evidence (not every tool failure).
- **Review principle proposals**: `pd candidate list` — proposals awaiting
  Owner decision (approve / reject / defer / rollback).
- **Owner console**: `pd console open` — visual review and rollback controls.
- **RuleHost / code_tool_hook activation**: managed via `pd` — the hard-gate
  activation channel for approved principles.

---

_Add your own tool conventions here._
