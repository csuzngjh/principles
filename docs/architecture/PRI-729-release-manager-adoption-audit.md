# PRI-729 Phase 1 Reality Audit — ReleaseManager Production Adoption & Legacy Updater Bypass

| Field | Value |
| --- | --- |
| Status | Phase 1 Reality Audit（只读调查；未修改生产代码 / runtime / 数据） |
| Date | 2026-09-10 |
| Source of truth | 独立工作树 @ `57f0dfebb25d1d0b54a34ce8e48f7215d982fbec`（= `origin/main`，即 PR #1600 合并点） |
| Governing ADR | ADR-0023（Installation Architecture）、ADR-0024（Runtime Mutation Governance，D-1 / D-2 / D-7） |
| Method | 全部结论以**当前 commit 的源码** + 本机生产安装（`~/.pd`）只读取证为准；不采信旧 SPEC / 旧审计叙述 |
| Supersedes | `PRI-698-release-manager-authority-convergence-audit.md` §2 生产门控（已被 PRI-709 P0-1/P0-2/P0-3 改变） |

---

## 0. Verdict — 结论先行

**任务书的两条目标，一条已经成立，一条在当前 commit 上不可达。**

1. **「MutationController 成为唯一入口」——已成立。** `/api/update/*` 在全仓只有一个挂载点（`server/index.ts:455` → `handleUpdateRoute` → `updateMutationController.dispatch`），四个 mutation kind 全部注册到同一个 controller；没有第二条 mutation 入口。

2. **「ReleaseManager 成为唯一生产 mutation authority / 生产路径不再执行 legacy updater」——本 commit 上不可达。** 三个相互独立、且都不在本任务授权范围内可解的阻塞点：
   - **B1 签名元数据无供给方**：CI 不发布 `channels/<ch>.json` / 签名 target；`PD_RELEASE_METADATA_URL` 只有「操作者手工 env / install.json」两个人肉供给面。⇒ 对**每一个**现存安装，RM 都是 `metadata_source_unconfigured`。
   - **B2 现存安装全是 legacy-overlay**：`~/.pd/active.json` 不存在（P0-2 的写入只在 2026-09-08 之后的安装/更新里发生），`legacy-migration.ts` 零生产接线。⇒ 即使元数据可用，`ReleaseManager.apply()` 仍抛 `legacy_layout_not_supported`。
   - **B3 / B4 `apply` 与 `rollback` 是 RM 的结构性缺口**：插件增量 diff 不是 RM 的机制；`ROLLBACK_AVAILABLE = false`（`rollback-policy.ts` 至今零消费方）。

**因此 Phase 2 的可交付目标按下述代码事实修正**（任务书已授权：「如果发现任务假设错误：以代码事实为准修改方案」）：

> **已成立的部分**：单一入口 + RM 为 preferred authority + 每一处降级都带稳定 reason code。
> **本任务新增**：把「兼容 fallback」从*事实上的默认路径*升级为**被声明、被封闭、可枚举、fail-loud、有测试覆盖**的设计决策——即「只有经过明确设计的兼容 fallback 才允许存在」由构造保证。
> **明确不在本任务内**：签名元数据发布管线、Phase 2 rollback、dual-slot 迁移接线、删除 legacy 代码（PRI-738）。

---

## 1. Update Authority Map（当前 commit 逐一核实）

| Component | File | Responsibility | Mutation capability | 当前生产角色 |
| --- | --- | --- | --- | --- |
| **MutationController** | `pd-console/src/server/update/mutation-controller.ts`（205 行） | kind 注册表 + preferred(`release-manager`)/fallback(`legacy-console-updater`) 解析 + `X-PD-Mutation-Authority` / `X-PD-Mutation-Fallback-Reason` 头 | **零**（纯路由，`resolveAuthority()` 对未注册 kind 直接抛错） | **唯一入口** |
| **ReleaseManager** | `create-principles-disciple/src/update/release-manager.ts`（约 780 行）+ `release-manager-authority.ts`（231 行） | check（签名 channel → 候选评估 → shadow 对比）/ apply（编排：签名元数据 → 下载 → 校验 → installer 部署，一个事务）/ rollback（**拒绝**） | 自身零部署写入；写 `~/.pd/{trust,channels,releases}` 缓存 + staging；部署一律交 installer | **名义 preferred，实际 0 服务**（B1/B2） |
| **Console legacy updater** | `pd-console/src/server/routes/update.ts`（2340 行） | `/api/update/{check,apply,apply-full,rollback}` 的全部实际实现：npm registry 检查、tarball 解包、插件增量 diff、全量更新、备份恢复 | **最宽**：直接 copy 到 `~/.pd/runtime/*` 与 `~/.openclaw/extensions/principles-disciple`；备份进 `~/.pd/backups` | **事实上的执行权威**（4/4 kind） |
| **Installer** | `create-principles-disciple/src/installer.ts`（`install()` @2721） | 唯一合法 direct artifact deployment authority（ADR-0024 §2.1）：digest preflight → 备份 rename-swap → 组件部署 → console probe → host installers → commit → `commitInstallerActiveRecord()` | `~/.pd/runtime/*` + 扩展副本 + install manifest + `active.json` | 合法部署权威（RM.apply 与手工安装共用） |
| **legacy-migration** | `create-principles-disciple/src/update/legacy-migration.ts`（约 320 行） | legacy-overlay → dual-slot 迁移；`writeActiveRecord` 的原始唯一调用方；写 SPEC §12 history | `~/.pd/{trust,channels,releases,staging,transactions}` + `active.json` | **零生产接线**（仅测试引用） |
| **pd-cli** | `packages/pd-cli/src/commands/*`（60+ 命令，**无 update 命令**） | 无更新能力 | 零 | 非 authority |
| **Desktop Companion** | `pd-companion/src/lib/poller.ts`（`parseUpdateCheckResponse`）、`main/main.ts:675`（6h 轮询 `/api/update/check`，版本变化→通知/重启 console） | 通知 + 托管 console 进程 | 零（只写自身 state） | **只读消费者** |

