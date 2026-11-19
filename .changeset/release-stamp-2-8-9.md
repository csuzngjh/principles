---
"create-principles-disciple": patch
---

为产品版本 2.8.9 重铸安装器 payload 身份戳：#2708 cohort（95de4c633）在产品版本 bump（#2717）落地前已进入发布火车，其 stamp 固定为 2.8.8；需要一个新的 patch cohort 让签名频道能以 `product_version=auto` 发出 2.8.9，使已装运行时经控制台获得更新。
