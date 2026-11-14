---
"@principles/core": patch
---

内部化完整性修复命令的 state.db 写路径收口到既有 `SqliteConnection`：5 处裸 better-sqlite3 写句柄改为与任务/运行/租约/工件等写者相同的打开方式（WAL、busy_timeout、foreign_keys、schema 初始化），解析路径由 `workspaceDirFromStateDbPath` 反解，结果不变。

- 可感知行为变化：锁竞争下该命令的失败耗时从约 5.7s 变为约 11.2s（`getDb()` 先跑 schema 初始化，多消耗一个 busy_timeout）；失败即止、零部分写入、释放后重跑成功这三条不变。
- 新增 canonical 建库基线测试：confirm 前后 `sqlite_master` 哈希一致、dry-run 行数不变、二次执行幂等。
- 9 处只读连接保留原样并逐处记录理由；无 schema 变更、无数据迁移、无新公共 API。回退该提交即恢复旧行为。
