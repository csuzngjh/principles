---
name: pd-control
description: Use when the Owner explicitly requests installation, initialization, disablement, re-enablement, or repair of PD host integration. Use only management entrypoints supported by the current host; do not edit configuration or business state directly.
---

# PD Control

## Purpose

Manage PD integration through the official installer and host management surface. This skill is a constrained router; it does not duplicate installer logic or mutate principle, candidate, task, or ledger state. Only perform an operation explicitly requested by the Owner.

## Install or initialize

{{capability control.install}}

## Disable

{{capability control.disable}}

## Enable or resume

{{capability control.enable}}

## Success criteria

Distinguish installer success, host plugin discovery, actual Hook execution, and PD business-pipeline health. Each requires its own receipt or runtime evidence. Plugin presence does not prove it is enabled, and installation does not prove Runtime health.

## Never

- Edit host configuration or PD state files by hand.
- Overwrite user configuration or delete business data to disable PD.
- Approve, reject, or activate principles through CLI, scripts, or another skill.
- Report an unverified host operation as successful.
- Describe installation, registration, or configuration presence as PD being actually enabled.
