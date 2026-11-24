---
"create-principles-disciple": patch
---

为产品版本 2.8.12 重铸安装器 payload 身份戳：main 上已有多轮 cohort 以 productVersion=2.8.11 发布且 stable 渠道已服务 2.8.11，已装 2.8.11 的运行时按"不高于已装版本则禁止升级"规则收不到本批合并 PR；需要一个新的 patch cohort 让签名频道能以 `product_version=auto` 发出 2.8.12。
