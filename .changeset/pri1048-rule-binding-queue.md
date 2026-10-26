---
"@principles/core": patch
"@principles/pd-console": patch
"create-principles-disciple": patch
---

PRI-1048：治理焦点「规则的正式原则归属」队列修复父子任务重复并改版为可理解的来源/阶段/操作卡片。根因：`getCandidatesByTaskId` 本身按「自身+子任务」查询，队列又同时遍历 diagnostician 与 diag_router 任务列表，router 子任务提交的候选被父诊断带出一次、router 再带出一次（真实 workspace 9 候选显示 18 条）。修复在队列聚合所有者（RuleCandidateBindingConsoleModel.list）按 canonical candidateId 去重，共享 store 查询语义不变。同时把队列 DTO 从 candidateId/text/reason 扩展为只读投影：来源痛苦信号原文（trajectory.db 批量只读）、诊断状态、绑定态与原则正文（ledger 权威）、生成链阶段（dreamer→…→rollout_reviewer，受阻带 reasonCode）、修订资格（真实 `resolveRuleBindingRevisionTarget` + 与 reviseRuleBindingOnce 相同的预算规则，仅导出既有函数，无逻辑复制）；前端改为按痛苦信号分组的有界卡片（默认回答「哪次反馈/卡在哪/要做什么」，技术 ID 与原始 JSON 折叠进「技术详情」），「修订并继续」仅在真实资格 ready 且链不在运行时出现，不摆不能执行的按钮，也不把通用重试冒充源修订；@principles/core 仅把 `resolveRuleBindingRevisionTarget` 加入 runtime-v2 barrel 导出（冻结快照同步 +1）。
