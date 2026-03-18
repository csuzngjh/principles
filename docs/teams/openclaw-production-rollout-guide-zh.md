# OpenClaw 生产环境落地指南

> 目标：把 Principles Disciple 内部团队模板，真正落到你的云端 OpenClaw 环境里。

## 这份文档解决什么问题

这份文档不是讲理念，而是讲怎么动手。

按这份文档做完以后，你会得到：

- 5 个可识别的团队角色
- 一套全局共享 skills
- 每个角色各自的 workspace 启动文件
- 每个角色都能读到团队共享治理文件
- `openclaw.json` 里正确的 agent 配置

这份文档暂时 **不包含 cron 创建**。  
先把目录、文件、agent 配置、skills 和 smoke test 跑通，再进下一步。

## 先记住两个最重要的事实

### 1. 角色启动文件放在 workspace，不放在 agentDir

OpenClaw 会从 **workspace** 读取这些 bootstrap 文件：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`

也就是说：

- 这些文件应该放到每个 agent 的 `workspace` 目录
- `agentDir` 不是你这次需要重点改的地方

### 2. 共享 skills 放到 `~/.openclaw/skills`

这次我们采用：

- **全局共享 skills**：`~/.openclaw/skills`
- **团队共享治理文件**：每个 workspace 下的 `./.team/governance`

不要再维护一套 `./.team/skills` 镜像了。

## 你的目标环境

结合你给的生产配置，这次建议落成下面这 5 个角色：

- `main`：Principle Manager
- `pm`：Product Manager
- `resource-scout`：Scout + Triage
- `repair`：Repair Agent
- `verification`：Verification Agent

建议的 workspace：

- `main`：`/home/csuzngjh/clawd`
- `pm`：`/home/csuzngjh/.openclaw/workspace-pm`
- `resource-scout`：`/home/csuzngjh/.openclaw/workspace-resource-scout`
- `repair`：`/home/csuzngjh/.openclaw/workspace-repair`
- `verification`：`/home/csuzngjh/.openclaw/workspace-verification`

## 第 0 步：先备份

先在服务器上做备份：

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
```

如果你准备改现有 workspace，也建议备份：

```bash
cp -R /home/csuzngjh/clawd /home/csuzngjh/clawd.bak.$(date +%Y%m%d-%H%M%S)
cp -R ~/.openclaw/workspace-pm ~/.openclaw/workspace-pm.bak.$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
cp -R ~/.openclaw/workspace-resource-scout ~/.openclaw/workspace-resource-scout.bak.$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
```

## 第 1 步：准备变量

先把路径变量写清楚。

把下面的 `<PRINCIPLES_REPO>` 改成你服务器上 principles 仓库的真实路径。

```bash
export PD_REPO=<PRINCIPLES_REPO>
export OC_HOME=/home/csuzngjh/.openclaw

export MAIN_WS=/home/csuzngjh/clawd
export PM_WS=$OC_HOME/workspace-pm
export SCOUT_WS=$OC_HOME/workspace-resource-scout
export REPAIR_WS=$OC_HOME/workspace-repair
export VERIFICATION_WS=$OC_HOME/workspace-verification
```

如果你不确定仓库路径，先在服务器上找到它再继续。

## 第 2 步：安装全局共享 skills

先创建全局 skills 目录：

```bash
mkdir -p "$OC_HOME/skills"
```

把这些共享 skills 从仓库复制进去：

```bash
cp -R "$PD_REPO/myagents/shared/skills/context-rebuild" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/agent-handoff" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/team-standup" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/weekly-governance-review" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/manager-dispatch" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/issue-triage" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/proposal-drafting" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/repair-execution" "$OC_HOME/skills/"
cp -R "$PD_REPO/myagents/shared/skills/verification-gate" "$OC_HOME/skills/"
```

做完以后可以检查：

```bash
ls "$OC_HOME/skills"
```

你应该能看到这 9 个目录。

## 第 3 步：创建缺少的 workspace

如果 `repair` 和 `verification` 还没有 workspace，先创建：

```bash
mkdir -p "$REPAIR_WS"
mkdir -p "$VERIFICATION_WS"
```

## 第 4 步：给每个 workspace 放静态角色文件

### 这一步只复制静态模板文件

**不要复制这些动态文件：**

- `MEMORY.md`
- `CURRENT_FOCUS.md`
- `PLAN.md`
- `AUDIT.md`
- `EVOLUTION_QUEUE.json`
- `.pain_flag`
- `resource-status.md`

