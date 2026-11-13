---
---

仅调整 `scripts/` 测试套件的执行并发，不影响任何发布物，显式声明非发布相关。

PRI-1195：`scripts/vitest.config.ts` 增加 `maxWorkers: 2`。该套件每个清理用例要串行完成约 10 次 git 子进程往返、隔离区 rename 与整机 `/proc` 扫描；在 4 核 CI runner 上默认按文件无上限并行会拉长这些串行窗口，并让 `workspace-lifecycle.test.ts` 的 PRI-712 用例偶发被 fail-closed 拒绝。并发上限只降低环境竞争，不断言、不放宽任何 fail-closed 判定，也不改产品代码。