**Surface → Authority**：

| Surface | 入口 | 实际 authority |
| --- | --- | --- |
| Web Console | `/api/update/{check,apply,apply-full,rollback}` → `handleUpdateRoute` → MutationController | check / apply-full：RM（flag+ready）否则 legacy；**apply / rollback：恒 legacy** |
| Desktop Companion | `/api/update/check`（只读，6h） | 无（消费 console 响应） |
| CLI | 无 update 命令 | 无 |

**Authority 结论**：map 上只有两个真实 mutation authority——installer（合法部署）与 console legacy updater（存量执行）；ReleaseManager 是「有决策权、生产无执行记录」的编排者；Companion / CLI 不在 mutation 面上。

---

## 2. Current Production Routing（源码逐条核实）

`handleUpdateRoute`（`update.ts:2324`）→ `syncReleaseManagerAuthority`（`:2262`，每请求幂等）→ `controller.dispatch`（`:2339`）。

| kind | preferred | 实际执行者（本 commit） | 门控 | fallback reason |
| --- | --- | --- | --- | --- |
| `check` | release-manager | RM **若** `release_manager_shadow` && base ready；否则 legacy | flag + metadata source + layout≠none + journal dir 可写 | `release_manager_shadow_disabled` / `release_manager_unavailable:<reasons>` / `installer_missing` / `authority_module_unavailable` |
| `apply`（插件增量） | release-manager | **恒 legacy** | RM 结构性 not-ready（`readiness.ready === false` 恒成立） | `release_manager_unavailable:rollback_not_available` |
| `apply-full`（全量） | release-manager | RM **若** `release_manager_write_authority` && base ready；否则 legacy | flag + base ready | `release_manager_write_disabled` / `release_manager_unavailable:<reasons>` / `release_manager_refused_pre_transaction:<reason>` |
| `rollback` | release-manager | **恒 legacy** | RM 结构性 not-ready（`ROLLBACK_AVAILABLE = false`） | `release_manager_unavailable:rollback_not_available` |

**关键事实（Phase 2 的前提）**：

- **RM 对全部 4 个 kind 都会被咨询**（在 `release_manager_shadow` 生效时——即生产默认值）：`syncReleaseManagerAuthority` 通过 flag 检查后调用一次 `createReleaseManagerAuthority(...)`，后者为 4 个 kind 各算一份 readiness（`release-manager-authority.ts:176-196`）。所以「优先进入 ReleaseManager」在语义上已经成立；`apply` / `rollback` 是由 **RM 自己报告 not-ready** 才降级的，不是被跳过。
  - 唯一例外：flag **被显式关闭**时不构造 authority，直接 `fallbackToLegacyForAllKinds('release_manager_shadow_disabled')`（`update.ts:2263-2266`）——此时 RM 完全不被咨询，降级理由由 wiring 声明而非 RM 报告。
- 两个治理开关均为 **default ON**（`feature-flag-contract.ts:229,238`，2026-09-07 Owner 毕业）。⇒ 今天唯一的实际门控是 **readiness**，不是 flag。
- 所有降级都带稳定 reason（headers + `describeGovernance().fallbackReason`）。**但：降级本身零日志**——`syncReleaseManagerAuthority` 只 `setFallbackReason`，不打印任何东西；只有 governed check 的 *refusal* 分支会 `console.log`。这是 Phase 2 要补的 "fail-loud" 缺口。

---

## 3. ReleaseManager Capability Matrix（PRI-709 之后的现状）

