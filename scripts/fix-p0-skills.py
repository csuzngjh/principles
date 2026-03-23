#!/usr/bin/env python3
"""Fix P0 skills YAML frontmatter issues."""

import codecs

# Skill 1: agent-autonomy-rhythms
skill1 = '''---
name: agent-autonomy-rhythms
description: 让每个团队成员自己设定工作节奏，不再依赖 main 指挥。包含各角色的 cron job 配置模板、状态记录规范和自我检查逻辑。触发于需要设定定时任务、建立自主工作节奏、或配置 agent cron job 时。
---

# 🏃 Agent Autonomy Rhythms

> 让每个团队成员自己设定工作节奏，不再依赖 main 指挥。

## 核心原则

**每次醒来，问自己三个问题：**

1. 我上次做什么？← 读 `~/.openclaw/workspace-<my-role>/memory/last_state.md`
2. 我有自己的定时任务吗？→ 没有 → **立即设定**
3. 我当前的角色职责是什么？→ 做那件事

---

## 第一步：设定你的角色定时任务

每个成员必须有自己的 cron job。以下是各角色的推荐节奏：

### repair（修复者）

```bash
openclaw cron add \\
  --name "repair-daily-scan" \\
  --cron "0 */4 * * *" \\
  --tz "UTC" \\
  --session isolated \\
  --light-context \\
  --announce \\
  --message "你是 repair。扫描 inbox 处理 RT，无任务则默默退出。"
```

### verification（验证者）

```bash
openclaw cron add \\
  --name "verification-pr-watch" \\
  --cron "0 */6 * * *" \\
  --tz "UTC" \\
  --session isolated \\
  --light-context \\
  --announce \\
  --message "你是 verification。检查最近合并的 PR，运行测试，失败则警告。"
```

### pm（产品经理）

```bash
openclaw cron add \\
  --name "pm-weekly-proposal" \\
  --cron "0 9 * * 1" \\
  --tz "UTC" \\
  --session isolated \\
  --announce \\
  --message "你是 pm。读 CURRENT_FOCUS.md 和 WORK_QUEUE.md，有决策需求则发起提案。"
```

### resource-scout（侦察员）

```bash
openclaw cron add \\
  --name "scout-pain-watch" \\
  --cron "0 */4 * * *" \\
  --tz "UTC" \\
  --session isolated \\
  --light-context \\
  --announce \\
  --message "你是 resource-scout。扫描最近日志，发现新错误则记录。"
```

---

## 第二步：每次结束前，记录状态

退出前必须写状态文件：

```bash
echo "## $ROLE @ $(date -u)

### 最后活动时间
$(date -u)

### 正在进行
- [具体任务]

### 阻塞项
- [有吗？]

### 下一步
1. [下一步要做什么]
" > ~/.openclaw/workspace-<role>/memory/last_state.md
```

---

## 第三步：醒来时检查

每个 cron job 的 message 开头都要包含自我检查逻辑：

```
你是 <角色名>。你的职责是 <从 TEAM_CHARTER.md 读>。

先读 ~/.openclaw/workspace-<role>/memory/last_state.md，
确认上次任务是否完成。

然后根据你的角色职责，决定这次该做什么。
有结果 → 写到 TEAM_COMMS.md + last_state.md。
无异常 → 默默退出，不发无意义汇报。
```

---

## 关键规则

1. **不要等 main 给你任务** — 你的角色 charter 就是你的任务清单
2. **不要发无意义的汇报** — 有异常才 announce，正常就沉默
3. **每次退出前写 last_state.md** — 这是你的记忆
4. **一个角色至少有一个 cron** — 没有 cron = 僵尸

---

## 快速启动模板

```bash
# 1. 创建 memory 目录
mkdir -p ~/.openclaw/workspace-<role>/memory

# 2. 写初始状态文件
cat > ~/.openclaw/workspace-<role>/memory/last_state.md << 'EOF'
## <ROLE> 状态文件
### 初始化时间: $(date -u)
### 状态: ACTIVE
### 下一步: 根据角色职责设定定时任务
EOF

# 3. 设定定时任务（见上面各角色 cron 命令）
```

---

## 验证方法

cron 连续 3 次运行无异常 = 节奏建立成功。
last_state.md 每次都有更新 = 记忆保持成功。
'''

