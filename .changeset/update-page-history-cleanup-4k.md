---
"create-principles-disciple": patch
---

更新页重设计：更新历史排序/折叠/清理 + 4K 双栏布局（pd-console 承载，随安装器发布）。

- **更新历史最新在上**：页面按事实时间降序渲染（此前按文件追加序，最旧在最上面）；API 文件序契约不变，显示顺序归 UI 所有。
- **默认只展示最近 5 条**：其余折叠在「显示其余 N 条」 disclosure（aria-expanded）后，≤5 条时不出现开关。
- **Owner 清理**：新增 `POST /api/update/history/prune?keep=N`（1–50 整数校验，缺省 5）——保留最新 N 条删除其余；删除前滚动备份 `update-history.json.bak-prune`，被删事务 id 记入台账 `update-history-pruned.json`，启动 reconcile 不再复活已清理行；清理窗口同时覆盖曾被 50 条上限挤出文件的更旧 journal（否则重启后列表会长回来）；UI 入口带 AlertDialog 确认与结构化计数 toast，≤5 条时禁用。`~/.pd/transactions` 日志只读不写。
- **4K 双栏**：页面升 PageShell `table` 档（1200/1440/1760），容器 ≥82rem（每栏保住 640px 阅读地板）时状态卡与更新历史左右双栏（各 760px 封顶）——4K 多出的宽度变成第二列与留白，不是更长的文字行（DESIGN_BRIEF D20）。
