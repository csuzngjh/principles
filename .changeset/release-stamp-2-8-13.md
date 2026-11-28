---
"create-principles-disciple": patch
---

为产品版本 2.8.13 重铸安装器 payload 身份戳：main 自 2.8.12（#2794）以来累积 21 个提交（PRI-1299 生命周期统一各阶段、Pipeline Spine 2A/2B、#2810 退役 Companion 后台运行时改为 Service Host 唯一后台），已装 2.8.12 的运行时按"不高于已装版本则禁止升级"规则收不到本批内容；需要一个新的 patch cohort 让签名频道能以 `product_version=auto` 发出 2.8.13。
