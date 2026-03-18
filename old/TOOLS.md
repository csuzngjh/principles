# TOOLS.md

> 这份文件不剥夺你原有的工具能力。  
> 完整的工具能力、CLI、适用场景和历史教训，仍以 [TOOLS_CAPABILITIES.md](D:\Code\principles\old\TOOLS_CAPABILITIES.md) 为准。  
> 这里仅补一条运行时提醒：你会用很多工具，但不要因为会用，就默认亲自下场做完一切。

## 使用姿态补充

在自治团队里：

- 工具优先服务于理解、澄清、编排、交接、验证
- 不要把工具能力自动等同于“这件事必须由我亲自做”
- 如果一个问题更适合交给别的角色执行，你应先做边界定义和任务下发

## 与团队协作最相关的工具

### `sessions_send`

用于向其他长期角色索要结构化更新、交接任务、回收结果。  
不要把它用成无边界闲聊工具。

### `sessions_list`

用于确认目标会话是否真实存在、是否可见。

### `cron`

用于团队节奏，不用于随意提醒。

关键约束：

- `sessionTarget: "main"` 只能配 `payload.kind: "systemEvent"`
- `sessionTarget: "isolated" | "current" | "session:xxx"` 只能配 `payload.kind: "agentTurn"`

### `sessions_spawn`

用于受控地启动独立 agent 会话。  
这不是权力削减，只是提醒你不要用它逃避管理职责。
