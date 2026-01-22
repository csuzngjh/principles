# SPEC：Claude Code 可进化编程智能体（实现交付文档）

> 读者：初级开发人员（按阶段交付）
>
> 目标：在 Claude Code 项目内实现一套“稳定进化 + 反盲从 + 可信度加权”的编程智能体框架。
>
> 重点：**可跑通闭环**，不追求一次性完美；每阶段都有验收标准。

---

## 0. 术语与边界

### 0.1 Claude Code 组件

- **rules**：`.claude/rules/*.md`，自动注入项目记忆（可用 `paths:` 条件加载）。
- **skills**：`.claude/skills/*.md`，可用 `/skill-name` 调用；用于固定输出格式与流程模板。
- **subagents（子智能体）**：`.claude/agents/*.md`，主会话可委派任务；每个有独立提示与工具权限。
- **hooks**：`.claude/settings.json` 中配置，事件触发执行脚本或 prompt；常用：`PreToolUse` / `PostToolUse` / `Stop` / `PreCompact`。

### 0.2 系统目标边界

本系统**不实现真正的模型训练**；所谓“进化”是指：
- 将负反馈（痛苦信号）沉淀为：日志（Issue Log）→ 原则（Principles）→ 运行时护栏（rules/hooks/tests）
- 并通过可执行参数（PROFILE）与可信度画像（USER/AGENT）调节系统行为。

---

## 1. 功能需求（FR）

### FR-1：可跑通的最小闭环（MVP）

当出现痛苦信号（例如测试失败、用户指出错误等），系统必须：
1) 记录到 `docs/ISSUE_LOG.md`（包含：证据、直接原因、根因、5Whys、分类、原则候选、护栏建议）。
2) 更新 `docs/USER_PROFILE.json`（对用户领域可信度加减分）。
3) 更新 `docs/AGENT_SCORECARD.json`（对子智能体绩效加减分）。

### FR-2：强制委托（避免主会话“忘记调用”子智能体）

提供一个入口 skill：`/evolve-task`，用于强制流程：
- Explorer → Diagnostician → Auditor → Planner → Implementer → Reviewer

并通过 hooks 在关键节点（写文件前/后）强制门禁：
- 高风险路径写入前必须有 Plan + Audit PASS，否则阻断写入。
- 写入后自动跑检查并触发 Reviewer。

### FR-3：反盲从（用户意见不能绕过硬约束与审计）

当用户要求：跳过测试、绕过审计、不可逆 DB 操作、改生产配置等高风险动作时：
- 系统必须提出劝阻理由 + 更安全替代方案 + 要求验证。

### FR-4：可信度加权（对用户与子智能体）

- 用户：维护 `USER_PROFILE.json`，按领域（frontend/backend/infra/security）记录可信度分数。
- 子智能体：维护 `AGENT_SCORECARD.json`，记录每个 agent 的分数、wins/losses、失败模式。
- 决策规则：硬约束 > 审计 > 可信度加权。

### FR-5：原则治理（PRINCIPLES 与 rules 分离）

- `docs/PRINCIPLES.md`：原则源代码（完整、可读、可审计）。
- `.claude/rules/10-guardrails.md`：运行时短规则（从 PRINCIPLES 提纯而来）。

> MVP 不要求自动“编译”；先人工提纯即可。

---

## 2. 非功能需求（NFR）

- NFR-1：尽量少消耗上下文：Kernel Rules 控制在 80-150 行。
- NFR-2：hooks 脚本优先，避免 prompt hook 频繁触发。
- NFR-3：所有写入文件都应可读、可 git review、可回滚。
- NFR-4：失败要可诊断：脚本输出清晰错误信息，告诉 Claude/开发者“缺什么文件/哪一步没做”。

---

## 3. 文件与目录结构（必须按此创建）

```
.claude/
  rules/
    00-kernel.md
    10-guardrails.md
    paths/
      frontend.md
      backend.md
      infra.md
  skills/
    evolve-task.md
    triage.md
    root-cause.md
    deductive-audit.md
    plan-script.md
    execute-checklist.md
    reflection-log.md
  agents/
    explorer.md
    diagnostician.md
    auditor.md
    planner.md
    implementer.md
    reviewer.md
  hooks/
    pre_write_gate.sh
    post_write_checks.sh
    stop_evolution_update.sh
    precompact_checkpoint.sh
  settings.json

docs/
  ISSUE_LOG.md
  PRINCIPLES.md
  PROFILE.json
  USER_PROFILE.json
  AGENT_SCORECARD.json
  DECISIONS.md
  PLAN.md
  AUDIT.md
  CHECKPOINT.md
```

