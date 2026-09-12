# CNB → GitHub Delivery Bridge 测试载荷（PRI-778 验证）

- 用途：验证交付桥（`pull_request.merged` → `sync/cnb-delivery/<sha>` → GitHub PR）端到端自动同步。
- 本文件是临时验证载荷：桥验证完成后可删除或由 Owner 裁决保留。
- 预期结果：本 PR 在 CNB 合并后，GitHub 自动出现分支 `sync/cnb-delivery/<合并提交短SHA>` 与对应 PR。

- 第二轮（2026-09-13）：修复 git-sync 插件凭据注入问题后（PR #1647），验证桥的完整自动交付。
