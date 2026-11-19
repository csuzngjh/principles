---
---

CI flake 修复，不需要发版：本 PR 只改 `console-verify-identity.test.ts` 的端口窗口获取方式——把硬编码的 34710–34809 窗口（位于 Linux ephemeral 端口范围内，会被并行 worker 的 `listen(0)` 抢占导致 EADDRINUSE）改为在 beforeAll 中发现一个连续空闲 100 端口窗口并整个文件持有，测试只替换响应策略而不再重绑端口。生产代码与可观察行为未变。