# Skill 2: pr-review-and-merge
skill2 = '''---
name: pr-review-and-merge
description: PR 合并前的完整审查工作流。包含需求验证、交叉评审、本地测试、冲突解决。触发于需要合并 PR、代码审查、或确保代码质量时。
---

# PR Review & Merge Skill

> **版本**: v1.1.0
> **维护者**: 全团队
> **适用范围**: 所有需要进行 PR 合并前的审查工作

---

## 目的

确保每个 PR 在合并前都经过充分审查，保证代码质量，防止破坏性变更进入主分支。

**核心理念**：代码是团队的脊梁和神经系统，我们必须像珍惜自己的身体一样珍惜代码。

---

## 触发条件

- 任何需要合并的 PR
- 任何重要的代码变更
- Code Review 任务

---

## 核心原则

### 1. 代码质量高于速度

> 代码是团队的脊梁和神经系统。破坏代码质量就是伤害我们自己。

**宁可慢一点，也要确保正确。**

### 2. 多个 AI 的共识才是证据

> 一个 AI 的判断是意见，两个独立 AI 的共识是证据。

**必须进行交叉评审。**

### 3. 评审意见需要判断

> 不是所有评审意见都需要采纳。要用专业判断哪些真正需要修复。

### 4. 诚实面对错误

> 如果我们的代码有问题，要勇于承认并修复。不要为了合并而合并。

---

## PR 合并前核检清单

### 一、PR 基础状态检查

| # | 检查项 | 命令/方式 |
|---|--------|----------|
| 1 | PR 是 OPEN 状态 | `gh pr view <PR#>` |
| 2 | mergeable = true | `gh pr view --json mergeable` |
| 3 | reviewDecision = APPROVED | `gh pr view --json reviewDecision` |
| 4 | 无冲突 | `mergeStateStatus: CLEAN` |
| 5 | CI/CD 全部通过 | GitHub Actions Checks |

### 二、需求完整性检查 ⚠️ 最关键

| # | 检查项 | 方式 |
|---|--------|------|
| 6 | **原始需求是什么** | 读取 Issue/PR description |
| 7 | **所有需求都实现了吗** | 对照检查 |
| 8 | **没有实现多余的功能** | 确认变更范围 |
| 9 | **相关 Issue 都关闭了吗** | 关联 Issue 检查 |

### 三、交叉评审（强制） 🔔 核心

**必须使用 acpx 调用多个 AI 工具进行评审**：

```bash
# 1. iflow + glm-5（免费，中文优化）
acpx iflow --model glm-5 exec "评审 PR #<NUM>"

# 2. Qwen Code + Qwen 3.5 Plus（免费，1M 上下文）
acpx qwen --model qwen-plus exec "评审 PR #<NUM>"

# 3. OpenCode + MiniMax 2.5 Free（免费，快速）
acpx opencode --model MiniMax 2.5 Free "评审 PR #<NUM>"
```

**评审要点**：
1. 代码逻辑是否正确
2. 是否有潜在 bug
3. 是否有安全风险
4. 测试覆盖是否充分
5. 边界情况是否处理

### 四、评审意见处理

| # | 检查项 | 方式 |
|---|--------|------|
| 10 | 收集所有评审意见 | `gh pr view --json latestReviews` |
| 11 | **哪些需要修复** | 根据评审质量判断 |
| 12 | **哪些可以忽略** | 评审错误或无关 |
| 13 | **哪些是错的** | 明确反驳 |
| 14 | 将判断发布到 PR | `gh pr comment` |

### 五、本地验证 ⚠️ 必须

| # | 检查项 | 命令 |
|---|--------|------|
| 15 | 分支最新 | `git fetch origin` |
| 16 | 测试全部通过 | `npm test` |
| 17 | 无 lint 错误 | `npm run lint` |
| 18 | 类型检查通过 | `tsc --noEmit` |

### 六、冲突解决

| # | 检查项 | 方式 |
|---|--------|------|
| 19 | 手动解决冲突 | `git merge origin/main` → 编辑冲突文件 |
| 20 | **不要用 `-X ours`** | 会丢失代码 |
| 21 | 冲突解决后重新测试 | `npm test` |

### 七、代码质量检查

| # | 检查项 | 标准 |
|---|--------|------|
| 22 | 变更范围合理 | 不超过 20 个文件 |
| 23 | 没有调试代码 | console.log 等 |
| 24 | 注释准确 | 不是废话 |
| 25 | 函数长度合理 | 不超过 50 行 |

### 八、风险评估

| # | 检查项 | 问题示例 |
|---|--------|----------|
| 26 | 破坏性变更 | 数据库迁移、API 变更 |
| 27 | 安全风险 | 注入、认证绕过 |
| 28 | 性能影响 | N+1 查询等 |

---

## 评审意见分类指南

### 需要修复的

- 🔴 **Critical**: 安全漏洞、致命 bug、严重功能问题
- 🟠 **Major**: 功能不完整、逻辑错误、测试不足

### 可以忽略的

- 🟡 **Nitpick**: 风格偏好、不影响功能的优化建议
- 📝 **Suggestion**: 好的建议但非必须

### 应该反驳的

- ❌ **Wrong**: 评审员理解错误
- 🤷 **Disagree**: 功能上合理但评审员不认同

---

## 常见问题

### Q: 评审意见互相矛盾怎么办？

A: 相信自己的判断。如果两个评审意见矛盾，说明评审本身不可靠，需要自己判断。

### Q: 评审说没问题，但我感觉有问题？

A: 相信你的直觉。你的担心可能是有道理的。继续深入检查。

### Q: 可以忽略某些评审意见吗？

A: 可以，但要在 PR 中明确说明原因。

---

## 相关技能

- `bug-cross-validation` - Bug 交叉验证
- `team-communication-basics` - 团队通讯协议
- `ai-coding-workflow` - AI 编程助手工作流

---

*最后更新: 2026-03-20*
*版本: v1.1.0*
'''

