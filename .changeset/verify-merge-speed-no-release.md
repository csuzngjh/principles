---
---

仅新增测试入口，不影响发布行为，显式声明非发布相关。

本 PR 只改 CI 门禁的执行方式与调度：`verify:merge` 去掉重复构建、`npm run` 包装改直调、`lint-by-package` 增加默认关闭的并发、`ci.yml` 缓存 `node_modules`。

`packages/pd-mcp-server` 的唯一改动是新增 `test:unit` 脚本（`vitest run`），`test` 脚本原样保留；没有导出变化、没有运行时分支变化、发布物不变，因此不发布。
