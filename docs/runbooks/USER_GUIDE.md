# Principles Disciple User Guide

This guide focuses on the commands and workflows that are actually useful in the current `v1.9.0` milestone.

## What The System Does

Principles Disciple now has two main responsibilities:

1. Protect the workspace while the agent is working.
2. Turn repeated mistakes into reusable internalized behavior through principles, rule implementations, and replay evaluation.

You do not need to understand the full architecture to use it. Most people only need the commands below.

## Daily Commands

### `/pd-status`

Use this when the assistant seems stuck or confused.

- `/pd-status` shows the current fatigue/friction state.
- `/pd-status reset` clears the current session friction so the assistant can try again with a fresh state.
- `/pd-status empathy` shows emotion-event statistics.
- `/pd-status empathy --week` shows weekly trends.
- `/pd-status empathy --session` limits the view to the current session.

Use `reset` when the assistant is looping on the same mistake.

### `/pd-rollback last`

Use this when the empathy system penalized the wrong thing.

- `/pd-rollback last` rolls back the most recent empathy penalty in the current session.
- `/pd-rollback <eventId>` rolls back a specific empathy event.

This affects empathy-related GFI only. It does not erase the whole session state.

### `/pd-evolution-status`

Use this as the main operator dashboard for the new internalization pipeline.

It shows:

- current and peak session GFI
- recent pain signals
- recent gate blocks and bypasses
- evolution queue state
- principle counts
- internalization route recommendations such as `skill`, `code`, or `defer`

Read this command first if you are unsure whether the system is blocked by fatigue, pain, or code-implementation policy.

## Code Implementation Workflow

This workflow is for operators reviewing code implementations generated or maintained by the system.

### When To Use It

Use these commands when:

- a new candidate implementation appears
- you want to evaluate a candidate against replay data
- a promoted implementation regressed and needs to be disabled or rolled back
- an old implementation should be archived

### Step 1: List Candidates

```text
/pd-promote-impl list
```

This lists candidate implementations and tells you whether each one already has a passing replay report.

> ⚠️ **Note**: The legacy replay generation path was retired in PRI-230. There is currently no CLI entry point to generate new replay reports. Promotion only works for implementations that already have a pre-existing passing replay report. The `eval` subcommand referenced in older documentation no longer exists.

### Step 2: Inspect The Replay Report

```text
/pd-promote-impl show <implId>
```

This prints the latest replay report for the implementation.

Check:

- total sample count
- pass/fail decision
- which classifications were exercised
- whether the report is empty because no replay samples were available

### Step 3: Promote The Candidate

```text
/pd-promote-impl <implId>
```

Promotion rules:

- the implementation must be in `candidate` or `disabled`
- it must have a passing replay report
- if the same rule already has an active implementation, the old one is disabled automatically

This is the normal path from candidate to active.

### Step 4: Disable A Bad Implementation

```text
/pd-disable-impl list
/pd-disable-impl <implId> --reason "reason"
```

Use this when an implementation is causing bad runtime behavior and should stop applying immediately.

Disabling keeps the implementation in the ledger but removes it from active use.

### Step 5: Roll Back To The Previous Active Implementation

```text
/pd-rollback-impl list
/pd-rollback-impl <implId> --reason "reason"
```

Use this when the current active implementation should be reverted and the previous active version restored.

If there is no previous active implementation, the rule simply falls back to the hard host boundaries such as GFI and Progressive Gate.

### Step 6: Archive An Implementation

```text
/pd-archive-impl list
/pd-archive-impl <implId>
```

Use this for permanent cleanup when an implementation is no longer relevant.

Archiving is stronger than disabling. It is intended for old or obsolete implementations that should not be promoted again.

## Recommended Operator Sequence

When the system has produced a new code candidate, use this order:

1. `/pd-evolution-status`
2. `/pd-promote-impl list`
3. `/pd-promote-impl show <implId>`
4. `/pd-promote-impl <implId>`

If the promoted implementation regresses:

1. `/pd-disable-impl <implId> --reason "reason"`
2. `/pd-rollback-impl <implId> --reason "reason"` if you want to restore the previous active version
3. `/pd-archive-impl <implId>` only when the implementation is obsolete and should be retired

## How To Read Internalization Routes

`/pd-evolution-status` may show route recommendations like:

- `skill`
- `code`
- `defer`

Interpret them like this:

- `skill`: the principle likely needs prompt/SOP shaping first
- `code`: the principle is deterministic or high-risk enough for a code implementation
- `defer`: there is not enough evidence yet, or forcing implementation would be premature

These are recommendations, not automatic actions.

## Troubleshooting

### "Promotion rejected: no passing replay report"

The legacy replay generation path was retired in PRI-230. There is currently no CLI entry point to generate new replay reports. Promotion only succeeds for implementations that already have a pre-existing passing replay report.

You can inspect the existing report with:

```text
/pd-promote-impl show <implId>
```

If no report exists, the implementation cannot be promoted through the CLI until the replay generation path is restored.

### “Replay report is empty”

This means the system did not find classified replay samples for that implementation yet.

Check:

- whether nocturnal/replay data exists for the workspace
- whether the implementation is attached to the expected rule
- whether recent sessions produced usable samples

### “The implementation was disabled but behavior still feels restricted”

That can be normal. Disabling a code implementation does not remove the host hard boundaries:

- Thinking checkpoint
- GFI
- Progressive Gate
- Edit verification

### “I only want to know whether the system is healthy”

Use:

```text
/pd-status
/pd-evolution-status
```

That is enough for most day-to-day use.

## Console

If your deployment exposes the plugin UI, open:

```text
http://localhost:18789/plugins/principles/
```

Use the console for:

- reviewing queue and trend data
- checking evolution events
- inspecting correction samples
- watching principle and implementation activity at a glance

## Bottom Line

For normal use, remember only this:

1. use `/pd-status` when the assistant is stuck
2. use `/pd-rollback last` when empathy penalized the wrong thing
3. use `/pd-evolution-status` to inspect the new internalization pipeline
4. use `/pd-promote-impl ...` and related implementation commands only when you are operating candidate code implementations
