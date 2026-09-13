# Credential Governance — Phase 3 Implementation Proposal（最小实施方案）

> **状态**: Proposed（等待 Owner 批准）
> **日期**: 2026-09-13
> **作者**: AI（CNB NPC `npc/CodeBuddy(deepseek-v4.1-flash)`，ISSUE #19）
> **基线**: `main` @ `81d113fc`
> **前置**: `docs/architecture/CREDENTIAL_GOVERNANCE_DECISION.md`（Phase 2，模式 G 推荐）
> **任务性质**: **实施方案提案（Phase 3）**。未修改任何配置、Secret 或权限。
>
> **注**：本文引用的 `ADR-0026` 目前为 `Proposed`，存在于 **CNB PR #21**，尚未合入 `main`（见 `docs/adr/`）。

---

## 0. 本提案的边界

**只提出，不实施。** 本文件记录"如果 Owner 批准 DEC-1/DEC-2，接下来应当做什么"。

**严格禁止（Owner 明令，本提案亦不例外）**：

- ❌ 自动修改 Secret
- ❌ 自动创建 Token
- ❌ 自动改变权限
- ❌ 修改 `.cnb.yml`
- ❌ 修改 `.github/**`

**允许范围**（Owner 指定的可能范围）：

- credential inventory 更新
- runbook 更新
- 权限收敛
- ruleset 建议

---

## 1. 依赖：本提案假设的决策

本提案**以以下决策为前提**。若 Owner 未批准，本提案不成立：

| 决策 | 值 | 来源 |
|---|---|---|
| DEC-1 | **模式 G（GitHub canonical）** | Phase 2 §3 |
| DEC-2 | 接受 RA-1 ~ RA-6 | Phase 2 §4.1 |

若 Owner 选择模式 C（CNB canonical），本提案**必须整体作废并重写**——
因为模式 C 需要发布链迁移、合并权迁移与治理规则重写，与本节的所有条目都不同。

---

## 2. 最小实施方案总览

**一句话**：**只做文档级收敛——把"事实"写进文档，把"后果控制"交给已存在的平台保护，不新增任何机制。**

| # | 工作项 | 类型 | 触碰文件 | 可回滚 | 风险 |
|---|---|---|---|---|---|
| **P3-1** | 登记 P0-01 残余风险到 runbook §5 已知限制 | 文档 | `docs/runbooks/CNB_CLOUD_WORKER.md` | ✅ | 零 |
| **P3-2** | 修正 runbook §1.2 / §8 与现实的矛盾 | 文档 | 同上 | ✅ | 零 |
| **P3-3** | runbook §4.4.2 补"容器同时持有两平台令牌"事实 | 文档 | 同上 | ✅ | 零 |
| **P3-4** | 台账更新：模式 G 声明 + 桥令牌权限边界 + 镜像方向状态 | 文档 | `docs/runbooks/CREDENTIAL_INVENTORY.md` | ✅ | 零 |
| **P3-5** | ruleset 建议（供 Owner 在 GitHub 平台执行） | 建议（不实施） | 无 | N/A | 零 |
| **P3-6** | 权限收敛建议（供 Owner 在后台核对） | 建议（不实施） | 无 | N/A | 零 |

**总计**：2 个文档文件的修改，零配置改动，零权限改动。

---

## 3. 逐项说明

### P3-1 · 登记 P0-01 残余风险到 runbook §5

**问题**：Phase 0 §3.1 判定"沉默接受不可接受"。当前 runbook §5「已知限制」**未提及** P0-01。

**动作**：在 `docs/runbooks/CNB_CLOUD_WORKER.md` §5 表格中追加 P0-01 条目，
并在其后新增一小节登记 RA-1 ~ RA-5（引用 Phase 2 §4.1，不复制全文以避免双事实源）。

**登记内容（要点）**：

- 容器同时持有 `CNB_TOKEN` 与 `GITHUB_SYNC_TOKEN`；
- 该状态由平台注入边界决定，配置不可消除；
- 残余风险指向 `CREDENTIAL_GOVERNANCE_DECISION.md` §4.1；
- 现有缓解（main 保护 / 前缀约束 / 禁 force）**不得削弱**。

**验收**：`grep -n "CNB_TOKEN" docs/runbooks/CNB_CLOUD_WORKER.md` 在 §5 区域有命中；
risks 条目含 `RA-1`~`RA-5` 的引用。

---

### P3-2 · 修正 runbook §1.2 / §8 与现实的矛盾

**问题（Phase 0 P1-05）**：

| 位置 | 现表述 | 现实 |
|---|---|---|
| §1.2（`:59-61`） | "本项目的令牌只用于 Owner 手动执行镜像……**不进入 CI/流水线配置**" | `.cnb.yml:263,368` 已 `imports` 密钥仓库 |
| §8（`:392`） | "**不得**引用密钥仓库文件 / 当前为「云端零密钥」姿态" | 同上；且 §4.4.1 明确要求预置 |

