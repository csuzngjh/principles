---
"@principles/host-runtime": patch
"create-principles-disciple": patch
---

控制台审批：历史 scribe 工件的身份改为沿候选血缘解析账本原则，批准预检不再把本可激活的记录判为永久不可批准。

- 追溯性影响：`#2614` 收紧 preview 身份口径（移除 `principleDraft.title` 兜底）后，2026-09 之前未回填 `source_principle_id` 的历史审批从可批准变为永久不可批准。生产 33 条 pending prompt 审批中约 18 条可通过血缘恢复，约 15 条确实没有账本对应。
- 预检与激活共用同一身份权威（existing `resolveLedgerPrincipleId` / `resolveLedgerActivationId`），属于连接既有能力，不是新增校验。
- 队列对确实无法解析身份的 pending 记录禁用批准并说明原因/下一步，保留“不批准”出口；不删除、不隐藏历史数据。
- 不做隐式数据写入或迁移；如需批量回填 `source_principle_id`，另开工具。
- Rollback：新增字段均为可选、无 schema 变更，回退提交即恢复旧行为。
