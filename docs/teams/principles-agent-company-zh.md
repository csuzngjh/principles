# Principles Agent Company

> Updated: 2026-03-18
> Status: V1 skeleton implemented

## Summary

This document defines the first working team shape for Principles Disciple.

The team uses:

- peer agents for long-lived roles
- subagents for bounded execution only
- shared governance docs as the long-term source of truth

## Team Roles

- `main`
  Principle Manager. Watches, prioritizes, dispatches, escalates, and decides.
- `pm`
  Product Manager. Owns user value, proposals, prioritization tradeoffs, and product framing.
- `resource-scout`
  Scout + Triage. Scans runtime signals, resources, pain, bugs, and produces issue drafts.
- `repair`
  Repair Agent. Executes low-risk fixes after a clear Repair Task exists.
- `verification`
  Verification Agent. Reproduces, validates, and issues release/acceptance recommendations.

## Shared Governance

The team-level governance layer lives under:

- [governance](D:\Code\principles\myagents\shared\governance\TEAM_CHARTER.md)

Core shared files:

- `TEAM_OKR.md`
- `TEAM_CURRENT_FOCUS.md`
- `TEAM_WEEK_STATE.json`
- `TEAM_WEEK_TASKS.json`
- `WORK_QUEUE.md`
- `AUTONOMY_RULES.md`
- `WEEKLY_REVIEW.md`

## Delivery Contracts

All team handoffs should converge to four standard artifacts:

- Issue Draft
- Proposal Draft
- Repair Task
- Verification Report

## Defaults

- `main` is the manager, not the default coder
- `pm` remains a product role and is not the team orchestrator
- `resource-scout` remains a scout/triage role
- human approval is still required for critical actions
