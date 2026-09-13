# Agent Delivery Operating Model — PD 长任务 Agent 执行规范

> **状态**: Draft（Agent 起草的规范提案；Owner 认可后作为团队约定生效，见 §10）
> **日期**: 2026-09-13（ISSUE #23）
> **作者**: AI（CNB NPC `npc/CodeBuddy(deepseek-v4.1-flash)`）
> **基线**: `main` @ `75589f15`（工作区 HEAD = `origin/main`）
> **性质**: 纯规范文档。不修改任何代码、配置、Secret 或权限。
> **读者**: 在 PD 仓库中执行任务的任何 AI Agent（CNB NPC / 本地会话 / 未来接入的 Agent）与 Owner。

---

## 0. 这份文档解决什么

本文档把近期若干次真实治理任务中**已经验证有效的执行纪律**固化为一条可复用的
长任务执行规范，使未来 Agent 能在**低 Owner 介入**下完成复杂任务。

Owner 只应在三类节点被打断：

1. **架构决策**（canonical source / trust boundary / 第二事实源）；
2. **产品方向**（是否属于 PD 产品边界、MVP 取舍）；
3. **风险接受**（凭据、权限、外部集成、不可逆操作）。

其余调查、分析、文档、PR、修测试等**低价值交互**应由 Agent 自主完成。

### 0.1 本文档不解决什么（避免第二事实源）

本文档**不重新定义**以下已经存在的单一事实源（SSoT）：

| 主题 | 唯一权威 | 本文档的位置 |
|---|---|---|
| 工程宪法（P1–P8、§14–§30、稳定 ID） | `AGENTS.md` | 引用，不复制 |
| 产品边界 | `docs/product/PRODUCT_IDENTITY.md` | 引用 |
| CNB Auditor / Developer 角色硬约束 | `.cnb/agents/pd-auditor.md` / `.cnb/agents/pd-developer.md` | 引用，不复制 |
| CNB 接入与桥的运行细节 | `docs/runbooks/CNB_CLOUD_WORKER.md` | 引用 |
| 凭据信任边界与残余风险 | `docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md` | 引用 |
| 多 Agent Git 治理（worktree / lease） | `AGENTS.md` §23A | 引用 |
| 错误经验检索 | `docs/process/error-management/ERROR_PATTERN_INDEX.md` | 引用 |

> 阅读顺序建议：先 `AGENTS.md`（宪法），再本文档（长任务执行编排），
> 最后按具体任务读相应章程 / runbook。

---

## 1. Agent Mission Lifecycle

一条 Agent 任务的生命周期由七个阶段构成。**每个阶段都有明确的允许、禁止与停止条件。**

```
Owner Intent
   ↓
Reality Check          ← 问题是否真实存在？（§2）
   ↓
Planning               ← 最小合理方案（§3）
   ↓
Implementation         ← 受限写入（§4）
   ↓
Verification           ← 以真实边界为证据（§P5）
   ↓
Delivery               ← PR / 桥（§6）
   ↓
Evidence Persistence   ← 产物必须落库（§6）
```

### 1.1 各阶段契约

| 阶段 | Agent 可以做什么 | Agent 不可以做什么 | 何时停止 |
|---|---|---|---|
| **Owner Intent** | 复述任务目标、列出歧义点、判断合法性 | 凭 Issue 措辞直接假设现状；自行扩大范围 | 任务含糊 / 自相矛盾 / 超出授权边界 → 停止请求澄清（Developer 章程 D8/D9） |
| **Reality Check** | 只读调查代码、配置、文档、测试、历史报告 | 修改任何文件；把 SPEC/Issue 描述当作 implementation truth | 目标**已完成** → 停止并报告（§2 Completion Check） |
| **Planning** | 写计划、回答四问（§3）、预判 Complexity Delta | 设计新子系统；为假设的未来做抽象（`antipattern-future-extensibility`） | 需要架构选择 / 第二事实源 → 停止，列选项交 Owner（§5） |
| **Implementation** | 在授权路径内做最小连贯改动 + 测试 + 文档 | 越界写 `packages/**`、`.github/**`、Secret、权限；制造第二状态源 | 触碰 §5 任一停止条件 → 停手 |
| **Verification** | 跑真实边界测试、`error:context`、目标检查脚本 | 删/禁用/弱化测试以求绿；声称跑过但未跑 | 门禁红且无法在本任务内合法修复（pre-existing 除外，须附证据）→ 停止 |
| **Delivery** | 建分支、提交、开 PR、写证据 | 直推 `main`、自行合并、force push、改动凭据 | 需要新凭据/权限 → 停止（§5） |
| **Evidence Persistence** | 把报告 / 决策 / 验证结果提交进仓库或依既定 runbook 发布 | 只留 Agent 回复、流水线日志、临时文件系统（§6） | 产物无法持久化 → 停止并升级（这是 P1 同族风险） |

