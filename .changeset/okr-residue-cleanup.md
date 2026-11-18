---
"principles-disciple": patch
---

OKR 旧功能残留清理（与 PR#2698 Principle Context Batch 1+2 零冲突）：删除 openclaw-plugin 的 OKR 周任务死模板种子 `templates/workspace/okr/WEEK_TASKS.json` 与 `TASK_CHANGES.jsonl`（全仓库无任何代码读写，仅 2026-W11 陈旧种子）；删除 `PD_FILES.WEEK_STATE` / path-resolver pathMap `WEEK_STATE` 死标识符（零消费者）；删除 2026-03 OKR 历史测试归档脚本 4 个（docs/archive/tests-2026-03/scripts）；修正架构文档过期 OKR 行（`/pd-manage-okr` 幽灵命令行、"OKR context" 注入描述、tests README 旧话术）。`memory/okr/` 目录名与 `CURRENT_FOCUS.md`（Principle Context 规范载体）不受影响，由 PRI-1269（PR#2698）管辖。
