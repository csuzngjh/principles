# Principles Disciple 与 OpenClaw 运行框架集成计划

> Updated: 2026-03-18
> Branch: `codex/agent-team-skeleton`
> Purpose: 把当前团队骨架和 OpenClaw 的真实运行机制接起来，找出流程断层、异常场景和技术落地点

## 1. 当前计划完成度

### 已完成

- 团队角色骨架已建立
- 团队共享治理层已建立
- 标准交付物模板已建立
- 团队技能骨架已建立
- 已厘清“通用模板层”和“内置团队层”的边界

### 进行中

- 将团队制度映射到 OpenClaw 的 `heartbeat / cron / sessions_send / subagent` 运行框架
- 为上下文压缩、重启、缺席、超时等异常情况补运行护栏

### 未完成

- 真实接入 heartbeat / cron 调度
- 真实跑通 `Issue Draft -> Repair Task -> Verification Report`
- 形成定期会议与周治理闭环
- 对异常场景进行演练与回退验证

## 2. OpenClaw 已有的底层能力

基于真实源码，当前最关键的运行件如下：

### `heartbeat`

来源：

- `D:\Code\openclaw\src\infra\heartbeat-runner.ts`
- `D:\Code\openclaw\src\infra\heartbeat-summary.ts`

它适合做：

- 保持角色活性
- 轻量巡检
- 读取 `HEARTBEAT.md` 后执行短检查
- 在没有用户对话时做最低限度的后台巡视

它不适合做：

- 复杂业务编排
- 多角色长链路协作
- 需要强时序和强交付的会议流程

### `cron`

来源：

- `D:\Code\openclaw\src\cron\types.ts`
- `D:\Code\openclaw\src\cron\service.ts`
- `D:\Code\openclaw\src\cron\isolated-agent\run.ts`
- `D:\Code\openclaw\src\cron\isolated-agent\session.ts`

它适合做：

- 精确定时
- 周期任务
- 独立会话运行
- 固定角色例行工作
- 定期会议、周报、巡检、验证扫尾

特别重要的一点：

- `cron` 可以跑在 `main / isolated / current / 指定 session` 上
- `isolated` 模式下会重新建立或复用会话，有自己的新鲜度和重置策略

这意味着：

- 团队会议
- 周治理
- bug 巡检
- verification sweep

都更适合建在 `cron` 上，而不是压到 heartbeat 上。

另外，OpenClaw 确实提供了内置 `cron` 工具，支持：

- `status`
- `list`
- `add`
- `update`
- `remove`
- `run`
- `runs`
- `wake`

因此“让智能体自己给自己创建定时任务”在技术上是可行的，不需要额外发明调度 API。

### 平级智能体通信

来源：

- `D:\Code\openclaw\src\agents\tools\sessions-send-tool.ts`
- `D:\Code\openclaw\src\agents\tools\sessions-send-tool.a2a.ts`

它适合做：

- 派单
- 索要进度
- 汇报结果
- 角色间回合式沟通

关键现实：

- 不是天然开放的
- 受 session visibility 和 `tools.agentToAgent` policy 控制
- 有 ping-pong 回合上限，不适合无限聊天

所以角色协作必须设计成：

- 少量显式消息
- 以共享工件为主
- 以结构化汇报为终点

### 子智能体

来源：

- `D:\Code\openclaw\src\agents\subagent-spawn.ts`
- `D:\Code\openclaw\src\agents\subagent-announce.ts`

它适合做：

- 定向复现
- 定向分析
- 定向实现
- 定向验证

它不适合做：

- 长期职位
- 团队级长期记忆
- 团队治理中枢

## 3. 最关键的运行设计原则

### 原则 A：长期角色靠平级智能体，不靠子智能体

原因：

- 平级角色有稳定身份和工作区
- 能长期持有自己的 `AGENTS / SOUL / HEARTBEAT / TOOLS`
- 更适合做周期性职责

### 原则 B：长期真相必须落盘

因为：

- 会话会压缩
- `cron` 可能跑在隔离会话
- heartbeat 也不是可靠长期记忆

所以团队不能依赖“大家都记得刚才聊过什么”，而必须依赖：

- `TEAM_CURRENT_FOCUS.md`
- `TEAM_WEEK_STATE.json`
- `TEAM_WEEK_TASKS.json`
- `WORK_QUEUE.md`
- `reports/`

### 原则 C：会议是工作流，不是聊天

OpenClaw 没有内建“会议”对象，但完全可以用下面这套工作流模拟：

1. `cron` 唤醒 `main`
2. `main` 读取共享治理文件
3. `main` 通过 `sessions_send` 向各角色索要标准化更新
4. 各角色只回标准格式状态
5. `main` 汇总为会议记录和行动项
6. 结果回写共享治理文件

这比“让几个 Agent 自由聊一会”稳定得多。

### 原则 D：每个自动流程都要能失败得体

我们不是要假设一切顺利，而是要让系统在这些情况下仍然稳定：

- 某个角色没回应
- 某个 `cron` 超时
- 某个 session 因新鲜度策略重建
- 某个子智能体失败
- 某条消息因 policy/visibility 不可达

## 4. 建议的运行映射

### `main / Principle Manager`

建议运行机制：

- `heartbeat`
  用于轻量巡视、对齐当前焦点、发现挂起任务
- 低频 `cron`
  用于主持例会、刷新周状态、整理团队工作队列
