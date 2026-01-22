# Claude Code 可进化编程智能体：详细设计文档

> 目标：将你笔记中的“达利欧五步进化循环 + 根因分析 + 演绎审计 + 痛苦信号 + Issue Log”工程化落地到 Claude Code。
>
> 核心原则：**轻主会话、重模块化、强门禁、可审计、可回滚、可通用适配**。

---

## 1. 设计目标与约束

### 1.1 设计目标

1) **稳定进化**：每次任务中获得的“痛苦信号”都能沉淀为可执行的护栏（rules/hooks/tests），形成持续改进闭环。

2) **降低LLM负担**：避免把整套思维模型塞进 CLAUDE.md 导致每轮都运行重推理。

3) **通用场景适配**：面向全栈/通用工程任务（调试、重构、功能开发、性能、安全、架构），并允许系统在使用过程中逐步找到“更合适的运行状态”。

4) **可审计与可回滚**：原则、配置、门禁升级都可追踪；出现退化时能快速定位并回滚。

### 1.2 关键约束

- Claude Code 的推理成本主要来自：长上下文、重复系统指令、多次调用模型。
- 需要将“必须做”的步骤下沉到 **Hooks**（脚本优先），将“复杂推理”分发到 **Agents/Skills**。
- 任何自适应必须在**受控参数**范围内发生（调参，而非改内核）。

---

## 2. 总体架构概览

### 2.1 三层结构：内核 / 外壳 / 门禁

**A. 不变量内核（Rules）**
- 固化你笔记的核心机制：五步循环、根因分析、演绎审计、谦逊、痛苦信号、日志沉淀等。
- 体量必须极小（建议几十行），保证每轮都能加载且不稀释。

**B. 可变外壳（Skills + Agents + Path Rules）**
- 将复杂流程模块化为“岗位”和“模板”。
- 可按项目/目录/任务类型加载，减少全局干扰。

**C. 强制门禁（Hooks + Tests + Scripts）**
- 把“必须执行”的关键步骤做成事件驱动的自动化。
- **脚本优先**，LLM 仅在需要判断时用 prompt hook。

### 2.2 进化闭环：Pain → Root Cause → Principle → Guardrail

每次遇到负反馈（痛苦信号）必须经过：

1) **记录**（Issue Log）
2) **提炼**（原则候选）
3) **门禁化**（rules/hooks/tests）
4) **回归验证**（最小回归测试）

---

## 3. 进化系统的状态与持久化

### 3.1 三件套：ISSUE_LOG / PRINCIPLES / PROFILE

1) `docs/ISSUE_LOG.md`（事件级）
- 每次痛苦信号必写，作为“问题数据库”。

2) `docs/PRINCIPLES.md`（原则级）
- 从 Issue Log “晋升”的稳定原则（短、硬、可执行）。

3) `docs/PROFILE.json`（运行状态参数）
- 系统适配与演化主要通过“调参”实现。
- 只存**可执行参数**，不存哲学叙述。

### 3.2 PROFILE.json 示例（建议字段）

```json
{
  "mode": "default",
  "audit_level": "medium",
  "risk_paths": ["src/server/", "infra/", "db/"],
  "tests": {
    "on_change": "smoke",
    "on_risk_change": "unit",
    "on_release": "full"
  },
  "permissions": {
    "require_plan_for_risk_paths": true,
    "require_audit_before_write": true
  },
  "output": {
    "verbosity": "balanced",
    "show_evidence": true
  }
}
```

> 关键：适配发生在 audit_level、risk_paths、tests、permissions 这类“可执行开关/阈值”上。

---

## 4. 进化稳定性的三道门

### 4.1 记录门（Stop Hook 强制）

触发条件（任一）：
- 测试失败 / 运行报错 / lint失败
- 用户指出错误或不满意
- 性能/安全指标不达标

必须落盘：
- 复现步骤 + 证据
- 直接原因（动词）
- 根本原因（形容词/设计缺陷/错误假设）
- 5 Whys
- 人/设计归类
- 原则候选
- 需要的护栏（hook/rule/test）

### 4.2 晋升门（从经验到原则）

不是每条都进 PRINCIPLES，避免膨胀与冲突。

