# Agent Delivery Operating Model — PD 长任务执行规范

> **状态**: Draft（待 Owner Review）
> **日期**: 2026-09-13
> **作者**: AI（CNB NPC `npc/CodeBuddy(deepseek-v4.1-flash)`，ISSUE #23）
> **基线**: `main` @ `75589f15`
> **来源**: PRI-767 / PRI-768（云端 Developer 入口）、PRI-778（CNB → GitHub 交付桥）、PRI-782（集成凭据治理）的实践
> **关联**:
> - `AGENTS.md`（工程宪法，本文所有规则的上位来源）
> - `docs/runbooks/CNB_CLOUD_WORKER.md`（云端 Worker 接入与运行手册）
> - `docs/runbooks/CREDENTIAL_INVENTORY.md`（凭据台账）
> - `docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md`（凭据信任边界决策）
> - `docs/audit/PRI-778-cnb-github-bridge-reality-report.md`、`docs/audit/PRI-782-integration-credential-reality-report.md`
> - `.cnb/agents/pd-developer.md`（PD Developer 章程）、`.cnb/agents/pd-auditor.md`（PD Auditor 章程）

---

## 0. 本文是什么 / 不是什么

**是**：PD 长任务（跨多个 session、跨多个执行环境、持续数小时到数天）的**执行规范**。
它回答三个问题：

1. 一个任务从 Owner 意图到 GitHub merge，中间必须发生什么、由谁负责；
2. Agent 在执行中**何时必须停下**（而不是继续猜）；
3. 所有治理产物**写到哪里才算存在**。

**不是**：

- ❌ 不是新的工程宪法。`AGENTS.md` 是上位来源；本文只**落实与串联**它已有的规则（P1–P8、§21–§25、§23A、§29）。
- ❌ 不是新的运行时机制、状态源或门禁。本文不引入任何 `packages/**` 改动、不新增脚本、不新增流水线阶段。
- ❌ 不是工具使用手册。具体命令、平台细节仍以 `docs/runbooks/CNB_CLOUD_WORKER.md` 为准（单一事实源）。
- ❌ 不是 Agent 编排系统。PD 不拥有通用任务编排（`AGENTS.md` §1）。

**稳定性**：本文所有规则 ID（`AL-*` / `SC-*` / `AP-*` / `OI-*`）为仓库稳定 ID，
可被 PR、章程、runbook 与后续工单引用。**不得随意重命名或删除**——
修改需按 `AGENTS.md` 的 Constitution Change Rule 走 Owner 评审。

---

## 1. 适用范围与不适用范围

### 1.1 适用（长任务）

满足任一条件的任务：

- 跨多个 agent session（含被中断后恢复）；
- 跨多个执行环境（本地 worktree / CNB 云容器 / GitHub CI）；
- 预期产物 ≥ 1 份治理文档或 ≥ 1 个 PR；
- 涉及不可逆外部动作（推送分支、开 PR、调用外部 API）。

### 1.2 不适用

- 单次问答、只读查询；
- 单个小改动的即席修复（按 `AGENTS.md` §22 现有 PR 流程即可）；
- PD 产品运行时内部的 Agent 编排行为（那是 ADR-0003/0008/0009 的领域）。

---

## 2. Canonical 模型（先读这一节）

长任务的一切判断都依赖"哪一侧是权威"。本文沿用仓库已固化的模型，**不新建**：

| 面 | 角色 | 依据 |
|---|---|---|
| **GitHub `main`** | **Canonical 事实源**；唯一合并点；Owner 独占 merge 权 | `AGENTS.md` §23；`docs/runbooks/CREDENTIAL_INVENTORY.md` §0.0 |
| **CNB** | **执行环境**（Auditor / Developer / 定时审计 / 交付桥），不是事实源 | 同上；`docs/runbooks/CNB_CLOUD_WORKER.md` §1–§2 |
| **CNB PR / `ai/cnb-dev/*` 分支** | **提案载体**，不是落地。经 T7/T6 桥送到 GitHub 后才有意义 | runbook §4.3–§4.4 |
| **`sync/cnb-delivery/*`** | 桥的传输分支（只推该前缀） | runbook §4.4.2 |
| **本地/云端 worktree** | 一次性工作区，可丢弃；**不是**证据存储 | `AGENTS.md` §23A |

