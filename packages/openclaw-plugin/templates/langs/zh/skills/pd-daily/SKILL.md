---
name: pd-daily
description: 配置并发送每日进化日报（支持邮件/即时通讯/飞书/语音通知）
disable-model-invocation: true
---

# 进化日报

智能体通过此技能帮助用户配置并自动发送每日进化报告，让用户感知系统"每天都在进步"。

## 执行原则

1. 首次运行必须与用户确认需求
2. 用户偏好存储在 `{stateDir}/daily-report.md`，已存在则跳过采集
3. 使用 OpenClaw 的 cron 工具创建定时任务
4. 自主选择可用的发送渠道

---

## 流程

### Step 1: 检查配置文件

读取 `{stateDir}/daily-report.md`：
- **已存在** → 检查 cron 任务状态，执行日报生成
- **不存在** → 进入需求采集流程

### Step 2: 需求采集（首次运行）

通过会话对话依次询问：

1. **是否启用进化日报？**
2. **发送时间？**（默认每天 23:00 UTC）
3. **时区？**（默认 UTC）
4. **发送渠道？**
   - 📱 **飞书** → 需用户 open_id（推荐，格式：ou_xxx）
   - 邮件 → 需邮箱地址
   - WhatsApp/Telegram → 需手机号/用户ID
   - Discord/Slack → 需频道ID
   - 语音通知 → 需手机号
5. **报告风格？**（参考下方"风格选项"）
6. **内容偏好？** 选择包含哪些模块

### Step 3: 创建配置文件

将用户偏好写入 `{stateDir}/daily-report.md`：

```markdown
# 进化日报配置

## 基本信息
- 启用状态: 是
- 创建时间: {date}

## 发送设置
- 发送时间: 23:00
- 时区: UTC
- Cron 表达式: 0 23 * * *

## 发送渠道
- 渠道: feishu
- 目标: ou_cf5c98aada743ab12c65c7c6764b5a49

## 报告风格
- 风格: standard
- 语言: zh

## 内容偏好
- 成长亮点: 是
- 痛苦信号: 是
- 趋势对比: 是
- 洞察建议: 是

## Cron 任务
- jobId: {创建后自动填充}
```

### Step 4: 创建 Cron 任务

使用 cron 工具：

```json
{
  "action": "add",
  "job": {
    "name": "evolution-daily-report",
    "schedule": { "kind": "cron", "expr": "0 23 * * *", "tz": "UTC" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "执行进化日报技能：读取日志数据，生成日报并发送"
    },
    "delivery": { "mode": "announce", "channel": "feishu", "to": "ou_cf5c98aada743ab12c65c7c6764b5a49" }
  }
}
```

### Step 5: 日报生成（定时触发或手动触发）

1. **读取定量数据**：获取 `daily-stats.json` 和 `pain_dictionary.json` 中的指标。
2. **提取定性记忆（关键防遗忘步骤）**：因为你可能经历了漫长的上下文，**必须使用文件读取工具**去扫描以下核心进化文件，提取"今天"新增的内容：
   - `memory/ISSUE_LOG.md`：寻找今天发生的具体错误与复盘。
   - `memory/DECISIONS.md`：寻找今天定下的新架构规则。
   - `memory/logs/SYSTEM.log`：寻找今天触发的门禁拦截或子代理孵化事件。
3. **合成与生成**：结合定量指标和定性记忆，生成深度洞察，按用户风格生成 Markdown。绝不要凭空捏造洞察。
4. **发送飞书推送**：调用飞书 API 发送（见下方"飞书推送实施规范"）。

---

## 飞书消息格式

当发送渠道为飞书时，使用以下格式发送消息：

```json
{
  "action": "send",
  "channel": "feishu",
  "target": "user:ou_cf5c98aada743ab12c65c7c6764b5a49",
  "message": "📊 Principles 进化日报 - {date}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🛡️ Trust Score: {trust_score}/100 (Stage {trust_stage})\n😴 GFI: {gfi_peak}\n⚡ Pain: {pain_count} pts\n\n📈 7 日趋势：\n{7day_trend}\n\n📋 进化队列：待处理 {pending} 项\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n详情: 输入 /pd-evolution-status"
}
```

## 飞书推送实施规范

### 推送流程

1. **组装消息**：根据上方"飞书消息格式"生成完整消息内容
2. **执行推送**：使用 `message` 工具发送到飞书
3. **记录状态**：将推送结果写入 `memory/logs/daily-push-log.md`

### 重试机制

推送失败时自动重试，最多 3 次：

```
尝试 1 → 失败 → 等待 30 秒 → 尝试 2 → 失败 → 等待 60 秒 → 尝试 3
```

- 每次尝试都要记录到日志
- 3 次全失败后，降级为控制台输出（print 到会话）

### 状态日志格式

每次推送（成功或失败）都追加到 `memory/logs/daily-push-log.md`：

```markdown
## {date} 推送记录

- **时间**: {timestamp} UTC
- **接收人**: ou_cf5c98aada743ab12c65c7c6764b5a49
- **尝试次数**: {attempts}
- **状态**: success / failed
- **失败原因**（如有）: {error_message}
```

