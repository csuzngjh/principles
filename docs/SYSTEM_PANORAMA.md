# Claude Code 可进化编程智能体：系统全景图 (Final Architecture v2.5)

> 这是一个“三层轨道 + 一个调度中枢 + 五大生理循环”的有机生命体。
> 核心哲学：**Run Fast -> Hit Wall (Comply) -> Plan; Run Fast -> Crash (Evolve) -> System Upgrade.**
> 战略哲学：**Vision -> Strategy -> OKR (Align) -> Execution -> Check-in.**

---

## 1. 核心思维模型实现映射 (Philosophy to Code)

| 思维模型 (Mental Model) | 实现组件 (Component) | 机制说明 (Mechanism) |
| :--- | :--- | :--- |
| **五步进化循环** | `00-kernel.md` + `/evolve-task` | Kernel 定义顺序，Skill 强制 Step-by-step 执行。 |
| **痛苦驱动进化** | `hook_runner.py` (PreCompact) | 检测报错/停滞 -> 生成 Pain Flag -> 触发反思。 |
| **根因分析 (5 Whys)** | `/root-cause` Skill | 独立的诊断技能，强制追问“为什么门禁失效”。 |
| **演绎审计 (Deductive Audit)** | `/deductive-audit` Skill + `pre_write_gate` | Skill 生成审计报告，Python Hook 强制检查报告是否存在且合格。 |
| **反盲从 (Anti-Sycophancy)** | `USER_CONTEXT.md` + `00-kernel.md` | SessionEnd 更新画像 -> 挂载到 CLAUDE.md -> Kernel 规定“基于画像反盲从”。 |
| **可信度加权 (Believability)** | `SubagentStop` Hook + `.verdict.json` | 任务结束 -> 主智能体裁决 -> Python Hook 自动更新 Agent 积分。 |
| **系统性修复 (System Fix)** | `/reflection-log` Skill | 强制要求输出“可执行的 Guardrail 建议”（如改 PROFILE.json）。 |
| **战略目标 (Strategic Goal)** | `/init-strategy` + `/manage-okr` | 定义 Vision -> 生成 STRATEGY.md -> 拆解并分发 OKR。 |
| **智能体自治 (Agent Agency)** | `/manage-okr` (Negotiation) | 主智能体通过 `Task()` 面试子智能体，子智能体基于调研主动承诺 KR。 |

---

## 2. 系统解剖图 (Anatomy)

### 2.1 大脑 (Core)
- **主智能体 (Main Agent)**: 调度中枢，负责决策、分发任务、最终裁决。
- **记忆中枢 (Memory)**:
  - `CLAUDE.md`: 挂载以下动态上下文：
    - `USER_CONTEXT.md`: 用户能力与偏好。
    - `AGENT_CONTEXT.md`: 子智能体实时战绩。
    - `okr/CURRENT_FOCUS.md`: 当前迭代的核心目标 (O+KRs)。
    - `PRINCIPLES.md`: 长期原则。
  - `docs/PROFILE.json`: 身体参数 (Risk Paths, Gate Switches)。

### 2.2 肢体 (Subagents)
- 内置: `Explorer`, `Diagnostician`, `Auditor`, `Planner`, `Implementer`, `Reviewer`.
- **特性**: 每个子智能体通过定义文件中的 `@docs/okr/<agent>.md` 引用，加载专属 KPI。
- **扩展**: 外置/新加的 Agent 文件会被 `/manage-okr` 自动扫描并注入 OKR 引用。

### 2.3 神经反射 (Python Hooks)
所有 Hook 逻辑均集成在 `.claude/hooks/hook_runner.py` 中：
- **痛觉**: `post_write_checks` (写后自测)。
- **拦截**: `pre_write_gate` (写前查票，支持语义校验)。
- **反思**: `precompact_checkpoint` (压缩前自省) + `session_init` (重启后提醒)。
- **记账**: `subagent_complete` (Agent打分) + `stop_evolution_update` (用户打分)。
- **同步**: `sync_user_context` + `sync_agent_context` (JSON -> Markdown)。
- **监控**: 内置 `telemetry`，日志记录于 `docs/SYSTEM.log`。

### 2.4 人类控制台 (Human Console)
- **`/admin`**: 初始化、修复、重置系统的最高权限工具。
- **`/pain`**: 手动触发痛苦信号。
- **`/profile`**: 手动修正用户画像。
- **`/inject-rule`**: 手动注入临时规则。
- **`/system-status`**: 查看系统健康度日志。

---

## 3. 五大生理循环 (Physiology Loops)

