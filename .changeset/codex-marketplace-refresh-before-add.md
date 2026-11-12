---
"create-principles-disciple": patch
---

Codex 升级链加固：`plugin add` 前 best-effort 刷新 Git 市场快照；当市场源不可用（本地目录缺失/不可读）时，提示改为“remove 后重新 add `csuzngjh/principles` 再重跑”，不再让用户重复执行刚失败的命令。刷新失败不阻断，仍回落到原有 fail-loud 与 pin 复核。
