# HEARTBEAT.md - Heartbeat Checklist (Owner-Governed, Minimal)

PD is an owner-governed behavior-internalization layer. Heartbeats exist to
surface **one thing**: principle proposals that need Owner review. Everything
else (environment checks, memory grooming, task derivation, background cron
maintenance) is either host/OpenClaw capability or out of PD's MVP boundary —
PD does not own general memory, task orchestration, or autonomous decisions.

---

## Check: Owner Review Queue

- [ ] Run `pd candidate list` (or open `pd console open`) and check the ledger
      for principle proposals awaiting Owner review.

**Action**: If there are pending proposals, surface them **once** with a
concise summary and the review decision options (approve / reject / defer /
rollback). Otherwise stay silent.

---

## Stay Silent (HEARTBEAT_OK)

Reply `HEARTBEAT_OK` when:

- there are no pending Owner-review items;
- a proposal was already surfaced recently and the Owner has not acted;
- it is late night (23:00-08:00) unless the item is urgent.

No news is a normal state. Do not invent work, derive tasks, groom memory, or
proactively interrupt the Owner to "stay useful".

---

## Principle

- Necessary: only Owner-review items qualify.
- Low-noise: surface once, then wait.
- Explicitly authorized: no background jobs, no self-derived tasks, no
  automatic memory maintenance.
- Directly connected to PD governance: behavior evidence → diagnosis →
  proposal → Owner review → reversible activation.
