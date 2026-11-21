---
"create-principles-disciple": patch
---

为产品版本 2.8.10 重铸安装器 payload 身份戳：#2731 cohort（44eb226）在产品版本 bump 落地前已进入发布火车，其 stamp 固定为 2.8.9，已装 2.8.9 的运行时按"不高于已装版本则禁止升级"规则收不到更新；需要一个新的 patch cohort 让签名频道能以 `product_version=auto` 发出 2.8.10。
