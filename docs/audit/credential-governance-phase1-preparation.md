# Credential Governance — Phase 1 Preparation Report

> **状态**: Complete（已 Owner Review；**结论经 ADR-0026 修正**，Phase 2 暂停）
>
> ## ⚠️ 修正通知（2026-09-13，Owner 复审后）
>
> Owner 复审否决了本文档 §4.1 推荐方向，并给出架构结论：
>
> > CNB stage/job imports cannot remove CNB_TOKEN from the execution environment.
> > P0-01 is therefore not an imports configuration problem.
>
> **本文档 §1.3 末段与 §4.1 对 Option A 的"可行但收益边际"判断不准确**，
> 正确表述为「**命题不成立**」：`imports` 只能控制密钥仓库导入的自定义变量，
> `CNB_TOKEN` 由平台注入（内置只读变量，构建过程中无法覆盖），
> 因此 **imports 层级调整在原理上无法关闭 P0-01**。
>
> 完整归因修正与取证见 **`docs/adr/0026-cnb-token-injection-boundary.md`**。
> **阅读本文档 §3 Option A / §4 时必须以 ADR-0026 为准。**
> 其余取证事实（§1.1 三级支持、§1.2 三条限制、§2 台账）仍然有效。
> **日期**: 2026-09-13
> **调查人**: AI（CNB NPC `npc/CodeBuddy(deepseek-v4.1-flash)`，ISSUE #19）
> **基线**: `main` @ `4bfd74fb`
> **任务性质**: **只读取证 + 文档输出**。未修改代码、配置、Secret、Token 权限；未实施任何隔离方案。
> **产物**: 本文档 + `docs/runbooks/CREDENTIAL_INVENTORY.md`（台账草案）
> **前置**: `docs/audit/PRI-782-integration-credential-reality-report.md`（Phase 0.1 Recovery Run，P0-01 定义来源）

---

## 0. 执行摘要

| # | 问题 | 结论 | 置信度 |
|---|---|---|---|
| 1 | CNB 是否支持 stage / job / pipeline 级 `imports`？ | **支持全部三级**，且语义为"注入到该级作用域内的环境变量" | **高**（官方文档三处独立定义） |
| 2 | 能否实现"Audit Stage 无 GitHub 凭据、Delivery Stage 仅有 GitHub 凭据"？ | **部分可行，但不能达到理想隔离**——因为 **Pipeline 级 `imports` 会整容器注入**，而 T6/T7 目前用的正是 Pipeline 级 | **高**（文档语义 + 本仓配置实证） |
| 3 | P0-01 应如何处置？ | ~~推荐 Option A'（Pipeline 级 `imports` → Stage 级）~~ **已被 ADR-0026 否决**：P0-01 **不是 imports 配置问题**，`imports` 层级调整在原理上无法关闭它。处置须落到 GitHub 侧后果控制 | **高**（官方文档 + 本仓实证，见 ADR-0026） |
| 4 | 是否存在 Option C（其他方案）？ | 存在一个**文档级**候选（受控配置库 + `include`），但与本仓现有 T6/T7 架构冲突，且不解决同容器问题 → 记录为不推荐 | 中 |

**一句话**：Task 1 的答案是"支持三级，但关键限制是**作用域=整容器**而非"仅脚本"；且 `imports` 只作用于**密钥仓库导入项**，对平台内置的 `CNB_TOKEN` 无管辖权。故 **P0-01 不是 imports 配置问题**（ADR-0026）。

---

## 1. CNB `imports` 能力取证（Task 1）

### 1.1 结论

CNB **同时支持三级** 环境变量文件导入（`imports`）：

| 级别 | 配置位置 | 定义文档 | 作用域（官方原文） |
|---|---|---|---|
| **Pipeline 级** | `main.<event>[].imports` | `docs.cnb.cool/zh/build/grammar.md` §`pipeline-imports`（L882-L1082） | 「对当前 `Pipeline` 内的非插件任务均有效」 |
| **Stage 级** | `<stage>.imports` | 同上 §`stage-imports`（L1588-L1594） | 「仅对当前 `Stage` 生效。用法同 Pipeline imports」 |
| **Job 级** | `<job>.imports` | 同上 §`job-imports`（L1943-L1949） | 「仅对当前 `Job` 生效。用法同 Stage imports」 |

