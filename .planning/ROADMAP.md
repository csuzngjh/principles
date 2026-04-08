# Roadmap: v1.7 — PD Task Manager

**Milestone:** v1.7
**Status:** Planning
**Architecture Doc:** `docs/architecture/pd-task-manager.md`
**Date:** 2026-04-07

## Phases

Phase numbering continues from v1.6 (Phase 14).

| Phase | Name | Description | Requirements | Depends on | Status |
|-------|------|-------------|--------------|------------|--------|
| 14 | Core Infrastructure | PDTaskSpec 类型定义 + PDTaskStore + builtin tasks | TYPE-01~03, STORE-01~03 | None | Pending |
| 15 | Reconciler & Advanced Features | Reconcile 算法 + dry-run + health + prefetch + trigger + history | RECON-01~08, HLTH-01~07, PREF-01~05, TRIG-01~04, HIST-01~07 | Phase 14 | Pending |
| 16 | Integration & Migration | PDTaskService 注册 + index.ts 更新 + 删除 cron-initializer.ts | SVC-01~06 | Phase 15 | Pending |

## Dependencies (from v1.6)

None — v1.7 is self-contained within the plugin package.

## Risks

**Low** — isolated change, backward compatible, no new dependencies. All new files follow existing file-lock.ts + atomic write patterns.

## v2 (Future)

- Nocturnal Review — daily 21:00 pain signal analysis
- Weekly Governance — Friday OKR alignment + system health report

---

*Last updated: 2026-04-07 after roadmap creation*