### 1.2 阶段纪律的既有依据

上述契约不是新发明，而是把已有经验收敛为一条通用生命周期：

- **PRI-782** 实证了"产物只存在于临时容器"导致**历史结论不可恢复**（Artifact Lifecycle 缺陷）；
  §6 的持久化契约就是把该教训前置到每一个任务。
- **PRI-766** 实证了"Agent 输出必须可验证"（Evidence Quality Gate、完整性自检抓住了计数错误）；
  §4 的实施纪律要求 Agent 自证而非自述。
- **PRI-767/768** 建立了角色硬约束（Auditor H1–H7 / Developer D1–D9）与"停止请求澄清"；
  §5 把它泛化为所有 Agent 的停止条件。
- **PRI-778** 确立了 canonical 方向（GitHub 权威、CNB 执行）；
  §4.3 的 canonical boundary 引用它。
- **PRI-630** 是 Completion Check 的既有先例：Reality Check 证明任务已完成即停止。

---

## 2. Reality Check Protocol

**任何实施前必须先做 Reality Check。** 这是 `AGENTS.md` P1 / P2 / P2.1 在长任务上的落地。

### 2.1 Requirement Reality — 问题是否真实存在

- 从**当前仓库现实**出发：生产代码、schema、配置、生产 wiring、消费方、测试、运行证据。
- **禁止**仅凭 Issue 描述、SPEC 假设、历史 PR 或记忆假设问题存在（§P1 原文）。
- 判定优先级：`AGENTS.md` §3.1 Intent Truth（应该怎样）vs §3.2 Implementation Truth（实际怎样）。
  两者冲突时**不要默默选一边**，把它作为 drift 记录进交付（§3.3）。

### 2.2 Existing Mechanism Check — 是否已有机制

实施前必须检查：

- **已有代码**：`rg "SymbolName"` / `rg "new SomeService"` / `rg "interface SomePort"`；
- **已有关联文档**：`docs/architecture/`、`docs/adr/`、`docs/audit/`、`docs/runbooks/`；
- **已有配置**：`.cnb.yml`、`.cnb/`、`.github/workflows/`、各包 manifest；
- **已有抽象**：哪个 owner 已经承担该职责？（§P2 question 5/6）

**禁止**的形状：

- 重复实现（同一职责出现第二套实现）；
- 创建第二系统 / 第二事实源（§P4）；
- 误判"缺失能力"，实为"已有能力未接通"（§P2.1 Connection Before Creation）。

### 2.3 Completion Check — 是否已经完成

**如果目标已经完成，必须停止并报告，不得为了"有产出"而制造改动。**

判定依据（全部来自当前仓库现实，而非记忆）：

1. 目标能力是否已在生产路径存在并被消费？（§P2 question 3）
2. 是否有保护它的测试 / 契约？（§P2 question 4）
3. 是否只是**文档未更新**，而非功能缺失？（→ 交付收窄为文档修正或直接报告 drift）

**既有先例**：PRI-630 的 Reality Check 证明了任务已完成，执行随之终止——这正是本文档
要求的行为，不是失败。

### 2.4 与 Owner 的既有工作流衔接（§21）