- `sessions_send`
  用于派单和收集团队汇报

不建议：

- 默认靠它自己直接修代码

### `pm / Product Manager`

建议运行机制：

- 低频 `cron`
  定期检查 proposal backlog、产品权衡、体验问题
- `sessions_send`
  接收 `main` 的问题、返回 `Proposal Draft`

### `resource-scout / Scout + Triage`

建议运行机制：

- 中频 `cron`
  巡检 bug、pain、资源、日志
- 可选 heartbeat
  做很轻的值班感知
- `sessions_send`
  向 `main` 报送 `Issue Draft`

### `repair / Repair Agent`

建议运行机制：

- 任务驱动为主
- 收到 `Repair Task` 再启动
- 需要时再派生实现类子智能体

### `verification / Verification Agent`

建议运行机制：

- 中频 `cron`
  清扫待验证项
- `sessions_send`
  回传 `Verification Report`
- 需要时派生验证类子智能体

## 5. 会议机制应该怎么做

当前建议把会议分成 3 类，而不是一类：

### A. 日常站会

目标：

- 快速同步状态
- 发现阻塞
- 更新 `TEAM_CURRENT_FOCUS`

技术实现：

- 用 `cron` 唤醒 `main`
- `main` 通过 `sessions_send` 向 `pm / resource-scout / verification / repair` 收集固定格式更新
- `main` 汇总后写入会议记录和行动项

建议频率：

- 每天 1-2 次

### B. 周治理会

目标：

- 汇总本周观察
- 审视 OKR、风险、异常模式
- 决定下周重点

技术实现：

- 用单独 `cron`
- 由 `main` 主持
- `pm` 必须参加
- `resource-scout` 和 `verification` 至少提供书面输入

产出：

- 更新 `TEAM_WEEK_STATE.json`
- 更新 `TEAM_WEEK_TASKS.json`
- 写一份周回顾报告

### C. 异常事件会

目标：

- 处理高优先级故障
- 在系统异常时快速定责和收敛动作

触发条件：

- 连续验证失败
- 队列堆积
- 重复 bug 爆发
- 某角色长时间缺席

技术实现：

- 不一定等固定 cron
- 可由 `main` 或 `resource-scout` 主动触发

## 6. 最重要的流程断层

### 断层 1：制度存在，但未接到调度器

现在我们已经有：

- 角色
- 章程
- 队列
- 交付物

但还没有：

- 真正驱动它们周期运行的 `cron`

这会导致制度是静态文档，而不是活系统。

### 断层 2：共享治理层存在，但未成为启动必读

如果各角色在每次启动时不稳定读取共享工件，团队就会退化成：

- 各做各的
- 依赖会话残留记忆

所以后面要把共享治理文件正式写入角色启动协议。

### 断层 3：有角色分工，但没有会议与回报协议

没有会议协议，就没有稳定的节奏化协作。

没有回报协议，就会出现：

- manager 不知道团队在干什么
- 多个角色各自推进，但无法汇合

### 断层 4：异常时没有降级策略

例如：

- 某角色消息不可达
- 子智能体超时
- 验证角色缺席

如果没有降级路径，流程就会直接卡死。

## 7. 必须补上的异常策略

### 情况：上下文压缩或重启导致遗忘

处理：

- 启动时必须重读角色静态文件
- 复杂任务必须回写共享治理文档
- 正在进行的任务必须落到 `WORK_QUEUE.md` 或报告文件

### 情况：`cron` 跑在隔离会话，拿不到旧上下文

处理：

- 不依赖旧聊天上下文
- 所有关键状态从共享工件恢复
- 会议和治理流程只消费共享文件，不消费“上轮聊天残留”

### 情况：消息发送失败或 agent-to-agent 被 policy 拦住

处理：

- 角色协作必须有共享工件兜底
- 关键派单和回报同时写文档记录
- 不把 `sessions_send` 当成唯一真相源

### 情况：某角色超时或缺席

处理：

- 会议主持方等待一个有限超时时间
- 超时后记录为“缺席”
- 由 `main` 进行升级或改派

### 情况：子智能体失败

处理：

- 父角色不能直接跳成全能执行者
- 必须把失败回写为新的 `Issue Draft`、`Repair Task` 或 `Verification Report`

## 8. 下一阶段最值得做的事

### 第一优先级

- 把共享治理文件接入各角色启动协议
- 设计第一版例会 `cron` 和消息格式
- 使用 `CRON_BOOTSTRAP_PROMPT.md` 驱动真实创建或更新团队 cron
- 让 `main` 使用明确的管理者执行提示词主持站会和周治理
- 给 `pm`、`resource-scout`、`verification` 配套明确的角色执行提示词
- 给 `repair` 配套明确的低风险执行提示词

### 第二优先级

- 把 `Issue Draft -> Repair Task -> Verification Report` 跑成真实闭环

### 第三优先级

- 设计角色缺席、消息失败、验证失败时的降级流程

## 9. 一句话结论

现在我们已经把“团队制度”搭出来了，下一步真正决定它能不能活起来的，不是再写更多原则，而是把这些制度接到 OpenClaw 的：

- `cron`
- `heartbeat`
- `sessions_send`
- `subagent`
- 共享治理文件

上面去。

只有这一步完成，它们才会从“写在纸上的团队”变成“生活在赛博空间里的团队”。
