# Claude Code 可进化编程智能体：系统全景图 (Final Architecture)

> 这是一个“三层轨道 + 一个调度中枢 + 四大生理循环”的有机生命体。
> 核心哲学：**Run Fast -> Hit Wall (Comply) -> Plan; Run Fast -> Crash (Evolve) -> System Upgrade.**

---

## 1. 核心思维模型实现映射 (Philosophy to Code)

| 思维模型 (Mental Model) | 实现组件 (Component) | 机制说明 (Mechanism) |
| :--- | :--- | :--- |
| **五步进化循环** | `00-kernel.md` + `/evolve-task` | Kernel 定义顺序，Skill 强制 Step-by-step 执行。 |
| **痛苦驱动进化** | `post_write_checks.sh` + `PreCompact` Hook | 脚本检测报错/停滞 -> 生成 Pain Flag -> 触发反思。 |
| **根因分析 (5 Whys)** | `/root-cause` Skill | 独立的诊断技能，强制追问“为什么门禁失效”。 |
| **演绎审计 (Deductive Audit)** | `/deductive-audit` Skill + `pre_write_gate.sh` | Skill 生成审计报告，Hook 强制检查报告是否存在且合格。 |
| **反盲从 (Anti-Sycophancy)** | `USER_CONTEXT.md` + `00-kernel.md` | SessionEnd 更新画像 -> 挂载到 CLAUDE.md -> Kernel 规定“基于画像反盲从”。 |
| **可信度加权 (Believability)** | `SubagentStop` Hook + `.verdict.json` | 任务结束 -> 主智能体裁决 -> Hook 自动更新 Agent 积分。 |
| **系统性修复 (System Fix)** | `/reflection-log` Skill | 强制要求输出“可执行的 Guardrail 建议”（如改 PROFILE.json）。 |
| **认识论谦逊** | `00-kernel.md` | 明确规定“不确定就停下验证”，“Above/Below line”分层思考。 |

---

## 2. 系统解剖图 (Anatomy)

### 2.1 大脑 (Core)
- **主智能体 (Main Agent)**: 调度中枢，负责决策、分发任务、最终裁决。
- **记忆中枢 (Memory)**:
  - `CLAUDE.md`: 挂载 `USER_CONTEXT.md` (用户画像) 和 `PRINCIPLES.md` (原则)。
  - `docs/PROFILE.json`: 身体参数 (Risk Paths, Gate Switches)。

### 2.2 肢体 (Subagents)
- 👀 `Explorer`: 侦察兵 (Read/Grep/Glob)。
- 🩺 `Diagnostician`: 医生 (Read/Grep)。
- 👮 `Auditor`: 安全员 (Read/Grep)。
- 🎬 `Planner`: 导演 (Read)。
- 🛠️ `Implementer`: 工人 (Write/Edit/Bash)。
- ⚖️ `Reviewer`: 质检员 (Read/Bash)。

### 2.3 神经反射 (Hooks)
- **痛觉**: `post_write_checks.sh` (写后自测)。
- **拦截**: `pre_write_gate.sh` (写前查票)。
- **反思**: `precompact_checkpoint.sh` (压缩前自省) + `session_init.sh` (重启后提醒)。
- **记账**: `subagent_complete.sh` (Agent打分) + `stop_evolution_update.sh` (用户打分)。
- **同步**: `sync_user_context.sh` (JSON -> Markdown)。

---

## 3. 四大生理循环 (Physiology Loops)

### ♻️ 循环一：主工作流 (The Evolve Loop)
**场景**: 复杂任务或“快速模式”受阻时。
1. **Triage**: `/triage` 定级风险。
2. **Diagnosis**: `Diagnostician` 找病因。
3. **Audit**: `Auditor` 查方案 (Pass/Fail)。
4. **Plan**: `Planner` 写剧本 (`PLAN.md` 含 `Target Files`)。
5. **Execute**: `Implementer` 执行。
   - *Hook 介入*: `pre_write_gate.sh` 检查 Target 是否在 PLAN 中。
6. **Review**: `Reviewer` 验收。
7. **Reflect**: `/reflection-log` 复盘，生成裁决书。

### 🛡️ 循环二：门禁反射环 (The Gatekeeper Loop)
**场景**: 任何 Write/Edit 操作。
- **Trigger**: 工具调用。
- **Check**: `pre_write_gate.sh` 读取 `PROFILE.json` 和 `PLAN.md`。
- **Logic**: 
  - 路径在 `risk_paths`? -> 是。
  - `PLAN.md` 存在且状态 READY? -> 是。
  - 目标文件在 `Target Files` 列表? -> 是。
  - **Result**: 放行 (Exit 0) / 拦截 (Exit 2)。

### 🧠 循环三：认知反思环 (The Reflection Loop)
**场景**: 上下文快满 (Context Full)。
- **PreCompact**: 脚本检查 PLAN 状态和 Pain Flag。
  - 发现异常 -> 生成 `docs/.pending_reflection`。
- **Context Clear**: 上下文压缩。
- **SessionStart**: 脚本发现 `.pending_reflection`。
  - **Action**: 输出 `🛑 URGENT` 提示，强迫 LLM 先 `/reflection`。

### 📈 循环四：信用归因环 (The Attribution Loop)
**场景**: 任务结束或子任务结束。
- **Agent 归因**:
  - 主智能体写 `.verdict.json`。
  - `SubagentStop` 触发 `subagent_complete.sh`。
  - 更新 `AGENT_SCORECARD.json`。
- **用户归因**:
  - 主智能体写 `.user_verdict.json`。
  - `Stop` 触发 `stop_evolution_update.sh`。
  - 更新 `USER_PROFILE.json` -> 触发 `sync_user_context.sh` -> 更新 `USER_CONTEXT.md`。

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

`PROFILE.json` 在架构中不仅仅是一个配置文件，它扮演着**“具备目录结构的动态拦截数据库”**的关键角色。

- **实时性**: Hooks 脚本在每次工具调用时实时读取此数据库，确保规则变更“立竿见影”，无需重启或刷新上下文。
- **强制性**: 相比于 Rules (道理/潜意识)，PROFILE (墙/数据库) 是由脚本执行的硬性约束，不会随上下文压缩而稀释。
- **进化载体**: 系统进化（Evolution）的实质结果主要体现为对该数据库的“增删改查”（如自动将故障路径加入 `risk_paths`）。

---

## 6. 文件清单 (File Inventory)

- **Rules**: `.claude/rules/00-kernel.md`, `10-guardrails.md`
- **Skills**: `.claude/skills/{triage, root-cause, deductive-audit, plan-script, reflection-log, evolve-task}/SKILL.md`
- **Agents**: `.claude/agents/*.md` (6个)
- **Hooks**: `.claude/hooks/*.sh` (9个)
- **Docs**: `docs/{ISSUE_LOG.md, PRINCIPLES.md, PROFILE.json, USER_PROFILE.json, AGENT_SCORECARD.json, PLAN.md, AUDIT.md, USER_CONTEXT.md}`
- **Memory**: `CLAUDE.md` (入口)

---

**状态确认**:
所有组件均已按照上述逻辑**代码实现**并**测试通过**（Windows 路径兼容性除外，以 Linux 为准）。
系统已具备自我防御、自我反思、自我进化的完整能力。
