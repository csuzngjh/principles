---
gsd_state_version: 1.0
milestone: v1.10
milestone_name: Thinking Models 页面优化
status: defining
last_updated: "2026-04-09"
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# State: v1.10 Thinking Models 页面优化

## Project Reference

See `.planning/PROJECT.md` (updated 2026-04-09)

**Milestone:** v1.10
**Name:** Thinking Models 页面优化
**Core Value:** AI agents improve their own behavior through a structured evolution loop. pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization
**Current Focus:** Phase 01 — 基础可视化 (覆盖率趋势图、场景热力图、空状态优化)

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-09 — Milestone v1.10 started, all 50 prior issues closed

## Accumulated Context

### Architecture
- Frontend: React + TypeScript (`ui/src/pages/ThinkingModelsPage.tsx`)
- API client: `ui/src/api.ts` (getThinkingOverview, getThinkingModelDetail)
- Backend service: `src/service/control-ui-query-service.ts`
- HTTP routes: `src/http/principles-console-route.ts`
- Database: SQLite trajectory DB with views (v_thinking_model_usage, v_thinking_model_effectiveness, v_thinking_model_scenarios, v_thinking_model_daily_trend)
- Chart components available: `ui/src/charts.tsx` (Sparkline, LineChart, BulletChart, BarChart, etc.)

### Existing Data (Backend → Frontend Gap Analysis)
- ✅ `scenarioMatrix` (model × scenario cross-tab) — fetched but NOT rendered
- ✅ `coverageTrend` (daily coverage rate) — fetched but NOT rendered
- ✅ `usageTrend` (daily hits per model) — fetched but NOT rendered
- ✅ `dormantModels` (zero-hit models) — fetched but NOT rendered
- ✅ `recentEvents.toolContext`, `painContext`, `principleContext` — fetched but NOT rendered
- ✅ `recentEvents.matchedPattern` — fetched but NOT rendered
- ✅ `modelDefinitions` — fetched but NOT rendered on this page
- ✅ `correctionSampleRate` — in summary but NOT rendered

### Current Page Limitations
- No pagination, filtering, or search on model list
- No loading states for detail transitions
- "Back" button clears detail but doesn't deselect model (inconsistent UX)
- Recommendation badges are plain text (no color coding)
- Scenario list can overflow (no truncation)
- Events are plain `<pre>` cards (no context display)

### THINKING_OS.md
- Single source of truth for 10 thinking model definitions (T-01~T-10)
- Template currently has 8 directives, builtin has 10 — mismatch needs fixing
- `antiPattern` (forbidden field) is lost in API response type
- `trigger` text is used only for regex generation, never displayed

### Previous Milestone
- v1.9.1: WebUI 数据源修复 — 4 pages fixed (Overview, Loop, Feedback, Gate Monitor)
- v1.9.3: 剩余 Lint 修复 — deferred to after this milestone
- All 50 open issues verified fixed and closed

### Key Decisions

- All needed data already exists in backend — no new API endpoints needed
- Existing chart components in charts.tsx should be reused
- Desktop-only admin tool — no mobile responsive redesign needed
- Polling-based refresh is sufficient — no WebSocket needed

### Blockers

- None identified

## Session Continuity

**Previous milestone:** v1.9.1 (WebUI 数据源修复)
**Current milestone:** v1.10 — Thinking Models 页面优化
**Ready for:** `/gsd-plan-phase 1` to start Phase 01