**推论（本文的核心动机）**：任何只存在于临时执行环境（容器文件系统、构建日志、聊天记录、Agent 回复）的产物，
**在任务结束时等于不存在**。PRI-782 就是这个推论的实证：Phase 0 报告只存在于已被销毁的容器里，
工作区文件系统、`git log --all`、全部 ref 的 `ls-tree`、`git stash list`、`git fsck --unreachable`、
远端分支均无命中，只能整份重新取证（见 `docs/audit/PRI-782-integration-credential-reality-report.md` §0）。

---

## 3. 完整生命周期：Owner Intent → GitHub Merge

### 3.1 状态图

```text
  [0] Owner Intent
        │  载体：CNB Issue 评论 / Linear 工单 / GitHub Issue
        │  动作：Owner 表达目标；Agent 只记录，不解释、不扩写
        ▼
  [1] Reality Check                ← 对应 Phase 模型 §4.1
        │  动作：读任务书原文 → 读仓库现实 → 判定合法性（许可范围 / 有无冲突）
        │  产物：若不足则停（SC-*）；若充分 → 调查结论（叙述，不落盘）
        ▼
  [2] Planning                     ← §4.2
        │  动作：定义验收证据（P5）→ 最小变更面（P3）→ 选路（复用 or 新建）
        │  产物：见 §6（本节通常只在 PR 描述里留痕）
        ▼
  [3] In Progress
        │  动作：建立隔离工作区（§5）→ 取得写租约（git-9）
        │  产物：worktree + 分支
        ▼
  [4] Implementation               ← §4.3
        │  动作：最小改动 / 文档写入（按 §9 契约落盘）
        │  产物：commit（+ 必要的中间证据）
        ▼
  [5] Verification                 ← §4.4
        │  动作：跑真实检查（含负向控制，见 §8）
        │  产物：**原文输出**（未跑的不许声称跑过）
        ▼
  [6] Delivery（提案）             ← §4.5
        │  动作：push 分支 → 开 PR（本仓库 / CNB 镜像）→ 交付报告
        │  产物：PR（提案状态）
        ▼
  [7] Bridge（CNB 场景）
        │  动作：T7 自动投递 / T6 兜底 → 落地 GitHub PR
        │  注意：桥只送内容，CNB main 的合并提交不进 GitHub 历史（runbook §4.4.3）
        ▼
  [8] Owner Review                 ← §7 OI-*
        │  动作：Owner 在 GitHub 评审。Agent **等待**，不催、不改结论、不自认已审
        ▼
  [9] Merge（Owner 独占）
        │  动作：Owner 合并。**AI 永不执行 merge**（AGENTS.md §23 / 章程 D4）
        ▼
  [10] Reconciliation              ← §7 OI-7
        │  动作：工单状态收口（AGENTS.md §21 rules 9–11）；后续跟进项落盘
        ▼
      完成
```

### 3.2 授权来源

| 决策 | 授权来源 |
|---|---|
| 是否开工 | Owner 的显式任务书 |
| 允许改哪些路径 | 任务书原文（通常是 `D1`/`D2` 的白名单） |
| 验收标准 | 任务书的"输出 / 覆盖 / 限制"三段 |
| 是否可合并 | **Owner 独占** |
| 是否可扩大范围 | 否（`P3`；`antipattern-review-missing`） |
| 是否可新建架构 | 否，除非 Owner 显式要求（`P7`） |

---

## 4. Agent Phase 模型

五个 Phase：**Reality Check → Planning → Implementation → Verification → Delivery**。
每个 Phase 有：入口条件、必做动作、产出、退出条件。
**Phase 不得跳过**；不得用"任务很小"作为跳过 Reality Check 的理由。

