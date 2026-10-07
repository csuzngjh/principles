---
"@principles/pd-console": patch
"create-principles-disciple": patch
---

更新恢复面不再永久误报 + 事务 journal 封卷守卫（PRI-896, PRI-897）

- 控制台更新页的「检测到未完成的更新事务」横幅此前把 `~/.pd/transactions/` 里**任何**非终态 journal 一律列为需恢复，且不参考产品自己的恢复判定（PRI-853 `recoverUnfinishedTransaction`）。被后续代次取代的崩溃残留孤儿因此永久报警，而官方路径没有任何手段让它收敛。现在只有当活动安装记录（`active.json`）能证明该事务确已被取代、且判定为 `old_confirmed` 时才降级；降级结果在 `GET /api/update/recovery` 的 `superseded` 字段中可见（绝不静默丢弃）。无活动记录 = 无证据 = 继续报警；激活被中断（`explicit_refusal`）= 真危险 = 继续报警。
- `ReleaseManager.apply()` 现在拒绝对已存在的 journal 文件续写（新拒绝码 `journal_sealed`，零副作用、发生在任何写入之前）。用陈旧 request 文件重跑 bootstrap 执行器会把第二次尝试追加进已封卷的文件，使整份 journal 的连续性校验永久失败，连其中已成功 `confirmed` 的更新历史都被判为损坏。

Console recovery banner no longer alarms forever on superseded crash residue, and `ReleaseManager.apply()` refuses to append a second attempt onto an already-sealed transaction journal (`journal_sealed`).