晋升条件（满足任一）：
- 同类问题复现 ≥2 次
- 影响高风险目录/生产安全
- 属于硬约束（Via Negativa）
- 可脚本化/门禁化

晋升动作：
- 写入 PRINCIPLES（短、可执行、带触发条件）
- 更新 PROFILE（阈值/门禁/测试策略）

### 4.3 回归门（防退化）

原则/门禁升级后必须：
- 跑最小回归（smoke）
- 或跑守护用例集（逐步积累）

---

## 5. Claude Code 组件映射

### 5.1 推荐目录结构

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
  settings.json
  hooks/
    pre_write_gate.sh
    post_write_checks.sh
    stop_issue_log.sh

docs/
  ISSUE_LOG.md
  PRINCIPLES.md
  PROFILE.json
  DECISIONS.md
```

### 5.2 Rules（内核与路径规则）

**00-kernel.md（必须短）**
- 规定五步顺序
- 规定“痛苦信号”触发停顿-诊断
- 规定演绎审计插入点
- 规定谦逊（不确定就要信息/查文档）
- 规定必须写 Issue Log
- 规定 Above/Below line
- 规定禁止羞辱性表达

**paths/*.md（按目录加载）**
- 前端：组件规范、状态管理、性能预算
- 后端：API契约、错误处理、数据库迁移
- infra：发布与回滚、密钥与权限、SLO

> 原则：工程细节都放路径规则里，内核只放“轨道”。

---

## 6. 岗位化智能体（Agents）设计

### 6.1 六岗位职责与输出契约

1) **Explorer（探索员）**
- 目标：收集证据、定位代码位置、给出复现路径。
- 工具：Read/Grep/Glob/Bash(可选)
- 模型：快（haiku/sonnet）
- 输出契约：
  - Evidence（文件/函数/行号）
  - Repro steps（可复现）
  - Hypotheses（不超过3条）

2) **Diagnostician（诊断员）**
- 目标：从证据推导根因。
- 输出契约：
  - Proximal cause（动词）
  - Root cause（形容词/设计/假设）
  - 5 Whys（链条）
  - 分类：人/设计/假设错误

3) **Auditor（演绎审计员）**
- 目标：方案进入计划前的门禁审计。
- 三审：
  - 公理测试（语言/库/API契约）
  - 系统测试（反馈回路、延迟、技术债）
  - 否定测试（最坏输入不崩溃）
- 输出契约：Pass/Fail + Must-fix 列表

4) **Planner（编剧型规划员）**
- 目标：把修复写成“电影剧本”。
- 输出契约：
  - Step-by-step plan（含文件/命令）
  - Metrics（验证指标）
  - Risk & rollback（风险与回滚）

5) **Implementer（执行员）**
- 目标：严格按计划改代码、补测试、跑命令。
- 规则：不改变需求，不跳过审计。
- 输出契约：
  - 变更摘要
  - 运行结果（命令与输出）

6) **Reviewer（审查员）**
- 目标：git diff 审查 + 测试/安全建议。
- 输出：Critical / Warning / Suggestion
- 决策：是否需要回到 Diagnostician（若出现新问题）

### 6.2 智能体协作流程（一次任务）

1) Triage（skill）
2) Explorer
3) Diagnostician
4) Auditor（门禁）
5) Planner
6) Implementer
7) Reviewer
8) Stop Hook：写 Issue Log + 提议晋升原则

---

## 7. Skills（流程模板）设计

Skills 的作用：固定输出结构，降低主会话提示负担。

推荐最小集合：
- `/triage`：收集复现、环境、日志
- `/root-cause`：动词/形容词 + 5 Whys + 人/设计
- `/deductive-audit`：三审清单输出
- `/plan-script`：电影剧本计划 + metrics + rollback
- `/execute-checklist`：执行注意事项（测试、格式、边界）
- `/reflection-log`：写 Issue Log + 原则候选 + 护栏建议

---

## 8. Hooks（门禁自动化）设计

### 8.1 Hook 策略：脚本优先，LLM 判断最少化

- **PreToolUse**：写入高风险路径前门禁
  - 检查是否已有 Plan 与 Audit 结论（可通过文件存在或标记）
  - 不满足则阻断写入

- **PostToolUse**：写入后自动检查
  - formatter / lint / smoke tests
  - 自动调用 Reviewer

- **Stop**：任务结束时落 Issue Log

### 8.2 settings.json（示意）

> 这里是结构示意，具体命令根据项目脚本调整。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {"type": "command", "command": "./.claude/hooks/pre_write_gate.sh"}
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {"type": "command", "command": "./.claude/hooks/post_write_checks.sh"}
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {"type": "command", "command": "./.claude/hooks/stop_issue_log.sh"}
        ]
      }
    ]
  }
}
```