三级语法一致（`Array<String> | String`），优先级为 **Job > Stage > Pipeline**，且 `env` 覆盖 `imports` 同名 key。

**文档来源**：

- 语法手册：`https://docs.cnb.cool/zh/build/grammar.md`
- 文件引用与鉴权：`https://docs.cnb.cool/zh/build/file-reference.md`
- 密钥仓库：`https://docs.cnb.cool/zh/repo/secret.md`
- 环境变量：`https://docs.cnb.cool/zh/build/env.md`

### 1.2 关键限制（决定 Option A 可行性）

这三条限制**必须与"支持三级"同时阅读**，否则会得出过于乐观的结论：

**限制 1 — Pipeline 级 `imports` 是整流水线注入（已在本仓实证）**

本仓 T6（`.cnb.yml:263`）与 T7（`.cnb.yml:368`）当前使用的是 **Pipeline 级** `imports`：

```yaml
"pull_request.merged":
  - name: cnb-github-delivery-bridge
    imports: https://cnb.cool/csuzngjh/pd-secrets/-/blob/main/cnb-github-bridge.yml   # ← 此处
    stages: [...]
```

⇒ `GITHUB_SYNC_TOKEN` 对**该流水线的所有 Stage、所有 Job、所有脚本**可见。这正是 P0-01 的形态。

**限制 2 — 作用域是"容器环境变量"，不是"脚本可见性"**

Stage/Job 级 `imports` 收窄的是**该容器内环境变量的注入范围**，不是"给出某个脚本的临时凭据"。因此：

> **若 Audit 与 Delivery 在同一 Pipeline 容器内执行，仅靠 stage 级 `imports` 无法做到"Audit Stage 完全看不到 GitHub 凭据"。**

真正的隔离必须满足其一：

- (a) Audit 与 Delivery 在**不同 Pipeline**（不同容器）；或
- (b) 凭据仅在 Delivery Stage 注入，且 Audit Stage **不导出、不落盘、不传递**该变量。

**限制 3 — `imports`/`env` 不会传递给插件任务**

官方原文（grammar L1775）：

> 「通过 `imports`、`env` 设置的自定义环境变量**不会传递给插件**，但可在 `settings`、`args` 中使用变量替换。CNB 系统环境变量会传递给插件。」

⇒ 若目标 Stage 是**插件任务**（含 `npc:go` 等内置/镜像任务），stage 级 `imports` **不会**让插件进程直接读到该变量；需经 `settings`/`args` 变量替换传入。

**对本仓的意义**：T6/T7 的消费点是 **script 任务**（`script:` 内 shell），不是插件任务，因此 stage 级 `imports` **对该消费路径有效**。但 `CNB_TOKEN` 的消费点 `cnb-auto-deliver.mjs` 也是 script 任务调用，同样有效。

### 1.3 "Audit Stage 无 GitHub 凭据 / Delivery Stage 仅有 GitHub 凭据" 可行性判定

| 询问 | 判定 | 依据 |
|---|---|---|
| Audit Stage 无 GitHub 凭据 | **可实现**（给定"不同 Pipeline"或"凭据仅在 Delivery Stage 注入"） | stage 级 `imports` 的作用域语义（§1.1） |
| Delivery Stage 仅有 GitHub 凭据 | **部分可实现** | `CNB_TOKEN` 是**平台自动注入**的，无法通过 `imports` 配置移除（见下） |

**关键发现（对 P0-01 的直接修正）**：`CNB_TOKEN` **不是** `imports` 引入的凭据，而是 CNB 平台自动注入到容器、构建结束即销毁的临时令牌（`.cnb.yml:249-251` 的注解即此意；本环境 `env | grep CNB_TOKEN` 亦可观察到其存在）。

**官方文档证据（权威，2026-09-13 取证）** — `docs.cnb.cool/zh/build/build-in-env.md`：

> 首句：「`云原生构建`内置了一些**只读环境变量，构建过程中无法覆盖**。」
>
> §`CNB_TOKEN`：「流水线运行期间的临时令牌，结束后自动销毁……」