**关键判读**：§1.2 的原意针对的是 **CNB 个人访问令牌**（该令牌确实不入库），
表述本身在**其语境下正确**；问题在于读者会把它误读为"该项目整体零密钥"。
§8 的"不得引用密钥仓库文件"则与 `.cnb.yml` **直接冲突**。

**动作**（最小、非破坏性）：

1. §1.2 保持原句（它是针对个人令牌的正确约束），**追加一句边界说明**：
   "该约束针对**个人访问令牌**；交付桥（§4.4）使用**独立的密钥仓库文件**，两者不是同一凭据。"
2. §8 的"不得引用密钥仓库文件"改为**指向 §4.4 的修订说明**，并标明修订日期与理由。
   **不删除**原句——保留可追溯性（与 Phase 1 报告对 Option A 的处理方式一致）。

**验收**：两处均可从 §8 到达 §4.4；`git diff` 显示为追加/修订，非删除。

---

### P3-3 · runbook §4.4.2 补"容器同时持有两平台令牌"事实

**问题（Phase 0 REC-1 明确要求）**：§4.4.2 的「安全边界」表列了令牌存储、传播、
main 保护、force、方向，但**未登记**"该容器同时持有 CNB 令牌"。

**动作**：在 §4.4.2 表中追加一行：

| 项 | 约束 |
|---|---|
| **双平台令牌同行** | T6/T7 容器同时持有 `CNB_TOKEN`（平台注入，不可配置移除）与 `GITHUB_SYNC_TOKEN`（`imports` 注入）。**这是已接受的残余风险**，不是配置缺陷。详见 `CREDENTIAL_GOVERNANCE_DECISION.md` §4.1（RA-1~RA-4）与 §4.4（接受条件） |

**验收**：§4.4.2 出现该行；指向 Phase 2 决策文档。

---

### P3-4 · 台账更新

**动作**（`docs/runbooks/CREDENTIAL_INVENTORY.md`）：

1. **顶部**追加"Canonical 模式"一行：`GitHub canonical`，指向 Phase 2 决策文档。
   （台账此前不记录模式，导致读者无法判断凭据的相对重要性。）
2. **§1.2 CNB 侧**的 `CNB_TOKEN` 行追加备注：
   "平台注入，（`PROPOSED` 决策下）CNB 侧为镜像，非 canonical ⇒ 写权限后果降级；
   但不可消除，见 ADR-0026。"
3. **§1.2**的 `GITHUB_SYNC_TOKEN` 行追加备注：
   "**唯一可达 canonical 事实源的令牌**（收敛重点）。权限不得扩大（CG-2）。"
4. **§2 耦合组**追加一组：镜像方向（GitHub → CNB）状态未自动化 ⇒ CNB main 可能落后。

**注意**：台账**不写任何 Secret 值**（既有纪律，继续遵守）。

**验收**：台账含 canonical 模式声明；`GITHUB_SYNC_TOKEN` 行标明"收敛重点"。

---

### P3-5 · ruleset 建议（**建议，不实施**）

**背景**：Phase 1 §4.2 P2-4 提出"为 `sync/cnb-delivery/*` 与 `ai/cnb-dev/*` 评估 ruleset"。

**本提案的建议**：**建议暂不新增 ruleset**，理由：

| # | 理由 |
|---|---|
| 1 | `main` 保护已覆盖**权威历史**（事实源的写入）。RA-2 的真实暴露是**非保护分支的内容写入**，而桥的产出必须落在这两类前缀分支上才可用 ⇒ 对前缀加 ruleset **会阻断桥的正常功能**，除非只加"禁 force/禁 delete"这类不阻断新建的规则。 |
| 2 | 若只加"禁 force + 禁 delete"，收益有限：桥本身已 `force: false`，且这些分支是**短生命周期的交付通道**，删除保护意义不大。 |
| 3 | 符合 P3（最小改动面）：无明确可观察收益的规则不应新增。 |

**若 Owner 仍希望加强**，建议的最小形态（供参考，**不由 Agent 实施**）：

- 规则类型：`deletion`（阻止删除）— 对交付通道分支风险低、收益低，可选；
- **不建议**：`required_status_checks` / `required_signatures`（会阻断桥的自动推送）。

**结论**：**建议不实施**。记录为"已评估且拒绝"，避免后续重复评估。

---

### P3-6 · 权限收敛建议（**建议，不实施**）

**原则（Phase 2 CG-2）**：`GITHUB_SYNC_TOKEN` 保持 **Contents RW + PR RW + 单仓库**，
**不扩大**。以下是供 Owner 在 GitHub 后台**自行核对**的清单（Agent 无凭据，不代执行）：

