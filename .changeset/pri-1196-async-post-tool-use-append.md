---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/codex-adapter": minor
"create-principles-disciple": patch
---

Codex 桌面普通聊天：自适应原则注入新增「后台选择」时机（PRI-1196）。

- `adaptiveActivation.timing`: `sync | background`（缺省即 `sync`，已有工作区行为不变）。`background` 下首请求只发 Native，决策在独立后台进程进行；仅当同一轮的合格只读工具返回后、结果已就绪且仍能赶上时，才在下一次模型请求追加一条原则。
- 后台选择复用既有候选读取、跳过判定、决策协议、授权复验、容量计量与运行事件；不新建调度平台，最多一次评分请求，无可追加候选/无可信轮次/命中既有跳过条件时零评分。
- 同轮、及时、只送一次：结果绑定工作区 + Session + `turn_id` + 激活身份；`renameSync` 原子领取保证重放/并发最多送达一次；首个动作是变更、并行工具含变更或顺序不可证、结果迟到、跨轮/跨会话、授权或版本变化、预算不足、关闭与 Stop 一律回到 Native。
- 追加保持 Native 原项与顺序；`replaceableActivationIds` 非空时拒绝后台模式（追加专用）。
- 设置页「自适应原则注入」新增「同步选择 / 后台选择」时机选择，与原开关、服务配置、上一次结果区共用；`selected:background_ready`（后台选中）与 `selected:background_appended`（最终追加）分开记录，运行记录不含原始正文、凭据或完整模型响应。