### 4.1 main

```bash
cp "$PD_REPO/myagents/main/AGENTS.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/BOOTSTRAP.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/HEARTBEAT.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/IDENTITY.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/MANAGER_OPERATING_PROMPT.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/PRINCIPLES.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/REPOSITORY_BOUNDARIES.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/SOUL.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/TEAM_ROLE.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/TOOLS.md" "$MAIN_WS/"
cp "$PD_REPO/myagents/main/USER.md" "$MAIN_WS/"
```

### 4.2 pm

```bash
cp "$PD_REPO/myagents/pm/AGENTS.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/HEARTBEAT.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/IDENTITY.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/PRODUCT_OPERATING_PROMPT.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/SOUL.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/TEAM_ROLE.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/TOOLS.md" "$PM_WS/"
cp "$PD_REPO/myagents/pm/USER.md" "$PM_WS/"
```

### 4.3 resource-scout

```bash
cp "$PD_REPO/myagents/resource-scout/AGENTS.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/BOOTSTRAP.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/HEARTBEAT.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/IDENTITY.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/PRINCIPLES.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/SCOUT_OPERATING_PROMPT.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/SOUL.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/TEAM_ROLE.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/TOOLS.md" "$SCOUT_WS/"
cp "$PD_REPO/myagents/resource-scout/USER.md" "$SCOUT_WS/"
```

### 4.4 repair

```bash
cp "$PD_REPO/myagents/repair/AGENTS.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/HEARTBEAT.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/IDENTITY.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/REPAIR_OPERATING_PROMPT.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/SOUL.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/TEAM_ROLE.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/TOOLS.md" "$REPAIR_WS/"
cp "$PD_REPO/myagents/repair/USER.md" "$REPAIR_WS/"
```

### 4.5 verification

```bash
cp "$PD_REPO/myagents/verification/AGENTS.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/HEARTBEAT.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/IDENTITY.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/SOUL.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/TEAM_ROLE.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/TOOLS.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/USER.md" "$VERIFICATION_WS/"
cp "$PD_REPO/myagents/verification/VERIFICATION_OPERATING_PROMPT.md" "$VERIFICATION_WS/"
```

## 第 5 步：给每个 workspace 放共享治理文件

这一步只复制 `governance`，不复制 `skills`。

```bash
mkdir -p "$MAIN_WS/.team/governance"
mkdir -p "$PM_WS/.team/governance"
mkdir -p "$SCOUT_WS/.team/governance"
mkdir -p "$REPAIR_WS/.team/governance"
mkdir -p "$VERIFICATION_WS/.team/governance"
```

然后复制：

```bash
cp -R "$PD_REPO/myagents/shared/governance/." "$MAIN_WS/.team/governance/"
cp -R "$PD_REPO/myagents/shared/governance/." "$PM_WS/.team/governance/"
cp -R "$PD_REPO/myagents/shared/governance/." "$SCOUT_WS/.team/governance/"
cp -R "$PD_REPO/myagents/shared/governance/." "$REPAIR_WS/.team/governance/"
cp -R "$PD_REPO/myagents/shared/governance/." "$VERIFICATION_WS/.team/governance/"
```

检查一下：

```bash
ls "$MAIN_WS/.team/governance"
```

你应该能看到：

- `TEAM_CHARTER.md`
- `TEAM_CURRENT_FOCUS.md`
- `WORK_QUEUE.md`
- `AUTONOMY_RULES.md`
- `TEAM_OKR.md`
- `TEAM_WEEK_STATE.json`
- `TEAM_WEEK_TASKS.json`

## 第 6 步：修改 `~/.openclaw/openclaw.json`

重点改 4 处：

### 6.1 在 `agents.list` 里补全 5 个角色

把 `repair` 和 `verification` 加进去。  
同时给每个角色加 `skills` 过滤器。

可以参考这个结构：

```json
{
  "agents": {
    "list": [
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
        "workspace": "/home/csuzngjh/.openclaw/workspace-resource-scout",
        "model": "openrouter/stepfun/step-3.5-flash:free",
        "skills": [
          "context-rebuild",
          "issue-triage",
          "agent-handoff"
        ]
      },
      {
        "id": "pm",
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
        "workspace": "/home/csuzngjh/.openclaw/workspace-repair",
        "model": "openrouter/hunter-alpha",
        "skills": [
          "context-rebuild",
          "repair-execution"
        ]
      },
      {
        "id": "verification",
        "workspace": "/home/csuzngjh/.openclaw/workspace-verification",
        "model": "openrouter/stepfun/step-3.5-flash:free",
        "skills": [
          "context-rebuild",
          "verification-gate",
          "agent-handoff"
        ]
      }
    ]
  }
}
```

