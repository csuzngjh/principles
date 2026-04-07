# OpenClaw Plugin Control UI Plan

> Updated: 2026-03-19
> Scope: Principles Disciple Web productization without modifying `D:\Code\openclaw`

## Summary

Principles Disciple should ship a plugin-owned web product under the existing OpenClaw Gateway origin, not as a separate deployment and not by patching the upstream OpenClaw UI.

Recommended delivery shape:

- Reuse OpenClaw Gateway host/port
- Serve a plugin-owned UI at `/plugins/principles/`
- Reuse the existing plugin runtime, trajectory DB, and gateway auth
- Keep OpenClaw chat/control UI unchanged
- Treat the Principles UI as a sibling product surface, not an injected tab inside OpenClaw chat

This respects the current hard constraint:

- We must not modify the OpenClaw source in `D:\Code\openclaw`

## Feasibility Conclusion

What is possible today:

- A plugin can register HTTP routes and serve plugin-owned pages and APIs
- A plugin can reuse the same Gateway process and same origin
- A plugin can reuse plugin config rendering through `configSchema` and `uiHints`

What is not possible today without modifying OpenClaw:

- Injecting a new native tab, sidebar, or panel into the existing Control UI
- Extending the existing chat page with a plugin-declared frontend mount point
- Registering a plugin frontend bundle that OpenClaw dynamically loads into its SPA

Therefore the best product path is:

- `OpenClaw chat` for conversation
- `Principles Console` for governance, analytics, samples, and Thinking OS insights

## User Experience

Users should experience two adjacent surfaces on the same system:

- Chat: `/chat` or existing OpenClaw Control UI chat
- Principles Console: `/plugins/principles/`

This gives the feeling of one product because:

- Same host
- Same port
- No second deployment
- No second service to run

## Product Pages

Phase-1 pages:

1. Overview
2. Samples
3. Thinking Models

Phase-2 pages:

4. Principles
5. Trajectory Analysis
6. Settings

## Page Goals

### 1. Overview

Purpose:

- Show whether the agent is improving
- Show what needs attention next

Core widgets:

- Repeat error rate
- User correction rate
- High-quality approved samples
- Principle hit rate
- Thinking OS coverage rate
- Top regressions
- Quick links to Samples / Principles / Thinking / Export

### 2. Samples

Purpose:

- Curate correction samples for downstream LoRA / SFT

Core widgets:

- Pending / approved / rejected counters
- Filter by quality / date / failure mode
- Review list
- Detail drawer with:
  - bad attempt
  - user correction
  - recovery tool span
  - related principle ids
  - related thinking model ids
- Approve / reject actions
- Export approved samples

### 3. Thinking Models

Purpose:

- Make Thinking OS observable and product-valuable

Core widgets:

- Most used models this week
- Most effective models this week
- Underused models
- Thinking coverage rate
- Per-model cards:
  - model id
  - display name
  - usage count
  - common scenarios
  - success correlation
  - correction correlation
  - pain correlation
- Scenario matrix:
  - debugging
  - editing
  - planning
  - risky operations
  - recovery after user correction
- Recommendations:
  - reinforce
  - rework regex
  - archive

## Current Data Reality

Today the codebase already has:

- trajectory DB for sessions, turns, tool calls, pain, trust, principle events, samples
- Thinking OS usage counting in `thinking_os_usage.json`
- regex-based model hit detection in `packages/openclaw-plugin/src/hooks/llm.ts`
- governance commands in `packages/openclaw-plugin/src/commands/thinking-os.ts`

Today it does not yet have:

- per-hit Thinking OS event records in SQLite
- scenario tagging for each model hit
- outcome correlation between model hits and later success/failure
- frontend APIs or pages for Thinking OS analysis

## Required Backend Additions

## A. Plugin HTTP Surface

Add plugin-owned HTTP routes:

- `/plugins/principles/`
- `/plugins/principles/assets/*`
- `/plugins/principles/api/overview`
- `/plugins/principles/api/samples`
- `/plugins/principles/api/samples/:id`
- `/plugins/principles/api/samples/:id/review`
- `/plugins/principles/api/thinking`
- `/plugins/principles/api/thinking/models/:id`
- `/plugins/principles/api/export/corrections`

Implementation note:

- Route registration should use the native OpenClaw plugin HTTP route API
- Static assets can be served by the plugin route layer from a built frontend bundle

## B. Thinking Model Events

Add a new table:

- `thinking_model_events`

Suggested fields:

- `id`
- `session_id`
- `assistant_turn_id`
- `model_id`
- `matched_pattern`
- `scenario_json`
- `tool_context_json`
- `principle_context_json`
- `pain_context_json`
- `created_at`

Why:

- Current `thinking_os_usage.json` only stores counts
- Product UI needs event-level visibility

