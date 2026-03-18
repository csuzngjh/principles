# OpenClaw 云端助手检查与配置清单

> 目标：把本地已经完成的团队模板与部署经验，清晰交接给云端 AI 编程助手，让它能在真实服务器上完成检查、补漏、合并和修正。  
> 适用环境：`/home/csuzngjh/.openclaw`

## 一、先确认要使用的仓库版本

云端助手先执行：

```bash
cd /path/to/principles
git fetch origin
git checkout codex/agent-team-skeleton
git pull --ff-only origin codex/agent-team-skeleton
git rev-parse --short HEAD
```

要求：

- 使用分支 `codex/agent-team-skeleton`
- 不要假设 `main` 已包含这些改动

## 二、这次交接的核心目标

云端助手要完成的不是“重新设计系统”，而是：

1. 检查 OpenClaw 生产环境是否已具备 5 角色自治团队运行条件
2. 检查静态 MD 文件是否拷全、是否放对目录
3. 检查 `~/.openclaw/skills` 是否具备所需共享 skills
4. 检查并修正 `openclaw.json`
5. 检查角色间通信、cron 前提、workspace 结构、共享治理文件
6. 如发现缺漏，再补充安装或补充复制

## 三、目录映射规则

### 1. OpenClaw 根目录

生产根目录：

```bash
/home/csuzngjh/.openclaw
```

### 2. 各角色工作区

- `main` -> `/home/csuzngjh/.openclaw/workspace-main`
- `pm` -> `/home/csuzngjh/.openclaw/workspace-pm`
- `resource-scout` -> `/home/csuzngjh/.openclaw/workspace-resource-scout`
- `repair` -> `/home/csuzngjh/.openclaw/workspace-repair`
- `verification` -> `/home/csuzngjh/.openclaw/workspace-verification`

### 3. 全局共享 skills

```bash
/home/csuzngjh/.openclaw/skills
```

### 4. 每个角色本地共享治理目录

每个 workspace 下都应该有：

```bash
./.team/governance
```

注意：

- 不再维护 `./.team/skills`
- skills 统一放全局 `~/.openclaw/skills`
- governance 统一复制到每个 workspace 的 `./.team/governance`

## 四、必须检查的全局 skills

云端助手检查以下目录是否都存在于：

```bash
/home/csuzngjh/.openclaw/skills
```

必须有：

- `context-rebuild`
- `team-standup`
- `weekly-governance-review`
- `agent-handoff`
- `manager-dispatch`
- `issue-triage`
- `proposal-drafting`
- `repair-execution`
- `verification-gate`

## 五、`main` 角色应使用的静态核心文件

`main` 比较特殊。

它的人格内核以仓库中的 `old/` 为准，而不是以新团队模板强行覆盖。

云端助手应优先从仓库以下目录复制到 `workspace-main`：

```text
old/AGENTS.md
old/SOUL.md
old/IDENTITY.md
old/PRINCIPLES.md
old/HEARTBEAT.md
old/TOOLS.md
old/TOOLS_CAPABILITIES.md
old/USER.md
old/BOOTSTRAP.md
old/REPOSITORY_BOUNDARIES.md
old/AUDIT.md
old/BOOT.md
```

注意：

- 不要用 `myagents/main` 全量覆盖 `main`
- 不要覆盖 `main` 的动态记忆和状态文件
- `old/` 的目标是保留 `main` 的人格连续性，只补最少的自治团队边界

## 六、其他角色应使用的静态文件来源

### `pm`

```text
myagents/pm/AGENTS.md
myagents/pm/HEARTBEAT.md
myagents/pm/IDENTITY.md
myagents/pm/PRODUCT_OPERATING_PROMPT.md
myagents/pm/SOUL.md
myagents/pm/TEAM_ROLE.md
myagents/pm/TOOLS.md
myagents/pm/USER.md
```

### `resource-scout`

```text
myagents/resource-scout/AGENTS.md
myagents/resource-scout/HEARTBEAT.md
myagents/resource-scout/IDENTITY.md
myagents/resource-scout/SCOUT_OPERATING_PROMPT.md
myagents/resource-scout/SOUL.md
myagents/resource-scout/TEAM_ROLE.md
myagents/resource-scout/TOOLS.md
myagents/resource-scout/USER.md
```

### `repair`

```text
myagents/repair/AGENTS.md
myagents/repair/HEARTBEAT.md
myagents/repair/IDENTITY.md
myagents/repair/REPAIR_OPERATING_PROMPT.md
myagents/repair/TEAM_ROLE.md
myagents/repair/TOOLS.md
```

### `verification`

```text
myagents/verification/AGENTS.md
myagents/verification/HEARTBEAT.md
myagents/verification/IDENTITY.md
myagents/verification/VERIFICATION_OPERATING_PROMPT.md
myagents/verification/TEAM_ROLE.md
myagents/verification/TOOLS.md
```

## 七、不要从仓库复制到生产的动态文件

以下内容不要直接覆盖到云端实例：

- `MEMORY.md`
- `memory/`
- `CURRENT_FOCUS.md`
- `PLAN.md`
- `EVOLUTION_QUEUE.json`
- `.state/`
- `.principles/`
- 任何运行日志、队列、临时文件

## 八、每个角色都需要的共享治理文件

云端助手应将以下文件复制到每个 workspace 的：

