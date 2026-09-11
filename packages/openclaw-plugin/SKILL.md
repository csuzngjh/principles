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
- `Evolution` is the learning plane with EP (Evolution Points) as the sole gating mechanism
- `EP Tier` determines agent capabilities (Seed → Sprout → Sapling → Tree → Forest)

## Key Commands

| Command | Description |
|---|---|
| `/pd-rollback` | Roll back the latest or specified empathy penalty |
| `/pd-help` | Show help |

## Important Behavior Notes

- `/pd-rollback` now removes only the `user_empathy` GFI slice; it does not wipe the full session GFI.

## Usage

Use Principles Disciple to:

- observe runtime control-plane state
- capture pain signals and empathy signals
- guard risky actions through Gate
- feed lessons into the evolution pipeline without turning evolution into a second authority system

This skill is designed to support the current observation window before any `Capability shadow` rollout.
