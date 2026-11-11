---
"@principles/core": patch
"create-principles-disciple": patch
---

Console 证据链以中性措辞展示「智能体报告，拥有者已授权」来源。

- `EvidenceChainRecord` 增加可选只读 `provenance`，来自既有 `tasks.diagnostic_json`（不新增列、不做迁移、不新建真值）。
- `pd-console` 对 `agent_reported_owner_approved` 使用中性 i18n 文案；旧三值展示不变，内部枚举不出现在界面。
