# ADR-0026: CNB_TOKEN 注入边界不可由 imports 配置消除（P0-01 归因修正）

- 状态：Proposed（等待 Owner 决策）
- 日期：2026-09-13
- 关联：PRI-782、ISSUE #19、`docs/audit/PRI-782-integration-credential-reality-report.md`（Phase 0.1）、
  `docs/audit/credential-governance-phase1-preparation.md`（Phase 1 Preparation）

## 背景

PRI-782 Phase 0 现实审计确认 P0-01：CNB 交付流水线（T6 `cnb-github-delivery-bridge`、
T7 `cnb-github-auto-deliver`）在同一执行环境内同时持有两类写权限：

1. `CNB_TOKEN` — CNB 仓库写能力；
2. `GITHUB_SYNC_TOKEN` — GitHub Contents write + Pull requests write。

Phase 1 Preparation（ISSUE #19）曾提出 Option A「Stage 级凭据隔离」，思路是把
Pipeline 级 `imports` 下移到真正消费 GitHub 令牌的 Stage，以期实现
"Audit Stage 无 GitHub 凭据 / Delivery Stage 仅有 GitHub 凭据"。

Owner 于 2026-09-13 复审后否决了该方向，并给出结论：

> CNB stage/job imports cannot remove CNB_TOKEN from the execution environment.
> P0-01 is therefore not an imports configuration problem.

本 ADR 记录该结论并附取证，作为后续架构决策的前提。

## 决策

**接受 Owner 结论。确认以下两点为架构事实：**

### 事实 1 — `CNB_TOKEN` 是平台注入的内置只读变量，与 `imports` 无关

官方文档 `docs.cnb.cool/zh/build/build-in-env.md` 首句：

> 「`云原生构建`内置了一些只读环境变量，**构建过程中无法覆盖**。」

同文档 §`CNB_TOKEN`：

> 「流水线运行期间的临时令牌，结束后自动销毁，可用于代码和制品的拉取与推送，以及 API 调用。」

⇒ `CNB_TOKEN` 的**在场性**由平台决定，**不由 `.cnb.yml` 的 `imports`/`env` 决定**。

本仓实证：运行环境 `env` 中存在 `CNB_TOKEN`（本仓未在任何 `imports` 中声明它）；
唯一声明处 `.cnb.yml:249-251` 是**注释**，说明"写能力来自流水线 CNB_TOKEN"，
而非引入它。消费点 `scripts/dev/cnb-auto-deliver.mjs:21,65,163,171` 直接
`process.env.CNB_TOKEN`。

### 事实 2 — `imports` 只能控制「密钥仓库导入的自定义变量」，管不到内置变量

`imports` 语义（`docs.cnb.cool/zh/build/env.md`）是「从密钥仓库导入自定义环境变量」，
作用域三级（Pipeline / Stage / Job）。它的**控制对象**是导入项，
不是平台内置项。因此：

> stage / job 级 `imports` **无法**移除 `CNB_TOKEN`。

### 事实 3 — 由事实 1+2 得出：P0-01 不是 imports 配置问题

P0-01 的形态是「两写权限同容器」。其中 CNB 侧那一半由平台注入，**配置不可消除**。
因此任何以"调整 `imports` 层级"为手段的方案**在原理上无法关闭 P0-01**。

工程含义：

- 依赖 `imports` 分层的方案（如 Phase 1 的 Option A）**命题不成立**，不应作为 P0-01 的处置路径；
- P0-01 的处置必须落到 **GitHub 侧的后果控制**（分支保护 / ruleset / 令牌权限收敛），
  或 **CNB 侧执行环境本身的可信度**（可信事件语义），而不是 CNB 容器内变量的可见范围。

## 由此产生的归因修正

| 项 | Phase 1 原表述 | 修正后 |
|---|---|---|
| Option A 可行性 | "可行但收益边际"（假设可收窄暴露面） | **命题不成立**：连"消除 CNB_TOKEN"的前提都无法满足；`imports` 只能收窄 `GITHUB_SYNC_TOKEN` 的注入层级 |
| P0-01 归因 | 描述为待治理的配置形态 | **非 imports 配置问题**——属平台注入边界 |
| Option A 的定位 | 推荐方案之一 | 降级：只能作为"降低 `GITHUB_SYNC_TOKEN` 无关暴露"的**局部收窄**手段，且在当前单 Stage 结构下无收益 |

## 后果

### 正面

- 避免在原理不成立的路径上投入实现（Phase 2 实施据此**暂停**）。
- P0-01 的讨论从"配置技巧"回到"权限与后果控制"这一正确层面。

### 负面 / 需接受的现实

- P0-01 在当前平台能力下**无法被完全消除**，只能被缓解与显式登记。
- 缓解手段因此集中于 GitHub 侧防护与平台可信事件语义，而非执行环境隔离。

### 未改变的部分

- Phase 1 已产出的事实仍然有效：CNB `imports` 支持三级、作用域为容器环境变量、
  `imports` 不传递给插件任务、凭据台账 `docs/runbooks/CREDENTIAL_INVENTORY.md`。
- `GITHUB_SYNC_TOKEN` 的注入层级收窄（Pipeline → Stage）在**多 Stage 结构**下仍是
  有效的暴露面收敛手段；本 ADR 只否认它能解决 P0-01。

## 待 Owner 决策

Phase 2 **不得启动**，直至 Owner 就以下方向作出决定：

1. 是否接受"P0-01 不可消除，转入缓解 + 显式登记"；
2. 若接受，缓解组合取哪些（GitHub ruleset / 令牌权限收敛 / 轮换节奏）；
3. 是否仍要在**独立测试仓库**验证 stage 级 `imports` 的真实行为（Phase 1 §1.4 UNK-10）。

## 未在本 ADR 中做的事

- 未修改 `.cnb.yml`、任何 Secret、任何 Token 权限（Owner 明令禁止）。
- 未实施任何隔离方案。
- 未创造新方案；本 ADR 只固化结论与归因修正。