### 4.1 Phase 1 — Reality Check（现实核查）

> 上位规则：`P1 Evidence Over Assumption`、`P2 Survey Before Acting`、`P2.1 Architecture Reality Audit`、`AGENTS.md` §3.3。

**必做**：

1. 读任务书**原文**（不是摘要、不是上一轮 Agent 的复述）。
2. 判定 Canonicity：任务要改的东西在哪一侧（GitHub / CNB / 平台后台）。
3. 读仓库现实：目标文件是否存在、当前内容、消费者、测试、既有抽象。
4. 判定合法性：目标路径是否在任务书许可范围内；是否存在与之冲突的既有决策。
5. 标记 UNKNOWN：**无法取证的一律标 UNKNOWN，不猜测**（PRI-782 §5 的做法）。

**禁止**：

- 从记忆、历史 PR、SPEC 假设推断当前实现；
- 把任务书的措辞当作现状描述（SPEC 表达意图，不证明现状）；
- 在未读目标文件前起草内容。

**退出条件**：能回答"当前行为在哪、权威源是谁、最小缺口是什么"三个问题。
否则进入 **Stop Condition**。

### 4.2 Phase 2 — Planning（规划）

**必做**：

1. 定**验收证据**（P5）：什么证据能说服我们改动是对的？先选方法，再动手。
2. 定**最小变更面**（P3）：满足任务书所需的最小文件集合。
3. 跑 **Reality Audit**（`P2.1`）：先找"已有能力 + 断开的连接"，再考虑新建抽象。
4. 做 **Error Context 路由（Pass 1）**：`npm run error:context -- --paths <预期改动文件> --signals <概念>`，
   人工复核 `ERROR_PATTERN_INDEX.md`，把命中项的 Required Evidence 变成验证计划。
5. 列 **Stop Condition 预判**：本任务预计会撞到哪几条 `SC-*`。

**产出**：一段可复述的计划（落在 PR 描述 / 交付报告中，不单独造文件）。

### 4.3 Phase 3 — Implementation（实现）

**必做**：

1. 隔离工作区：`git-1-worktree-per-task`（本地）或独立云端容器（CNB）；开写前取租约 `git-9-lease-before-write`。
2. 一次只做一个连贯改动（`P3`）；相邻改进**只记录，不顺手做**。
3. 所有写入遵循 **Artifact Persistence Contract（§9）**。
4. 不修改未授权路径；越界 = 最严重违规。

**禁止**：

- 直推 `main`、`--force` 推送（`git-6-force-with-lease-only` 仅在确需重写时用 `--force-with-lease`）；
- 修改他人 worktree / 未知分支 / stash（`git-2`、`git-4`、`git-5`）；
- 用"为了让测试通过"为由弱化契约。

### 4.4 Phase 4 — Verification（验证）

**必做**：

1. 跑与改动面匹配的检查（文档改动至少跑 `node scripts/check-docs-structure.cjs`）。
2. **原文输出**入交付报告；未跑的项如实列出。
3. 关键结论需要**负向控制**：证明"改之前会失败、改之后通过"（EP-09 的要求）。
4. **Error Context 路由（Pass 2，diff 模式）**：`npm run error:context` 对真实 diff 复跑，
   新出现的 HIGH 命中必须处理或显式排除并给理由。
5. 区分**预存在失败**与**本次回归**：任何 "pre-existing" 声明必须在 base 分支上复现（EP-10 / ERR-078）。

**退出条件**：每条验收证据都有可复跑的命令与真实输出。

### 4.5 Phase 5 — Delivery（交付）

**必做**：

1. 建 PR（本仓库或 CNB 镜像），标题一行、无括号、无分支名（平台规范）。
2. PR 描述按 `.github/PULL_REQUEST_TEMPLATE.md` 结构填充，含 Owner Review Card 与 Complexity Delta。
3. 写交付报告：Problem / Investigation / Changes / Validation / PR / 未做的事（Developer 章程 §4）。
4. 更新工单状态（`AGENTS.md` §21 rules 9–11）。
5. **停止并等待 Review**（OI-1）。

