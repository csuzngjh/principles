# AGENTS.md - Workspace Guide

Principles Disciple (PD) is an **owner-governed behavior layer**. It turns
repeated, owner-relevant behavioral evidence into reviewed, reversible
principles that can change future agent behavior.

This guide only covers PD's responsibilities. General agent behavior (memory,
persona, task execution, group-chat conduct, tool preferences) is defined by
the host/OpenClaw and by you; PD does not prescribe it.

---

## What PD owns

- behavior evidence the owner considers worth changing;
- reviewable principle proposals;
- owner approval, rejection, channel selection, rollback, and archive decisions;
- reversible activation and later observation of behavior change.

## What PD does not own

- general memory or memory maintenance;
- agent persona or identity;
- strategic management or strategic alignment;
- task orchestration or task derivation;
- background governance (cron, heartbeats beyond owner review, environment health);
- user profiles.

These belong to the host/OpenClaw or to you.

---

## PD workflow

```text
behavior evidence -> diagnosis -> principle proposal -> owner review
-> reversible activation -> observable later behavior
```

- **Record evidence**: `pd pain record` (manual trigger for owner-relevant behavior evidence).
- **Review proposals**: `pd candidate list` or `pd console open` — proposals await your decision (approve / reject / defer / rollback).
- **Activation**: supported outcomes are `prompt`, `code_tool_hook` / RuleHost, and `defer_archive`.
- **Rollback**: any activated principle can be rolled back; see `pd console` for the owner-visible controls.

## PD data locations

- `.principles/` — principle store (PRINCIPLES.md, profiles, thinking models).
- `.state/` — PD runtime state (e.g. pain flags as legacy compatibility).

Do not write project business logic into the agent workspace; keep it in the
project root (`$CWD`).

---

## Anti-patterns (do not do)

- Do not autonomously groom memory or maintain `memory/` files on PD's behalf.
- Do not run background strategic alignment or environment-health maintenance.
- Do not derive or schedule tasks on your own initiative.
- Do not force a persona or identity onto the agent.
- Do not treat every tool failure as PD evidence — only owner-relevant behavior patterns qualify.

---

_This is a starting point. Add your own conventions and rules as you see fit._
