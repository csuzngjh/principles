# Research: Stack Additions for PD CLI

## Existing Validated Capabilities (Do Not Re-Research)

| Capability | Location | Notes |
|---|---|---|
| PainSignalSchema + validation | `packages/principles-core/src/pain-signal.ts` | Universal schema, frozen at Semver |
| StorageAdapter interface | `packages/principles-core/src/storage-adapter.ts` | Framework-agnostic |
| EvolutionHook | `packages/principles-core/src/evolution-hook.ts` | No-op default available |
| Event types + record methods | `packages/openclaw-plugin/src/core/event-log.ts` | 6 EventType, 7 recordXxx methods |
| WorkspaceContext | `packages/openclaw-plugin/src/core/workspace-context.ts` | Central integration hub |
| CentralDatabase + CentralSyncService | `packages/openclaw-plugin/src/service/central-sync-service.ts` | Already wires central sync |

## Stack Additions

### Required New Dependency

| Library | Version | Purpose |
|---|---|---|
| **commander** | `^14.0.3` | CLI subcommand framework (used by create-principles-disciple) |

### Already Present (reuse)

| Library | In | Usage |
|---|---|---|
| typescript | ^6.0.2 (dev) | Same tsconfig |
| esbuild | ^0.28.0 | Bundle CLI |
| @sinclair/typebox | ^0.34.48 | PainSignalSchema |
| js-yaml | ^4.1.1 | WorkflowFunnelLoader |
| better-sqlite3 | ^12.9.0 | TrajectoryDatabase |

### What NOT to Add

- react, react-router-dom — no UI
- ws — no WebSocket

## package.json Skeleton

```json
{
  "name": "pd-cli",
  "version": "0.1.0",
  "bin": { "pd": "./dist/index.js" },
  "dependencies": {
    "@principles/core": "^0.1.0",
    "commander": "^14.0.3",
    "js-yaml": "^4.1.1",
    "better-sqlite3": "^12.9.0",
    "@sinclair/typebox": "^0.34.48"
  }
}
```