**禁止**：

- 轮询 CI 与评审（平台规范：失败会自动唤起 NPC）；
- 合并 / 关闭 PR；
- 把"交付完成"表述为"工作已落地"（**提案 ≠ 落地**）。

---

## 5. Worktree / Session 纪律（长任务的物理前提）

| ID | 规则 | 上位 | 失效后果 |
|---|---|---|---|
| `AL-5` | 每个写入型任务独占一个 worktree/容器；分支不是并发边界 | `git-1` | 两 Agent 互相覆盖工作文件 |
| `AL-6` | 一个 worktree 同一时刻最多一个写入者 | `git-2` | 静默污染 |
| `AL-7` | 主检出（primary worktree）只用于 fetch / 查看 / 建 worktree | `git-3` | 控制面被特性代码污染 |
| `AL-8` | 开写前取写租约，结束释放 | `git-9` | 并发会话覆盖他人未提交工作（PRI-663） |
| `AL-9` | 他人未提交文件 / 未知分支 / 未知 worktree 视为他人工作，不得清理 | `git-4` | 不可恢复的工作丢失 |
| `AL-10` | 需要重写远端分支时 `git fetch` 后 `--force-with-lease` | `git-6` | 覆盖他人提交 |
| `AL-11` | 云端长任务的会话状态不是证据；结论必须在同一 Phase 内落盘 | 本文 §2 | PRI-782 Phase 0 报告不可恢复 |

---

## 6. Stop Conditions

> **总则**：Stop Condition 命中时，Agent **立即停止推进**，按 `SC-1` 的格式输出停点报告，
> 并保持当前已完成的落盘产物不变。**停止不是失败**——PRI-768 第一轮测试中 PD Developer
> 因基线漂移主动停止并给出 A/B/C 选项，被认定为章程防呆机制的**成功**（见
> `docs/audit/PRI-768-developer-entry-reality-report.md` 附录）。

### `SC-1-stop-report-format`

**所有**停点必须使用同一格式，保证 Owner 无需追问即可决策：

```text
STOPPED — <一句话停点>

Evidence missing:   <缺什么证据，为什么取不到（不是"我没查"）>
Architecture:       <涉及的架构决策面，及你为什么无权决定>
Scope:              <任务书哪两处/哪几处冲突，或越界点>
Secret/Permission:  <触及的边界，及为什么不该由你越过>
Already done:       <已落盘产物（分支/commit/PR），以及它们是否可安全丢弃>
Options:            <2–3 个互斥路径，各含代价>
Recommendation:     <你的倾向 + 理由；只建议，不执行>
Blocking question:  <Owner 需要回答的最小问题（越具体越好）>
```

### `SC-2-evidence-missing`

**触发**：

- 关键事实只能靠登录后台 / 持有凭据 / 物理接触才能取得（UNKNOWN）；
- 目标文件的"真相"无法从仓库现状确定（文档互斥、代码与文档冲突且无法判定哪边陈旧）；
- 需要外部系统的当前状态（权限粒度、令牌 scope、平台能力）才能选路。

**动作**：停止。把 UNKNOWN 登记进产物（可引用 `docs/runbooks/CREDENTIAL_INVENTORY.md`
的 UNKNOWN 清单格式：ID / UNKNOWN / 为何无法取证 / 阻断的决策）。

**禁止**：用记忆或合理推测填补（`P1`）；把猜测写成结论再让别人去核对。

**示例（真实）**：PRI-782 UNK-05「CNB 是否支持 stage 级 `imports`」——该 UNKNOWN 直接决定
REC-1 走路径 A 还是路径 B，Agent 无权用假设选路。

### `SC-3-architecture-decision-required`

**触发**：

- 需要新增/改变架构边界、公共契约、状态源、门禁、feature flag；
- 两个可行方案在**架构层面**互斥（不是实现细节之争）；
- 发现 Intent Truth 与 Implementation Truth 冲突（`AGENTS.md` §3.3）；
- 改动会触及 `docs/adr/`、`docs/product/`、`AGENTS.md` 的决策面。

