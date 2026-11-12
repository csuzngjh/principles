---
"@principles/core": minor
---

新增窄公开子路径 `./runtime/storage-paths`（存储路径收口第 1 批 / console）：

- `resolveStateDbPath(workspaceDir)` — 返回 `<workspaceDir>/.pd/state.db`；
- `resolveTrajectoryDbPath(workspaceDir)` — 返回 `<workspaceDir>/.state/trajectory.db`。

两者实现在 `src/runtime/store/storage-paths.ts`，本子路径只是公开入口，不包含 `workspaceDirFromStateDbPath`（靠 `join(dbPath,'..','..')` 反推工作区根，属已知隐患，不对外承诺）。

本批把 `packages/pd-console` 里 17 个文件、23 处手写的 `path.join(..., '.pd', 'state.db')` / `path.join(..., '.state', 'trajectory.db')` 换成上述 resolver，路径字符串逐字不变（见等价性探针），不改变任何读写语义。导出面门禁：新增 1 个子路径 + 2 个符号，均带准入记录，`+3 / -0`。