### ♻️ 循环一：主工作流 (The Evolve Loop)
**场景**: 复杂任务或“快速模式”受阻时。
1. **Triage**: `/triage` 定级风险。
2. **Diagnosis**: `Diagnostician` 找病因。
3. **Audit**: `Auditor` 查方案 (Pass/Fail)。
4. **Plan**: `Planner` 写剧本 (`PLAN.md` 含 `Target Files`)。
5. **Execute**: `Implementer` 执行。
   - *Hook 介入*: `pre_write_gate` 检查 Target 是否在 PLAN 中。
6. **Review**: `Reviewer` 验收。
7. **Reflect**: `/reflection-log` 复盘，生成 `.verdict.json`。

### 🎯 循环二：战略校准环 (The Strategic Loop)
**场景**: 项目启动或迭代开始。
1. **Init**: `/init-strategy` 访谈用户 -> 生成 `STRATEGY.md`。
2. **Align**: `/manage-okr` 扫描 Agent -> 面试并收集提案。
3. **Commit**: 生成 `okr/*.md` 并注入 Agent 定义文件。
4. **Focus**: 更新 `okr/CURRENT_FOCUS.md` 供主智能体常驻阅读。

### 🛡️ 循环三：门禁反射环 (The Gatekeeper Loop)
**场景**: 任何 Write/Edit 操作。
- **Trigger**: 工具调用。
- **Check**: `hook_runner.py` 读取 `PROFILE.json` 和 `PLAN.md`。
- **Logic**: 
  - 路径在 `risk_paths`? -> 是。
  - `PLAN.md` 存在且状态 READY? -> 是。
  - 目标文件在 `Target Files` 列表? -> 是。
  - **Result**: 放行 (Exit 0) / 拦截 (Exit 2)。

### 🧠 循环四：认知反思环 (The Reflection Loop)
**场景**: 上下文快满 (Context Full)。
- **PreCompact**: Python 逻辑检查 PLAN 状态和 Pain Flag。
  - 发现异常 -> 生成 `docs/.pending_reflection`。
- **Context Clear**: 上下文压缩。
- **SessionStart**: Python 逻辑发现 `.pending_reflection`。
  - **Action**: 输出 `🛑 URGENT` 提示，强迫 LLM 先 `/reflection`。

### 📈 循环五：信用归因环 (The Attribution Loop)
**场景**: 任务结束或子任务结束。
- **Agent 归因**: 主智能体写 `.verdict.json` -> `SubagentStop` -> 更新 Scorecard -> 更新 `AGENT_CONTEXT.md`。
- **用户归因**: 主智能体写 `.user_verdict.json` -> `Stop` -> 更新 Profile -> 更新 `USER_CONTEXT.md`。

---

## 4. 进化逻辑 (Evolution Logic)

**不是所有错误都是进化，只有“漏网之鱼”才是进化。**

1. **被拦截 (Blocked)**:
   - 现象: Hook 返回 Exit 2。
   - 本质: **Compliance (合规)**。系统在按现有规则运行。
   - 动作: 补全手续 (Plan/Audit)，继续执行。

2. **遭遇灾难 (Uncaught Pain)**:
   - 现象: 没被拦截，但跑崩了/被骂了。
   - 本质: **Design Flaw (设计漏洞)**。现有规则不完善。
   - 动作: **Evolution (进化)**。
     - 调用 `/root-cause`: "为什么 Hook 没拦住？"
     - 调用 `/reflection-log`: "建议把这个路径加入 `risk_paths` 或新增正则拦截。"

---

## 5. 核心基础设施：拦截数据库 (Interception Database)

`PROFILE.json` 在架构中不仅仅是一个配置文件，它扮演着**“具备目录结构的动态拦截数据库”**的关键角色。Hook 脚本实时读取此数据库，确保规则变更立竿见影。

---

## 6. 文件清单 (File Inventory)

- **Rules**: `.claude/rules/00-kernel.md`, `10-guardrails.md`
- **Skills**: `.claude/skills/{init-strategy, manage-okr, triage, root-cause, deductive-audit, plan-script, reflection-log, evolve-task, admin, pain, profile, inject-rule}/SKILL.md`
- **Agents**: `.claude/agents/*.md` (6个)
- **Hooks**: `.claude/hooks/hook_runner.py` (统一入口)
- **Docs**: `docs/{STRATEGY.md, okr/*.md, ISSUE_LOG.md, PRINCIPLES.md, PROFILE.json, USER_PROFILE.json, AGENT_SCORECARD.json, PLAN.md, AUDIT.md, USER_CONTEXT.md, AGENT_CONTEXT.md, SYSTEM.log}`
- **Memory**: `CLAUDE.md` (入口)
