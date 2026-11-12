---
---

核心库导出面准入门禁（P0）：把 `packages/principles-core` 的 27 个 `package.json#exports` 入口当前 2,351 个公开符号冻结成基线，并新增 `export-admissions.json` 准入记录。

本 PR 只锁边际、不改接口：不新增/不删除任何导出，不清理存量 1,380 个零外部引用符号，首次运行阻塞为 0。`./runtime`（2,032）与根桶（200）的符号数与既有 PRI-775 fixture 逐字一致。

无发布意图：仅新增一个只读门禁脚本、一个测试与两份 fixture，运行时与类型声明产物不变。