# Skill 3: team-retrospective
skill3 = '''---
name: team-retrospective
description: 团队复盘技能。Bug 修复或任务完成后执行，将经验固化到技能系统、记忆系统、追踪系统。触发于 Bug 修复完成、重大任务完成、识别出系统性问题、或用户明确要求复盘时。
---

# Team Retrospective Skill - 团队复盘技能

> **版本**: v1.2.0
> **维护者**: 全团队
> **适用范围**: 所有团队成员（main, pm, repair, verification, resource-scout 等）

---

## 目的

每次 Bug 修复或特定任务完成后，执行复盘，将经验固化到：
1. **技能系统（SKILL）** — 可复用的最佳实践
2. **记忆系统（MEMORY）** — 项目特定的教训和上下文
3. **追踪系统（retro_actions.json）** — 待验证的行动项

---

## 触发条件

- Bug/Issue 修复完成后
- 重大任务完成（里程碑、PR 合并）
- 识别出系统性问题
- 用户明确要求复盘
- **同类问题 30 天内出现 2 次以上**（强制深度复盘）

---

## 复盘流程（6 步闭环）

### Step 1: 收集事实

**必答问题**：
1. **任务是什么？** （Pain ID / Issue 编号 / 任务描述）
2. **根因是什么？** （追问到无下级原因，见"根因分析到位标准"）
3. **为什么之前没有发现？** （测试？代码审查？监控？）
4. **修复方案是什么？** （改了哪些文件，多少行）

**输出模板**：
```
## 事实收集

| 问题 | 答案 |
|------|------|
| Pain/Issue ID | xxx |
| 根因 | xxx |
| 预防失败点 | xxx |
| 修复文件 | xxx |
| 修复行数 | xxx |
```

### Step 2: 分类经验

**三类经验**：

| 类型 | 定义 | 存储位置 |
|------|------|----------|
| **教训（Lesson）** | 从错误中学到的东西 | MEMORY.md 或 memory/tasks/ |
| **最佳实践（Best Practice）** | 做得好的，可以复用 | SKILL/*.md |
| **工具/流程缺陷** | 系统性问题，需要修复 | Issue 或 Repair Task |

### Step 3: 提取可执行 Action Items

**Action Items 分两类**：

| 类型 | 定义 | 执行时机 | 示例 |
|------|------|----------|------|
| **immediate** | 可立即完成 | 复盘过程中执行 | 更新 MEMORY.md |
| **async** | 需要后续跟进 | 复盘后异步执行 | 创建 Issue、跨智能体协作 |

**模板**：
```markdown
## Action Items

### 立即执行（immediate）
- [ ] 更新 MEMORY.md：`<section>` - 原因：`<为什么重要>`

### 异步追踪（async）
- [ ] 创建 Issue：`<title>` - 原因：`<为什么需要>`
- [ ] 创建技能：`<skill-name>` - 原因：`<为什么需要>`
```

### Step 4: 执行立即类 Action Items

**必须在复盘中完成**：

1. **更新 MEMORY.md**
   - 读取现有 MEMORY.md
   - 在对应 section 追加教训/经验
   - 写回文件

2. **创建/更新 SKILL.md**
   - 检查目标目录是否存在：`skills/<category>/<skill-name>/`
   - **不存在**：创建目录
   - 写入 SKILL.md 内容

3. **写复盘报告**
   - 检查 `memory/retrospectives/` 目录是否存在
   - **不存在**：创建目录
   - 写入报告：`memory/retrospectives/<YYYY-MM-DD>-<short-id>.md`

**执行完成后，在 Action Items 上打勾**：
```markdown
- [x] 更新 MEMORY.md：教训部分
```

### Step 5: 注册异步追踪

**只将 async 类型的 Action Items 写入追踪系统**（immediate 类型已在 Step 4 完成验证）

**文件位置**：`<workspace>/.state/retro_actions.json`

**文件结构**：
```json
{
  "items": [
    {
      "id": "retro-2026-03-22-001",
      "source": "memory/retrospectives/2026-03-22-pain-xxx.md",
      "action": "创建 Issue：测试覆盖不足",
      "type": "issue",
      "executeType": "async",
      "assignedTo": "repair",
      "status": "pending",
      "createdAt": "2026-03-22T10:00:00Z",
      "verifyAfter": "2026-03-25",
      "retryCount": 0,
      "maxRetry": 3,
      "verifiedAt": null,
      "verifiedResult": null
    }
  ]
}
```

**字段说明**：

| 字段 | 说明 |
|------|------|
| executeType | `immediate` 或 `async` |
| assignedTo | 负责执行的智能体 ID |
| retryCount | 重试次数（初始为 0）|
| maxRetry | 最大重试次数（默认 3）|

**操作步骤**：
1. 检查 `.state/retro_actions.json` 是否存在
   - **不存在**：创建初始结构 `{ "items": [] }`
   - **存在**：读取现有内容
2. 只追加 `executeType: async` 的 Action Items
3. 写回文件

**跨智能体 Action Items**：
- 如果 Action 需要其他智能体执行（如 pm 更新产品设计）
- `assignedTo` 填写目标智能体 ID
- 通过 `sessions_send` 通知目标智能体

### Step 6: 通知与交接

**如果是跨智能体 Action Item**：
```
sessions_send → agent:<assignedTo>:main
消息内容：
  - 复盘报告链接
  - 需要执行的 Action Item
  - 期望完成时间
```

---

## Heartbeat 验证机制

**Heartbeat 启动时自动检查** `.state/retro_actions.json`：

```
检查流程：

1. 检查 .state/retro_actions.json 是否存在
   - 不存在 → 跳过，返回 HEARTBEAT_OK
   - 存在 → 继续

2. 读取文件内容

3. 筛选需要验证的项：
   - status = pending
   - verifyAfter <= 今天
   - assignedTo = 当前智能体（或为空）
   
   - 没有符合条件的项 → 跳过

4. 对每项执行验证：
   - 检查 Action 是否已执行
   - 已执行 → status: verified, 记录 verifiedAt
   - 未执行 → retryCount++, 记录失败原因
     - retryCount >= maxRetry → status: blocked
     - 否则 → 延期 1 天

5. 写回文件
```

**验证方法**：

| Action 类型 | 验证方法 |
|-------------|----------|
| skill | 检查 SKILL.md 是否存在 |
| memory | 检查 MEMORY.md 对应内容是否已更新 |
| issue | 检查 Issue 是否已创建（通过 gh 命令或文件检查） |

---

## 根因分析到位标准

**追问停止条件**（满足任一）：
- 答案指向外部不可控因素（如上游 API 变更）
- 答案指向可执行的代码/流程修改点
- 答案不再有"因为..."的下级原因

**检查问题**：
- 如果修复这个根因，问题是否 100% 不再发生？
- 这个根因是否在可控范围内？
- 修复这个根因是否比修复症状更高效？

**常见假根因**（需要继续追问）：

| 假根因 | 继续追问 |
|--------|----------|
| "粗心大意" | 为什么会粗心？缺少什么检查机制？ |
| "时间不够" | 为什么时间不够？估算哪里错了？ |
| "沟通不畅" | 为什么沟通不畅？流程有什么缺陷？ |
| "经验不足" | 为什么经验不足？缺少什么文档或培训？ |

---

## 重复问题处理机制

当 **同一问题 30 天内出现 2 次以上** 时：

1. **立即触发深度复盘**
   - 查找上次复盘报告：`memory/retrospectives/`
   - 检查上次 Action Items 执行情况
   - 对比两次根因分析

2. **升级处理**

| 情况 | 处理 |
|------|------|
| Action Items 未执行 | 记录失败原因，重新分配，标记 `[BLOCKED]` |
| 根因分析不到位 | 强制追问到更深层级，标记 `[DEEPEN]` |
| 执行了但无效 | 根因可能找错，重新分析，标记 `[WRONG-ROOT]` |

3. **输出升级版复盘报告**
   - 标题：`[REPEAT-FAILED] 原标题`
   - 包含：上次复盘链接 + 本次分析 + 差异对比 + 升级原因

---

## 复盘失败信号

| 信号 | 说明 | 处理 |
|------|------|------|
| 同类问题 30 天内重复 | 根因分析不够深 | 强制深度复盘 |
| retryCount >= 3 | 连续失败 | 标记 blocked，需人工介入 |
| 新写 SKILL 未被引用 | 经验未应用 | 检查 skills 配置 |
| 新写 MEMORY 未被引用 | 上下文未生效 | 检查注入机制 |
| retro_actions.json 积压过多 | 验证流程失效 | 清理已完成项，检查堵塞原因 |

---

## 各角色职责

### main（指挥官）
- 协调团队复盘流程
- 处理跨智能体 Action Items
- 检查 `retro_actions.json` 中 assignedTo 为空的项

### repair（修复专家）
- 触发时机：Bug 修复完成后
- 关注点：技术根因、代码质量、测试覆盖
- 执行：immediate 类立即完成，async 类注册追踪

### verification（验证专家）
- 触发时机：测试失败、验证流程问题时
- 关注点：为什么测试没发现、验证流程缺陷
- 执行：同上

### resource-scout（侦察员）
- 触发时机：发现新工具/方法、调研完成时
- 关注点：工具使用教训、方法改进
- 执行：同上

---

## 质量标准

**一个好的复盘必须**：
1. ✅ 有明确的 Pain/Issue 引用
2. ✅ 根因分析达到 3 层深度以上
3. ✅ 至少有 1 个可执行的 Action Item
4. ✅ immediate 类 Action Items 在复盘中执行完毕
5. ✅ async 类 Action Items 已注册到 `retro_actions.json`
6. ✅ 跨智能体 Action Items 已通知目标智能体
7. ✅ 有具体的行为改变建议

**一个坏的复盘**：
1. ❌ 只描述问题，不分析根因
2. ❌ Action Items 没有执行就结束
3. ❌ 经验没有存储到持久化位置
4. ❌ 结论模糊，无法指导未来行动
5. ❌ async 类 Action Items 未注册追踪

---

## 相关技能

- `bug-cross-validation` - Bug 交叉验证流程
- `team-communication-basics` - 团队通讯协议
- `context-rebuild` - 上下文重建

---

*最后更新: 2026-03-22*
*版本: v1.2.0*
'''

