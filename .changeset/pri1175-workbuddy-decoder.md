---
'@principles/workbuddy-adapter': minor
'@principles/host-runtime': patch
---

WorkBuddy 会话转录解码器接入统一摄取 seam（PRI-1171 P2 工单④）。新增 `ingestion/` 模块：`encodeWorkbuddyCwd`（按盘上取证样本锁定的目录编码契约）、确定性转录定位/校验（hint 优先 + `<projects>/<encodeCwd(cwd)>/<sessionId>.jsonl` 推导，含穿越/包含/主会话形状校验）、六记录类型宽容解码（message/function_call/function_call_result/reasoning/file-history-snapshot/ai-title，另容忍 session-meta/fork/未知类型——跳过全部计数告警，不静默）、callId 工具配对（配对缺失侧 partial）、reasoning parentId 链归属（失败=partial+unattributed，不猜）、压缩标记只告警不传墓碑（WorkBuddy 压缩是追加摘要，传 compactionTimestamp 会删有效证据）、checkpoint 种子合成序数、50MB 单会话告警。host-runtime：`GovernanceObservationKind` 联合增 `reasoning`（首个生产者=WorkBuddy 解码器；Codex 丢弃分支保持到 P3 工单⑧）。变体基线固化 fixtures + 51 项契约/集成测试（含 pipeline 端到端：checkpoint 提交、重放无操作、incomplete-tail 恢复、flag-off/未同意零端口调用隐私不变量）。