### 6.2 修改 `tools.agentToAgent.allow`

把 allowlist 扩成：

```json
["main", "pm", "resource-scout", "repair", "verification"]
```

### 6.3 先不要给所有角色都加 heartbeat

第一阶段建议保持简单：

- `main` 保留 heartbeat
- `pm` 不加 heartbeat
- `resource-scout` 先不加 heartbeat，后面主要靠 cron
- `repair` 不加 heartbeat
- `verification` 不加 heartbeat

原因很简单：  
先把角色识别、技能加载、文件读取和 session 跑通，再上调度。

### 6.4 保持 `tools.sessions.visibility = "all"`

你现在这个配置是对的，不要收紧。

## 第 7 步：重启 OpenClaw

```bash
openclaw gateway --force
```

如果你是 daemon 模式，按你现在服务器的实际启动方式重启也可以。

## 第 8 步：做 smoke test

这一步非常重要。  
先不要建 cron，先一个角色一个角色验证。

### 8.1 看 agent 是否存在

```bash
openclaw agents list
```

你应该能看到：

- `main`
- `pm`
- `resource-scout`
- `repair`
- `verification`

### 8.2 分别测试 5 个角色

```bash
openclaw agent --agent main --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent pm --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent resource-scout --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent repair --message "Read AGENTS.md and tell me your role in one sentence." --local
openclaw agent --agent verification --message "Read AGENTS.md and tell me your role in one sentence." --local
```

如果这 5 条都能正常回答，说明：

- workspace 文件已经放对了
- OpenClaw 已经能识别这些 agent
- skills 过滤配置没有把 agent 弄坏

### 8.3 再测试一个共享治理文件是否可读

比如：

```bash
openclaw agent --agent main --message "Read ./.team/governance/TEAM_CURRENT_FOCUS.md and summarize it in one sentence." --local
```

如果能成功，说明 `./.team/governance` 这条线通了。

## 第 9 步：这一步先不要做什么

在 smoke test 通过前，不要做下面这些事：

- 不要先建 cron
- 不要先做多 agent 会议
- 不要先测 `sessions_send`
- 不要先做自动修 bug
- 不要先做自动 deploy

原因是：

如果基础目录和配置都还没跑通，你一上来测调度，只会让排查难度翻倍。

## 你现在最容易犯的 5 个错误

### 错误 1：把角色文件放进 `agentDir`

这次不要这样做。  
角色 bootstrap 文件放 **workspace**。

### 错误 2：把动态文件也复制过去

不要复制：

- `MEMORY.md`
- `CURRENT_FOCUS.md`
- `PLAN.md`
- `AUDIT.md`
- `.pain_flag`

这些要么是动态状态，要么是实例痕迹，不该作为模板下发。

### 错误 3：既维护全局 skills，又维护本地 `.team/skills`

这次不要双轨。  
统一用：

- 全局 skills：`~/.openclaw/skills`
- 本地治理：`./.team/governance`

### 错误 4：配置了角色，但没把它们加入 `agentToAgent.allow`

这样以后会议和 handoff 会直接失败。

### 错误 5：还没 smoke test 就直接建 cron

这会让你不知道问题出在：

- 文件路径
- skills
- 角色配置
- 还是 cron

## 做完这份文档后，你应该达到的状态

完成后，你应该能确认下面 5 件事都成立：

- 5 个 agent 都出现在 `openclaw agents list`
- 5 个 agent 都能各自读到自己的 `AGENTS.md`
- `main` 能读到 `./.team/governance/TEAM_CURRENT_FOCUS.md`
- 全局 skills 目录已经安装好
- `openclaw.json` 已经包含 5 个角色和正确的 skills 过滤器

## 下一步是什么

这份文档完成后，下一步才进入：

1. 建第一版真实 cron
2. 建立稳定 session / label
3. 测一次 `sessions_send`
4. 跑第一条真实闭环：
   `resource-scout -> main -> repair -> verification -> main`

在这之前，不要把系统复杂度再往上加。