⇒ `CNB_TOKEN` 属**内置只读变量**，其在场性由平台决定，**不由 `.cnb.yml` 的 `imports`/`env` 决定**。

⇒ **`CNB_TOKEN` 的在场性无法通过 `imports` 作用域控制。** 因此 **Option A 只能消除 `GITHUB_SYNC_TOKEN` 在无关 Stage 的暴露，不能消除 `CNB_TOKEN` 的在场**。

这与 Phase 0 的 P0-01 描述完全一致（P0-01 的本质是"两权限同容器"），也说明：

> **Option A 是"降低暴露面"，不是"消除 P0-01"。**

**⇒ Owner 结论（ADR-0026 固化）：`imports` 只能控制密钥仓库导入的自定义变量，管不到平台内置变量，因此 P0-01 不是 imports 配置问题。** 任何声称 Option A 能解决 P0-01 的表述都是不准确的。

### 1.4 未取证项（显式标记 UNKNOWN，不猜测）

| ID | UNKNOWN | 说明 |
|---|---|---|
| UNK-10 | stage 级 `imports` 在**同类脚本任务串联**时，前序 Stage 是否残留变量到后续 Stage（进程模型细节） | 文档只声明"仅对当前 Stage 生效"，未描述容器进程复用细节。**未实机验证**。 |
| UNK-11 | `allow_events` 是否支持 `pull_request.target` 之外的更细粒度事件约束（用于进一步收窄 T7） | 文档列出的 `allow_events` 为事件名 glob，未提及按 stage 约束。 |
| UNK-05（承接 Phase 0） | CNB 侧对 stage 级 `imports` 的实际行为 | 本次以**官方文档语义**取证；**未做 CNB 实机验证**（本任务约束禁止修改 `.cnb.yml`，无法跑验证性流水线）。 |

**验证建议（供 Phase 2 执行）**：在**独立测试仓库**（非本仓）放一条含 stage 级 `imports` 的最小流水线，断言：前序 Stage 读不到该变量、目标 Stage 读得到。— 本任务约束明确禁止改 `.cnb.yml`，故此处只给出方法，不执行。

---

## 2. Credential Inventory 状态（Task 2）

### 2.1 产物

`docs/runbooks/CREDENTIAL_INVENTORY.md` — 台账草案（v0）。

### 2.2 覆盖情况

| 存储面 | 项数 | 状态 |
|---|---|---|
| GitHub Secrets | 12 | 已知，`updated_at` UNKNOWN（UNK-04） |
| CNB 侧 | 5（含 1 项非凭据的授权声明） | 部分 UNKNOWN（UNK-01/07） |
| Cloudflare Pages Secrets | 8 | 已知；实际设置面 UNK-08 |
| 宿主 / 运行时 env | 5 | 已知 |
| OpenClaw 插件面 | 0 凭据 | 已知（正向边界） |
| **合计** | **20 项凭据 / 5 存储面** | — |

### 2.3 台账的独特价值：耦合轮换组

台账第 2 节首次把"**必须同步轮换**"的跨面耦合显式登记：

1. **Linear 双副本**（`LINEAR_API_KEY` + `LIN_API_KEY`）→ 漏改一侧静默失效（P1-01）
2. **Telemetry 清理同名双面**（`PRODUCT_TELEMETRY_CLEANUP_TOKEN` ×2）→ P2-01
3. **NPM 回退对**（`NPM_READ_TOKEN || NPM_TOKEN`）→ 只读分离未落地（P1-02）
4. **Cloudflare 双形态**（PAT + wrangler OAuth）→ P2-02

### 2.4 待 Owner 回填的 UNKNOWN

8 项（UNK-01/02/03/04/06/07/08/09）。**Agent 无法取证的原因**均为"需登录外部后台"，已在台账第 3 节逐条登记。

---

## 3. P0-01 治理方案比较（Task 3）

### 3.0 P0-01 事实复核（基于当前代码）