**动作**：停止，列选项与倾向，交 Owner 裁决（Developer 章程 `D9`）。

**禁止**：自行选一条路并把另一条写成"follow-up"来掩盖已做的架构选择。

### `SC-4-scope-conflict`

**触发**：

- 任务书内部矛盾（例：要求输出 X，同时禁止改 X 所在的目录）；
- 任务的基线异常（例：镜像落后、目标分支不含必要文件——PRI-768 第一轮的巨型失真 PR 风险）；
- 实现中发现必须做任务书未列出的改动才能正确完成任务；
- 评审发现了相邻问题（`antipattern-review-missing`）。

**动作**：停止。列出冲突两侧 + 选项 + 推荐。

**禁止**：

- 猜一个读法硬做；
- 顺手扩大 scope；
- 制造"格式合规但语义错误"的产物（比不作为更糟：它会被误当作已完成）。

### `SC-5-secret-permission-boundary`

**触发**：任务要求以下任一动作时：

- 请求 / 读取 / 打印 / 存储任何 Secret、Token、PAT 值；
- 新增跨仓 `imports`、新增密钥仓库引用、变更 `allow_*` 授权声明；
- 修改 GitHub Settings / CNB 组织设置 / Cloudflare Secret / Linear 后台；
- 直推 `main`、合并 PR、发布 / 打 tag / 改版本号；
- 开启 NPC「工作模式」；
- 读写安装运行时目录（`~/.pd/runtime/`、`~/.openclaw/extensions/`、`<workspace>/.pd/`——`AGENTS.md` §1.1 硬规则）。

**动作**：停止。说明触及的边界与为什么必须由 Owner 执行（参照 runbook §1「Owner 前置清单」中
"为什么 Agent 做不了"那一列）。

**禁止**：任何"只是试一下"的越界（读一个 token、临时开个权限、patch 一个已安装文件）。

**另注**：凭据治理的既有结论（`docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md`）已把
"容器同时持有两个事实源写权限"（P0-01）登记为**已接受残余风险**（RA-1~RA-5）。
`SC-5` 不重开该议题，只约束**新增**边界。

---

## 7. Owner Interaction Rules

### 7.1 必须等待 Owner（硬等待）

| ID | 情形 | 依据 |
|---|---|---|
| `OI-1` | 任务书要求"创建 PR 后停止等待 Review"——PR 创建即停，不做后续动作 | 平台 PR 规范 |
| `OI-2` | 任一 `SC-*` 命中 | §6 |
| `OI-3` | 任何合并、打 tag、发布、关 PR、改版本号 | `AGENTS.md` §23；章程 `D4/D5` |
| `OI-4` | 触及 `docs/adr/`、`docs/product/`、`AGENTS.md` 的决策面 | 章程 `D6`；Constitution Change Rule |
| `OI-5` | 新增凭据引用 / 新增密钥仓库 / 新增外部网络能力 | §6 `SC-5`；runbook §8 |
| `OI-6` | 任务的**验收标准**本身需要 Owner 判定（"这样做算不算达成目标"） | 无客观判据时不得自评通过 |
| `OI-7` | 工单状态收口（`In Review`→`Done`/`Canceled`）中，涉及**推翻原诊断**或**判定工作被取代**的动作 | `AGENTS.md` §21 rules 9–11 |

**等待期间的行为禁令**：不轮询、不催促、不替 Owner 预写结论、不把"未合并"表述为"已落地"。

### 7.2 Agent 可自主推进（无需等待）