### 幂等检查

推送前先检查当日是否已推送成功（读取日志文件）：
- **已推送成功** → 跳过本次推送，记录"已存在，跳过"
- **未推送或失败** → 执行推送

### 错误处理

- **API 错误**：记录错误信息到日志，继续重试
- **token 过期**：返回明确错误提示，停止重试
- **数据读取失败**：使用默认值，继续生成日报
```

---

## 数据源

| 数据 | 路径 | 说明 |
|------|------|------|
| 每日统计 | `{stateDir}/logs/daily-stats.json` | 聚合数据 (成功率/GFI) |
| 系统事件 | `memory/logs/SYSTEM.log` | 门禁拦截/子代理活动的审计日志 |
| 核心复盘 | `memory/ISSUE_LOG.md` | **(重要)** 记录了今天踩过的坑和具体教训 |
| 架构决策 | `memory/DECISIONS.md` | **(重要)** 记录了今天固化的系统级原则 |
| Pain 规则 | `{stateDir}/pain_dictionary.json` | 规则数量 |
| 用户配置 | `{stateDir}/daily-report.md` | 偏好设置 |
| Trust Score | `{stateDir}/AGENT_SCORECARD` | Trust Engine 数据 |
| Evolution Queue | `{stateDir}/evolution_queue.json` | 进化队列状态 |

---

## 风格选项

采集需求时询问用户偏好：

| 风格 | 特点 | 适合人群 |
|------|------|---------|
| **简洁版** | 3-5 行核心指标，1 分钟读完 | 忙碌型用户 |
| **标准版** | 完整指标 + 趋势对比，5 分钟读完 | 默认推荐 |
| **详实版** | 全量数据 + 分析建议，15 分钟读完 | 数据控 |
| **幽默版** | 轻松语气 + 表情包风格 | 休闲用户 |
| **可视化版** | ASCII 图表 + 进度条 | 视觉型用户 |

---

## 进化指标元素清单

### 成长亮点区（正能量）

| 指标 | 数据来源 | 进步信号 |
|------|---------|---------|
| 规则学习数 | `pain_dictionary.json` 规则总数 | 系统学会了识别新的错误模式 |
| 规则晋升数 | `DailyStats.pain.candidatesPromoted` | L3 语义检测 → 正式规则 |
| 进化任务完成 | `DailyStats.evolution.tasksCompleted` | 完成了自我改进 |
| GFI 峰值下降 | `DailyStats.gfi.peak` 环比 | 摩擦减少，更稳定 |
| 成功率提升 | `DailyStats.toolCalls.success/total` | 执行更顺畅 |

### 健康监测区（预警）

| 指标 | 数据来源 | 预警信号 |
|------|---------|---------|
| Pain 信号数 | `DailyStats.pain.signalsDetected` | 检测到多少次错误模式 |
| GFI 峰值时刻 | `DailyStats.gfi.hourlyDistribution` | 什么时候最痛苦 |
| 死亡螺旋检测 | git log 中 fix/fail/error 词频 | 是否陷入修复循环 |
| 队列健康 | 进化队列状态 | 是否拥堵 |

### 趋势对比区（进步感知）

| 指标 | 计算方式 | 意义 |
|------|---------|------|
| 7 日成功率趋势 | 7 天 success/total 变化 | 长期稳定性 |
| Pain 信号周环比 | 本周 vs 上周 Pain 信号数 | 问题是否减少 |
| 规则增长率 | 本周新增规则数 | 学习速度 |
| GFI 平均值变化 | 7 天 GFI 平均值趋势 | 整体摩擦趋势 |

---

## 默认日报模板

```markdown
# 🌱 进化日报 - {date}

## 📈 今日成长
- 🧠 新学规则: {rules_promoted} 条
- ✅ 进化完成: {tasks_completed} 项
- 🎯 成功率: {success_rate}% ({trend_emoji})
- 📉 GFI 峰值: {gfi_peak} ({gfi_trend})

## ⚡ 痛苦信号
- 检测次数: {pain_count}
- 平均强度: {avg_score}
- 主要来源: {top_sources}

## 📊 趋势对比
- 成功率 7 日趋势: {success_trend}
- Pain 信号周环比: {pain_trend}

## 💡 今日洞察
{insights}

---
📊 数据来源: Principles Disciple
```

---

## 手动触发

用户可随时运行 `/pd-evolution-status` 查看当前进化状态。

---

## 故障处理

### 飞书推送失败
1. 记录错误到 `memory/logs/daily-push-log.md`
2. 执行重试（最多 3 次，间隔 30s/60s）
3. 3 次全失败后降级为控制台输出
4. 下次执行时自动检查幂等（不重复推送）

### 数据读取失败
1. 使用默认值（0 或 "无"）
2. 继续生成日报，不阻塞
3. 在日报中标注"部分数据不可用"

### 数据读取失败
1. 使用默认值（0 或 "无"）
2. 继续生成日报，不阻塞
3. 在日报中标注"部分数据不可用"
