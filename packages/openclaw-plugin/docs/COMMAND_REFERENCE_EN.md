# Principles Disciple Command Reference

> Current state: the control plane is in the observation window after `Phase 1 + Phase 2a + Phase 2b`.  
> That means `legacy trust` is frozen, empathy rollback only subtracts the `user_empathy` slice, and `/pd-evolution-status` reads the runtime summary.

---

## Core Commands

| Command | Purpose | Current interpretation |
|---|---|---|
| `/pd-evolution-status` | View control-plane and evolution-plane state | Reads canonical state through `RuntimeSummaryService` |
| `/pd-trust` | View the legacy trust compatibility model | `legacy/frozen`; no automatic increase from `tool_success` or `subagent_success` |
| `/pd-status empathy` | Inspect empathy/frustration event statistics | Used to verify `user_empathy` and `system_infer` eventing |
| `/pd-rollback last` | Roll back the latest empathy penalty | Removes only the `user_empathy` GFI slice |
| `/pd-evolve` | Run an evolution task | Belongs to the learning plane, not the current authoritative control plane |

---

## `/pd-evolution-status`

### What it shows now

- `Legacy Trust`: frozen legacy trust score and stage
- `Session GFI`: current session GFI and peak
- `GFI Sources`: currently attributable friction sources
- `Pain Flag`: whether a pain flag is active
- `Gate Events`: recent block / bypass counts
- `Queue / Directive`: evolution queue and directive state

### Important notes

- This is the main operator entry point into the current control-plane read model.
- It reads canonical `.state` and tries to merge live session state and buffered events when available.
- When data is incomplete, it surfaces `partial` or warnings instead of silently printing `0`.

---

## `/pd-trust`

### What it means now

- It shows `legacy trust`
- Its current status is `legacy/frozen`
- It is kept mainly for compatibility with older gate and status behavior

### What it no longer means

- It no longer means ordinary success steadily upgrades authority
- It no longer means `tool_success` or `subagent_success` automatically raise permissions
- It should not be treated as the future capability model

---

## `/pd-rollback`

### Current behavior

- `/pd-rollback last`
- `/pd-rollback <event-id>`

It rolls back the latest or specified `user_empathy` event.

### Important change

- It now subtracts only the `user_empathy` GFI slice
- It no longer wipes the whole session GFI
- If the event is missing or the source does not match, unrelated friction should remain untouched

---

## Observation Window Checklist

Before entering `Phase 3 capability shadow`, check daily:

1. legacy trust stays frozen
2. `user_empathy` and `system_infer` appear in `events.jsonl`
3. rollback affects only the empathy slice
4. `evolution_queue.json`, `evolution_directive.json`, and status stay aligned
5. summary warnings still accurately explain partial data quality

---

## Current Non-Goals

The following are intentionally not part of the current observation window:

- no Gate authority switch to Capability
- no deletion of legacy trust
- no full GFI decay redesign
- no reintroduction of Evolution tier as a second control authority
