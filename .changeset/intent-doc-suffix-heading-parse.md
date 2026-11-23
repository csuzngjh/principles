---
"@principles/core": patch
---

fix: INTENT 标题带分隔符后缀（`—–:：` 引导的非空注释）按 canonical 解析，消除 Owner 本地化标题（如 `## 1. Why — 为什么存在`）导致的 Intent 链整链静默 not_configured 降级；词组延伸（`## 1. Why not`）仍拒绝。PRI-1284。
