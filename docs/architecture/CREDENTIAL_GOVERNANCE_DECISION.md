# Credential Governance Decision — PD 集成凭据信任边界与收敛模式

> **状态**: Proposed（等待 Owner 决策）
> **日期**: 2026-09-13
> **作者**: AI（CNB NPC `npc/CodeBuddy(deepseek-v4.1-flash)`，ISSUE #19）
> **基线**: `main` @ `81d113fc`（CNB PR #21 未合并；ADR-0026 为 `Proposed`，见 CNB PR #21）
> **关联**:
> - `docs/audit/PRI-782-integration-credential-reality-report.md`（Phase 0.1 Recovery Run，P0-01 定义来源）
> - `docs/audit/credential-governance-phase1-preparation.md`（Phase 1 Preparation）
> - `docs/adr/0026-cnb-token-injection-boundary.md`（P0-01 归因修正，CNB PR #21）
> - `docs/runbooks/CNB_CLOUD_WORKER.md` §4.4（CNB → GitHub 交付桥）
> - `docs/runbooks/CREDENTIAL_INVENTORY.md`（凭据台账 v0）
> **任务性质**: **架构决策文档（Phase 2）**。未修改任何代码、配置、Secret 或权限。
>
> **注**：本文引用的 `ADR-0026` 目前为 `Proposed`，存在于 **CNB PR #21**，尚未合入 `main`（见 `docs/adr/`）。

---

## 0. 这份文档决策什么 / 不决策什么

**决策**：PD 的集成凭据在 **CNB 与 GitHub 两个事实源之间的信任边界应如何划定**，
以及在 P0-01 不可完全消除的既定事实下，收敛路径取哪一条。

**不决策**：不实施任何改动。本文档只输出决策与理由；实施方案在 Phase 3，
落地在 Phase 4，且必须经 Owner Review Gate。

**前提事实（已固化，不在本文档重新论证）**：

| # | 事实 | 来源 |
|---|---|---|
| F1 | `CNB_TOKEN` 是平台注入的内置只读变量，`imports` **无法移除**它 | ADR-0026 §事实 1-3；官方 `build-in-env.md` |
| F2 | T6/T7 容器同时持有 `CNB_TOKEN`（CNB 写）与 `GITHUB_SYNC_TOKEN`（GitHub Contents RW + PR RW） | `.cnb.yml:263,368`；`scripts/dev/cnb-auto-deliver.mjs:21-22` |
| F3 | GitHub Bridge（T6/T7）已从"设计方案"转为**实际运行的工作流** | runbook §4.4；`git log` 中的 `sync/cnb-delivery/*` 合并记录 |
| F4 | GitHub `main` 有平台级分支保护（Verify Merge Gate strict + `enforce_admins` + 禁 force） | `docs/audit/PRI-778-cnb-github-bridge-reality-report.md` §1 |

---

## 1. 当前 Trust Boundary（信任边界现状）

### 1.1 边界声明（as-built，非 as-designed）

PD 的凭据现状**没有一张被显式声明的信任边界图**。以下是按代码与平台事实重建的当前边界：

```
┌───────────────────────────────────────────────────────────────────────────┐
│ TRUST ZONE 0 — Owner（人类，唯一预置者与最终合并者）                        │
│   持有：全部凭据的创建权、GitHub merge 权、CNB 组织权、Cloudflare/Linear 后台│
└───────┬───────────────────────┬───────────────────────┬───────────────────┘
        │ 手工预置               │ 手工预置               │ 手工预置
        ▼                       ▼                       ▼
┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ ZONE A           │  │ ZONE B               │  │ ZONE C               │
│ GitHub Actions   │  │ CNB 流水线容器        │  │ Cloudflare Pages     │
│                  │  │                      │  │ Functions            │
│ GITHUB_TOKEN     │  │ CNB_TOKEN   ← 平台注入│  │ 8 项 Pages Secrets   │
│ 12 项 Secrets    │  │ GITHUB_SYNC_TOKEN ← imports │                  │
│                  │  │                      │  │                      │
│ 写权限：仓库内   │  │ 写权限：CNB 仓库      │  │ 写权限：Linear /     │
│ （受 workflow    │  │ + GitHub 内容 + PR    │  │ 遥测 / 清理端点      │
│  permissions 限）│  │  ⚠ 双事实源同容器     │  │                      │
└──────────────────┘  └──────────────────────┘  └──────────────────────┘
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                                │
                                ▼
                 ┌────────────────────────────────┐
                 │ ZONE D — 宿主 / 运行时（Owner 机器）│
                 │ PD_CONSOLE_TOKEN（keychain 加密）│
                 │ LLM keys（env / .pd/config.yaml）│
                 │ 零外部集成凭据 = 干净边界        │
                 └────────────────────────────────┘
```

