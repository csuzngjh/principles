---
"@principles/core": patch
---

修复诊断任务恢复（`pd pain retry` / `pd diagnose run`）在子阶段已 `succeeded` 时必然 `lease_conflict` 死锁的问题：`SplitDiagnosticianRunner` 的 Stage A / Stage B 现在与既有的 Stage C 一致，先复用已成功阶段（阶段产物在任务标记 `succeeded` 之前已提交，下游阶段直接读取产物），不再重新 lease 一个不可 lease 的 `succeeded` 任务。

同时修正 dev 脚手架 `scripts/setup-worktree.mjs` 的 critical files 清单：移除仓库中已不存在的 `CLAUDE.md`，避免 worktree 引导永久停在 `CREATED_NOT_READY`（该文件仅为 dev 脚本，不影响发布物）。
