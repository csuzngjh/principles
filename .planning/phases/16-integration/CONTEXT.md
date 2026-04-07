# Phase 16: Integration & Migration — Context

## Objective

Create PDTaskService as an OpenClawPluginService, update index.ts to register it, remove the old cron-initializer hook wiring, and delete cron-initializer.ts.

## Requirements

- **SVC-01**: PDTaskService registers as OpenClawPluginService (id: `principles-disciple-task-manager`)
- **SVC-02**: Service `start()` calls `reconcilePDTasks()` — non-blocking on startup
- **SVC-03**: Service `stop()` no cleanup needed (cron jobs persist in jobs.json)
- **SVC-04**: index.ts — remove `ensurePDCronJobs` call, register PDTaskService
- **SVC-05**: Delete cron-initializer.ts
- **SVC-06**: Remove `before_prompt_build` hook cron init code and `workspaceInitialized` flag for cron

## Architecture Reference

- `docs/architecture/pd-task-manager.md` — §4.6 PDTaskService (lines 468-493)
- `packages/openclaw-plugin/src/service/trajectory-service.ts` — minimal 15-line service registration example

## index.ts Changes

**Current (lines 99-109):**
```typescript
if (!workspaceInitialized && workspaceDir) {
  migrateDirectoryStructure(api, workspaceDir);
  ensureWorkspaceTemplates(api, workspaceDir, language);
  SystemLogger.log(workspaceDir, 'SYSTEM_BOOT', ...);
  const { ensurePDCronJobs } = await import('./core/cron-initializer.js');
  const cronResult = ensurePDCronJobs();
  if (cronResult.created.length > 0) {
    api.logger?.info?.(`[PD] Auto-created cron jobs: ${cronResult.created.join(', ')}`);
  }
  workspaceInitialized = true;
}
```

**After (Phase 16):**
- Remove entire cron initializer block (lines 103-108)
- Keep `workspaceInitialized` guard for `migrateDirectoryStructure` + `ensureWorkspaceTemplates`
- OR remove `workspaceInitialized` entirely since service handles its own init

## Service Registration (after line 335)

```typescript
import { PDTaskService } from './core/pd-task-service.js';
// ...
PDTaskService.api = api;
api.registerService(PDTaskService);
```

## File Structure

```
packages/openclaw-plugin/src/
├── core/
│   ├── pd-task-types.ts        (Phase 14)
│   ├── pd-task-store.ts        (Phase 14)
│   ├── pd-task-reconciler.ts   (Phase 15)
│   └── pd-task-service.ts      (NEW) — OpenClawPluginService
├── service/
│   └── (existing services)
└── index.ts                    (MODIFY) — register service, remove old hook
cron-initializer.ts             (DELETE)
```

## Verification Criteria

1. `api.registerService(PDTaskService)` called in index.ts
2. `before_prompt_build` hook no longer calls `ensurePDCronJobs`
3. `cron-initializer.ts` deleted
4. TypeScript compiles without errors
5. No new dependencies
