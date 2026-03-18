# CRON_BOOTSTRAP_PROMPT

> Purpose: reusable prompt for an agent to create the Principles internal team's recurring cron jobs in OpenClaw

## Use This Prompt As-Is

你现在要为 Principles Disciple 的内部团队创建或更新 OpenClaw 定时任务。

你必须基于 OpenClaw 的**内置 `cron` 工具**工作，不要假设别的调度 API，不要编造工具名。

## 你的目标

为以下角色建立第一版半自治调度：

- `main` 负责日常站会、周治理、队列梳理
- `resource-scout` 负责巡检和 issue 线索收集
- `pm` 负责 proposal 和产品视角审查
- `verification` 负责验证扫尾
- `repair` 默认不做周期任务，主要由 `Repair Task` 驱动

## 你必须遵守的工具事实

OpenClaw 的定时任务工具名是：

- `cron`

它支持的 `action` 是：

- `status`
- `list`
- `add`
- `update`
- `remove`
- `run`
- `runs`
- `wake`

你创建任务时，必须使用：

- `action: "add"`

如果发现已有相同或相近任务，优先使用：

- `action: "update"`

## 你必须遵守的运行约束

### 1. 先查，后改

在创建任何任务前，先调用：

- `cron` with `action: "list"`

先检查是否已经存在同名或同职责任务，避免重复创建。

### 2. 不要猜 sessionTarget

你必须根据任务类型正确设置 `sessionTarget`：

- `payload.kind = "systemEvent"` 时，使用 `sessionTarget: "main"`
- `payload.kind = "agentTurn"` 时，使用 `sessionTarget: "isolated"`、`"current"` 或 `"session:xxx"`

默认优先使用：

- `sessionTarget: "isolated"`

因为这类任务更适合在独立、可恢复的运行里执行。

### 3. 会议和巡检优先使用 `agentTurn`

因为这类任务需要：

- 读取共享治理文件
- 总结现状
- 产生结构化输出

所以默认使用：

```json
{
  "payload": {
    "kind": "agentTurn",
    "message": "..."
  },
  "sessionTarget": "isolated"
}
```

### 4. 不要把 cron 当成聊天提醒器

每个 cron 任务都必须：

- 有明确 owner
- 有明确输出
- 有明确更新对象

不要创建“泛泛地看看情况”的空洞任务。

### 5. 不要自动创建 deploy / merge 类任务

当前团队边界是半自治。

允许创建：

- 巡检
- 例会
- proposal 审查
- verification 扫尾

不要创建：

- 自动部署
- 自动 merge
- 自动关闭高影响问题

## 建议的第一版任务

如果现有 cron 中没有等价任务，请创建下面 4 类。

### A. `main` 的日常站会

建议名称：

- `team-daily-sync`

建议频率：

- 每天 2 次

建议意图：

- 读取 `TEAM_CURRENT_FOCUS.md`、`WORK_QUEUE.md`、`TEAM_WEEK_STATE.json`
- 向其他角色索要结构化更新
- 汇总 blockers、next actions、artifact 状态
- 回写共享治理文件

### B. `main` 的周治理会

建议名称：

- `team-weekly-governance`

建议频率：

- 每周 1 次

建议意图：

- 汇总周进展
- 检查 OKR 偏移
- 识别重复失败模式
- 更新 `TEAM_WEEK_STATE.json` 与 `TEAM_WEEK_TASKS.json`

### C. `resource-scout` 的巡检任务

建议名称：

- `scout-triage-sweep`

建议频率：

- 每天多次

建议意图：

- 巡检日志、pain 信号、资源状态
- 发现 candidate issue
- 产出或更新 `Issue Draft`

### D. `verification` 的验证扫尾

建议名称：

- `verification-sweep`

建议频率：

- 每天多次

建议意图：

- 检查待验证工作
- 运行必要验证
- 生成或更新 `Verification Report`

### E. `pm` 的产品回顾

建议名称：

- `pm-proposal-review`

建议频率：

- 每周 2-3 次

建议意图：

- 审阅 proposal backlog
- 识别产品层冲突和优先级问题
- 形成 `Proposal Draft`

## 推荐执行顺序

严格按这个顺序执行：

1. 用 `cron` 的 `list` 查看现有任务
2. 识别是否已有同职责任务
3. 若已有，优先 `update`
4. 若没有，再 `add`
5. 创建完成后，再次 `list`
6. 输出最终结果：
   - 新增了哪些任务
   - 更新了哪些任务
   - 哪些任务因为信息不足而未创建

## 任务消息写法要求

每个 `agentTurn` 任务的 `message` 必须明确写出：

- 你是谁
- 你这次要检查什么
- 你要读哪些共享治理文件
- 你要产出什么
- 没发现问题时怎么处理

不要写成一句模糊的“去看看团队状态”。

## 你必须使用的输出格式

完成后，请用简洁结构输出：

### Created

- job name
- purpose
- frequency

### Updated

- job name
- what changed

### Skipped

- job name
- why skipped

## 可直接参考的创建样例

### 样例 1：创建 `resource-scout` 巡检任务

```json
{
  "action": "add",
  "job": {
    "name": "scout-triage-sweep",
    "schedule": {
      "kind": "every",
      "everyMs": 14400000
    },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "You are resource-scout. Read TEAM_CURRENT_FOCUS.md, WORK_QUEUE.md, and relevant runtime evidence. Identify new candidate issues, repeated pain, or resource anomalies. Produce or update an Issue Draft if needed. If nothing important changed, summarize briefly and avoid noisy output."
    },
    "enabled": true
  }
}
```

### 样例 2：创建 `main` 周治理会

```json
{
  "action": "add",
  "job": {
    "name": "team-weekly-governance",
    "schedule": {
      "kind": "cron",
      "expr": "0 9 * * 1",
      "tz": "Asia/Shanghai"
    },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "You are main, the Principle Manager. Run the weekly governance review. Read TEAM_OKR.md, TEAM_WEEK_STATE.json, TEAM_WEEK_TASKS.json, WORK_QUEUE.md, and recent reports. Identify blockers, repeated failures, and next-week priorities. Update shared governance artifacts and summarize decisions."
    },
    "enabled": true
  }
}
```

## 红线

- 不要编造不存在的 OpenClaw 工具
- 不要跳过 `cron list`
- 不要重复创建同类任务
- 不要创建自动 deploy / merge 任务
- 不要把自由聊天当成会议机制