| Capability | 状态 | 证据 |
| --- | --- | --- |
| check（签名 channel → 候选 → shadow 对比） | **PASS** | `release-manager.ts:311-339` |
| download / verify / stage | **PASS** | `apply-payload.ts` + `trust-metadata.ts`（TUF 链 + whole-payload digest） |
| activate（经 installer） | **PASS** | `release-manager.ts:432-445` 调 `install(..., journal)` |
| apply-full 编排（含 journal 链） | **PASS** | journal `planned→downloaded→verified→…→confirmed`；测试 `tests/release-manager-apply.test.ts`（3） |
| apply（插件增量 diff） | **MISSING（结构性）** | 不是 RM 机制；RM 只服务签名全量 payload |
| rollback | **MISSING（结构性）** | `release-manager.ts:489-496` 显式拒绝；`ROLLBACK_AVAILABLE=false`（`release-manager-authority.ts:77`）；`rollback-policy.ts` 零消费方 |
| metadata source 供给 | **PARTIAL** | 读侧契约已建（`release-metadata-source.ts`，env / install.json 三层）；**发布侧不存在**（见 B1） |
| active record 锚点 | **PASS（代码）** | installer `commitInstallerActiveRecord()` @3165，journal-first，身份取自已部署 manifest |
| journal 覆盖 | **PASS** | RM→installer 同一 journal；legacy 三 kind 自 PRI-709 P0-3 起写**同一** journal（`legacy-mutation-journal.ts`） |
| history（Owner 可见流） | **PARTIAL** | 双流并存：console `<ws>/.pd/update-history.json`（活跃，PRI-702 起带 `authority`/`transactionId`）vs cpd `<pdHome>/logs/history.jsonl`（SPEC §12，唯一消费方 legacy-migration = 无生产接线） |
| gateway 协调 / host installer / 兼容性 preflight | **PASS** | installer 内承担，RM.apply 继承（`stopGateway: true`） |

---

## 4. 阻塞点（为什么 RM 还不能成为唯一生产路径）

### B1 — 签名元数据**没有发布侧**（P0，非本任务）
全仓 grep `PD_RELEASE_METADATA_URL` / `channels/stable.json`：命中的只有**读侧**（`release-metadata-source.ts`、console 三个调用点、installer 的 `persistReleaseMetadataSource()`）与文档。`.github/workflows/` 下**没有任何**工作流产出一条 `channels/<ch>.json` 或签名 release target。
⇒ 每个安装的诚实状态都是 `metadata_source_unconfigured`；RM 的 check / apply-full 生产可达性为 **0**。
本机实证（2026-09-10）：`~/.pd/install.json` 无 `releaseMetadataUrl`；`~/.pd/{trust,channels,releases}` 不存在。

### B2 — 现存安装全部被判为 legacy-overlay（P0，非本任务）
`ReleaseManager.inspect()` 的 layout 由 `active.json` 推导（`release-manager.ts:290-308`）。本机 `~/.pd/active.json` **不存在** ⇒ layout = `legacy-overlay` ⇒ `apply()` 抛 `legacy_layout_not_supported`（`:357-363`）。
`legacy-migration.ts` 是唯一的迁移实现，**零生产消费方**。⇒ 即使 B1 解决，RM 对现存安装仍不可服务。

### B3 — `apply`（插件增量 diff）不是 RM 的机制（结构性，Owner 决策项）
RM 只消费签名全量 payload；插件 diff 需要一套 RM 没有的「当前部署 → 目标部署」逐文件比对，且没有签名物。当前 UI 仍暴露该按钮，因此它**必然**走 legacy。

### B4 — `rollback` 未实现（结构性，Phase 2 计划项）
`ROLLBACK_AVAILABLE = false`；RM 更新路径**没有可回滚物**（installer 在 commit 点 `cleanupBackup()` 删除备份），而 legacy 回滚依赖 `update-history.json` 里的 `backupPath` —— 这是两种互相冲突的备份哲学。

### B5 — 残余：installer-only `bundled-…` releaseId 无法映射到缓存元数据（PRI-709 §2 ②）
纯 installer 产出的 `releaseId` 带 `bundled-` 前缀且无 `releases/<id>/metadata.json`，严格 current-release 比较无法解析 ⇒ check 保守地报「有更新」。只在元数据源可用后才可达。

---

## 5. 风险分析