---

## 9. 通用适配：让系统“演化到合适状态”

### 9.1 适配不靠改内核，而靠“调参+启停模块”

允许演化的维度：
- `PROFILE.audit_level`：low/medium/high
- `risk_paths`：哪些目录写入需要 plan/audit
- `tests.on_change`：smoke/unit/full
- 工具权限：是否必须 ask
- 输出风格：简洁/平衡/详细

禁止演化的维度（内核）：
- 五步顺序、根因方法、演绎审计、痛苦信号、Issue Log

### 9.2 自适应触发（示例）

- 如果连续3次出现“未审计导致返工” → 提升 audit_level
- 如果频繁被用户要求更细节 → 调高 verbosity
- 如果频繁出现测试失败 → 提升 tests.on_change

这些触发应写入 Issue Log 并通过晋升门更新 PROFILE。

---

## 10. 冲突与过期机制（防过拟合）

### 10.1 原则冲突处理

- Reviewer 标注冲突
- Auditor 做“回归公理”裁决
- 结论写入 `docs/DECISIONS.md`（包含理由与适用范围）

### 10.2 原则过期与清理

- PRINCIPLES 每条应带：触发条件/适用范围/例外
- 定期清理：长期未触发原则降级回 Issue Log

---

## 11. 安全与体验（去情绪化但保留护栏）

- 表达规则：透明、非羞辱性
- 禁止“公开处刑”风格
- 对不确定事项必须表明不确定并请求信息/查文档

---

## 12. 里程碑与落地路径

### 12.1 MVP（1周内可跑通）
- 内核 rules（00-kernel.md）
- 6 agents 最小定义（只要求输出契约）
- 3 hooks：pre write gate / post write checks / stop issue log
- ISSUE_LOG/PRINCIPLES/PROFILE 三件套落盘

### 12.2 V1（稳定进化）
- 晋升门与回归门
- 风险路径门禁按 PROFILE 生效
- 增加守护用例集

### 12.3 V2（插件化与复用）
- 将 rules/skills/agents/hooks 打包为插件
- 多项目共享与版本管理

---

## 13. 附录：Issue Log 模板

```markdown
## [YYYY-MM-DD] <短标题>

### Context
- 任务：
- 环境：
- 证据（文件/日志/命令输出）：

### Pain Signal
- 用户反馈/错误日志：

### Diagnosis
- 直接原因（动词）：
- 根本原因（形容词/设计缺陷/错误假设）：
- 5 Whys：
  1.
  2.
  3.
  4.
  5.
- 归类：人 / 设计 / 假设

### Fix
- 采取的修复：
- 验证方式与结果：

### New Principle (Candidate)
- 原则：
- 触发条件：
- 例外：

### Guardrail Proposal
- 需要新增：rule / hook / test / script
- 最小回归：
```

---

## 14. 附录：Principles 模板（短而硬）

```markdown
### P-XX：<原则一句话>
- 触发条件：
- 约束（必须/禁止）：
- 验证（怎么确认做到了）：
- 例外：
- 来源：Issue Log 链接/日期
```

---

## 15. 下一步（我可以继续帮你写的内容）

如果你认可本设计，我可以直接补齐：
1) `00-kernel.md` 的具体文本（控制在 50-120 行）
2) 6 个 agents 的最小可用定义文件（Claude Code 格式）
3) 6 个 skills 的模板内容（每个几十行）
4) hooks 脚本框架（用 PROFILE.json 驱动门禁强度）

你只需给我一个偏好：默认门禁严格度 `low/medium/high`（不影响后续自适应）。

