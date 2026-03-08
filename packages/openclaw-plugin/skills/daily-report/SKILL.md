---
name: daily-report
description: 配置并发送每日进化日报（支持邮件/即时通讯/语音通知）
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
2. **发送时间？**（默认每天 9:00）
3. **时区？**（默认 Asia/Shanghai）
4. **发送渠道？**
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
- 发送时间: 09:00
- 时区: Asia/Shanghai
- Cron 表达式: 0 9 * * *

## 发送渠道
- 渠道: whatsapp
- 目标: +8613800138000

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
    "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "执行进化日报技能：读取日志数据，生成日报并发送"
    },
    "delivery": { "mode": "announce", "channel": "whatsapp", "to": "+8613800138000" }
  }
}
```

### Step 5: 日报生成（定时触发或手动触发）

1. 读取数据源
2. 计算进化指标
3. 按用户风格生成 Markdown
4. 发送日报

---

## 数据源

| 数据 | 路径 | 说明 |
|------|------|------|
| 每日统计 | `{stateDir}/logs/daily-stats.json` | 聚合数据 |
| 原始事件 | `{stateDir}/logs/events.jsonl` | 详细审计 |
| Pain 规则 | `{stateDir}/pain_dictionary.json` | 规则数量 |
| 用户配置 | `{stateDir}/daily-report.md` | 偏好设置 |

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

用户可随时运行 `/daily-report` 手动生成并发送当日日报。