- 开工前：用 `linear-cli` 的 `context <ID>` 读工单与最新评论；
- 进入实施：`start <ID>`（对 blocker fail-closed）；
- 若发现工单描述与仓库现实冲突：按 §2.1 记录 drift，**不盲从 SPEC 假设**（§21 原文）。

---

## 3. Planning Protocol

计划阶段必须显式回答以下四问（Project 自有的 `mvp-q-*` 稳定 ID 在 §4 已定义，此处是编排层面的最小集）。

### 3.1 Problem — 真正的问题是什么

- 用**自己的话**复述问题，暴露理解偏差（Developer 章程 §4 `Problem` 节即此意）。
- 明确"当前系统实际发生什么"（Before）与"期望发生什么"（After）。
- 如果复述不出与 Issue 措辞不同的一句话，说明 Reality Check 不足。

### 3.2 Existing Mechanism — 是否已有可复用机制

- 本轮任务的变更应**优先扩展既有 authority / module / subsystem**；
- 若要新增：先回答"现有 owner 为何无法满足"（§13 要求逐项解释）。

### 3.3 Complexity Delta — 是否新增复杂度

按 `AGENTS.md` §13 逐项判定并解释：

```
New durable source of truth:        YES / NO
New persisted schema/state:         YES / NO
New subsystem/service/background:   YES / NO
New public abstraction/interface:   YES / NO
New runtime feature flag:           YES / NO
New cross-package dependency:       YES / NO
New host/platform-specific behavior:YES / NO
New external/network capability:    YES / NO
```

多个无法解释的 `YES` 是架构警告。**权限 / 数据流的新增同样属于 Complexity Delta**，
必须在计划中显式说明。

### 3.4 Scope — 允许修改什么、禁止修改什么

每个任务书必须给出两张清单：

- **允许修改**：逐路径列出（例：`docs/**`）；
- **禁止修改**：逐路径列出（例：`packages/**`、`.github/**`、`.cnb.yml`）。

范围外的相邻改进 → 写进交付的 "未做的事 / 建议" 区（§P3、Developer 章程 D8），
**不顺手实施**（`antipattern-review-missing`）。

---

## 4. Implementation Rules

### 4.1 允许

- 在授权路径内创建必要代码 / 测试 / 文档；
- 跑既有检查脚本（`scripts/check-*.js|cjs`，零依赖）与目标测试；
- 建分支、提交、开 PR（见 §6）。

### 4.2 禁止 — Architecture Expansion

- **未授权新增系统 / 子系统 / 后台进程**（§P7、`antipattern-prep-next-phase`）；
- **第二状态源 / 第二事实源**（§P4）：缓存、投影、只读模型只能是派生的，
  不得悄然成为写权威；
- **投机 seam**：零实现或仅一实现的 factory / registry / provider（§P7）；
- **无端复活退役架构**（§8.3）：历史文档描述过的 Nocturnal / 旧调度 / 旧状态机制
  不因文档仍在而被重建。

### 4.3 禁止 — Secret Boundary

- **禁止输出 Secret**：不打印、不写评论、不写 PR、不进日志与命令行；
- **禁止创建 Secret**：Agent 不得生成新凭据；
- **禁止修改权限**：不改 Token scope、不改仓库权限、不改外部集成授权。

**除非 Owner 明确批准**，以上三条不可由 Agent 自行放宽。

现状事实（引用，不重述）：交付桥容器同时持有 `CNB_TOKEN` 与 `GITHUB_SYNC_TOKEN`
属**已接受的残余风险**（P0-01 / RA-1~RA-5），
详见 `docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md` 与
`docs/runbooks/CNB_CLOUD_WORKER.md` §4.4.2 / §5.1。新增任何凭据引用都必须走最小授权
（`allow_*`）并在 `docs/runbooks/CREDENTIAL_INVENTORY.md` 登记。

### 4.4 禁止 — Canonical Boundary

**当前架构事实（不得由 Agent 改变）：**

