---
name: principles-disciple
description: Evolutionary programming agent framework with control-plane observability, pain-driven learning, and guarded execution.
version: 1.7.0
author: Principles Disciple Team
tags: [core, safety, evolution, control-plane]
---

# Principles Disciple

An evolutionary agent framework built around pain signals, guarded execution, and a separable control plane.

## Current Model

- `Pain` captures failure and frustration signals
- `GFI` is the short-term friction brake
- `Gate` is the execution intercept layer
- `legacy trust` is still present for compatibility, but currently `frozen`
- `Evolution` remains the learning plane and is not the authoritative control plane

## Key Commands

| Command | Description |
|---|---|
| `/pd-evolution-status` | Show the current control-plane and evolution summary |
| `/pd-trust` | Show the frozen legacy trust compatibility view |
| `/pd-evolve` | Run an evolution task |
| `/pd-rollback` | Roll back the latest or specified empathy penalty |
| `/pd-help` | Show help |

## `/pd-evolution-status` Example

```text
Evolution Status
================

Control Plane
- Legacy Trust: 85/100 (stage 4, legacy/frozen, frozen_all_positive)
- Session GFI: current 18, peak 25 (partial)
- GFI Sources: user_empathy(18)
- Pain Flag: inactive
- Last Pain Signal: user_empathy - buffered empathy event
- Gate Events: blocks 1, bypasses 0 (authoritative)

Evolution
- Queue: pending 1, in_progress 0, completed 0 (authoritative)
- Directive: present, active yes, age 5m
- Directive Task: fix something important
```

## Important Behavior Notes

- `/pd-trust` does not imply ongoing automatic promotion anymore.
- `tool_success` and `subagent_success` no longer inflate trust.
- `/pd-rollback` now removes only the `user_empathy` GFI slice; it does not wipe the full session GFI.
- Before Phase 3, operators should validate production observation snapshots instead of cutting over Gate authority.

## Usage

Use Principles Disciple to:

- observe runtime control-plane state
- capture pain signals and empathy signals
- guard risky actions through Gate
- feed lessons into the evolution pipeline without turning evolution into a second authority system

This skill is designed to support the current observation window before any `Capability shadow` rollout.
