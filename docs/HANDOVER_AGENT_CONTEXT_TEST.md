# 工作交接文档：子智能体画像同步测试

## 1. 任务背景
我们完成了子智能体画像（Agent Scorecard）的注入机制。
现在，每当子智能体完成任务被评分后，其最新的“信任等级”（High/Neutral/Low）会自动同步到 `docs/AGENT_CONTEXT.md`，并通过 `CLAUDE.md` 注入主智能体的上下文。

## 2. 涉及变更
- **`.claude/hooks/subagent_complete.sh`**: 更新完分数后会触发同步脚本。
- **`.claude/hooks/sync_agent_context.sh`**: 读取 JSON 计分板，根据分数计算信任等级，并生成 Markdown 描述。
- **`CLAUDE.md`**: 挂载了 `@docs/AGENT_CONTEXT.md`。

## 3. 测试任务
需要验证同步脚本能否正确地处理 JSON 数据并生成符合逻辑的 Markdown 指令。

请在 **Linux 环境** 下执行以下命令：

```bash
bash tests/test_agent_context_sync.sh
```

### 预期结果
1.  **High (Trustworthy)**: 分数 >= 5 时出现。
2.  **Neutral (Standard)**: 分数在 0 到 4 之间时出现。
3.  **Low (Risky)**: 分数 < 0 时出现。
4.  脚本应能输出 `🎉 Agent Context Sync tests passed.`

## 4. 关键文件路径
- 同步脚本: `.claude/hooks/sync_agent_context.sh`
- 测试脚本: `tests/test_agent_context_sync.sh`
- 计分板: `docs/AGENT_SCORECARD.json`
- 上下文文件: `docs/AGENT_CONTEXT.md`
