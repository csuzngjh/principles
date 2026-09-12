# PD Cloud Agent 架构设计（Phase 2）

> 状态：设计稿，待 Owner 确认
> 范围：PD 第一个云端 Agent 开发节点（CNB Cloud Agent Worker）
> 前置：[环境兼容性报告](./cnb-environment-compatibility-report.md) · [CNB 能力验证报告](./cnb-capability-validation-report.md)
> 实现：[`.cnb.yml`](../../.cnb.yml) · [`.ide/Dockerfile`](../../.ide/Dockerfile) · [`.cnb/settings.yml`](../../.cnb/settings.yml) · [审计员章程](../../.cnb/agents/pd-auditor.md)

---

## 1. 目标与非目标

### 1.1 目标（本阶段）

建立一个**长期在线的只读分析节点**，承担：

| # | 职责 | 为什么适合云端 |
|---|---|---|
| G1 | 自动化代码审查（PR 维度） | 与本地开发并行，不占用开发机；审查结论可沉淀 |
| G2 | 架构健康检查（仓库维度、周期性） | 需要"重复、无聊但重要"的定时执行，人不会主动做 |
| G3 | 长时间运行任务 | 云端按需/定时执行，闲置自动回收 |
| G4 | 为后续低风险自动 PR 预留**结构位**（不实现） | 先把"只读 + 可观测"打牢，写权限另行审批 |

### 1.2 明确的非目标

- ❌ **不迁移本地开发环境**。本地仍是主战场，CNB 是**增量节点**。
- ❌ **不引入新的 Agent Framework**。只用 CNB 原生 NPC + 内置任务 `npc:go`。
- ❌ **不新增 PD 状态源**（不写 `.pd/`、不写 `.state/`、不新增 DB）。
- ❌ **不修改 PD 核心代码**。零 `packages/**` 改动。
- ❌ **不实现自动修复 / 自动 PR / 自动合并**（Phase 2 任务书明确禁止）。
- ❌ **不改变 GitHub Actions 流程**。

---

## 2. 目标架构

```
                          ┌───────────────────────────────┐
                          │            Owner              │
                          │  最终决策 · 合并 PR · 接入账号  │
                          └───────────────┬───────────────┘
                                          │
              ┌───────────────────────────┴───────────────────────────┐
              │                                                       │
              ▼                                                       ▼
   ┌────────────────────────┐                       ┌────────────────────────────────┐
   │    Local Development    │                       │      CNB Cloud Worker          │
   │  Claude / Codex /       │                       │   DeepSeek / CodeBuddy (NPC)   │
   │  CodeBuddy              │                       │                                │
   │                        │                       │  职责（第一阶段，只读）:         │
   │  复杂工作 · 写代码       │                       │   · clone repository           │
   │  设计决策 · 本地验证     │                       │   · install dependencies       │
   │  唯一代码写入口          │                       │   · run tests / checks         │
   │                        │                       │   · analyze code               │
   └───────────┬────────────┘                       │   · generate reports           │
               │                                    │                                │
               │  git push / PR                     │  禁止:                          │
               ▼                                    │   · 修改 main                   │
   ┌────────────────────────┐                       │   · 自动 merge                  │
   │  github.com/.../principles │  ◄── 单向镜像 ──►  │   · 修改架构规则                 │
   │  GitHub Actions（不变）  │                    └───────────────┬────────────────┘
   │  PD 的单一事实源         │                                    │
   └────────────────────────┘                                    │
                                                                 ▼
                                            报告落地：CNB commit 附件（不落 main）
                                                       │
                                                       ▼
                                            Owner 在 CNB 构建页 / 本地查看
```

### 2.1 三面职责切分

| 面 | 主体 | 拥有 | 不拥有 |
|---|---|---|---|
| **Owner** | 人 | 最终决策、PR 合并、优先级、账号/凭据接入 | — |
| **本地开发** | 人 + Claude/Codex/CodeBuddy | **唯一的代码写入口**、设计决策、复杂改动、本地验证 | 无人值守的周期性任务 |
| **CNB Worker** | NPC（`PD Auditor`） | 只读分析、报告产出、周期性健康检查 | 任何代码写权限、任何 runtime 状态 |

**单一写入口原则（P4）**：代码变更只从本地经 PR 进入 `main`。CNB Worker 在只读阶段**不产生新的写入口**。

---

## 3. 只读边界（Allow / Deny）

### 3.1 允许

| 动作 | 说明 |
|---|---|
| `clone repository` | 从 CNB 侧镜像读取当前分支代码 |
| `install dependencies` | `npm ci`（原生模块需容器工具链） |
| `run tests` | 执行 PD 既有测试/校验脚本 |
| `analyze code` | 静态阅读源码、文档、ADR |
| `generate reports` | 产出审查报告并上传为 commit 附件 |
| 写评论 | 在 Issue/PR 下发表审查意见（CNB 默认能力） |

### 3.2 禁止（本项目显式约束，且 CNB 原生默认已满足）

