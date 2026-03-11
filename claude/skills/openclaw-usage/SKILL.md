# OpenClaw 使用技能

> 完整的 OpenClaw CLI 使用指南和最佳实践
> 基于 OpenClaw 官方文档和源码整理

## 📋 目录

- [OpenClaw 概述](#openclaw-概述)
- [核心命令](#核心命令)
- [Gateway 管理](#gateway-管理)
- [Agent 交互](#agent-交互)
- [Channel 管理](#channel-管理)
- [工具和自动化](#工具和自动化)
- [配置文件](#配置文件)
- [日志和调试](#日志和调试)
- [常见问题](#常见问题)
- [最佳实践](#最佳实践)

---

## OpenClaw 概述

### 什么是 OpenClaw？

**OpenClaw** 是一个个人 AI 助手，运行在你自己的设备上。它通过你已使用的渠道与你对话（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage 等）。

### 核心特性

- **本地优先的 Gateway** - 单一控制平面，管理会话、渠道、工具和事件
- **多渠道收件箱** - 支持 20+ 消息平台
- **多智能体路由** - 将入站渠道/账户/对等方路由到隔离的智能体
- **语音唤醒 + 对话模式** - macOS/iOS 语音唤醒，Android 持续语音
- **实时 Canvas** - 智能体驱动的可视化工作空间
- **内置工具** - browser、canvas、nodes、cron、sessions 等

### 系统架构

```
渠道 (WhatsApp/Telegram/Slack/Discord/...)
    │
    ▼
┌───────────────────────────────┐
│          Gateway              │
│     (控制平面)                 │
│   ws://127.0.0.1:18789        │
└──────────────┬────────────────┘
               │
               ├─ Pi 智能体 (RPC)
               ├─ CLI (openclaw …)
               ├─ WebChat UI
               ├─ macOS app
               └─ iOS/Android nodes
```

---

## 核心命令

### 安装和初始化

```bash
# 安装 OpenClaw（需要 Node ≥22）
npm install -g openclaw@latest

# 运行向导（推荐）
openclaw onboard --install-daemon

# 启动 Gateway
openclaw gateway --port 18789 --verbose
```

### 常用命令速查

```bash
# 发送消息
openclaw message send --to +1234567890 --message "Hello from OpenClaw"

# 与智能体对话
openclaw agent --message "Ship checklist" --thinking high

# 查看智能体列表
openclaw agents list

# 查看会话历史
openclaw sessions list
openclaw sessions history --limit 50

# 检查系统健康
openclaw doctor

# 查看配置
openclaw config show
```

---

## Gateway 管理

### 启动和停止

```bash
# 启动 Gateway
openclaw gateway start

# 后台启动
openclaw gateway --daemon

# 停止 Gateway
openclaw gateway stop

# 重启 Gateway
openclaw gateway --force

# 查看状态
ps aux | grep openclaw-gateway
```

### Gateway 配置

**配置文件位置**: `~/.openclaw/openclaw.json`

**常用配置项**:

```json5
{
  "gateway": {
    "port": 18789,
    "verbose": false,
    "logLevel": "info"
  },
  "workspaceDir": "/path/to/workspace",
  "models": {
    "provider": "openai",
    "model": "gpt-4"
  }
}
```

### 健康检查

```bash
# 检查 Gateway 是否运行
curl -s http://127.0.0.1:18789/health

# 查看 Gateway 日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log

# 运行诊断
openclaw doctor
```

---

## Agent 交互

### 基础对话

```bash
# 简单对话
openclaw agent --agent main --message "你好，请介绍一下你自己"

# 带思考级别
openclaw agent --message "分析代码质量" --thinking high

# 带 JSON 输出
openclaw agent --message "报告状态" --json

# 超时设置
openclaw agent --message "复杂任务" --timeout 300
```

### 高级选项

```bash
# 指定智能体
openclaw agent --agent ops --message "检查服务器状态"

# 显式指定 Session ID
openclaw agent --session-id abc123 --message "继续上次任务"

# 启用详细输出
openclaw agent --message "执行任务" --verbose on

# 发送回复到特定渠道
openclaw agent --message "生成报告" --deliver \
  --reply-channel slack --reply-to "#reports"
```

### Agent 管理命令

```bash
# 列出所有智能体
openclaw agents list

# 查看智能体详情
openclaw agents show main

# 创建新智能体
openclaw agents create --name dev --workspace /path/to/workspace

# 删除智能体
openclaw agents delete <agent-id>
```

---

## Channel 管理

### 支持的渠道

- **WhatsApp** (Baileys)
- **Telegram** (grammY)
- **Slack** (Bolt)
- **Discord** (discord.js)
- **Google Chat** (Chat API)
- **Signal** (signal-cli)
- **iMessage** (BlueBubbles / legacy)
- **IRC**
- **Microsoft Teams**
- **Matrix**
- **Feishu**
- **LINE**
- **Mattermost**
- **Nextcloud Talk**
- **Nostr**
- **WebChat**

### 渠道配置

```bash
# 连接渠道
openclaw channels connect whatsapp

# 查看渠道状态
openclaw channels list

# 断开渠道
openclaw channels disconnect <channel-id>
```

### DM 安全策略

**默认行为**: 未知发送者需要配对码

```json5
{
  "channels": {
    "telegram": {
      "dmPolicy": "pairing"
    },
    "discord": {
      "dmPolicy": "pairing",
      "allowFrom": ["*"]  // 公开 DM（需明确选择加入）
    }
  }
}
```

**配对流程**:

```bash
# 批准配对请求
openclaw pairing approve telegram <code>

# 查看待批准的配对
openclaw pairing list
```

---

## 工具和自动化

### 内置工具

#### Browser 工具

```bash
# 在智能体对话中使用 browser 工具
openclaw agent --message "打开 https://example.com 并截图"
```

**能力**:
- 专用 Chrome/Chromium
- 快照和操作
- 文件上传
- 配置文件管理

#### Canvas 工具

```bash
# 使用 Canvas 可视化
openclaw agent --message "在 Canvas 上显示项目结构"
```

**能力**:
- A2UI 推送/重置
- 代码执行
- 快照

#### Cron 任务

```bash
# 创建定时任务
openclaw agent --message "每天早上 9 点报告天气"

# 管理 cron
openclaw cron list
openclaw cron delete <job-id>
```

### 自动化工作流

#### Webhook

```bash
# 创建 webhook
openclaw agent --message "创建 webhook 接收 GitHub 通知"
```

#### Gmail 集成

```bash
# 设置 Gmail Pub/Sub
openclaw agent --message "监听 Gmail 新邮件"
```

---

## 配置文件

### 主配置文件

**位置**: `~/.openclaw/openclaw.json`

**完整示例**:

```json5
{
  // Gateway 配置
  "gateway": {
    "port": 18789,
    "host": "127.0.0.1",
    "verbose": false,
    "logLevel": "info"
  },

  // 工作区目录
  "workspaceDir": "~/clawd",

  // 模型配置
  "models": {
    "provider": "openai",
    "model": "gpt-4",
    "apiKey": "sk-..."
  },

  // 智能体路由
  "agents": {
    "main": {
      "workspaceDir": "~/clawd"
    }
  },

  // 渠道配置
  "channels": {
    "telegram": {
      "botToken": "...",
      "dmPolicy": "pairing"
    },
    "discord": {
      "botToken": "...",
      "dmPolicy": "pairing"
    }
  },

  // 插件
  "plugins": {
    "allow": ["principles-disciple"]
  }
}
```

### 环境变量

```bash
# 设置 API Key
export OPENAI_API_KEY="sk-..."

# 设置自定义配置路径
export OPENCLAW_CONFIG_PATH="/path/to/config"
export OPENCLAW_STATE_DIR="/path/to/state"
```

---

## 日志和调试

### 日志位置

| 日志类型 | 位置 |
|---------|------|
| Gateway 日志 | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` |
| 会话历史 | `~/.openclaw/agents/main/sessions/[session-id].jsonl` |
| 命令日志 | `~/.openclaw/logs/commands.log` |
| 配置审计 | `~/.openclaw/logs/config-audit.jsonl` |

### 调试命令

```bash
# 查看 Gateway 错误
tail -100 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep -i error

# 实时监控 Gateway
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log

# 查看最近对话
CURRENT_SESSION=$(cat ~/.openclaw/agents/main/sessions/sessions.json | jq -r '.["agent:main:main"].sessionFile')
tail -20 "$CURRENT_SESSION" | jq '{type, role: .message.role}'

# 工具调用统计
cat "$CURRENT_SESSION" | jq -r 'select(.type == "tool_use") | .message.name' | sort | uniq -c | sort -rn
```

### 故障排除

#### Gateway 无法启动

```bash
# 检查端口占用
lsof -i :18789

# 查看详细错误
openclaw gateway --verbose

# 重新安装
openclaw doctor --fix
```

#### Agent 不响应

```bash
# 检查 Gateway 状态
curl -s http://127.0.0.1:18789/health

# 查看会话状态
openclaw sessions list

# 重启 Gateway
openclaw gateway stop && openclaw gateway start
```

#### 渠道连接问题

```bash
# 测试渠道连接
openclaw channels test <channel-id>

# 查看渠道状态
openclaw channels list

# 重新连接
openclaw channels reconnect <channel-id>
```

---

## 常见问题

### Q: 如何更新 OpenClaw？

```bash
# 更新到最新版本
npm update -g openclaw@latest

# 切换开发频道
openclaw update --channel dev

# 查看当前版本
openclaw --version
```

### Q: 如何重置配置？

```bash
# 备份当前配置
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak

# 重新运行向导
openclaw onboard
```

### Q: 如何查看会话历史？

```bash
# 列出所有会话
openclaw sessions list

# 查看特定会话历史
openclaw sessions history --session-id <session-id> --limit 100

# 导出会话
openclaw sessions export --session-id <session-id> --format json > session.json
```

### Q: 如何删除会话？

```bash
# 删除特定会话
openclaw sessions delete <session-id>

# 清除所有会话
openclaw sessions purge --agent main
```

---

## 最佳实践

### 1. 安全配置

```bash
# 运行安全检查
openclaw doctor

# 启用 DM 配对
openclaw config set channels.telegram.dmPolicy pairing
openclaw config set channels.discord.dmPolicy pairing
```

### 2. 性能优化

```bash
# 使用合适的模型
openclaw config set models.model gpt-4-turbo

# 启用会话修剪
openclaw config set sessionPruning.enabled true
```

### 3. 日志管理

```bash
# 定期清理旧日志
find /tmp/openclaw -name "*.log" -mtime +7 -delete

# 压缩归档会话
openclaw sessions archive --before 2024-01-01
```

### 4. 备份和恢复

```bash
# 备份配置
tar -czf openclaw-backup.tar.gz ~/.openclaw

# 恢复配置
tar -xzf openclaw-backup.tar.gz -C ~
```

---

## 参考资料

### 官方文档

- **[OpenClaw 文档](https://docs.openclaw.ai)** - 官方文档中心
- **[GitHub 仓库](https://github.com/openclaw/openclaw)** - 源代码和问题追踪
- **[Discord 社区](https://discord.gg/clawd)** - 社区支持

### 源码位置

- **主仓库**: `/home/csuzngjh/code/openclaw/`
- **本地配置**: `~/.openclaw/`
- **工作区**: `/home/csuzngjh/clawd/`

### 相关技能

- **[Principles Disciple Plugin](../principles-disciple/)** - 信任引擎和进化系统
- **[观测地图](../../memory/SYSTEM_OBSERVATION_MAP.md)** - 系统观测指南

---

## 更新日志

- **2026-03-11** - 初始版本，基于 OpenClaw 官方文档和源码创建