说明：
- `PLAN.md`、`AUDIT.md` 是门禁检查用的“标记文件”（最简单可靠）。
- `CHECKPOINT.md` 用于 PreCompact checkpoint。

---

## 4. 数据结构（实现时严格遵守）

### 4.1 docs/PROFILE.json（运行时参数）

最小字段：

```json
{
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],
  "gate": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true,
    "require_reviewer_after_write": true
  },
  "tests": {
    "on_change": "smoke",
    "on_risk_change": "unit",
    "on_release": "full"
  },
  "permissions": {
    "deny_skip_tests": true,
    "deny_unsafe_db_ops": true
  }
}
```

### 4.2 docs/USER_PROFILE.json（用户可信度画像）

```json
{
  "domains": {"frontend": 0, "backend": 0, "infra": 0, "security": 0},
  "signals": {"accepted_suggestions": 0, "rejected_suggestions": 0, "skip_test_requests": 0},
  "interaction_mode": {"verbosity": "balanced", "accepts_pushback": true},
  "notes": []
}
```

加分/减分规则（MVP）：
- 若用户建议被验证通过（测试通过/修复成功）：对应领域 +1，accepted_suggestions+1
- 若用户建议导致失败（测试失败/返工）：对应领域 -1，rejected_suggestions+1
- 若用户要求跳过测试/审计：skip_test_requests+1，并触发反盲从提示

### 4.3 docs/AGENT_SCORECARD.json（子智能体绩效画像）

```json
{
  "agents": {
    "explorer": {"score": 0, "wins": 0, "losses": 0, "failure_modes": {}},
    "diagnostician": {"score": 0, "wins": 0, "losses": 0, "failure_modes": {}},
    "auditor": {"score": 0, "wins": 0, "losses": 0, "failure_modes": {}},
    "planner": {"score": 0, "wins": 0, "losses": 0, "failure_modes": {}},
    "implementer": {"score": 0, "wins": 0, "losses": 0, "failure_modes": {}},
    "reviewer": {"score": 0, "wins": 0, "losses": 0, "failure_modes": {}}
  }
}
```

加分/减分规则（MVP）：
- 若该 agent 的输出被采纳且最终验证通过：score +1, wins+1
- 若出现失败并可归因到该 agent（例如审计漏掉致命问题）：score -2, losses+1, failure_modes[<type>]+=1

> MVP 允许“人工归因”：由 stop 脚本读取本轮标记（见 6.3）。

---

## 5. Rules 规范（必须按模板写，避免过长）

### 5.1 `.claude/rules/00-kernel.md`（不变量内核）

要求：80-150 行内。

必须包含的硬规则（用简短 bullet）：
- 五步顺序：Goal → Problem → Diagnosis → Audit → Plan → Execute → Review → Log
- 痛苦信号触发：禁止“抱歉+快修”，必须先诊断根因并写日志
- 根因方法：动词/形容词 + 5Whys + 人/设计/假设分类
- 演绎审计：公理/系统/否定三审必须在 Diagnosis→Plan 之间
- 谦逊：不确定就请求信息/查文档/跑命令验证，不编造
- 反盲从：高风险指令不得绕过测试/审计；必须劝阻并给替代方案
- 输出层级：Above/Below line，讨论架构时不陷入变量命名
- 表达护栏：透明但不羞辱

### 5.2 `.claude/rules/10-guardrails.md`（运行时短规则）

- 放：安全红线、不可逆操作限制、必须跑的最小测试等。
- 只写可执行规则，不写长解释。

### 5.3 `.claude/rules/paths/*.md`

- `frontend.md`：前端工程约定（简短）。
- `backend.md`：API、错误处理、DB 迁移。
- `infra.md`：发布、密钥、回滚、SLO。

---

## 6. Skills 规范（每个 skill 只做一件事）

### 6.1 `/evolve-task`（入口，强制委托）

**目标**：把流程“写死”，避免主会话忘记委托。

输出契约：
1) 先调用 `/triage` 补齐信息
2) 明确“接下来必须委派到哪些 agents”（按顺序）
3) 生成/更新 `docs/PLAN.md` 与 `docs/AUDIT.md`（若进入 Plan/Audit）

### 6.2 `/triage`

输出：
- 目标（Goal）
- 当前问题（Problem）
- 复现步骤/日志/环境

### 6.3 `/root-cause`

输出固定字段：
- Proximal cause（动词）
- Root cause（形容词/设计缺陷/假设）
- 5 Whys（至少 3 层）
- 分类：People/Design/Assumption

