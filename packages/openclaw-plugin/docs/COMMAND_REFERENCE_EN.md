# Principles Disciple Command Reference (English)

> Current state: EP (Evolution Points) system is the primary growth system, fully operational and enabled by default.

---

## Core Commands

| Command | Purpose |
|---|---|
| `/pd-status empathy` | Inspect empathy/frustration event statistics |
| `/pd-rollback last` | Roll back the latest empathy penalty |

---

## `/pd-rollback`

### Current behavior

- `/pd-rollback last`
- `/pd-rollback <event-id>`

It rolls back the latest or specified `user_empathy` event.

### Important notes

- It subtracts only the `user_empathy` GFI slice
- It no longer wipes the whole session GFI
- If the event is missing or the source does not match, unrelated friction remains untouched

---

## EP Tier System

| Tier | EP Required | Max Lines/Write |
|------|-------------|-----------------|
| Seed | 0 | 150 |
| Sprout | 50 | 300 |
| Sapling | 200 | 500 |
| Tree | 500 | 1000 |
| Forest | 1000 | Unlimited |

EP is earned through successful task completion and problem resolution.

---

## Observation Window Checklist

Before entering new capability phases, check daily:

1. EP tier and queue are functioning correctly
2. `user_empathy` and `system_infer` appear in `events.jsonl`
3. rollback affects only the empathy slice
4. summary warnings still accurately explain partial data quality

(End of file - total 84 lines)