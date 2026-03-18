# OpenClaw 团队配置片段

> 用途：基于你当前服务器上的 `~/.openclaw/openclaw.json`，只修改与团队落地直接相关的部分。  
> 原则：不要整份重写，只做最小必要修改。

## 修改目标

这次只改 4 类内容：

1. 补齐 5 个 agent
2. 给每个 agent 加 `skills` 过滤器
3. 放开 `agentToAgent` allowlist
4. 先不引入复杂 heartbeat，保守推进

## 你当前配置里最需要改的地方

你现在的真实问题是：

- 只有 `main`、`pm`、`resource-scout`
- 缺少 `repair` 和 `verification`
- `tools.agentToAgent.allow` 里没有 `repair` 和 `verification`
- 还没有用 `skills` 把各角色的可见能力收窄

## 一、替换 `agents.list`

把你当前 `openclaw.json` 里的 `agents.list` 整段替换成下面这版：

```json
[
  {
    "id": "main",
    "workspace": "/home/csuzngjh/clawd",
    "model": "openrouter/hunter-alpha",
    "skills": [
      "context-rebuild",
      "team-standup",
      "weekly-governance-review",
      "agent-handoff",
      "manager-dispatch"
    ]
  },
  {
    "id": "resource-scout",
    "name": "resource-scout",
    "workspace": "/home/csuzngjh/.openclaw/workspace-resource-scout",
    "agentDir": "/home/csuzngjh/.openclaw/agents/resource-scout/agent",
    "model": "openrouter/stepfun/step-3.5-flash:free",
    "skills": [
      "context-rebuild",
      "issue-triage",
      "agent-handoff"
    ]
  },
  {
    "id": "pm",
    "name": "pm",
    "workspace": "/home/csuzngjh/.openclaw/workspace-pm",
    "model": "zai/glm-4.7",
    "skills": [
      "context-rebuild",
      "proposal-drafting",
      "agent-handoff"
    ]
  },
  {
    "id": "repair",
    "name": "repair",
    "workspace": "/home/csuzngjh/.openclaw/workspace-repair",
    "model": "openrouter/hunter-alpha",
    "skills": [
      "context-rebuild",
      "repair-execution"
    ]
  },
  {
    "id": "verification",
    "name": "verification",
    "workspace": "/home/csuzngjh/.openclaw/workspace-verification",
    "model": "openrouter/stepfun/step-3.5-flash:free",
    "skills": [
      "context-rebuild",
      "verification-gate",
      "agent-handoff"
    ]
  }
]
```

## 二、修改 `tools.agentToAgent`

把 `tools.agentToAgent` 改成：

```json
{
  "enabled": true,
  "allow": [
    "main",
    "pm",
    "resource-scout",
    "repair",
    "verification"
  ]
}
```

## 三、`tools.sessions.visibility` 保持不变

保留你现在这一项：

```json
{
  "visibility": "all"
}
```

不要先收紧。

## 四、第一阶段不要新增复杂 heartbeat 配置

你当前已经有默认：

```json
{
  "every": "30m",
  "model": "openrouter/stepfun/step-3.5-flash:free"
}
```

第一阶段建议：

- 先不在各 agent entry 里额外加 `heartbeat`
- 接受当前只有默认 agent `main` 会走 heartbeat 的现实
- `pm`、`resource-scout`、`verification` 先主要靠后续 cron

原因：

- 先把角色识别、workspace 文件、skills、peer messaging 跑通
- 再加调度
- 否则问题来源会混在一起

## 五、建议保留的默认项

这些先不要动：

### `agents.defaults.workspace`

你可以先保留：

```json
"/home/csuzngjh/clawd"
```

因为这本来就和 `main` 对齐。

### `agents.defaults.maxConcurrent`

先保留：

```json
4
```

### `agents.defaults.subagents.maxConcurrent`

先保留：

```json
8
```

但后面真的开始跑 cron 时，需要注意 burst 风险。

## 六、全局 skills 目录应该至少包含这些目录

你的 `~/.openclaw/skills` 里，最终应该有：

```text
context-rebuild
agent-handoff
team-standup
weekly-governance-review
manager-dispatch
issue-triage
proposal-drafting
repair-execution
verification-gate
```

## 七、改完配置后的检查顺序

### 1. 校验 JSON 格式

如果你习惯用 `jq`：

```bash
jq . ~/.openclaw/openclaw.json >/dev/null
```

### 2. 重启 OpenClaw

```bash
openclaw gateway --force
```

### 3. 看 agent 是否都出现

```bash
openclaw agents list
```

你应该能看到：

- `main`
- `pm`
- `resource-scout`
- `repair`
- `verification`

### 4. 做最小 smoke test

```bash
openclaw agent --agent main --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent pm --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent resource-scout --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent repair --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent verification --message "Read AGENTS.md and tell me your role in one sentence." --local
```

## 八、如果报错，优先检查哪里

### 报 `Unknown agent id`

说明 `agents.list` 没生效，或者 JSON 改坏了。

### 报 skill 不可见 / 没加载到

优先检查：

- `~/.openclaw/skills` 目录里是否真的存在对应 skill
- `agents.list[].skills` 里名字是否拼对

### `sessions_send` 发不出去

优先检查：

- `tools.agentToAgent.enabled`
- `tools.agentToAgent.allow`
- 对方 agent 是否真的启动过并有可见 session

### `repair` / `verification` 启动不了

优先检查：

- workspace 目录是否存在
- 对应 workspace 里是否已经复制好 `AGENTS.md`、`HEARTBEAT.md`、`IDENTITY.md`、`TOOLS.md` 等文件

## 九、这一步完成后的状态

做到这里，你得到的是：

- 团队角色已经被 OpenClaw 识别
- 每个角色的 skill 可见范围已经收窄
- `repair` 和 `verification` 已经进入系统
- peer messaging 基本前置条件已经具备

但你还没有做：

- cron
- 真实会议
- 真实 handoff
- 真实闭环修复

这是故意的。  
先把底座配对，再做调度。