## C. Thinking Model Views

Add SQL views:

- `v_thinking_model_usage`
- `v_thinking_model_effectiveness`
- `v_thinking_model_scenarios`

Suggested outputs:

### `v_thinking_model_usage`

- `model_id`
- `hits`
- `distinct_sessions`
- `coverage_rate`

### `v_thinking_model_effectiveness`

- `model_id`
- `followed_by_success_rate`
- `followed_by_failure_rate`
- `followed_by_user_correction_rate`
- `followed_by_pain_rate`

### `v_thinking_model_scenarios`

- `model_id`
- `scenario`
- `hits`

## D. Scenario Derivation

Each Thinking OS hit should be tagged with one or more scenarios inferred from nearby context:

- `debugging`
- `editing`
- `planning`
- `high_risk_operation`
- `user_correction_followup`
- `recovery`
- `evidence_validation`

Input signals can be derived from:

- current / recent tool calls
- gate blocks
- user correction turns
- pain events
- prompt/runtime context

## E. Outcome Correlation

Each Thinking OS hit should be correlated with downstream results in the same session window:

- later tool success
- later tool failure
- user correction
- pain event
- correction sample creation

We do not need perfect causality in P2.

P2 only needs useful operational correlation.

## API Design

## `/plugins/principles/api/overview`

Returns:

- core trajectory metrics
- sample counts
- principle counts
- thinking coverage summary
- top issues

## `/plugins/principles/api/samples`

Supports:

- `status`
- `quality_min`
- `date_from`
- `date_to`
- `failure_mode`
- `page`
- `page_size`

Returns:

- list items
- aggregate counters

## `/plugins/principles/api/samples/:id`

Returns:

- sample detail
- related turns
- related tool calls
- related principles
- related thinking model hits

## `/plugins/principles/api/samples/:id/review`

Accepts:

- `decision`
- `note`

Writes:

- sample review status
- audit entry

## `/plugins/principles/api/thinking`

Returns:

- top models
- dormant models
- effective models
- scenario breakdown
- thinking coverage trend

## `/plugins/principles/api/thinking/models/:id`

Returns:

- model metadata
- usage trend
- scenario distribution
- effectiveness stats
- recent example hits

## Frontend Information Architecture

## Navigation

Recommended left navigation inside the plugin page:

- Overview
- Samples
- Thinking Models
- Principles
- Analysis
- Settings

P2 should implement only:

- Overview
- Samples
- Thinking Models

## Design Direction

The plugin UI should feel close to OpenClaw but clearly more product-like:

- operational dashboard rather than raw diagnostics
- simple information hierarchy
- low-friction review actions
- charts only where they answer clear questions

## P2 Scope

P2 should implement:

1. Plugin-owned HTTP route host
2. Static frontend bundle mounted under `/plugins/principles/`
3. Overview page
4. Samples page
5. Thinking Models page
6. `thinking_model_events` table + views
7. Review and export APIs needed by Samples
8. Overview and Thinking APIs

P2 should explicitly defer:

- Injecting UI into the upstream OpenClaw chat tabs
- Full Principles page
- Full trajectory analysis page
- Advanced auth sharing tricks with the Control UI
- Complex causal inference for Thinking OS effectiveness

## Suggested Work Breakdown

### Backend slice

1. Add plugin HTTP route registration
2. Add static asset serving
3. Add Thinking OS event persistence
4. Add scenario derivation
5. Add overview/thinking/sample APIs
6. Add tests for routes and event persistence

### Frontend slice

1. Add app shell
2. Add Overview page
3. Add Samples page
4. Add Thinking Models page
5. Add API client layer
6. Add empty/loading/error states

## Acceptance Criteria

P2 is done when:

1. A user can open `/plugins/principles/` without running another service
2. Overview page shows trajectory + sample + thinking metrics
3. Samples page supports review and export
4. Thinking page answers:
   - which models were used
   - in which scenarios
   - what outcomes followed
5. No OpenClaw upstream source changes are required

## Key Risks

### Risk 1: Over-promising Thinking OS causality

Mitigation:

- present correlations, not strong causal claims

### Risk 2: Frontend feels disconnected from OpenClaw

Mitigation:

- same host
- same base visual language
- plugin settings still surfaced through existing config schema where useful

### Risk 3: Scope creep

Mitigation:

- keep P2 to three pages only

## Recommended Next Thread Prompt

When opening the next thread, use a prompt close to:

> Implement P2 for the Principles plugin-owned Control UI under `/plugins/principles/` based on `docs/design/openclaw-plugin-control-ui-plan.md`. Do not modify `D:\\Code\\openclaw`. Start with backend HTTP route host, static asset mount, and Thinking OS event persistence, using TDD.