```bash
./.team/governance/
```

需要复制：

```text
myagents/shared/governance/TEAM_CHARTER.md
myagents/shared/governance/TEAM_OKR.md
myagents/shared/governance/TEAM_CURRENT_FOCUS.md
myagents/shared/governance/TEAM_WEEK_STATE.json
myagents/shared/governance/TEAM_WEEK_TASKS.json
myagents/shared/governance/WORK_QUEUE.md
myagents/shared/governance/AUTONOMY_RULES.md
myagents/shared/governance/WEEKLY_REVIEW.md
myagents/shared/governance/MEETING_PROTOCOL.md
myagents/shared/governance/MEETING_REPORT_TEMPLATE.md
myagents/shared/governance/RUNTIME_GUARDRAILS.md
myagents/shared/governance/CRON_BOOTSTRAP_PROMPT.md
myagents/shared/governance/ISSUE_DRAFT_TEMPLATE.md
myagents/shared/governance/PROPOSAL_DRAFT_TEMPLATE.md
myagents/shared/governance/REPAIR_TASK_TEMPLATE.md
myagents/shared/governance/VERIFICATION_REPORT_TEMPLATE.md
myagents/shared/governance/ASSET_MAP.md
```

## 九、必须检查的 `openclaw.json` 项

云端助手必须逐项核查：

### 1. `agents.list`

应至少包含：

- `main`
- `pm`
- `resource-scout`
- `repair`
- `verification`

并核对每个角色的：

- `id`
- `workspace`
- `skills`
- `model`

### 2. `tools.sessions.visibility`

要求：

```json
"all"
```

### 3. `tools.agentToAgent`

要求：

- `enabled = true`
- `allow` 至少包含：
  - `main`
  - `pm`
  - `resource-scout`
  - `repair`
  - `verification`

### 4. skills 过滤器

建议每个角色只看到自己的必要 skills。

### 5. heartbeat 认知

云端助手必须注意：

- 默认 heartbeat 不会天然让所有角色都自动跑
- 团队真正的节奏主引擎应以 `cron` 为主，不要误以为 heartbeat 会自动覆盖所有角色

## 十、`cron` 前提检查

在真正创建 cron 前，云端助手必须先确认：

1. `repair` 和 `verification` 已经在 `agents.list` 中存在
2. `agentToAgent.allow` 已放开到 5 个角色
3. 全局 skills 已安装
4. 每个 workspace 的 `./.team/governance/` 已存在
5. `main` 的核心文件已按 `old/` 方案放好

## 十一、必须知道的 `cron` 约束

云端助手不要自己猜。

要按以下规则检查：

- `sessionTarget: "main"` 只能配 `payload.kind: "systemEvent"`
- `sessionTarget: "isolated" | "current" | "session:xxx"` 只能配 `payload.kind: "agentTurn"`
- 对非默认 agent，不要使用 `sessionTarget: "main"`
- 团队会议、巡检、验证类任务优先用 `agentTurn + isolated`
- 多个 cron 要错峰，优先使用 `staggerMs`

## 十二、消息通信前提检查

云端助手必须知道：

- `sessions_send` 不能凭空创建目标 session
- 如果目标 session 不存在，必须先通过 `sessions_list` 发现可见 session
- 如果要按 `label + agentId` 发送，也必须先确保该 label 的会话已经存在

## 十三、推荐 smoke test 顺序

云端助手按这个顺序做：

1. 检查磁盘空间
2. 检查全局 skills 是否齐全
3. 检查 5 个 workspace 是否存在
4. 检查静态 MD 是否拷全
5. 检查每个 workspace 的 `./.team/governance/`
6. 检查 `openclaw.json`
7. 重启 OpenClaw
8. 验证 `openclaw agents list`
9. 逐个角色做一次最小本地启动
10. 验证 `sessions_list`
11. 验证 `sessions_send`
12. 最后再创建第一批 cron

## 十四、推荐给云端助手的最小任务链

在环境检查通过后，第一条真实闭环目标应是：

1. `resource-scout` 产出一个 `Issue Draft`
2. `main` 读取并下发一个清晰的 `Repair Task`
3. `repair` 执行一个小修复
4. `verification` 产出 `Verification Report`
5. `main` 更新共享治理文件

## 十五、发现问题时的修正优先级

如果云端助手发现缺漏，按这个顺序补：

1. 目录路径错误
2. 静态 MD 缺失
3. 全局 skill 缺失
4. `openclaw.json` 缺失角色或 allowlist
5. `sessions_send` 前提不成立
6. `cron` 任务缺失

## 十六、云端助手最终应产出的交付物

完成检查后，云端助手至少应输出：

### 已确认

- 已存在的 skills
- 已存在的角色 workspace
- 已存在的静态模板文件
- 已确认无误的 `openclaw.json` 项

### 已修复

- 补拷了哪些文件
- 修改了哪些配置
- 安装了哪些 skills

### 仍有风险

- 哪些会话还没建立
- 哪些通信还没验证
- 哪些 cron 还没创建
- 哪些角色仍可能角色漂移

## 十七、额外提醒

- 当前机器根盘使用率高，云端助手应避免无节制生成日志和备份
- 不要覆盖已有实例记忆
- 不要把 `main` 当成全新的模板实例
- `main` 应保留原人格内核，只补运行边界
