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

### Disable

Only when the Owner explicitly requests disablement, run:

    openclaw plugins disable principles-disciple

This uses OpenClaw's official plugin-management route and does not delete installed files. Then inspect `openclaw plugins list --enabled --json` and confirm `principles-disciple` is no longer enabled. When a Gateway is running, the command applies the state change through that Gateway; distinguish a disabled switch from proof that every previously started task has stopped.

### Enable or resume

Only when the Owner explicitly requests enablement, run:

    openclaw plugins enable principles-disciple

If the command reports capability consent, allowlist, denylist, or another policy block, do not automatically add `--accept-capabilities` and do not edit `openclaw.json` by hand. Preserve the full receipt and explain the required choice or policy issue to the Owner. Continue with the exact retry command returned by OpenClaw only after the Owner explicitly consents to the requested capabilities.

Afterward, inspect `openclaw plugins list --enabled --json`, then run `openclaw plugins inspect principles-disciple --runtime --json` to check registered runtime capabilities. A cold inventory or inspect result alone still does not prove a real Hook is effective; when needed, verify with a safe real host event.

## Success criteria

Distinguish installer success, host plugin discovery, actual Hook execution, and PD business-pipeline health. Each requires its own receipt or runtime evidence. Plugin presence does not prove it is enabled, and installation does not prove Runtime health.

## Never

- Edit host configuration or PD state files by hand.
- Overwrite user configuration or delete business data to disable PD.
- Approve, reject, or activate principles through CLI, scripts, or another skill.
- Report an unverified host operation as successful.
