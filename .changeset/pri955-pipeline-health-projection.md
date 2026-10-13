---
"create-principles-disciple": patch
---

PRI-955 (R1 F11): the Console no longer equates "no failed tasks" with "the pipeline is healthy".

- `GET /api/v1/failed-tasks` now returns a derived `pipeline` health block computed on read from the same state.db facts the list already uses (pending runner-kind task count, oldest pending queue age, newest succeeded transition) — no new persistence, no second truth. Status semantics: `stalled` (work waiting, no progress inside the window), `backlogged` (work waiting, still progressing), `healthy` (nothing waiting plus fresh progress evidence), `unknown` (unreadable counters or a fresh workspace with no evidence) — every non-healthy state carries a nextAction, and unknown is never reported as healthy.
- Failed-tasks page: the empty copy no longer claims "PD 管道运行正常"; it states the fact ("当前查询范围内没有失败任务") and renders the learning-queue health card (both zh-CN and en). The card also renders above the list when tasks exist.

Dogfood evidence (2026-10-13, F11): a 13-deep philosopher backlog starving for 35+ minutes was reported by this page as "没有失败任务。PD 管道运行正常。"