| 面 | 风险 | 依据 |
| --- | --- | --- |
| **rollback** | 今天把 rollback 路由到 RM = 立刻功能失效：RM 拒绝 + legacy 回滚所需的 `backupPath` 只存在于 console history | B4；`update-history.ts:50` |
| **history** | 双流并存且**作用域错位**：被更新的 runtime 是机器全局（`~/.pd`），Owner 历史却是 per-workspace（`<ws>/.pd`）；cpd 侧的 SPEC §12 流在生产无引用 | `appendUpdateHistory`(console) vs `appendHistoryEvent`(cpd) |
| **journal** | 已收敛（legacy 三 kind 与 RM/installer 共用同一 journal）。残余：legacy 事务恒 `generation=1` 且不推进 `active.json`（代码内已显式记录为有意取舍） | `legacy-mutation-journal.ts:44-59` |
| **metadata source** | 供给面只有「人肉 env / install.json」，无 CI 供给 ⇒ 操作者覆盖（`explicit`/`env`）是唯一现实通道；`invalid` 短路不回退（防误配被静默吞掉） | `release-metadata-source.ts:116-130` |
| **installer compatibility** | RM.apply 完全委托 installer，行为等价；但 legacy 独有的 ext-copy 漂移修复 / skill 语言重放 / staging 残留清扫在 RM 路径下由 installer 全量部署覆盖或缺失 | `installer.ts`；`update.ts` legacy 专属分支 |
| **Desktop Companion** | 只解析 `{success, data:{hasUpdate:boolean, latestVersion?:string}}`，对 authority 无感知；RM 化后契约若保持不变则**不受影响** | `poller.ts:77-89`；`main.ts:675-693` |
| **既有安装** | 全部 legacy-overlay ⇒ 对「切除 legacy」这个动作而言是 High；对当前「单一入口 + 显式降级」形态而言是 None（语义不变） | B2 |

---

## 6. 修正后的本任务范围（code-facts-first）

| 任务书条目 | 修正后 |
| --- | --- |
| Phase 2「所有 mutation 必须优先进入 RM」 | **已成立**（RM 对 4 kind 全部被咨询）。本任务补：兼容 fallback 必须是**被声明的封闭集合** + 路由决策 **fail-loud**，并由测试证明枚举完备 |
| Phase 2「不要偷偷 fallback」 | 现状已无「静默」降级（每处都有 reason），但降级**无日志**、reason 是自由字符串（可以是任意值）⇒ 本任务加：封闭 reason 词汇 + 每次路由变更的显式日志 |
| Phase 3 生命周期验证 | 补：check（契约 + Companion）/ apply-full（RM 被调用 + history）/ failure（可追踪 + history failure）/ rollback（显式降级 + 不产生第二 authority） |
| Phase 4 收敛检查 | 输出 `PRI-729-convergence-result.md`：新生产路径形态 + 剩余 legacy 位置 + PRI-738 前置条件 |
| 「生产路径不再执行 legacy updater」 | **不可达**（B1–B4）——本任务以 fail-loud 的方式记录该事实与前置条件，不制造假象 |

### Phase 2 实施清单（对应上表）

| 改动 | 文件 |
| --- | --- |
| 兼容 fallback 的封闭 reason 词汇表（type + literals + prefixes + 校验函数） | `pd-console/src/server/update/mutation-controller.ts` |
| `setFallbackReason` 只接受已声明 reason；未声明 → fail-loud 举报（仍记录，不阻断 Owner 更新） | 同上 |
| 所有 fallback reason 构造点收敛到该词汇表（编译期约束） | `pd-console/src/server/routes/update.ts` |
| 路由决策变更的 fail-loud 日志（每个 kind 一次，仅状态变化时） | 同上 |
| `apply` 的阻塞原因与 rollback 解耦：新增结构性原因 `plugin_diff_not_supported` | `create-principles-disciple/src/update/release-manager-authority.ts` |

---

## 7. PRI-738（删除 legacy）前置条件

1. **B1 签名元数据发布管线**落地（CI 产出 `channels/<ch>.json` + 签名 release target + artifact manifest），并接通操作者供给面。
2. **B2 dual-slot 迁移接线**：把 `legacy-migration` 作为一次显式 updater 事务接入安装/更新路径，使 RM 的服务面从 0% 扩到 100%。
3. **B4 Phase 2 rollback**（same-version restore）证明并切换 `ROLLBACK_AVAILABLE`；在此之前 rollback 必须留 legacy。
4. **B3 `/apply` 增量 kind 的裁决**（移植进 RM payload 体系，或 UI 降级为 apply-full）。
5. **B5 bundled- releaseId → 缓存元数据映射**。
6. 以上全部关闭后，才可物理删除 `routes/update.ts` 的 mutation 实现与其测试（PRI-738）。

---

## 验收对照（Phase 1）

- ✅ Authority map（§1，7 个组件 + 3 个 surface）
- ✅ 当前阻塞点（§4，B1–B5，每条带代码/本机证据）
- ✅ 风险分析（§5，rollback / history / journal / metadata source / installer compatibility）
- ✅ 任务假设修正（§0、§6：以代码事实为准）
- ✅ 下一步前置条件（§7）
