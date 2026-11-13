---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
---

RuleHost 决策内核收敛（PRI-1208）：共享门新增结构化 `evaluationFaults` 与 `evaluationStatus`，OpenClaw 适配层据此写入 `rulehost_unhealthy` / `rulehost_skipped` / `evaluation_failed`（此前这些事件在生产中没有产出）；删除无生产接线的 legacy RuleHost 路径与 `getRuleHost`。