```
GitHub = canonical source（唯一事实源、PR 合并权、分支保护）
CNB    = AI execution environment（执行环境、镜像、PR 提案）
```

- 方向约束：桥只做 **CNB → GitHub**（推分支 + 开 PR），**永不直推 GitHub main**；
  GitHub → CNB 是独立的单向镜像机制。
- 依据：`docs/audit/PRI-778-cnb-github-bridge-reality-report.md` §1（GitHub main 有平台级
  保护：`Verify Merge Gate` strict + `enforce_admins` + 禁 force/删除）。
- **改变 canonical 方向属架构决策 → 停止并请求 Owner（§5）。**

### 4.5 实施纪律

1. **最小连贯改动**（§P3）：解决既定问题的最小变更面；
2. **多 Agent 并发**：遵循 §23A —— 每任务一个 worktree（`git-1`）、一 worktree 一写者
   （`git-2`）、主 checkout 只读（`git-3`）、写前取 lease（`git-9`）、
   不 `reset --hard`/`clean -fdx`（`git-4`）、force-with-lease（`git-6`）；
3. **自验如实**：没跑的检查不许声称跑过（Developer 章程 §3.4）；
4. **失败要 loud 且可行动**：结构化 reason + nextAction，禁止静默降级（`rc-9`、ERR-002）。

---

## 5. Stop Conditions

以下是**必须停止并等待 Owner** 的情况。停止不是失败——它是 §P2.1 / PRI-767
"Agent 不是无限执行器"的直接体现。

### 5.1 Architecture Decision Required

触发例：

- 需要改变 **canonical source**（GitHub ↔ CNB 关系）；
- 需要改变 **Trust Boundary**（凭据的信任区划分、存储面）；
- 需要引入**第二事实源**或新的架构边界 / 契约 / 接口；
- 发现当前实现与已批准架构冲突，需要选择"改代码"还是"改设计"。

动作：**停止**，在交付里列出选项、利弊与自己的倾向，交 Owner 裁决（Developer 章程 D9）。

### 5.2 Evidence Missing

触发例：

- 审计报告 / 结论的**来源已丢失**，无法验证历史结论（PRI-782 的原始 Phase 0 报告
  只存在于已销毁容器，即此类）；
- 关键事实无法用当前仓库证据核实；
- 需要引用的私有文档不可访问（如 Auditor 零密钥姿态下 `$PD_PRIVATE_DOCS_DIR` 不可读）。

动作：**停止**，显式声明 `UNKNOWN` / 不可用范围，**不猜测、不编造**（Auditor 章程 D5 局限声明
即此纪律）。若必须基于不可验证结论继续，需 Owner 明确接受该风险。

### 5.3 Secret / Permission Change

触发例：

- 需要扩大 Token scope；
- 需要修改仓库权限 / 分支保护；
- 需要新增外部集成授权；
- 需要新增任何密钥引用面。

动作：**停止**。Agent 不得自行创建、修改或输出凭据（§4.3）。

### 5.4 Scope Expansion

触发例：原任务**没有授权**，但实施中发现需要修改：

- `packages/**`；
- `.github/**`；
- `.cnb.yml` / `.cnb/**`（CI 配置）；
- `AGENTS.md` / `docs/adr/**` / `docs/product/**`。

动作：**停止**，把发现写成 follow-up 建议；若要纳入本任务，先请 Owner 显式扩大授权
（§P3、`antipattern-review-missing`）。

### 5.5 其他停止信号

- 需要 **merge PR / 发布 / 打 tag / 改版本号**（Owner 独占，Developer 章程 D4/D5）；
- 需要 **force push**（`git-6` 只允许 `--force-with-lease`，且不得绕过评审）；
- 任务**含糊或自相矛盾**（停止请求澄清）；
- 门禁红且修复方式会**弱化契约**（不得为了让测试变绿而降低 observable expectation，§15）。

### 5.6 停止时的交付要求

停止报告必须包含：