| 动作 | 阻断机制 |
|---|---|
| 修改 `main` | **NPC 未开启工作模式 ⇒ 无代码写权限**（官方默认） |
| 自动 merge | 不配置 `git:auto-merge`；不开工作模式 |
| 修改架构规则 | 不持有写权限；章程明令禁止 |
| 写入 PD 运行时状态 | 不挂载、不写 `.pd/` / `.state/`；章程明令禁止 |
| 引用密钥 | 不使用 `imports` / 密钥仓库引用 |

**双重保障**：CNB 平台层（权限收窄）+ 章程层（行为约束）。任一层失效另一层仍生效。

---

## 4. 触发面设计

| # | 触发 | 用途 | 事件 | 报告落地 |
|---|---|---|---|---|
| T1 | PR 创建/更新 | 自动化代码审查（G1） | `pull_request` | PR 评论 |
| T2 | 每周定时 | 架构健康检查（G2/G3） | `crontab` on `main` | commit 附件 |
| T3 | 手动按钮 | 按需审计（G3） | `web_trigger` | 回复 + 附件 |
| T4 | 交互式 | 人工探索、深度调查 | `vscode`（云原生开发） | 人工 |
| — | `@NPC` 评论 | **当前不可用**（单向镜像下 CNB 侧无 PR/Issue），见 §4.4 | — | — |

### 4.1 T1 — PR 审查

挂在 `$:` 下（所有分支生效），只读：

```yaml
$:
  pull_request:
    - docker:
        image: cnbcool/default-npc:latest
      stages:
        - name: npc go
          type: npc:go
          options:
            role: PD Auditor
            userPrompt: <审查章程指引>
```

**注意**：CNB 官方把 `pull_request` 列为**不可信事件**（流水线配置取自源分支）。因此该流水线**不得持有写权限、不得引用密钥**。本设计满足。

### 4.2 T2 — 每周架构健康检查

```yaml
main:
  "crontab: 0 2 * * 1":
    - name: pd-auditor-weekly-audit
      ...
```

**确定性阶段 + 叙事阶段**两段式：

| 阶段 | 内容 | 为什么这样切 |
|---|---|---|
| **确定性** | 直接 `node scripts/check-*.{js,cjs}` 跑 PD 自有的门禁脚本 | 这些脚本**零外部依赖**（已验证），无需 `npm install`（省掉约 25 分钟）；结果客观、可重复、无 LLM 幻觉 |
| **叙事** | `npc:go` 读取 `AGENTS.md` + `docs/architecture/` + ADR 做偏离分析 | 提供确定性脚本给不出的判断（架构漂移、复杂度、文档一致性） |

**这是 P2「Connection Before Creation」的直接落实**：PD 已经有 `check-repo-hygiene`、`check-docs-structure`、`check-generated-artifacts`、`check-security-baseline`、`check-error-handbook`、`quality-report` 等能力；本设计**不新建能力，只把既有能力接到新的执行面上**。

### 4.3 T2 报告落地方式

| 步骤 | 机制 |
|---|---|
| 1 | 确定性阶段输出写入 `cloud-audit-deterministic.md` |
| 2 | `npc:go` 产出叙事分析 |
| 3 | 一致性校验：若 `cloud-audit-report.md` 缺失或为空 ⇒ **失败退出并给出 nextAction**（ERR-002 fail loud，不静默兜底） |
| 4 | `cnbcool/attachments:latest` 上传为本次 commit 附件（`ttl: 30`） |

**为什么挂 commit 附件而不提交回 main**：报告提交回 `main` 会（a）产生第二个写入口，（b）污染提交历史，（c）违反 P4。附件机制让报告**可追溯、可下载、不落主分支**。

### 4.4 已知限制：`@NPC` 评论触发不可用

单向镜像下 CNB 侧不产生 PR/Issue，`issue.comment@npc` / `pull_request.comment@npc` 无触发源。
→ **后果**：交互式"@ 一下让它看看"的能力在本阶段不可用。
→ **处置**：以 T3（`web_trigger` 手动按钮）替代交互式入口。若后续改为双向同步，可再启用 `@NPC`。这是**有意的取舍**，不是遗漏。

---

## 5. Agent 角色设计：PD Auditor

### 5.1 定义位置

| 层 | 文件 | 内容 |
|---|---|---|
| 角色注册 | `.cnb/settings.yml` → `npc.roles` | 名称、标语、系统提示词 |
| 行为章程 | `.cnb/agents/pd-auditor.md` | 审查维度、必读清单、输出契约、禁令 |
| 执行编排 | `.cnb.yml` | 何时调用、用什么镜像、报告如何落地 |

**为什么章程单独成文件**（而不是塞进 `prompt` 字段）：章程需要被 Owner 版本化审阅、需要列出必读清单与 5 个审查维度、后续会演进。放在 `.cnb/agents/pd-auditor.md` 使其**可 diff、可评审、可追溯**，符合 P8（next change 局部化）。

### 5.2 五个审查维度

