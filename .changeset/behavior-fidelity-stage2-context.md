---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Stage-2 纠正分类补必要行为事实（PD-BEHAVIOR-FIDELITY-001 Gate 3，PRI-1212）。

- **上下文**：`buildLlmPrompt` 新增可选 `Stage2ConversationContext`（本会话前置 assistant 回合数、最近回合有界摘要、anchor 指向），由 OpenClaw 宿主从既有 Trajectory 读取；读不到时明确标注"不可用"，绝不当成"没有"。未新增语义分类服务，未使用关键词黑名单。
- **判定纪律**：correction 必须能指认具体前置 AI 行为；本会话无前置行为时，只有消息本身明确回指此前 AI 行为（跨会话延续）才可判 correction；执行指令/授权/压制确认本身不是纠正；用户撤回自己的要求不是纠正；confidence 必须反映证据强度。
- **置信度门**：宿主确认本会话无前置 assistant 行为时，correction 需 ≥ 0.9，否则保持 `pending_low_confidence`（进入既有批量确认路径，不伪造纠正、也不丢弃）。未知（null）路径维持原契约，避免影响 Codex/WorkBuddy 等无会话快照的调用方。
- **实测**（zai/glm-5.3-flash，R3 原样本 ×5）：修复前 2/5 语义误判为 correction、1/5 真正被准入；修复后 0/5 误判、0 准入。七类反例矩阵见实验报告。
