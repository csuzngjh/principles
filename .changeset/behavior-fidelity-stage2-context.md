---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Stage-2 纠正分类补必要行为事实（PD-BEHAVIOR-FIDELITY-001 Gate 3，PRI-1212）。

- **上下文**：`buildLlmPrompt` 新增可选 `Stage2ConversationContext`（本会话前置 assistant 回合数、最近回合有界摘要、anchor 指向），由 OpenClaw 宿主从既有 Trajectory 读取；读不到时明确标注"不可用"，绝不当成"没有"。日志区分 `no_trajectory_writer`、`no_assistant_turn_context_reader` 与读取异常，线上可分辨"宿主没有轨迹"和"正常首条消息"。未新增语义分类服务，未使用关键词黑名单。
- **有界读取**：OpenClaw 侧新增 `TrajectoryDatabase.getAssistantTurnContext`（count + 最近 N 条 sanitized 摘要 + 可选 anchor，走既有 `session_id` 索引），不再在 `before_prompt_build` 同步栈上为每条候选消息读取整个会话（含 `raw_text`）的 assistant 回合。
- **判定纪律**：correction 必须能指认具体前置 AI 行为；本会话无前置行为时，只有消息本身明确回指此前 AI 行为（跨会话延续）才可判 correction；执行指令/授权/压制确认本身不是纠正；用户撤回自己的要求不是纠正；confidence 必须反映证据强度。
- **置信度门**：宿主确认本会话无前置 assistant 行为时，correction 需 ≥ 0.9，否则保持 `pending_low_confidence`；未知（null）路径维持原契约，避免影响 Codex/WorkBuddy 等无会话快照的调用方。
- **pending 不丢弃**：LLM 已表态（低置信度、结果不可用、分类器抛错）的零关键词 discovery 候选现在也进入既有 `signal_confirmations` 批量确认队列——它们已经消费过 discovery 配额，丢弃等于把"保持 pending"变成"删除真纠正"。没有 LLM 的降级路径仍维持原过滤，且所有未入队分支写 `SIGNAL_CONFIRMATION_NOT_QUEUED` 与具体原因，不再出现"日志说已入队、实际被丢弃"。
- **已知残余（未在本轮关闭）**：批量确认路径不携带入队时的 `priorAssistantTurnCount`，仍使用 0.7 门槛。因此会话首条消息若命中歧义词入队，下一周期仍可能以 0.85 被批量准入。关闭它需要把会话事实持久化进 `signal_confirmations`（schema 变更），不在本次 patch 范围内。
- **实测**（zai/glm-5.3-flash，R3 原样本 ×5）：修复前 2/5 语义误判为 correction、1/5 真正被准入；修复后 0/5 误判、0 准入。七类反例矩阵见实验报告。