| # | 核对项 | 期望值 | 关联 |
|---|---|---|---|
| 1 | `GITHUB_SYNC_TOKEN` 的 Repository access | Only select repositories → 仅 `csuzngjh/principles` | Phase 0 §1.2 |
| 2 | 该 PAT 的 Permissions | Contents = Read and write；Pull requests = Read and write；**其余一律 No access** | CG-2 |
| 3 | 该 PAT 的到期 | 有明确有效期（建议 ≤ 90 天） | RA-5 |
| 4 | `NPM_READ_TOKEN` 实际粒度 | 若为 rw ⇒ 只读分离未落地，需修或登记 | P1-02 |
| 5 | Linear key 实际粒度 | 若为个人 key ⇒ 考虑换服务账号（read + issues:create + comments:create） | P1-01 |
| 6 | CNB 个人令牌 scope / 到期 | `repo-code:rw` + `repo-basic-info:r`；到期 ≤ 90 天 | UNK-01 |

**动作**：这些核对项已在台账 §3 UNKNOWN 中登记。本提案**只把它们汇总为一张 checklist**，
不执行任何修改（禁止自动改权限）。

---

## 4. 明确不做的事（Scope 边界）

| 不做 | 理由 |
|---|---|
| 修改 `.cnb.yml` | Owner 明令；且 ADR-0026 已判定 `imports` 调整命题不成立 |
| 修改 `.github/**` | Owner 明令；且 canonical 模式下无必要 |
| 修改任何 Secret / Token 权限 | Owner 明令（禁止自动改权限） |
| 创建任何 Token | Owner 明令 |
| 新增门禁 / CI 检查 | Phase 0 既有治理姿态"第一阶段不新增门禁"；且 Phase 3 为文档级 |
| 新增 ruleset | P3-5：评估后建议不实施 |
| 消除 P0-01 | F1：平台注入边界，配置不可消除 |
| 建设轮换自动化 | 不属 MVP；RA-5 作为已接受风险登记 |
| 创建新 Issue | Owner 明令：同一 Mission 内持续推进 |

---

## 5. 验证方案（Phase 4 落地时执行）

| # | 验证 | 命令 / 方法 | 期望 |
|---|---|---|---|
| V1 | 文档结构 | `node scripts/check-docs-structure.cjs` | PASS（0 stray root .md） |
| V2 | 仓库卫生 | `node scripts/check-repo-hygiene.js all` | PASS |
| V3 | 禁止路径未被触碰 | `git diff --name-only origin/main...HEAD \| grep -E '\.cnb\.yml|\.github/|packages/'` | 空输出 |
| V4 | 无 Secret 值泄漏 | `npx gitleaks detect --no-git` 或等价（pre-push 钩子） | 无 findings |
| V5 | 风险已登记可检索 | `grep -n "RA-1" docs/runbooks/CNB_CLOUD_WORKER.md` | 命中 |
| V6 | 台账含 canonical 声明 | `grep -n "canonical" docs/runbooks/CREDENTIAL_INVENTORY.md` | 命中 |
| V7 | 决策文档链接可达 | 台账/runbook 中的相对路径指向存在的文件 | 全部存在 |

**注意**：V5~V7 在**当前（Phase 3）不满足**，因为 Phase 4 尚未实施。本提案不含实现。

---

## 6. Complexity Delta

| 项 | 值 |
|---|---|
| New durable source of truth | **NO** — canonical 事实源声明是**描述性**的，事实源仍是 GitHub（P4 合规） |
| New persisted schema/state | NO |
| New subsystem/service/background process | NO |
| New public abstraction/interface | NO |
| New runtime feature flag | NO |
| New cross-package dependency | NO |
| New host/platform-specific behavior | NO |
| New external/network capability | NO |

**Phase 4 的落地形态为"2 个文档文件的修订"**，复杂度增量为零。

---

## 7. 待 Owner 决策

| # | 决策点 | 选项 |
|---|---|---|
| **IMP-1** | 是否批准 §2 的 P3-1 ~ P3-4（**文档级**改动，4 项）？ | (a) 全部批准 → 进 Phase 4；(b) 部分批准（请指明）；(c) 全部拒绝 |
| **IMP-2** | 是否接受 P3-5 的"**建议不新增 ruleset**"结论？ | (a) 接受；(b) 要求实施最小形态（禁 delete） |
| **IMP-3** | §3.6 的 6 项权限核对，是否由 Owner 自行执行？ | (a) 是（Agent 无权，只留 checklist）；(b) 暂不执行 |
| **IMP-4** | Phase 4 的 PR 是否**只含 2 个文档文件的修订**？ | (a) 是（最小 scope）；(b) 允许合并 Phase 2 文档为一次 PR |

**Phase 4 不启动，直至 IMP-1 明确。**
