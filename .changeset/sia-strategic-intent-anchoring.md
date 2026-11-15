---
"@principles/core": minor
"@principles/pd-cli": patch
---

SIA v1.2（PRI-1214）：Stage A 捕获并持久化不可变 IntentSnapshot（服务端 hash、重试复用首快照），新增 IntentContract V2 与 relevance 唯一权威，审批写入新增服务端战略冲突门禁并只以可空 `intent_decisions.contract_digest` 绑定解决记录；pd-cli 的 internalization 运行入口传递同一 intent 上下文，不改变既有命令契约。