| 事实 | 证据 |
|---|---|
| T6 用 Pipeline 级 `imports` 注入 `GITHUB_SYNC_TOKEN` | `.cnb.yml:263` |
| T7 用 Pipeline 级 `imports` 注入同一令牌 | `.cnb.yml:368` |
| 同容器内 `CNB_TOKEN` 被 `cnb-auto-deliver.mjs` 用于 CNB API（列 PR / 发评论 / 关 PR） | `scripts/dev/cnb-auto-deliver.mjs:21,65,163,171` |
| 两令牌在同一执行环境被同时消费 | `scripts/dev/cnb-auto-deliver.mjs:21-22`（两个 env 常量相邻定义） |
| 现有平台侧缓解：GitHub main 分支保护 | `docs/audit/PRI-778-cnb-github-bridge-reality-report.md:15` |

**P0-01 修复的前提判断**：`CNB_TOKEN` 不可配置移除（平台注入）⇒ 任何方案都无法让"CNB 写权限"离开该容器。**可选空间只剩"GitHub 凭据何时进入容器"。**

---

### Option A — Stage-level credential isolation

**做法**：把 T6/T7 的 Pipeline 级 `imports` 下移到**真正消费 GitHub 令牌的那个 Stage**。

#### A.1 是否可行

| 维度 | 判定 |
|---|---|
| 机制是否存在 | ✅ 官方文档明确支持（§1.1） |
| 对本仓 T6/T7 是否适用 | ✅ 消费点是 **script 任务**（shell），不受"插件任务不继承 imports"限制（§1.2 限制 3） |
| 是否达到理想隔离（Audit 完全无凭据） | ⚠️ **取决于流水线结构**。T6/T7 目前是**单 Stage 流水线**，下移 `imports` 后暴露面不变 |
| 是否消除 P0-01 | ❌ **不能**。`CNB_TOKEN` 平台注入，不可移除 |

**关键判定**：仅做"Pipeline 级 → Stage 级"的机械下移**对 T6/T7 无实际收益**（各只有 1 个 Stage）。Option A 要产生实效，**必须同时补齐一个前提**：

> **把 T6/T7 中"不需要 GitHub 凭据的步骤"拆成独立 Stage，让 GitHub 凭据只出现在最后一个 Stage。**

#### A.2 修改范围（若采纳）

| # | 改动 | 位置 | 类型 |
|---|---|---|---|
| 1 | 把 `imports` 从 Pipeline 级移到 Stage 级 | `.cnb.yml` T6（`:263` 起）、T7（`:368` 起） | 配置 |
| 2 | T6 的三个 Stage（准备分支 / 推送 / 建 PR）**合并或重排**，使"准备"Stage 不持有令牌 | `.cnb.yml` T6 `stages` | 配置 |
| 3 | T7 的 `cnb-auto-deliver.mjs` 调用 Stage 与令牌注入 Stage 的关系需重新确认（脚本同时用两个令牌，见 §3.0） | `.cnb.yml:368` + `scripts/dev/cnb-auto-deliver.mjs` | 配置（脚本无需改） |

**实测前置**：改动后必须**实机跑一次** T6/T7，验证：

- 目标 Stage 内 `GITHUB_SYNC_TOKEN` 仍 present（`imports` 生效）；
- 凭据未因 Stage 边界被清空（UNK-10 未取证）。

#### A.3 风险

| 风险 | 等级 | 说明 |
|---|---|---|
| **收益有限** | 高 | 若流水线仍是单 Stage，改动**零收益**，只是形式上更"正确" |
| Stage 边界行为未实机验证（UNK-10） | 中 | 可能引入 fail-loud（`imports` 未生效导致桥失败）——但 T6/T7 有 `.cnb.yml:276,301` 的断言兜底，失败会显式报错而非静默 |
| 改动 `.cnb.yml` 影响交付主路径 | 中 | T7 是 Developer 产出送达 GitHub 的主路径；回归会阻断交付 |
| 不解决 `CNB_TOKEN` 同行 | 高 | **P0-01 的"两个事实源写权限"中，CNB 侧无论如何都在** |

#### A.4 结论