| ID | 情形 | 边界 |
|---|---|---|
| `OI-8` | 任务书已明确授权的路径内的事实核查与调查 | 只读；结论须带 `文件:行号` |
| `OI-9` | 在任务书许可范围内的最小实现与自验 | 不越白名单、不扩大 scope |
| `OI-10` | 建分支、commit、push 特性分支、开 PR | 仅限本任务；不直推 `main`；不合并 |
| `OI-11` | 按 §6 格式写停点报告 | 含选项与推荐；不执行推荐 |
| `OI-12` | 更新工单状态为 `In Progress` / `In Review`、留证据评论 | 文本用中文；不新建工单除非任务书要求 |
| `OI-13` | 失效/不可行路径的排除，并说明理由 | 必须在产物中留下可核验的排除理由 |
| `OI-14` | 相邻改进的记录（作为 follow-up 候选写入 PR，**不实施**） | `P3`；`antipattern-review-missing` |

### 7.3 判定口诀

> 不确定时按"**能否回滚 + 是否改变他人可见事实 + 是否触碰决策面**"三问：
> 三者全否 → `OI-8`~`OI-13` 自主推进；任一为是 → 停下来问。

---

## 8. Verification Contract（证据契约）

> 与 §9 的分工：§8 管"**什么算证据**"，§9 管"**证据写到哪里才算存在**"。

| ID | 规则 | 上位 |
|---|---|---|
| `AL-12` | 验证方法按任务类型选（可复现 bug→回归测试；不变量→守卫；Owner 可见流程→BDD；文档→对应 `check:*`） | `P5` |
| `AL-13` | 测试要打在生产/公共边界，只测内部 helper 不算证据 | `P5`、EP-02 |
| `AL-14` | 完整性声明（"零消费方""只有这些文件""已全部同步"）必须附**未经截断**的可复跑命令全文输出 | ERR-127 |
| `AL-15` | 关键修复需**负向控制**：证明修复前会失败 | EP-09 |
| `AL-16` | "pre-existing / 环境性失败"必须先在 base 分支复现才可声明 | ERR-078、EP-10 |
| `AL-17` | 未跑的检查不许声称跑过；未验证的部分必须显式列为"本次审查的局限" | 章程 §4 |
| `AL-18` | 长任务跨越多个 session 时，每个 session 结束后留下的**结论**必须已落盘（不然等于没做） | §2、PRI-782 §0 |

---

## 9. Artifact Persistence Contract（产物持久化契约）

> **一句话**：任何治理产物，若未 commit + PR + 在 canonical 侧可被引用，就**不算存在**。

### 9.1 三类产物与接收位置

| 类别 | 例子 | 接收位置 | 长期可引用形式 |
|---|---|---|---|
| **Governance Artifact** | Reality Report、架构文档、决策文档、runbook、台账、规范（本文） | 仓库路径（`docs/**`、`.cnb/**`、`scripts/**` 视许可范围） | **commit + PR + canonical reference** |
| **Evidence** | 检查命令输出、diff、评审回复、UNKNOWN 登记 | PR 描述 / PR 评论 或随文档提交 | PR 内可复跑命令 + 其原文输出 |
| **Ephemeral** | 构建日志、NPC 回复、容器文件、临时报告、聊天记录 | 不接收（允许存在，不可依赖） | **无** |

### 9.2 规则

| ID | 规则 |
|---|---|
| `AP-1` | 所有 Governance Artifact 必须 **commit + push 分支 + 开 PR**；只写在工作区 / 只发在评论里的治理产物**不算产物** |
| `AP-2` | 每条对外结论必须能**回溯**到 canonical 侧的一个引用（PR / 文档路径 + 章节 / 工单），不允许只有"我记得" |
| `AP-3` | 跨环境产物（CNB 容器 → GitHub）必须经交付桥落分支，**不得**依赖容器文件系统续命 |
| `AP-4` | 数据不落点：**不得**把治理产物写进运行时状态（`.pd/`、`.state/`、任何 DB） |
| `AP-5` | 周报 / 周期审计结果**不进 main 的产品文档**；证据进工单或 commit 附件（runbook §4.2） |
| `AP-6` | 序列化边界：产物中出现的运行时值按 `rc-8-safe-serialization` 处理；日志/预览要有界 |
| `AP-7` | 凭据边界：产物中**只允许变量名**，不得出现任何 Secret 值、token 片段、密钥内容（`CREDENTIAL_INVENTORY.md` §0） |
| `AP-8` | PR 被关闭 / 被取代时，产物仍需在仓库或工单留下可追溯痕迹（不得留下悬空结论） |

