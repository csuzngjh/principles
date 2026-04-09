# Phase 19: Gate Monitor + Frontend Field Mapping — Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Source:** ROADMAP.md + Phase 16 RESEARCH + Codebase analysis

## Phase Boundary

Fix data sources for Gate Monitor page (`/api/gate/stats`, `/api/gate/blocks`). Fix all frontend TypeScript types and component field accessors to match actual backend responses.

## Requirements

- **GATE-01**: Fix `/api/gate/stats` — verify gate stats data source and field mapping
- **GATE-02**: Fix `/api/gate/blocks` — verify gate blocks data source
- **FE-01**: Fix all frontend TypeScript types to match actual backend responses
- **FE-02**: Fix all frontend component field accessors to match actual response keys

## Implementation Decisions

### D-01: Gate stats data source (GATE-01)
`/api/gate/stats` → `healthService().getGateStats()` → `health-query-service.ts:294`
- Data source: `gate_blocks` table in ControlUiDatabase (per-workspace)
- Counts blocks by reason string pattern matching (gfi, tier, stage, p-03, bypass, p-16)
- Returns: `{ today: { gfiBlocks, stageBlocks, p03Blocks, bypassAttempts, p16Exemptions }, trust: { stage, score, status }, evolution: { tier, points, status } }`

### D-02: Gate blocks data source (GATE-02)
`/api/gate/blocks` → `healthService().getGateBlocks(limit)` → `health-query-service.ts:351`
- Data source: `gate_blocks` table via `readGateBlocksRaw()`
- Returns array of: `{ timestamp, toolName, filePath, reason, gateType, gfi, trustStage }`

### D-03: Frontend type alignment (FE-01)
Frontend `types.ts` declares `GateStatsResponse` and `GateBlockItem`. Backend service layer declares inline return types. Need to verify exact field name match.

### D-04: Frontend field accessor alignment (FE-02)
`GateMonitorPage.tsx` accesses: `gateStats.today.*`, `gateStats.trust.*`, `gateStats.evolution.*`, `block.toolName`, `block.filePath`, `block.gateType`, `block.reason`, `block.gfi`, `block.timestamp`

## Data Flow (from Codebase Analysis)

```
Frontend (GateMonitorPage.tsx)
  └─ api.getGateStats() → /plugins/principles/api/gate/stats
      └─ principles-console-route.ts:467 → healthService().getGateStats()
          └─ health-query-service.ts:294 → ControlUiDatabase (gate_blocks table)

Frontend (GateMonitorPage.tsx)
  └─ api.getGateBlocks(50) → /plugins/principles/api/gate/blocks
      └─ principles-console-route.ts:481 → healthService().getGateBlocks()
          └─ health-query-service.ts:351 → ControlUiDatabase (gate_blocks table via readGateBlocksRaw())
```

## Backend Response Shapes

### getGateStats() return type (health-query-service.ts:294)
```typescript
{
  today: {
    gfiBlocks: number;
    stageBlocks: number;
    p03Blocks: number;
    bypassAttempts: number;
    p16Exemptions: number;
  };
  trust: { stage: number; score: number; status: string };
  evolution: { tier: string; points: number; status: string };
}
```

### getGateBlocks() return type (health-query-service.ts:351)
```typescript
Array<{
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: string;
  gfi: number;
  trustStage: number;
}>
```

## Frontend Types (types.ts)

```typescript
export interface GateStatsResponse {
  today: {
    gfiBlocks: number;
    stageBlocks: number;
    p03Blocks: number;
    bypassAttempts: number;
    p16Exemptions: number;
  };
  trust: { stage: number; score: number; status: string };
  evolution: { tier: string; points: number; status: string };
}

export interface GateBlockItem {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: string;
  gfi: number;
  trustStage: number;
}
```

## Patterns to Follow

- `done()` wrapper pattern: `done(() => { service.method(); })` with `finally { service.dispose(); }`
- Service method returns camelCase objects from snake_case DB rows
- TypeScript interfaces in service files define actual return shapes

## Out of Scope

- UI visual changes (visual layer stays unchanged)
- Debug endpoint (not needed for gate endpoints - data flow is simpler than overview)

## Deferred Ideas

None — all 4 requirements are in scope

---

*Phase: 19-gate-monitor-frontend-field-mapping*
*Context gathered: 2026-04-09*