> **⚠️ 本节结论已被 ADR-0026 修正。** 原文"可行但收益边际"不准确。
>
> 正确结论：**Option A 对 P0-01 命题不成立。** 它只能收窄 `GITHUB_SYNC_TOKEN` 的
> 注入层级，**无法移除 `CNB_TOKEN`**（平台注入的内置只读变量）。因此它不能作为
> P0-01 的处置路径。详见 `docs/adr/0026-cnb-token-injection-boundary.md`。

~~**可行但收益边际。** 只有配合"Stage 拆分 + 实机验证"才有意义；单独下移 `imports` 属于**形式改动**（违反 AGENTS.md P3 最小改动面原则的精神——改了但没有解决可观察问题）。~~

---

### Option B — 保持现状 + GitHub 侧防护

**做法**：不动 `.cnb.yml`。接受"同容器双凭据"，用 GitHub 侧控制写权限的**后果**：

- 现有：GitHub `main` 分支保护（`required_status_checks: Verify Merge Gate (strict)` + `enforce_admins` + `allow_force_pushes: false`）
- 追加：对 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` 前缀加 **ruleset**

#### B.1 接受哪些残余风险（必须显式登记）

| # | 残余风险 | 后果 |
|---|---|---|
| R1 | 容器内任意代码可读取 `GITHUB_SYNC_TOKEN` | 供应链攻击（镜像投毒 / 依赖投毒 / PR 注入）可外泄该 PAT |
| R2 | 该 PAT 具备 Contents RW + PR RW（限 `csuzngjh/principles`） | 泄露后可**任意改写非保护分支内容**并开 PR |
| R3 | `CNB_TOKEN` 提供 CNB 仓库写权限 | 泄露可在 CNB 侧改 `ai/cnb-dev/*` 等内容 |
| R4 | 两权限同容器 = 单一突破点可获得**两个事实源**的写权限 | 攻击面叠加；审计上无法区分是哪一侧被滥用 |
| R5 | 无轮换自动化，PAT 长期有效 | 泄露窗口 = 令牌有效期（未登记到期，UNK-09） |

#### B.2 Option B 的合理性论证

**赞成**：

- 现状**已有**平台级缓解（main 保护），P0-01 的**后果**已被部分限制（不能直推 main、不能 force）。
- 桥只建 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` 分支（`.cnb.yml:272,283`；`cnb-auto-deliver.mjs:7`），**内容写入范围可控**。
- 符合 AGENTS.md P3（最小改动面）与"第一阶段不新增门禁"的既有治理姿态。
- Phase 1 的任务性质是"**准备**"，不是"实施"。

**反对**：

- **R1/R2 是真实攻击面**：PAT 在容器环境变量中明文可见，任何在该容器执行的代码（含第三方 npm 依赖的 postinstall）都能读取。
- **R4 是 P0 的本质**：这不是"两个独立的 P1"，而是"单一突破点 → 双事实源写权限"。
- 「沉默接受不可接受」（Phase 0 §3.1 原文）—— Option B 的**前提**是风险被**显式登记**，而非默认忽略。

#### B.3 结论

**可行，且是当前约束下的务实选择**，但**必须**满足两个条件：

1. 把 §B.1 的 R1~R5 **显式写入 runbook §5 已知限制**（消除"沉默接受"）；
2. runbook §4.4.2 补上"**容器同时持有 CNB 令牌与 GitHub PAT**"这一事实（Phase 0 REC-1 的要求）。

---

### Option C — 其他方案（有则列，无则不造）

经文档与代码双重取证，存在**一个**文档级候选，**不推荐**但必须记录：

#### C.1 受控配置库 + `include`（官方最佳实践建议）

**官方原文**（`docs.cnb.cool/zh/repo/secret.md` §"防范流水线内泄漏" / §"最佳实践"）：

> 「将包含 `imports` 的流水线配置存放在**独立的、权限受控的仓库**中，通过 `include` 方式提供给其他仓库使用，限制修改人员范围。」

**为什么不推荐**：

1. **不解决同容器问题**：`include` 只改变"配置来自哪个仓库"，凭据仍注入同一容器 ⇒ P0-01 的 R4 不变。
2. **与本仓架构冲突**：本仓 `.cnb.yml` 是自包含的单一事实源，引入外部配置库会新增一个**分布式配置事实源**（违反 AGENTS.md P4）。
3. **复杂度上升**：新增仓库、新增同步机制、新增权限模型 —— 与 P3/P7 精神相悖。
4. 它解决的是**"谁能改含凭据的配置"**（治理问题），而 P0-01 是**"凭据是否同容器"**（隔离问题）。**不同问题。**

#### C.2 未创造其他方案

按任务约束「如果没有，不要创造」，此处不发明方案。特别说明**有意排除**的方向及理由：

| 排除方向 | 理由 |
|---|---|
| 外部 Secret Manager（Vault 等） | Phase 0 已明确"不设计 Vault，不引入新 Secret 系统"；且不改变同容器事实 |
| 拆分 T6/T7 到不同触发器 | T7 的触发条件（`pull_request.target`）由其功能决定，无法"只触发不含 CNB 令牌的容器"——`CNB_TOKEN` 恒在 |
| 移除 `CNB_TOKEN` 的使用 | 会导致 T7 失去关闭 CNB PR / 发评论的能力，功能回退（且令牌本身由平台注入，无法配置移除） |
| 缩短 PAT 有效期 | 是**缓解**不是**隔离**；可作为 Option B 的补充，但不改变 R1~R4 |

---

### Option 比较总表

| 维度 | Option A（Stage 隔离） | Option B（现状 + GH 防护） | Option C.1（`include` 受控库） |
|---|---|---|---|
| 机制有据 | ✅ 官方文档 | ✅ 现状 + 平台能力 | ✅ 官方最佳实践 |
| 消除 `GITHUB_SYNC_TOKEN` 无关暴露 | ⚠️ 仅在拆分 Stage 后 | ❌ | ❌ |
| 消除 `CNB_TOKEN` 同行 | ❌ | ❌ | ❌ |
| 达到"Audit 完全无 GH 凭据" | ⚠️ 需不同 Pipeline | ❌ | ❌ |
| 改动 `.cnb.yml` | 是 | 否 | 是（+新仓库） |
| 新增事实源 | 否 | 否 | **是**（违反 P4） |
| 实机验证成本 | 中（需跑流水线） | 低 | 高 |
| 收益 | 低（当前流水线结构下） | 中（显式登记残余风险） | 低 |
| 符合 P3/P7 | ✅ | ✅ | ❌ |
| **推荐度** | 见 §4 | 见 §4 | ❌ 不推荐 |

---

## 4. Recommended Next Step

### 4.1 建议：**Option B 为基线 + Option A 作为条件化后续项**

> **⚠️ 修正（2026-09-13，Owner 复审）**：本节将 Option A 列为"条件化后续项"的
> 前提是"它能收窄暴露面"，这一前提**部分成立但对 P0-01 无效**。
> Owner 结论：**P0-01 不是 imports 配置问题**。因此：
>
> - Option A **不再作为 P0-01 的处置路径**（见 ADR-0026）；
> - 仅保留其"多 Stage 结构下收敛 `GITHUB_SYNC_TOKEN` 无关暴露"的**次要价值**；
> - **Phase 2 全部暂停**，等待 Owner 就"缓解组合"作出决定。

理由与依据：

1. **Option A 在当前 T6/T7 结构下收益不足**（§A.1、§A.4）。T6/T7 各只有 1 个 Stage，机械下移 `imports` 不改变暴露面。
2. **P0-01 不可被任何配置方案消除**（`CNB_TOKEN` 平台注入）。因此"实施隔离"本身**不能关闭 P0-01**，只能降低部分暴露。
3. **Option B 的残余风险可以且必须被显式化**——这正是 Phase 0 的原话要求（「沉默接受不可接受」）。
4. 本任务性质是 **Preparation**，不是实施。**Phase 1 的正确产出是证据与选项，不是配置改动。**

### 4.2 Phase 2 建议动作（按优先级）

| # | 动作 | 类型 | 前置 |
|---|---|---|---|
| P2-1 | 把 P0-01 的残余风险 R1~R5 显式写入 `CNB_CLOUD_WORKER.md` §5（已知限制） | 文档 | 无 |
| P2-2 | 修正 `CNB_CLOUD_WORKER.md` §1.2 / §8 与现实的矛盾（"不进入 CI / 云端零密钥" vs 实际 `imports`） | 文档 | 无（Phase 0 P1-05 / REC-5） |
| P2-3 | 回填 `CREDENTIAL_INVENTORY.md` 的 8 项 UNKNOWN | 文档 | Owner 登录各后台 |
| P2-4 | 为 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` 评估 ruleset | 平台配置 | Owner 决定 |
| P2-5 | **在独立测试仓库**验证 stage 级 `imports` 的真实行为（UNK-10） | 实验 | 不触碰本仓 `.cnb.yml` |
| P2-6 | ~~若 P2-5 通过，再评估 T6/T7 的 Stage 拆分是否值得做~~ **已否决**（ADR-0026：对 P0-01 无效） | 设计 | — |

> **⚠️ 上表整体处于暂停状态（2026-09-13 Owner 指令）。**
> Owner 要求：**Phase 2 实施一律不得启动，等待 Owner 决策**。
> 表中 P2-1~P2-3 为文档级动作，同样需在 Owner 决策后执行。
> 尤其：P2-4（ruleset）与 P2-6（Stage 拆分）属平台/配置改动，**当前明确禁止**。

### 4.3 明确不做的事（Phase 1 边界）

- ❌ 不修改 `.cnb.yml`
- ❌ 不修改任何 Secret / Token 权限
- ❌ 不创建 Token
- ❌ 不实施任何隔离方案
- ❌ 不在本仓做 stage 级 `imports` 的实机验证（会触碰 `.cnb.yml`）

### 4.4 Phase 2 冻结状态（Owner 指令 2026-09-13）

> Stop implementation.
> Do not modify: `.cnb.yml` / secrets / permissions.
> The next task is architecture decision only.
> Wait for Owner decision before any Phase 2 implementation.

本仓库当前处于 **P0-01 架构决策等待期**：
Phase 2 的任何实施动作（配置改动 / 平台配置 / 方案落地）均**未获授权**。

---

## 5. Complexity Delta

| 项 | 值 |
|---|---|
| New durable source of truth | **NO** — 台账是**描述性文档**，事实源仍是代码与平台（AGENTS.md P4 合规） |
| New persisted schema/state | NO |
| New subsystem/service/background process | NO |
| New public abstraction/interface | NO |
| New runtime feature flag | NO |
| New cross-package dependency | NO |
| New host/platform-specific behavior | NO |
| New external/network capability | NO |

**本任务为只读取证 + 两份文档，复杂度增量为零。** Option A/B/C 的分析亦均为"零新增存储面、零新增门禁"的复用型动作。

---

## 6. 验收对照

- [x] Task 1：CNB `imports` 三级粒度结论 + 官方文档证据（§1.1）
- [x] Task 1：关键限制（整容器作用域 / 插件任务不继承）（§1.2）
- [x] Task 1：`UNKNOWN` 显式登记（UNK-05、UNK-10、UNK-11）（§1.4）
- [x] Task 2：`docs/runbooks/CREDENTIAL_INVENTORY.md` 已建立（20 项 / 5 面）
- [x] Task 3：Option A / B / C 比较 + 残余风险（§3）
- [x] Required Output 四项（§1 / §2 / §3 / §4）
- [x] 约束遵守：未改 `packages/**`、`.github/**`、`.cnb.yml`、任何 Secret / 权限
- [x] Validation：`check-docs-structure`、`check-repo-hygiene`（见 PR 描述）
- [x] Complexity Delta（§5）

---

## 7. 本次调查的局限

1. **Task 1 为文档取证，非实机验证**。本任务约束禁止修改 `.cnb.yml`，故无法在本仓跑验证性流水线。stage 级 `imports` 的容器进程模型细节（UNK-10）**未实测**。
2. **UNKNOWN 未回填**：8 项需 Owner 登录外部后台，Agent 无凭据（见台账 §3）。
3. **`pd-secrets` 内容未读取**：`allow_*` 现值（UNK-07）无法确认，因此 Option A/B 的"最小授权是否已满足"未能完全判定。
4. **Option A 的收益评估基于当前单 Stage 结构**。若未来 T6/T7 拆分为多 Stage，结论需重估。