1. 已核实的事实与证据（`文件:行号` 或可复现命令 + 输出）；
2. 触发了哪一条停止条件；
3. 需要 Owner 决策的具体问题 + 可选项；
4. 自己的倾向与理由（不代替 Owner 决策）；
5. 已完成的、可保留的中间产物（若有）。

---

## 6. Artifact Persistence Contract

### 6.1 契约

**所有 Agent 重要产物必须走完：**

```
Created
   ↓
Committed
   ↓
Reviewed
   ↓
Merged
```

产物类型包括：

- Audit Report（审计报告）；
- Architecture Decision（架构决策）；
- Investigation Report（调查报告 / Reality Audit）；
- Validation Result（验证结果 / 证据）。

### 6.2 禁止的持久化位置

产物**不得只存在于**：

- Agent 回复（评论 / 对话）；
- Pipeline output（构建日志）；
- 临时文件系统（一次性容器 workspace）；
- Agent memory。

**依据**：PRI-782 实证 —— 一次只读调查的报告只存在于已销毁容器，事后
`git log --all`、全 ref `ls-tree`、`git stash list`、`git fsck --unreachable`、
远端分支、`cnb workspace list-workspaces` **全部无命中**，结论不可恢复，
只能按当前代码重新取证（Phase 0.1 Recovery Run）。该 PR 的根因归类即
**Artifact Lifecycle 缺陷**。

### 6.3 落地路径

| 产物 | 持久化位置 | 说明 |
|---|---|---|
| 审计 / 调查报告 | `docs/audit/<ID>-*.md` → PR → merge | 需进 canonical 仓库 |
| 架构决策 / 规范 | `docs/architecture/*.md` 或 `docs/adr/*`（ADR 需 Owner 决策） | ADR 属 Owner 决策面 |
| 验证结果 | PR 描述的 Verification Evidence + 相关测试 | 可复现命令 + 原文输出 |
| 周期性审计结果 | **不进 `main` 产品文档**；走 commit 附件 + Linear 证据评论 | 见 runbook §4.2（避免第二写入口） |

> 周期性审计产物的特殊处理来自 PRI-766 的既有约定，
> 引用 `docs/runbooks/CNB_CLOUD_WORKER.md` §4.2，不在此重述。

### 6.4 判断准则

> 如果这次任务明天被忘记，产物是否仍能被 Owner 找到并核验？
>
> 若答案是否，则持久化未完成 —— 该任务不算交付完成。

---

## 7. Owner Interaction Model

### 7.1 目标

减少 Owner 的**低价值交互**，保留 Owner 的**高价值决策控制**。

> 不是减少 Owner 控制，而是减少低价值交互。

### 7.2 Agent 可自主

- 调查（只读）；
- 分析（判断 + 证据）；
- 创建文档（授权路径内）；
- 创建 PR（不合并）；
- 修复测试（在授权范围内，且不弱化契约）。

### 7.3 Agent 必须请求 Owner

- **架构选择**（canonical / trust boundary / 第二事实源 / 新契约）；
- **风险接受**（凭据、权限、残余风险）；
- **产品方向**（是否属于 PD 边界、MVP 取舍、优先级）。

### 7.4 交互纪律

1. **不要问可以通过仓库回答的问题** —— 先调查，再无解时才问（§P1）；
2. **不要用评论轰炸 Owner** —— 汇总成一个可决策的问题，附证据与选项；
3. **不替 Owner 填 Owner 区** —— PR 模板的 "产品品味审计" 由 Owner 填，
   Agent 不得代填（PR 模板 policy 原文）；
4. **不请假式交付** —— 不要"我做了 X，请您看着办"，要给出明确的 before/after、
   证据与 nextAction；
5. **不做无信息的仪式性评论**（§21 原文）。

---

## 8. Constraints 与自我约束（本类任务）

对于**纯治理 / 规范类任务**（如本文档本身），附加约束：

| 项 | 约束 |
|---|---|
| 允许修改 | `docs/**` |
| 禁止修改 | `packages/**`、`.github/**`、`.cnb.yml`、Secret、权限、运行逻辑 |
| 验证 | `node scripts/check-docs-structure.cjs`、`node scripts/check-repo-hygiene.js all` |
| 交付 | PR diff 只含 docs 文件；PR 描述声明"未修改运行行为、未改变权限模型" |
| 收尾 | 交付后停止，等待 Owner Review，不自行扩展新治理任务 |

