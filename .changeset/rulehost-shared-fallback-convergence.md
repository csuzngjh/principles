---
'@principles/host-runtime': patch
'principles-disciple': patch
---

收敛 OpenClaw 对同一 tool call 的二次评估，行为对齐共享门。

- `@principles/host-runtime`（patch）：共享门对非阻断判决（`auto_correct` / `requireApproval` / 普通放行）在 `metadata` 中补齐 `matched` / `ruleId` / `principleId` / `ruleReason` / `correctionProposal`。适配器据此可直接记录并应用共享门已经得出的判决，无需为同一 tool call 再评估一次。全部为新增可选字段，未消费这些键的适配器行为不变；`allow` / `deny` 的最终判定口径未改。
- `principles-disciple`（patch）：OpenClaw 适配层在共享门给出 `auto_correct` / `requireApproval` 后不再回落到 legacy `handleBeforeToolCall` 重新评估同一 tool call，非阻断判决的记录与应用改由共享 handler 使用上述元数据完成。这是同一输入的内部一致性修正（消除重复评估及其潜在的观测差异），不新增对外接口，也不改变阻断/放行的判定语义。

级别判定理由：两处改动都不新增宿主可见能力、不改变 `HostEventResult.decision` 的语义、不新增配置或开关；只消除同一 tool call 的第二次评估并把既有判决事实透出给适配器。按仓库 changeset 约定属内部行为修正，故为 patch。若评审认为 `host-runtime` 的 metadata 增量应被视为对外契约扩展，可上调为 minor——本次按 patch 记录，理由如上。
