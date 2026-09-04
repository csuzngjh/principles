# Installer Journal Integration Analysis (PRI-664 / ADR-0024 D-2)

> **Status**: Analysis record（Phase 0 产出，随实现完成冻结）
> **Date**: 2026-09-04
> **Baseline**: `origin/main` @ `a1112212`（PR #1498/#1499/#1500 已合并；ADR-0023、ADR-0024 Accepted）
> **Scope**: 只回答"installer 的 mutation 生命周期如何映射到既有 transaction journal"；实现为最小侵入（不新建 journal 系统、不改安装布局、不启用 ReleaseManager）。

---

## 1. 现有能力盘点（源码实证）

### 1.1 Installer（`packages/create-principles-disciple/src/installer.ts`，2360 行）

`install(options, pluginDir, mode)` 的 mutation 时间线（行号为 baseline 实测）：

| 阶段 | 行号 | 副作用 | 失败语义 |
| --- | --- | --- | --- |
| 自包含资产 preflight | 1931–1959 | 无（只读 digest 校验：`verifyReleaseAssetTarget` + `verifyReleaseAssetManifest`） | 失败 → refusal（`rollback_no_changes`） |
| gateway 锁 preflight | 1960–1996 | 无（决定 stop/abort/proceed） | abort/stop 失败 → refusal（cli-5：不得 mutate） |
| `checkBuiltPlugin` | 2017 | 无 | throw → catch，`hasBackup=false` |
| legacy rule contract preflight | 2025–2032 | 无 | refusal return |
| **`backupExistingInstall`** | **2041** | **renameSync 现有 extDir/runtimeDir → 备份目录（第一个 mutation）** | throw → catch（EPERM 归类为 lock） |
| 铺设新内容 | 2047–2230 | core/host-runtime/codex-adapter/layout/plugin/pd-cli/console + 依赖 + workspace 模板/config/host installers | 任一 throw → catch |
| `cleanupBackup` | 2232 | 删除备份 | — |
| catch → `restoreBackup` | 2284–2289 | rename 备份回原位（不 rm node_modules 之外的未知物） | restore 失败显式上报（ERR-046） |

**已具备**：digest 校验（自包含资产链）、backup/rename-swap、失败恢复、legacy rule contract preflight、gateway 协调。
**缺失**：全流程零 journal——崩溃后无法区分"换过/没换过"（这正是 ADR-0024 §1.2 F1 指出的缺口）。

### 1.2 Transaction journal（`src/update/transaction-journal.ts`）

- 11 态状态机：`planned → downloaded → verified → staged → probed → activated → host_verified → confirmed | rolled_back | refused | failed`；terminal 态之后**禁止**继续追加（`journal_terminal_continued`）⇒ **一个 journal 文件 = 一个事务**。
- `appendJournalTransition`（append + fsync，journal-first：先落日志后做副作用）；`readTransactionJournalForRecovery`（torn-tail 感知）；`recoverUnfinishedTransaction`（old-confirmed / new-confirmed / explicit-refusal 三元收场）。
- `JournalTransition` 必填字段：`at / from / to / transactionId / releaseId / productVersion / releaseMetadataDigest(64-hex) / generation(≥1) / detail?`。
- 路径模型（`update/install-layout.ts:51` + `legacy-migration.ts:214` 唯一先例）：**`~/.pd/transactions/<transactionId>.jsonl`**（D-6：runtime 作用域，符合 ADR-0024）。
- 现有消费方：仅 legacy-migration（写）与 ReleaseManager（读 active.json 时的恢复契约）。

### 1.3 ReleaseManager / rollback-policy

- ReleaseManager `apply()/rollback()` 仍显式 `shadow_mode_read_only`（本任务不动它，PR 链条：PRI-661 再接管）。
- `rollback-policy.ts` 零消费方（不变）。

---

## 2. Mutation 生命周期映射

安装器的 payload 是本地捆绑包（无下载/远端 metadata 链），故 `downloaded` 不适用；自包含 preflight 发生在 journal 之前（只读），对应"verified"语义由资产 manifest 承担。映射：

| Journal 态 | 安装器时点（实现插入点） | 理由 |
| --- | --- | --- |
| `planned` | `backupExistingInstall` **之前**（第一个 mutation 前一行） | journal-first：先落意图再动文件 |
| `staged` | 全部 runtime 内容铺设完成（console 依赖校验后） | 新内容就位、未收尾 |
| `probed` | `verifyConsole` 通过后 | console 启动探测即 probe |
| `activated` | host installers 成功 + install manifest 写入后、`cleanupBackup` 前 | 安装整体落地 |
| `confirmed` | `cleanupBackup` 后（成功路径终点） | 备份清理 = 事务确认 |
| `failed` | catch 入口（detail = 错误消息） | — |
| `rolled_back` | `restoreBackup` 成功且确有备份时 | 恢复完成 |
| `refused` | （预留）pre-mutation refusal 不落 journal——零副作用无需事务记录 | 见 §3.2 |
| `downloaded/verified/host_verified` | 不适用（本地捆绑 payload / probe 由 `probed` 承担） | — |

**字段取值**：