| 维度 | 判据来源 |
|---|---|
| 1. 架构漂移 | ADR（`docs/adr/`）+ `docs/architecture/`，特别是 §20 架构守卫哲学 |
| 2. 新增复杂度 | AGENTS.md §13 Complexity Delta Gate、PR 模板 §5 Complexity Delta |
| 3. 测试风险 | P5 Verification First 的方法选择表；`verify:merge` 覆盖面 |
| 4. 文档一致性 | §3 Truth and Authority Model（Intent Truth vs Implementation Truth）+ `check:docs-structure` |
| 5. 用户体验风险 | §17 Owner-facing Emotional Value；`mvp-q-4-emotional-value` |

### 5.3 必读清单

1. `AGENTS.md`（工程宪法）
2. `docs/architecture/`（架构现实）
3. `docs/adr/`（意图真相，按 §3.1 优先级）
4. `docs/product/PRODUCT_IDENTITY.md`（产品边界）
5. Linear context（**若可用** —— 本阶段不可用，见 §7）

### 5.4 输出契约

- 唯一交付物：`cloud-audit-report.md`
- 结构：结论摘要 → 逐维度发现 → 证据（文件:行）→ 风险分级 → 建议的后续工单
- **禁止**：直接修改代码、开 PR、改 `main`

---

## 6. 治理对齐检查

| PD 原则 / 约束 | 本设计如何满足 | 证据 |
|---|---|---|
| **P4 单一事实源** | 代码唯一写入口仍是本地→GitHub PR；CNB 只读；报告走附件不落 main | 无写权限配置；无 `git:auto-merge` |
| **P7 不新增投机抽象** | 不引入 Agent 框架；直接用 CNB 原生 NPC；不新建 Agent Registry/Scheduler | 复用 `npc:go`、`crontab`、`attachments`（均为平台原生） |
| **P2 先勘察后动手 / Connection Before Creation** | 复用 PD 既有 `check:*` 脚本，而非新建检查器 | §4.2 两段式设计 |
| **P3 最小变更面** | 零 `packages/**` 改动；仅新增 4 个配置文件 + 3 个文档 | `git diff --stat` |
| **不新增 PD 运行时状态** | 不写 `.pd/`、不写 `.state/`、不新增 DB | 章程明令禁止；容器内无挂载 |
| **不破坏现有开发流程** | `.github/**` 未触碰；本地工具链未触碰 | 兼容性报告 §6 |
| **Owner 决策 / Agent 执行** | CNB 只产报告与建议；合并与优先级仍归 Owner | §2.1 职责表 |
| **§1.1 安装运行时边界** | 不触碰 `~/.pd/runtime`、`~/.openclaw/extensions/`、`<workspace>/.pd/` | 无相关路径操作 |
| **§21 Linear 工作流** | 本工作建 Linear 工单；AI 撰写文本用中文 | Phase 7 |

---

## 7. 待确认项（需 CNB 侧接入后才能验证）

| # | 待确认 | 影响 | 兜底 |
|---|---|---|---|
| **U1** | `npc:go` 能否在 workspace 写入 `cloud-audit-report.md` | 决定 T2 报告落地是否成立 | 若不能：改为"NPC 回复 + 只上传确定性阶段报告"，或改用自定义 NPC 镜像内的 CLI |
| **U2** | `cnbcool/default-npc:latest` 是否含 `git` / `ripgrep` | 影响确定性阶段能否跑 | 已设计为可在 `.cnb.yml` 换用自定义镜像 |
| **U3** | 定时任务"最后修改者即负责人"的人事风险 | 负责人被移出组织 ⇒ 任务静默失败 | runbook 标注 |
| **U4** | 默认开发镜像是否含 `code-server`（单/双容器模式） | 影响 WebIDE 体验形态 | `.ide/Dockerfile` 已装 code-server ⇒ 单容器 |
| **U5** | CNB 侧仓库 slug（决定 `CNB_REPO_SLUG` 等） | 影响附件 URL 拼接 | 接入后回填 runbook |

---

## 8. 分阶段路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 1** | 只读：clone / install / test / analyze / report | **本次交付（配置就绪）** |
| Phase 2 | 增加确定性检查的**强制门禁**（当前仅报告，不阻塞） | 待评价第一阶段噪声后再定 |
| Phase 3 | 低风险自动 PR（文档类、依赖升级类） | **未设计**，需单独审批；本设计仅预留结构位 |
| Phase 4 | 与 Linear 双向联动（审计发现 → 自动建工单） | 未设计 |

**明确不做**：本 PR 不实现 Phase 2/3/4 的任何功能。任务书约束 3「不要提前实现自动修复」已遵守。

---

## 9. 回滚

| 场景 | 回滚动作 |
|---|---|
| 云端行为不符合预期 | 在 CNB 仓库删除/注释 `.cnb.yml` 中对应事件；`.cnb` 配置生效即回滚 |
| 完全放弃 CNB | 从 GitHub 仓库移除 4 个配置文件即可（CNB 侧删除仓库或停止镜像） |
| 本地/GHA 受影响 | 不可能——本设计零 `packages/**`、零 `.github/**` 改动 |

**无状态迁移、无数据迁移、无 schema 变更** ⇒ 回滚是纯配置回退。