---

## 9. 与既有文档的关系（避免重复建设）

本文档是**编排层（orchestration layer）**规范，位于既有文档之上：

```
AGENTS.md（宪法：原则 + 稳定 ID + 校验门）
    ↓  本文档只编排"何时做、谁决策、产物去哪"
任务专属章程（.cnb/agents/*.md） / runbook（docs/runbooks/*） / 审计报告（docs/audit/*）
```

**明确不重复的内容**：宪法原则正文、角色硬约束清单、桥的实现细节、凭据台账、
错误模式清单 —— 这些各自已有 SSoT，本文档只**引用**。

---

## 10. 已知局限（如实声明）

| 局限 | 说明 |
|---|---|
| 本文档是规范，不是平台强制 | §4 的路径边界、§5 的停止条件是**治理级约束**，靠 Agent 遵守 + Owner PR Review 兜底；CNB 凭证级无法限制写路径（Developer 章程 §5 原文）。 |
| 无自动 enforcement | 本文档未新增任何 lint / guard / 脚本。是否机械化部分停止条件，属后续独立工单（见 §11）。 |
| 附录证据为快照 | §1.2 / §6.2 引用的任务结论基于撰写时的仓库证据，若后续 PR 推翻，以新证据为准。 |
| Owner 认可状态 | 本文档由 Agent 起草，属提案；Owner 认可后其 §1–§7 方作为团队约定生效。 |

---

## 11. 本 PR 未做的事（Follow-ups，供 Owner 决策）

1. **机械化部分停止条件**：例如 Scope Expansion（§5.4）可由 CI 对比
   `git diff --name-only` 与任务授权路径自动告警。本 PR 未实施
   （属 `scripts/**` + CI 面，超出 docs-only 授权）。
2. **与线性 / 角色章程的引用打通**：现有章程（`.cnb/agents/*.md`）可增加
   "遵循 `docs/architecture/AGENT_DELIVERY_OPERATING_MODEL.md`"一行指向。
   本 PR 未改 `.cnb/**`（超出授权）。
3. **文档索引登记**：`docs/README.md`、`docs/architecture/README.md` 可将本文档
   加入导航；本 PR 为保持最小改动面未动索引（若 Owner 要求，可随后续 PR 补）。
4. **周期性审计产物存储面的进一步收敛**：见 PRI-782 REC 系列，
   属既有 follow-up 家族，本 PR 不重复单独立项。

---

## 附录 A — 证据索引（本规范各条的来源）

| 规范条目 | 依据 |
|---|---|
| §1 生命周期、§6 产物持久化 | PRI-782 Recovery Run（`docs/audit/PRI-782-integration-credential-reality-report.md`）§0 根因归类 |
| §1.1 停止条件雏形 | PRI-767 / PRI-768 Developer 章程 D8/D9、`.cnb/agents/pd-developer.md` §3 |
| §1 证据质量、自证而非自述 | PRI-766（`docs/audit/PRI-766-weekly-audit-reality-report.md`）§2 缺口分析 |
| §4.4 Canonical Boundary | PRI-778（`docs/audit/PRI-778-cnb-github-bridge-reality-report.md`）§1 |
| §4.3 凭据边界与残余风险 | PRI-782 + `docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md` §4 |
| §2.3 Completion Check | PRI-630 Reality Check 先例（见 `docs/audit/pri-626-r1-consent-rollout-gate.md` 引用） |
| §2.1 / §3 / §4.2 原则 | `AGENTS.md` P1–P8、§13、§22–§25 |
| §4.5 多 Agent Git 纪律 | `AGENTS.md` §23A（`git-1`…`git-9`） |
| §6.3 周期审计产物处理 | `docs/runbooks/CNB_CLOUD_WORKER.md` §4.2 |