- `transactionId`：`install-<epochMs>-<uuid8>`（每事务一个 journal 文件：`~/.pd/transactions/<transactionId>.jsonl`）。
- `productVersion`：捆绑 `pd-cli/package.json` 的 `version`（缺省 `'unknown'`）。
- `releaseMetadataDigest`（必须 64-hex）：优先 = sha256(`<pluginDir>/_release/manifest.json`)（自包含资产全量清单——真实聚合身份数据）；回退 = sha256(`<pluginDir>/pd-cli/package.json`)；两者皆缺 = sha256(字面原因串)（文档化回退，journal 字段仅要求 hex 格式，不参与 `verifyReleaseMetadataIdentity` 链）。
- `releaseId`：`bundled-<productVersion>-<digest 前 12 位>`（确定性派生，与 legacy-migration 的严格 producer 模型解耦——identity 链收敛属 PRI-661）。
- `generation`：`1`。安装器模型尚无 `active.json` generation 链（安装器从不写 active.json，见 ADR-0023 审计 F3）；generation 连续性由 ReleaseManager 接管后（PRI-661）统一负责。此处如实记录，不伪造递增。

---

## 3. 关键决策记录

### 3.1 复用而非新建

直接消费 `transaction-journal.ts` 的 `appendJournalTransition`（含其 fsync 与严格读取契约）；在 `installer.ts` 内实现 ~90 行 glue（`beginInstallerJournal` / `journalInstallerTransition` / 降级包装）。**不创建** `installer-journal.ts`、不复制 history 系统（D-7 的 history 收敛仍归 console 侧后续任务）。

### 3.2 Journal 失败策略（两档，"不因 journal 失败而 brick 安装"）

| 时机 | 策略 | 理由 |
| --- | --- | --- |
| **Tier 1**：首个 `planned` 追加失败（mutation 尚未开始） | **拒绝安装**：返回 `success:false, reason:'transaction_journal_unavailable'` + nextAction（检查 `~/.pd/transactions` 权限/磁盘） | 零副作用 + 拒绝优于静默降级（ADR-0024 §2.4 规则 4）；此时尚无任何文件被触碰，中止零成本 |
| **Tier 2**：`planned` 之后的追加失败 | **降级继续**：记 `logger.error`、标记 `degraded=true`、跳过后续追加；结果对象带 `journal.degraded=true` | mutation 已在进行中——中止并不能让状态更好（恢复手段是 backup/restore，它不依赖 journal）；带备份网继续 = 现有安全模型，journal 降级如实上报 |
| pre-mutation refusal / pre-mutation throw（`checkBuiltPlugin`、rule preflight、gateway abort） | **不落 journal** | 零副作用；`refused` 态保留给"已 planned 后被拒"的未来场景（ReleaseManager 用） |

### 3.3 Recovery ownership（PRI-664 review 明确——不假装闭环）

截至本 commit，**代码库中没有任何消费者对 `~/.pd/transactions/` 下的 installer journal 执行自动恢复**——journal 目前提供的是**可观测性（observability only）**。journal 的 schema 与恢复原语（`readTransactionJournalForRecovery` / `recoverUnfinishedTransaction`）已经就位，但把它们接入实际恢复流程属于 **PRI-661 ReleaseManager adoption** 的职责。

已用测试钉住未来消费者必须继承的语义契约（`tests/installer-journal-sequence.test.ts` "unfinished transaction — recovery contract"）：

| 中断点 | 恢复原语的结论（installer 模型，无 active.json） |
| --- | --- |
| 激活未发生（planned/staged 前后崩溃） | `old_confirmed`（swap lineage 未到 activation，旧安装方成立） |
| 已 journal `activated` 但未 `confirmed` | `explicit_refusal`（`activation_interrupted_without_previous`——无 active record 可对账，规定动作是重跑官方安装器） |

同时 schema 增加 `releaseMetadataDigestSource: 'manifest' | 'package_manifest' | 'fallback'`（可选字段，向后兼容旧 journal 行），让每个 digest 的可验证性有据可查——`fallback` 摘要可读但不可验证。

### 3.4 不做的东西（对齐任务 Constraints）

不重设计 installer、不改布局、不启用 ReleaseManager、不做 repair executor、不手改 runtime、不删重复副本、不动 console updater（PRI-659 已收敛其边界）。

---

## 4. 测试策略

两个测试文件：

1. **`tests/installer-journal.test.ts`（流式，沿用 `installer.test.ts` 的 auto-mock fs + gateway mock harness；transaction-journal 模块部分 mock 以捕获 transitions）**
   - Tier-1 拒绝：`appendJournalTransition` 抛错 → install 返回 `transaction_journal_unavailable`，且 `renameSync/cpSync/rmSync` 未被调用（零 mutation）
   - planned → failed：备份 rename 抛错（无备份 → 无 rolled_back）
   - planned → failed → rolled_back：备份成功后 core 缺失抛错 → restore 成功 → rolled_back；并断言单事务 id、payload 身份字段（releaseId/productVersion/digest 64-hex）
   - D-6 路径：journal 落在 `~/.pd/transactions/install-*.jsonl`
2. **`tests/installer-journal-sequence.test.ts`（序列，真实 fs + 真实严格 reader，HOME 钉在临时目录）**
   - planned→staged→probed→activated→confirmed 全链通过严格 reader 回读校验（链式 from→to、身份字段、generation=1）
   - Tier-2 降级契约：中途追加失败 → degraded 标记 + 后续跳过 + journal 仍可严格解析（未完成事务）
   - Tier-1 契约：严格追加失败时照常抛错（由调用方拒绝）
3. **回归**：现有 `installer.test.ts` 全量不动、必须继续通过（install 行为不变；journal 只增不改）。