### 6.4 `/deductive-audit`

输出固定字段：
- Axiom test（语言/库/API 契约）
- System test（反馈回路/技术债/延迟）
- Via negativa（最坏输入不崩溃/安全红线）
- Result：PASS/FAIL + Must-fix

### 6.5 `/plan-script`

输出：
- Step-by-step（文件/命令）
- Metrics（验证）
- Risk & Rollback

### 6.6 `/reflection-log`

输出：
- 痛苦信号摘要
- 新原则候选（触发条件/例外）
- 建议门禁（rule/hook/test）

---

## 7. Subagents（子智能体）规范（岗位化）

> 初级实现只需要按“输出契约”写提示即可，不必追求完美。

### 7.1 explorer.md

职责：收集证据（文件/函数/日志/命令）。

输出契约：
- Evidence list（含路径）
- Repro steps
- Hypotheses（<=3）

工具权限：Read/Grep/Glob/Bash（可选）

### 7.2 diagnostician.md

职责：根因分析。

输出契约：按 `/root-cause` 字段。

工具权限：Read（必要时）

### 7.3 auditor.md

职责：演绎审计。

输出契约：按 `/deductive-audit` 字段。

工具权限：Read

### 7.4 planner.md

职责：电影剧本计划。

输出契约：按 `/plan-script` 字段。

工具权限：Read

### 7.5 implementer.md

职责：按计划执行改动。

输出契约：
- Change summary
- Commands run + results

工具权限：Read/Write/Edit/Bash

### 7.6 reviewer.md

职责：`git diff` 审查 + 结果分级。

输出契约：Critical / Warning / Suggestion。

工具权限：Read/Bash

---

## 8. Hooks 与脚本（实现重点）

### 8.1 `.claude/settings.json`（MVP 必须）

事件配置：
- `PreToolUse`：matcher=Write|Edit → `pre_write_gate.sh`
- `PostToolUse`：matcher=Write|Edit → `post_write_checks.sh`
- `Stop`：→ `stop_evolution_update.sh`
- `PreCompact`：matcher=auto|manual → `precompact_checkpoint.sh`

### 8.2 pre_write_gate.sh（写入门禁脚本）

输入：Claude Code 会提供项目目录环境变量（脚本在项目根目录执行）。

逻辑（MVP）：
1) 读取 `docs/PROFILE.json`
2) 检查本次写入目标路径是否属于 risk_paths（简化实现：通过环境变量或从标准输入获取工具参数；如果拿不到路径，则门禁只对“存在 PLAN/AUDIT 文件”做检查）
3) 若属于风险路径且 gate.require_plan_for_risk_paths=true：要求存在 `docs/PLAN.md`
4) 若 gate.require_audit_before_write=true：要求 `docs/AUDIT.md` 包含 `RESULT: PASS`
5) 不满足：echo 明确提示，并 `exit 2` 阻断

验收：
- 无 PLAN/AUDIT 时修改高风险目录会被阻断。

### 8.3 post_write_checks.sh（写入后自动检查）

逻辑（MVP）：
1) 读取 PROFILE.tests.on_change
2) 跑最小检查（按项目脚本替换）：
   - `npm test` / `pnpm test` / `pytest -q` 等
3) 成功：写入 `docs/AUDIT.md` 或 `docs/CHECKPOINT.md` 追加一条“checks ok”
4) 失败：
   - 记录 pain flag：写一个文件 `docs/.pain_flag`（内容：原因与命令）
   - 退出码非 0

验收：
- 写入后自动跑命令；失败会写 pain flag。

### 8.4 stop_evolution_update.sh（Stop：落盘与画像更新）

逻辑（MVP）：
1) 若不存在 `docs/.pain_flag`：仅做轻量 checkpoint（可选）并退出 0
2) 若存在 pain flag：
   - 追加 ISSUE_LOG 一条（可先写模板块，内容可由 Claude 在对话中补全；脚本至少写入时间、pain摘要、占位字段）
   - 更新 USER_PROFILE / AGENT_SCORECARD（MVP 可先只更新 counters；分数更新可留到 V1）
   - 删除 `docs/.pain_flag`

验收：
- 触发 pain 时 ISSUE_LOG 必有新增条目。

### 8.5 precompact_checkpoint.sh（PreCompact：压缩前检查点）

逻辑（MVP）：
- 将当前 `PROFILE/USER_PROFILE/AGENT_SCORECARD` 的摘要（文件头或关键字段）写入 `docs/CHECKPOINT.md`。

