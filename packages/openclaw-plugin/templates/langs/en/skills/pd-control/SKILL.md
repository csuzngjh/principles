---
name: pd-control
description: Use when the Owner explicitly requests installation, initialization, disablement, re-enablement, or repair of PD host integration. Use only management entrypoints supported by the current host; do not edit configuration or business state directly.
disable-model-invocation: false
---

# PD Control

## Purpose

Manage PD integration through the official installer and host management surface. This skill is a constrained router; it does not duplicate installer logic or mutate principle, candidate, task, or ledger state.

## Current OpenClaw support

### Install or initialize

Only when the Owner explicitly requests installation/initialization, use the documented non-interactive installer:

    npx create-principles-disciple --yes

Check the installed version's help and prerequisites first. Do not claim success when authorization, network, or dependency requirements are missing. After installation, use `pd-cli-operator` for a read-only health check.

### Disable or re-enable

Use OpenClaw's own official plugin-management surface. First inspect `openclaw plugins --help`; invoke only an enable/disable operation actually listed by the installed version, and verify the target is `principles-disciple`.

The PD skill package does not currently provide a standalone enable/disable CLI guaranteed across OpenClaw versions. If the host help does not expose a supported operation, report that it is unsupported; do not guess a command or edit `openclaw.json` or `.pd/config.yaml` directly.

## Success criteria

Distinguish installer success, host plugin discovery, actual Hook execution, and PD business-pipeline health. Each requires its own receipt or runtime evidence. Plugin presence does not prove it is enabled, and installation does not prove Runtime health.

## Never

- Edit host configuration or PD state files by hand.
- Overwrite user configuration or delete business data to disable PD.
- Approve, reject, or activate principles through CLI, scripts, or another skill.
- Report an unverified host operation as successful.