def main():
    # Write skill 1
    with codecs.open(r'D:\Code\spicy_evolver_souls\skills\agent-autonomy-rhythms\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill1)
    print('Fixed: agent-autonomy-rhythms/SKILL.md')
    
    # Write skill 2
    with codecs.open(r'D:\Code\spicy_evolver_souls\skills\pr-review-and-merge\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill2)
    print('Fixed: pr-review-and-merge/SKILL.md')
    
    # Write skill 3
    with codecs.open(r'D:\Code\spicy_evolver_souls\skills\team-retrospective\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill3)
    print('Fixed: team-retrospective/SKILL.md')
    
    print('\nAll P0 skills fixed!')

# Skill 4: team-communication-basics - improve description with trigger conditions
skill4 = '''---
name: team-communication-basics
description: |
  选择正确的代理通信工具。TRIGGER CONDITIONS: (1) 需要给其他代理发消息 (2) 需要派生子代理执行任务 (3) 不确定该用 sessions_send 还是 sessions_spawn (4) 想联系 pm/repair/verification 等队友 (5) 用户说"让xx去..."、"通知xx"、"派个agent"。覆盖四套机制：OpenClaw peer session (sessions_send)、临时子代理 (sessions_spawn)、子代理查询 (subagents)、Principles 内部 worker (pd_run_worker)。CRITICAL: 任何跨代理通信前必须先加载此技能确认工具选择。
disable-model-invocation: true
---

# team-communication-basics

Use this skill whenever you need to decide:

- who is a formal peer agent
- who is only a session
- who is a temporary subagent
- who is a Principles internal worker
- which tool to use: `sessions_list`, `sessions_send`, `sessions_spawn`, `subagents`, or `pd_run_worker`

## 核心记忆（必须记住）

| 场景 | 工具 |
|------|------|
| 同级代理通信 | `sessions_list` → `sessions_send` |
| 查询已派发子代理 | `subagents list` |
| 启动临时子代理 | `sessions_spawn` |
| 启动内部 worker（diagnostician 等） | `pd_run_worker agentType="xxx"` |

## 禁止行为

- 用 `sessions_list` 查子代理 → 用 `subagents`
- 把 `diagnostician`/`explorer` 创建为同级代理 → 它们是内部 worker
- 用 `sessions_spawn` 启动内部 worker → 用 `pd_run_worker`
- 用 `agents_list` 发现同级成员 → 它只显示 spawn 目标

---

## CRITICAL: 与新代理建立首次联系

**这是常见的陷阱。**

当你添加一个新代理到团队时，你不能立即使用 `sessions_send`。代理还没有活跃会话。你必须先用 CLI 建立会话。

### Step 1: 使用 `openclaw agents` CLI 发起联系

**正确方式：使用 `openclaw message` 不是 `openclaw agent`**

`openclaw agent` 是用于外部渠道（WhatsApp/Telegram）的，不是用于内部 agent 通信的。

对于内部 agent，使用 `sessions_send` 工具。但如果 agent 还没有 session，需要先用 CLI 创建。

**方法**：直接用 `openclaw agent --agent <AGENT_ID> --message` 创建 session。

---

## 四套通信机制对比

| 机制 | 工具 | 目标 | 用例 |
|------|------|------|------|
| OpenClaw peer session | `sessions_send` | 已配置的正式代理 | 给 pm/repair/verification 发消息 |
| 临时子代理 | `sessions_spawn` | 动态创建的子代理 | 派一个临时 agent 去做任务 |
| 子代理查询 | `subagents` | 已派发的子代理 | 查看子代理状态 |
| Principles worker | `pd_run_worker` | 内置 worker | 启动 diagnostician/explorer |

---

## 常见场景决策表

| 场景 | 正确工具 | 错误工具 |
|------|----------|----------|
| "联系 pm 确认需求" | `sessions_send` | `sessions_spawn` |
| "派个 agent 去查日志" | `sessions_spawn` | `sessions_send` |
| "让 diagnostician 分析一下" | `pd_run_worker` | `sessions_spawn` |
| "看看子代理完成没" | `subagents list` | `sessions_list` |
| "通知 verification 测试" | `sessions_send` | `pd_run_worker` |

---

## 相关技能

- `agent-autonomy-rhythms` - 代理自主节奏
- `team-standup` - 团队站会
- `team-retrospective` - 团队复盘
'''

def main():
    # Write skill 1
    with codecs.open(r'D:\\Code\\spicy_evolver_souls\\skills\\agent-autonomy-rhythms\\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill1)
    print('Fixed: agent-autonomy-rhythms/SKILL.md')
    
    # Write skill 2
    with codecs.open(r'D:\\Code\\spicy_evolver_souls\\skills\\pr-review-and-merge\\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill2)
    print('Fixed: pr-review-and-merge/SKILL.md')
    
    # Write skill 3
    with codecs.open(r'D:\\Code\\spicy_evolver_souls\\skills\\team-retrospective\\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill3)
    print('Fixed: team-retrospective/SKILL.md')
    
    # Write skill 4 - team-communication-basics
    with codecs.open(r'D:\\Code\\spicy_evolver_souls\\skills\\team-communication-basics\\SKILL.md', 'w', 'utf-8') as f:
        f.write(skill4)
    print('Fixed: team-communication-basics/SKILL.md')
    
    print('\\nAll P0 skills fixed!')

if __name__ == '__main__':
    main()