验收：
- 手动 `/compact` 或自动 compact 前后，CHECKPOINT 有更新。

---

## 9. 阶段拆分与验收标准（按周/按任务交付）

### Phase 0：项目骨架（0.5 天）

交付：创建目录结构 + 6 个 docs 文件初始化。

验收：
- git 中存在所有文件；`PROFILE.json` 可被 jq 解析。

### Phase 1：规则与入口技能（1 天）

交付：
- `00-kernel.md`（80-150 行）
- `10-guardrails.md`
- `/evolve-task` 与 `/triage` 两个 skills

验收：
- 在 Claude Code 中能看到 skill；调用 `/evolve-task` 能输出固定流程说明。

### Phase 2：子智能体定义（1 天）

交付：6 个 agents 文件。

验收：
- `/agents` 可列出并可调用；每个输出遵循契约字段。

### Phase 3：Hooks + 脚本（2 天）

交付：
- `.claude/settings.json`
- 四个脚本可运行（bash）

验收：
- 无 PLAN/AUDIT 改风险目录会被阻断
- 写入后自动跑测试，失败写 pain flag
- Stop 时触发 ISSUE_LOG 追加

### Phase 4：画像与加权（V1，2-3 天）

交付：
- 在 stop 脚本中实现对 USER/AGENT 分数加减（简单规则）
- 在 `/evolve-task` 中读取画像并输出“是否采纳用户建议”的建议说明（文字即可）

验收：
- 成功/失败会导致画像 score 变化

### Phase 5：原则“晋升”（V1.5，可选）

交付：
- `PRINCIPLES.md` 中新增晋升条目
- 将可执行部分同步到 `10-guardrails.md`（可先人工）

验收：
- 运行时 rules 生效并可解释“来源于哪个原则”。

---

## 10. 测试与演示脚本（交付验收用）

建议准备 2 个演示场景：

1) **痛苦信号演示**：故意引入一个会导致测试失败的小改动。
- 期望：post_write_checks 失败 → pain flag → stop 写 ISSUE_LOG

2) **门禁演示**：尝试直接改 `infra/` 或 `src/server/`。
- 期望：没有 PLAN/AUDIT 被阻断；补齐 PLAN + AUDIT(PASS) 后放行。

---

## 11. 风险与注意事项（给初级开发）

- hooks 触发频繁，脚本要快；避免跑全量测试。
- 先用最简单的“标记文件”方案（PLAN.md/AUDIT.md），不要一开始做复杂解析。
- 分数更新可先粗糙，重要的是“闭环能跑”。
- 遇到 Claude 工具参数不好拿（路径拿不到）时，先退化为“只检查标记文件是否存在”。

---

## 12. 交付清单（最终应提交的文件）

- `.claude/rules/00-kernel.md`
- `.claude/rules/10-guardrails.md`
- `.claude/skills/*.md`（至少 evolve-task、triage、root-cause、deductive-audit、plan-script、reflection-log）
- `.claude/agents/*.md`（6 个）
- `.claude/settings.json`
- `.claude/hooks/*.sh`（4 个）
- `docs/*.md/json`（ISSUE_LOG、PRINCIPLES、PROFILE、USER_PROFILE、AGENT_SCORECARD、DECISIONS、PLAN、AUDIT、CHECKPOINT）

---

## 13. 附录：ISSUE_LOG 初始模板（直接放进 docs/ISSUE_LOG.md）

```markdown
# ISSUE LOG

## [YYYY-MM-DD] <Title>

### Context
- Task:
- Environment:
- Evidence (files/logs/commands):

### Pain Signal
- What happened:

### Diagnosis
- Proximal cause (verb):
- Root cause (adjective/design/assumption):
- 5 Whys:
  1.
  2.
  3.
  4.
  5.
- Category: People / Design / Assumption

### Fix & Verification
- Fix summary:
- Verification (tests/metrics):

### Principle Candidate
- Principle:
- Trigger:
- Exceptions:

### Guardrail Proposal
- rule / hook / test / script:
- Minimal regression:
```

---

## 14. 附录：AUDIT.md 与 PLAN.md 标记格式（门禁脚本依赖）

### docs/PLAN.md

```markdown
# PLAN

STATUS: DRAFT | READY
UPDATED: <ISO timestamp>

## Target Files
- <file_path>

## Steps
1.
2.

## Metrics
-

## Rollback
-
```

### docs/AUDIT.md

```markdown
# AUDIT

RESULT: PASS | FAIL
UPDATED: <ISO timestamp>

## Axiom Test
-

## System Test
-

## Via Negativa
-

## Must Fix
-
```

