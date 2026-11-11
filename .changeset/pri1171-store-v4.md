---
"@principles/host-runtime": patch
---

PRI-1171 P1 工单③：governance observation store 升 schema v4（additive）——`host_kind` 契约放宽为 `codex | workbuddy | openclaw`（应用层联合类型，DDL 不变），checkpoint upsert 改为 MAX 单调（`byte_offset`/`last_ordinal` 取最大值），防止 Stop 钩子与 worker catch-up 并发时后提交者把水位拉回导致重复解码与健康页抖动。v3 旧库下次打开自动升版本号，存量行零改写；新增测试覆盖版本迁移幂等、workbuddy 行写入读取、MAX 单调（低水位后到不回退）。