### 9.3 反模式

| 反模式 | 为什么被禁止 | 真实先例 |
|---|---|---|
| 报告只写在容器里 | 容器销毁 = 产物消失，后续只能重新取证 | PRI-782 Phase 0 → Phase 0.1 Recovery Run |
| 结论只发在聊天/评论 | 不可检索、不可引用、无法复核 | 本文 §2 推论 |
| 把"已验证"写成结论但没有输出 | 是装饰，不是证据 | ERR-127 |
| 把治理产物写进 `main` 的周期性文档 | 制造第二个写入口、污染产品文档 | runbook §4.2 / §8 |
| 把产物写进 `.pd/` 等运行时状态 | 与产品状态源混淆，无法评审 | `AGENTS.md` §1.1 |

---

## 10. Cross-environment 交付（CNB ↔ GitHub）

| ID | 规则 | 依据 |
|---|---|---|
| `AL-19` | 方向单一：CNB → GitHub 只经 T6/T7 桥；GitHub → CNB 只经镜像，**不做双向同步** | runbook §2 方案 B 明确不推荐 |
| `AL-20` | 桥只推 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*`；**永不直推 GitHub `main`** | runbook §4.4.2 |
| `AL-21` | CNB main 的合并提交不进 GitHub 历史；同步用 `--force-with-lease` 重置，前提是所有已合并 CNB PR 均已桥接 | runbook §4.4.3 |
| `AL-22` | CNB 侧合并 ≠ 落地；只有 GitHub merge 才是完成 | §2 |
| `AL-23` | 云端写权限是**治理级**约束（`D1`/`D2`），不是凭证级隔离；越界视同事故 | 章程 §5 |
| `AL-24` | 平台级保护（GitHub `main` 分支保护）削弱任一条件即视为重开 P0-01 | runbook §5.1 接受条件 3 |

---

## 11. 与既有规范的关系（不重复建设）

| 主题 | 单一事实源 | 本文的角色 |
|---|---|---|
| 工程宪法（P1–P8、稳定 ID） | `AGENTS.md` | 引用；**不重述** |
| 多 Agent Git 治理（`git-1`~`git-9`） | `AGENTS.md` §23A | 引用为 `AL-5`~`AL-10` |
| 云端 Worker 接入 / 桥 / 安全边界 | `docs/runbooks/CNB_CLOUD_WORKER.md` | 引用；不复制具体命令 |
| 凭据台账 / UNKNOWN 登记 | `docs/runbooks/CREDENTIAL_INVENTORY.md` | 引用其登记格式 |
| 凭据信任边界决策 | `docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md` | 引用；不重开 P0-01 |
| 错误经验（EP/ERR） | `docs/process/error-management/*` | 引用为 `AL-14`~`AL-16` 的依据 |
| PR 模板 / 交付报告格式 | `.github/PULL_REQUEST_TEMPLATE.md`、`docs/runbooks/CNB_CLOUD_WORKER.md` §4.3 | 引用 |
| 云端角色约束（`D1`–`D9`、`H1`–`H7`） | `.cnb/agents/pd-developer.md`、`.cnb/agents/pd-auditor.md` | 引用 |

**结论**：本文的价值在于**串联与判定**（何时停、产物写哪里），
不在于新增规则。若本文与 `AGENTS.md` 冲突，**以 `AGENTS.md` 为准**。

---

## 12. Conformance Checklist（可执行）

任务交付前逐条自检（把结果写进 PR 或交付报告）：

```text
[ ] Reality Check 先于任何写入（§4.1 / P1）
[ ] 验收证据在动手前已定义（§4.2 / P5）
[ ] 变更面 = 最小；相邻改进只记录未实施（§4.2 / P3）
[ ] 只改任务书许可路径；越界为零（章程 D1/D2）
[ ] 独立 worktree；写租约已取并释放（AL-5 / AL-8）
[ ] 检查已运行，原文输出在报告中（AL-17 / ERR-127）
[ ] 完整性声明附未截断输出（AL-14）
[ ] 关键结论有负向控制（AL-15）
[ ] "pre-existing" 声明已在 base 复现（AL-16）
[ ] Pass 2 error:context 已跑，HIGH 命中已处理或排除并给理由（§4.4）
[ ] 治理产物已 commit + PR + 可引用（AP-1 / AP-2）
[ ] 产物中零 Secret 值，仅变量名（AP-7）
[ ] PR 已建；未合并、未关闭、未轮询（OI-1 / OI-3）
[ ] 停点（若有）使用 SC-1 格式（SC-1）
[ ] 工单状态已按 AGENTS.md §21 收口（OI-12 / OI-7）
```

---

## 13. 参考实现（真实实践索引）

| 事件 | 观察到的规范行为 | 出处 |
|---|---|---|
| PRI-767 / PRI-768 | 任务书四问先行；基线漂移时**主动停止**并给 A/B/C 选项；修复后端到端验证 | `docs/audit/PRI-768-developer-entry-reality-report.md` |
| PRI-778 | 桥的安全设计依据逐条落文档（令牌只存密钥仓库、只推固定前缀、永不直推 main）；双平台令牌风险**显式登记**而非沉默接受 | `docs/audit/PRI-778-cnb-github-bridge-reality-report.md`、runbook §4.4.2 / §5.1 |
| PRI-782 | 只读重新取证；UNKNOWN 显式登记不猜测；产物生命周期缺陷（报告只存在于已销毁容器）被定为根因类别；凭据只以变量名出现 | `docs/audit/PRI-782-integration-credential-reality-report.md` |

---

## 14. 已知边界与非目标

1. 本文**不**为 CNB 云容器增加任何门禁（`.cnb.yml` 头部治理说明：第一阶段不新增门禁）。
2. 本文**不**引入 Agent 编排、状态机或后台进程；Phase 模型是**人的执行纪律**，不是运行时组件。
3. 本文**不**解决"云端 Agent 与本地 Agent 并发修改同一文件"的平台级冲突——
   现有手段是 worktree + 租约（`git-9`），属协作信号，不是权限系统。
4. 本文**不**覆盖 Linear 工单的全部状态语义（`AGENTS.md` §21 是权威）。
5. 角色章程（`.cnb/agents/*.md`）仍是云端 Agent 的**运行时**约束来源；本文是仓库级规范，
   两者冲突时以章程对**该角色**的约束为准，并应同步修正其一（避免第二事实源）。
6. 本文件为 `Draft`；晋升 `Active` 需经 Owner Review（`docs/architecture/README.md` 文档贡献规范）。

---

## 15. Complexity Delta

| 项 | 值 |
|---|---|
| New durable source of truth | **NO**（复用 `AGENTS.md` + runbook + 台账） |
| New persisted schema/state | NO |
| New subsystem/service/background process | NO |
| New public abstraction/interface | NO（仅新增文档 + 稳定规则 ID） |
| New runtime feature flag | NO |
| New cross-package dependency | NO |
| New host/platform-specific behavior | NO |
| New external/network capability | NO |

---

## 16. 验收对照（对应 ISSUE #23 的覆盖要求）

- [x] Owner Intent → GitHub Merge 完整生命周期（§3，含状态图与授权来源）
- [x] Agent Phase 模型：Reality Check / Planning / Implementation / Verification / Delivery（§4）
- [x] Stop Conditions：evidence missing（`SC-2`）/ architecture decision required（`SC-3`）/
      scope conflict（`SC-4`）/ secret-permission boundary（`SC-5`）（§6）
- [x] Artifact Persistence Contract：commit + PR + canonical reference（§9）
- [x] Owner Interaction Rules：必须等待 vs 可自主推进（§7）
- [x] 只修改 `docs/**`；未触碰 `packages/**`、`.cnb.yml`、`.github/**`、任何 Secret
