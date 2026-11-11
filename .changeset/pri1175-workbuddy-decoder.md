---
'@principles/workbuddy-adapter': minor
'@principles/core': patch
'@principles/pd-cli': patch
'@principles/host-runtime': patch
---

WorkBuddy 会话转录解码器接入统一摄取 seam（PRI-1171 P2 工单④）。新增 `ingestion/` 模块：`encodeWorkbuddyCwd`（按盘上取证样本锁定的目录编码契约）、确定性转录定位/校验（hint 优先 + `<projects>/<encodeCwd(cwd)>/<sessionId>.jsonl` 推导，含穿越/包含/主会话形状校验）、六记录类型宽容解码（message/function_call/function_call_result/reasoning/file-history-snapshot/ai-title，另容忍 session-meta/fork/未知类型——跳过全部计数告警，不静默）、callId 工具配对（配对缺失侧 partial）、reasoning parentId 链归属（失败=partial+unattributed，不猜）、压缩标记只告警不传墓碑（WorkBuddy 压缩是追加摘要，传 compactionTimestamp 会删有效证据）、checkpoint 种子合成序数、50MB 单会话告警。host-runtime：`GovernanceObservationKind` 联合增 `reasoning`（首个生产者=WorkBuddy 解码器；Codex 丢弃分支保持到 P3 工单⑧）。变体基线固化 fixtures + 58 项契约/集成测试（含 pipeline 端到端：checkpoint 提交、重放无操作、incomplete-tail 恢复、flag-off/未同意零端口调用隐私不变量）。

真实载荷保护（PR #2534 评审 P0 修复）：WorkBuddy 的 `message/user` 记录在真实盘上是约 15KB 宿主 `<system-reminder>` 上下文 + 尾部 `<user_query>` 中的 Owner 原话。解码器只把 Owner 话语投影为 `visibleText`，绝不把宿主上下文写进治理库——整块投影会被 store 的 200 字 head-only 净化截断，既丢失真实输入，又把 AGENTS/身份文件/工具说明当成 Owner 行为证据送进 Pain 管道（本机 6 会话 24/24 条真实输入丢失）。上下文块缺失/未闭合/纯上下文等分支均带聚合告警并落 `partial`，不静默、不猜测；新增真实载荷形态的单元与 store 往返回归测试。修复后用真实盘上转录复核：25 条含 `<user_query>` 的记录中 24 条完整落库、0 条泄漏宿主上下文；剩余 1 条是超长引用型输入，仍受 store 既有 200 字 head-only 上限截断（但保留的是真实输入开头而非系统提示）。该上限属 PRI-1171 文本策略 full tier 范围，不在本次修复内。

工单⑤⑥接线（端到端采集）：新增 `workbuddy_conversation_ingestion`（quiet，默认关）与 lifecycle census 条目；`pd workbuddy setup` 成为该开关 + v3 同意记录的唯一授权入口（先开 flag、成功后写 granted，失败回滚）；运行时**真实读取** v3 consent ledger（Codex 路径仍硬编码 granted），撤销即时生效。WorkBuddy 插件注册 `Stop`（30s）→ decoder 映射 `turn_complete`（Stop 无 cwd，不伪造）→ `ingestWorkbuddyConversation` 把 snake_case `transcript_path` / `agent_transcript_path` 桥接到 `HookHints`，经统一 seam 落 `trajectory.db`；worker 增加按 durable checkpoint 精确 sessionId 定位的有界 catch-up，并把 `conversationIngestionEnabled: false` 硬编码改为真实 flag。三层门（host.workbuddy + ingestion flag + consent=granted）任一关闭均零转录读取。端到端测试用真实 hook 子进程 + 真实 SQLite 断言落库、可见文本为 Owner 原话，以及 flag-off / 未同意 / 已撤销零行、catch-up 补收 lag。
