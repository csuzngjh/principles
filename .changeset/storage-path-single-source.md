---
---

core: 工作区数据库路径单点化——`SqliteConnection`、SDK `trajectory-store` 与 8 个 core 读模型不再各自拼装 `.pd/state.db` / `.state/trajectory.db`，统一从 `runtime/store/storage-paths.ts` 解析。纯内部重构：路径字符串逐字不变，无 SQL / 表结构 / 读写语义 / 包导出面变更，不发布。
