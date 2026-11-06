---
---

PRI-1142：修复 main 上 PRI-212 plugin-core anti-growth guard 的 CI 红灯，仅补一条新增文件的分类登记，无用户可见行为变化，明确声明 no-release。

- PRI-1110 新增的 `adaptive-config-identity.ts` 未按守卫规则登记进 `KNOWN_PLUGIN_CORE_FILES`，导致 main 及在飞 PR 的 `Test principles-core` 连续失败。
- 按守卫头部既定流程补 plugin I/O boundary 分类注释与条目，并把基线 size 断言 93 → 94；守卫的 `expect.fail` 与未分类检查逻辑保持不变。
- mutation check：临时新增未登记文件仍能触发同一断言失败，证明守卫未被削弱。