### 1.2 边界的六条实际性质

| # | 性质 | 含义 | 风险指向 |
|---|---|---|---|
| B1 | **Owner 是唯一预置者** | 无签发/轮换自动化；凭据由人手工写入各存储面 | 轮换靠记忆（P1-03/P1-04） |
| B2 | **平台注入 > 配置声明** | `CNB_TOKEN` 不受 `.cnb.yml` 控制（F1） ⇒ 边界**不是**配置可塑的 | P0-01 不可完全消除 |
| B3 | **可信事件 = 权限上限的依据** | CNB 把"可信事件"（配置取自目标分支）作为可信度判据，而非容器隔离 | 可信度**建立在触发语义上，不在执行环境上** |
| B4 | **GitHub 侧边界是"写入口收敛"而非"读取收敛"** | `main` 受保护、force 被禁；但令牌可读性不受限 | 泄漏面 ≠ 写入面 |
| B5 | **同一凭据跨面复制是常态** | Linear 双副本、Telemetry 清理同名双面、NPM 回退对 | 静默失效（P1-01/P2-01/P1-02） |
| B6 | **宿主面边界干净** | OpenClaw 插件零外部集成凭据；PD Runtime 只有本地认证与 LLM key | 正向边界，不应被误伤 |

### 1.3 边界的核心张力（本文档要决策的对象）

> **B2（平台注入不可消除）与 B3（可信度建立在触发语义上）共同决定：
> P0-01 的"同容器双写权限"无法通过 CNB 侧配置消除。
> 因此问题必须重新表述为——**

**问题重述**：

> 在一个"执行环境不可隔离、但触发语义可信"的交付通道上，
> PD 应该把 **canonical（唯一事实源）** 放在哪一侧，
> 以及相应地，**哪一侧的凭据权限应当被收敛、哪一侧应当被接受为残余风险**？

这正是 Section 2 要比较的两种模式。

---

## 2. CNB canonical / GitHub canonical 两种模式比较

### 2.0 为什么是这两种

delivery bridge（F3）使 CNB 与 GitHub 之间出现了**双向流动**：

- GitHub → CNB：镜像同步（runbook §2 方案 A-2，手动或 GHA）
- CNB → GitHub：T6/T7 桥（自动，已运行）

**两个方向同时存在 ⇒ 必须显式指定哪一侧是 canonical。**
若不指定，PD 事实上处于"双向同步"状态——`CNB_CLOUD_WORKER.md` §2 方案 B 已明确
判定双向同步**与 AGENTS.md P4（单一事实源）冲突**。因此本节不是可选优化，
而是**必须收敛的架构歧义**。

### 2.1 模式定义

#### 模式 G —— GitHub canonical（现状实为默认）

**定义**：GitHub `main` 是唯一权威历史与唯一合并点。CNB 是**执行环境**（审计、开发任务、NPC），
不是事实源。CNB 侧的一切产物必须经 T6/T7 桥送到 GitHub，由 Owner 在 GitHub 合并一次。

**当前实现证据**：

