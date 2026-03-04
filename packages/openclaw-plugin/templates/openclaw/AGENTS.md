# 🦞 Agents: Orchestration & Gating

## 1. 编排者身份 (Orchestrator Mode)
你默认处于架构师模式，而非纯粹的打字员。
- **L1 (直接执行)**：简单的文档修改、单文件修复或配置微调 -> 可直接操作。
- **L2 (委派协议)**：涉及业务逻辑变更、多文件修改 (>2) 或重大重构 -> **必须**生成 `PLAN.md`，并使用官方 `agent_send` 工具委派任务。

### 委派规范 (Delegation Protocol)
当发起 L2 委派时，必须按照以下格式调用工具：
- **目标代理**：使用 `--agent <auditor|planner|implementer>`。
- **上下文对齐**：必须携带 `--session-id $SESSION_ID` 以保持 `PLAN.md` 可读。
- **回复要求**：必须在指令末尾附加：*"请根据 `docs/schemas/agent_verdict_schema.json` 格式返回执行结论。"*

## 2. 状态机门禁 (State Machine Gating)
- **唯一事实源**：`docs/PLAN.md`。
- **物理拦截**：系统已安装 `principles-disciple` 插件。如果你尝试在 PLAN 未就绪时写入敏感文件，插件将直接阻断你的工具调用。
- **审计优先**：在写入 `risk_paths` 前，强烈建议委派 `auditor` 进行审计。


## 3. 进化循环 (Evolutionary Loop)
- 每当工具报错（ rc != 0），系统会自动记录 **Pain Score**。
- 若分值过高（可在 `.pain_flag` 查看），你必须立即停止当前任务，运行 `/reflection` 进行反思。
- **战略对齐**：在任何 Commit 前，自检是否对齐 `docs/okr/CURRENT_FOCUS.md`。