| 面 | 事实 | 证据 |
|---|---|---|
| 合并权 | GitHub `main` 平台保护 + Owner 独占合并 | AGENTS.md §23；PRI-778 §1 |
| 交付方向 | T6/T7 单向 CNB → GitHub，禁推 main | `.cnb.yml` T6/T7；runbook §4.4.2 |
| 镜像方向 | GitHub → CNB 单向 | runbook §2 方案 A |
| 桥的分支纪律 | 只推 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` | `.cnb.yml:272,283`；`cnb-auto-deliver.mjs:7` |
| 文档声明 | "GitHub 是唯一事实源" | PRI-778 §1「Canonical 约束」 |

**此模式的凭据含义**：

- `GITHUB_SYNC_TOKEN` 是**交付写入器**（delivery writer），不是事实源本身；
- `CNB_TOKEN` 是**执行环境写能力**，其作用域（CNB 镜像仓库）在 canonical 模型中**不是权威历史**；
- P0-01 的"双写权限"在 canonical 语义下**不对等**：GitHub 写触及事实源，CNB 写只触及镜像。

#### 模式 C —— CNB canonical

**定义**：CNB `main` 是唯一权威历史与唯一合并点。GitHub 降级为**对外展示镜像 + 发布通道**。

**实现含义**：

| 面 | 变化 |
|---|---|
| 合并权 | 必须迁移到 CNB（`merge-pull` API，Owner 在 CNB 侧操作） |
| 交付方向 | T6/T7 桥**失去存在理由**（产物已在 canonical 侧） |
| 镜像方向 | CNB → GitHub 成为唯一镜像方向（取代 GitHub → CNB） |
| 发布链 | npm publish / release-metadata / Cloudflare 部署 / Linear sync 全部在 `.github/workflows/**` ⇒ **必须迁移到 CNB 或改为外部触发** |
| `GITHUB_SYNC_TOKEN` | 仍需要（镜像 + 发布），权限面不变 |
| 治理文档 | AGENTS.md §23（Owner 在 GitHub 合并）、§21（Linear workflow）、CODEOWNERS 全部需要重写 |

### 2.2 逐维比较

| 维度 | 模式 G（GitHub canonical） | 模式 C（CNB canonical） |
|---|---|---|
| **符合 AGENTS.md P4（单一事实源）** | ✅ 现状已声明 GitHub 为唯一事实源，只需**消除镜像方向的歧义** | ✅ 同样可满足，但需迁移合并权 |
| **事实源唯一性是否已成立** | ⚠️ **部分成立**：交付方向单向，但镜像方向仍未自动化（runbook A-2a 待批 / A-2b 手动） ⇒ 存在"CNB main 落后于 GitHub"的静默失真窗口（A-2 已标注为 P1） | ✅ 单向镜像下自然唯一 |
| **Owner 合并点数量** | 1 个（GitHub） | 1 个（CNB） |
| **是否需迁移发布链** | ❌ 不需要——发布链已在 GitHub | ✅ **需要**：npm / release-metadata / Cloudflare / Linear sync |
| **是否需迁移 Linear 集成** | ❌ 不需要 | ✅ `.github/workflows/linear-sync.yml` 需重做 |
| **对 `.cnb.yml` 的改动** | 零（当前结构即为该模式） | 大（触发面、合并流程、桥退役） |
| **对 `.github/workflows/**` 的改动** | 零 | 大 |
| **对 AGENTS.md / CODEOWNERS 的改动** | 零（保护 GitHub 合并权） | **大**（§23 需重写；CODEOWNERS 语义变化） |
| **对现有 GitHub PR 历史的处理** | 无需处理 | 需声明 GitHub 历史为只读镜像 |
| **桥（T6/T7）的角色** | 保留（核心通路） | 退役 |
| **P0-01 的严重性** | **中**：GitHub 写可达事实源，但 CNB 写只达镜像 ⇒ 双写权限**后果不对称** | **高**：CNB 写可达事实源；且 GitHub 镜像写仍需令牌 ⇒ 双写**后果对称**，攻击面叠加更严重 |
| **P0-01 能否被消除** | ❌ 不能（F1） | ❌ 不能（F1） |
| **缓解手段是否已存在** | ✅ `main` 保护 + 前缀分支约束 + 禁 force（F4） | ❌ 需重建等价保护（CNB 侧平台能力未取证） |
| **实施成本** | **低**（文档级） | **高**（跨包、跨平台、跨治理规则） |
| **可逆性** | ✅ 高（桥可关、镜像可改） | ❌ 低（合并权迁移是有中断风险的治理变更） |
| **是否符合 P3（最小改动面）** | ✅ | ❌ |
| **是否符合 P7（无投机抽象）** | ✅ | 需新增设施以维持等价能力 |
| **与 MVP-first 立场（ADR-0014）** | ✅ | ❌ 属重大架构迁移，非 MVP 需求 |

### 2.3 模式 C 的可行性质疑（为什么它不是"另一种合理选择"而是"高风险迁移"）

模式 C 在纸面上是自洽的（CNB 已经实际承载执行工作），但把 PD 的现实摊开看：

1. **发布链没有 CNB 版本**。npm provenance、release-metadata 签名、Cloudflare Pages 部署、
   Linear sync 全部是 GitHub Actions 实现。迁移它们不是"改个 yml"，而是**重建一条发布链**。
2. **P0-01 在模式 C 下更严重，不是更轻**。模式 C 中 CNB 写 = 事实源写，
   `CNB_TOKEN` 的在场所代表的权限**升级**。这直接把 F1 的不可消除问题**放大**。
3. **模式 C 需要先具备 CNB 侧的分支保护**，而该能力**未取证**（Phase 1 UNK-11 指出
   `allow_events` 只支持事件名 glob，未发现按分支的写约束；CNB 侧 ruleset 等价物 UNKNOWN）。
   在未知是否具备等价保护的情况下迁移合并权，等于**主动削弱已有保护**。
4. **模式 C 的收益是什么？** 唯一实质收益是"CNB 产物无须过桥"。但桥已经工作（F3），
   且 Owner 只在 GitHub 合并一次的事实**已经是当前的低摩擦形态**。

⇒ 模式 C **不作推荐**，但**必须被记录**，因为它代表一种真实的架构可能性，
且"CNB 侧执行 + GitHub 侧合并"这一分离在文档中从未被正式声明为**决策**（只被声明为现状）。

---

## 3. 推荐模式

### 3.1 推荐：**模式 G —— GitHub canonical，且显式声明并消除镜像方向歧义**

**推荐理由（按优先级）**：

| # | 理由 | 依据 |
|---|---|---|
| R1 | **P4 单一事实源**：GitHub 已是声明事实源，改动方向是"消除歧义"而非"改变事实源" | AGENTS.md P4；PRI-778 §1 |
| R2 | **P3 最小改动面**：零 `.cnb.yml` / 零 `.github/**` / 零 AGENTS.md 改动 | AGENTS.md P3 |
| R3 | **P0-01 后果不对称**：CNB 写只达镜像，GitHub 写才达事实源 ⇒ 双写权限的严重性已被现有保护显著削弱 | F4 |
| R4 | **保护已存在**：`main` 保护 + 前缀约束已就位；模式 C 需从零重建 | F4；`CNB_CLOUD_WORKER.md` §2 方案 B 判双向同步违反 P4 |
| R5 | **可逆**：模式 G 下任何后续调整都是局部的（改一个 workflow、改一个 ruleset） | P8 |
| R6 | **符合 MVP-first**：不引入非 MVP 需求的迁移 | ADR-0014 |

### 3.2 但模式 G 需要三处**显式声明**（否则只是"默认"而非"决策"）

现状是"事实上 GitHub canonical"，但**从未被作为一个决策写出**。三处缺失：

| # | 缺失 | 后果 | 处置（Phase 3 提出，Phase 4 落地） |
|---|---|---|---|
| D1 | 镜像方向（GitHub → CNB）**未自动化**，且 runbook A-2a 仍标"待 Owner 批准" | CNB main 静默落后 ⇒ 云端审计审的是**过期快照**却称"当前 main"（runbook §A-2 已自述为 P1） | 在 canonical 决策中明确镜像方向的状态与 owner |
| D2 | **"哪一侧是 canonical"未写入任何架构文档**（只有 runbook §2 与审计报告的顺带表述） | 后续维护者可能据"CNB 已承载全部执行"推断模式 C | 本文档 + ADR（Phase 4） |
| D3 | **P0-01 的残余风险 R1~R5 未登记** | "沉默接受"（Phase 0 §3.1 原文） | 写入 `CNB_CLOUD_WORKER.md` §5 已知限制（Phase 1 §4.2 P2-1） |

### 3.3 模式 G 下的凭据收敛原则

由 canonical 决策直接推出的四条原则（Phase 3 实施据其展开）：

| 原则 | 内容 | 对应风险 |
|---|---|---|
| **CG-1 后果优先于可见性** | 权限收敛优先作用于**能改变权威历史**的令牌。`GITHUB_SYNC_TOKEN` 是唯一可达事实源的令牌 ⇒ 它是收敛重点；`CNB_TOKEN` 不可消除 ⇒ 转为登记 | P0-01 |
| **CG-2 最小必要授权** | 桥只需 Contents RW + PR RW（已满足），且应限制在**单个仓库**（已满足）；任何扩大（如加 Actions/Workflows 权限）必须**先于**实施被拒绝 | P0-01 R2 |
| **CG-3 写入口收敛先于读取收敛** | 读取面不可控（容器内任意代码可读），因此防护落在**写入口**：分支前缀 ruleset、main 保护、禁 force | P0-01 R1/R2 |
| **CG-4 跨面副本必须显式登记** | 同一逻辑凭据的每一份副本登记为**耦合轮换组**，轮换时同步 | P1-01/P2-01/P1-02 |

---

## 4. 风险接受项（Risk Acceptance）

### 4.1 必须被显式接受的残余风险

下列风险在模式 G 下**无法消除**，只能接受。**接受的前提是登记，不是默认。**

| ID | 残余风险 | 为何不可消除 | 严重性 |
|---|---|---|---|
| **RA-1** | CNB 交付容器内**任意代码**可读取 `GITHUB_SYNC_TOKEN`（供应链攻击面：镜像投毒 / 依赖 postinstall / PR 注入） | F1：`CNB_TOKEN` 不可移除；且脚本任务必须读到 `GITHUB_SYNC_TOKEN` 才能推送 ⇒ 无"不可读"配置存在 | 中（R1） |
| **RA-2** | 该令牌具备 Contents RW + PR RW（限 `csuzngjh/principles`）⇒ 泄露后可改写**非保护分支**内容并开 PR | 权限已是最小必要授权（CG-2）；进一步收窄将破坏桥功能 | 中（R2） |
| **RA-3** | `CNB_TOKEN` 在同一容器提供 CNB 仓库写权力 | 平台注入，配置不可消除（F1） | 低-中（CNB 侧非权威历史，R3 在模式 G 下降级） |
| **RA-4** | **单一突破点可同时获得两个平台的写权限**（P0-01 的本质） | F2 + F1 的合成事实 | 中（R4；模式 G 下因 canonical 不对称而降级，但未消失） |
| **RA-5** | 无轮换自动化；PAT 长期有效，泄露窗口 = 有效期 | 本阶段不建设轮换系统（不属于 MVP） | 中（R5） |
| **RA-6** | 镜像方向未完全自动化 ⇒ CNB main 可能落后于 GitHub main | 属运维节奏问题，非安全边界问题 | 低（D1） |

### 4.2 已被现有机制覆盖、不需新增缓解的部分

**重要**：以下不是"待办"，而是**已经存在且不应重复建设**的控制：

| 控制 | 位置 | 覆盖的风险 |
|---|---|---|
| GitHub `main` 平台保护（Verify Merge Gate strict + `enforce_admins` + 禁 force/delete） | GitHub 平台（F4） | RA-2 的**主历史**部分 |
| 桥只推 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` | `.cnb.yml:272,283`；`cnb-auto-deliver.mjs:7` | RA-2 的**分支范围**部分 |
| 令牌不落盘：credential helper / 临时 header 文件（`umask 077` + `trap`）/ `redact()` | `.cnb.yml` T6；`cnb-auto-deliver.mjs:37,104` | RA-1 的**日志与外泄通道**部分 |
| `gitleaks` 进 pre-push 强制链（`useDefault = true`） | `lefthook.yml:29-43`；`.gitleaks.toml` | RA-5 的**误提交**部分 |
| 可信事件语义（配置取自目标分支 main） | CNB 平台（F2/B3） | RA-4 的**触发可信度**部分 |
| 结构化失败 + nextAction，无静默降级 | `.cnb.yml` T6 断言；`cnb-auto-deliver.mjs` fail-loud | 隐性失效 |

### 4.3 明确**拒绝**的缓解方向

| 方向 | 拒绝理由 |
|---|---|
| Vault / 外部 Secret Manager | Phase 0 已明确"不设计 Vault，不引入新 Secret 系统"；且不改变同容器事实 |
| 拆分 T6/T7 到"不含 CNB_TOKEN 的容器" | F1：`CNB_TOKEN` 恒在，该容器不存在 |
| `imports` 层级调整（Pipeline → Stage） | ADR-0026：命题不成立；在当前单 Stage 结构下零收益 |
| 移除 `CNB_TOKEN` 的使用 | 会导致 T7 失去关闭 CNB PR / 发评论能力 —— 功能回退 |
| 双向同步 | 违反 P4（`CNB_CLOUD_WORKER.md` §2 方案 B 已判不推荐） |
| 缩短 PAT 有效期 | 是**缓解**不是**隔离**；可作为 RA-5 的补充，但改变不了 RA-1~RA-4 |
| 受控配置库 + `include` | Phase 1 §C.1：解决的是"谁能改含凭据的配置"（治理），**不是**"凭据是否同容器"（隔离）；且新增配置事实源，违反 P4 |

### 4.4 风险接受的**条件**

接受 RA-1 ~ RA-5 **以以下三项为条件**，缺一即不成立：

1. **登记**：RA-1 ~ RA-5 必须写入 `CNB_CLOUD_WORKER.md` §5「已知限制」
   （消除 Phase 0 §3.1 指出的"沉默接受"）。
2. **事实对齐**：runbook §4.4.2 必须补上"容器同时持有 CNB 令牌与 GitHub PAT"这一事实；
   §1.2 / §8 与现实的矛盾（"不进入 CI / 云端零密钥" vs 实际 `imports`）必须修正。
3. **写入口保护持续在场**：§4.2 表中的保护（main 保护、前缀约束、禁 force）**不得被削弱**；
   削弱即视为重新打开 P0-01。

---

## 5. Complexity Delta

| 项 | 值 |
|---|---|
| New durable source of truth | **NO** — 本文档为决策记录，事实源仍是代码与平台（P4 合规） |
| New persisted schema/state | NO |
| New subsystem/service/background process | NO |
| New public abstraction/interface | NO |
| New runtime feature flag | NO |
| New cross-package dependency | NO |
| New host/platform-specific behavior | NO |
| New external/network capability | NO |

**全文零代码、零配置、零权限改动。** 推荐模式（G）的实施动作全部为文档级，
且不新增任何存储面或门禁。

---

## 6. 验收对照（对齐 Owner 的 Phase 2 要求）

| Owner 要求 | 本文档 |
|---|---|
| 1. 当前 Trust Boundary | §1（边界图 + 六条性质 + 核心张力） |
| 2. CNB canonical / GitHub canonical 两种模式比较 | §2（模式定义 + 13 维比较 + 模式 C 可行性质疑） |
| 3. 推荐模式 | §3（推荐 G + 三处需显式声明 + 四条收敛原则） |
| 4. 风险接受项 | §4（RA-1~RA-6 + 已覆盖部分 + 拒绝方向 + 接受条件） |
| 不修改任何代码 | ✅ 仅新增本文件 |
| 完成后等待 Owner Review | ✅ 见 §7 |

---

## 7. 待 Owner 决策（Phase 3/4 的 Gate）

本文档**不自行进入 Phase 3**。需 Owner 就以下事项作出决定：

| # | 决策点 | 选项 |
|---|---|---|
| **DEC-1** | 是否采纳**模式 G（GitHub canonical）**为正式决策？ | (a) 采纳 → 进入 Phase 3；(b) 选择模式 C → 需另行评估迁移路径；(c) 暂不决策 |
| **DEC-2** | 是否接受 §4.1 的 RA-1 ~ RA-6？ | (a) 全部接受；(b) 部分接受（请指出）；(c) 不接受 → 需新的缓解方案 |
| **DEC-3** | 是否批准 §4.4 的三项**接受条件**作为 Phase 4 的最小改动集？ | (a) 批准；(b) 增减条目 |
| **DEC-4** | 镜像方向（D1）如何处置？ | (a) 接受手动 A-2b 现状并登记；(b) 启用 A-2a 自动化（需新增 GitHub workflow + `CNB_MIRROR_TOKEN`，属范围扩展需批准）；(c) 暂不决策 |
| **DEC-5** | ADR-0026 是否转 `Accepted`？ | (a) 接受并合并 CNB PR #21；(b) 接受但需修订；(c) 保持 `Proposed` |

**Phase 3 不启动，直至 DEC-1 与 DEC-2 明确。**
