# PRI-698 Phase 0 Architecture Audit — ReleaseManager Authority Convergence

| Field | Value |
| --- | --- |
| Status | Phase 0 Audit（只读调查，未修改任何生产代码 / runtime / 数据） |
| Date | 2026-09-08 |
| Source of truth | 本地 main 工作树 @ `3ec948741`；与 `origin/main`（`1a9b071714`）diff 仅 package.json 版本号 / dependabot / docs，**审查范围内源码一致** |
| Governing ADR | ADR-0023（Installation Architecture，Accepted）、ADR-0024（Runtime Mutation Governance，Accepted，D-1/D-2/D-7） |
| Related | PRI-659（Update Surface Contract Map）、PRI-661/PRI-672（adoption + wiring）、PRI-664（Installer Journal Integration）、PRI-698 Phase 1（apply orchestration）、`docs/architecture/PRI-698-phase4-preflight-analysis.md` |
| Method | 全部结论以当前 main 分支源码 + 本机生产安装（`~/.pd`）只读取证为准，不采信旧文档叙述 |

---

## 0. 结论先行（Readiness Verdict）

**ReleaseManager 目前不具备成为唯一 update authority 的条件。**

- 它的 **代码能力** 已经覆盖 check + apply-full（签名元数据 → TUF 校验下载 → 事务日志 → installer 部署），且两条治理开关 `release_manager_shadow` / `release_manager_write_authority` 已于 2026-09-07 毕业为默认开启。
- 但 **生产可达性为零**：本机实证（`~/.pd` 只读检查）显示 `PD_RELEASE_METADATA_URL` 无任何供给方、`~/.pd/trust|releases|active.json` 均不存在、安装布局被 RM 判为 `legacy-overlay` ⇒ 即使开关全开，RM 的 4 个 mutation kind 全部 explicit fallback 给 legacy console updater。
- 更严重的是三个 **状态真相缺口**（详见 §2/§3）：active.json 永远无人写入、事务日志与真实运行版本相互矛盾、console 更新路径零 journal。这意味着今天把 authority 切给 RM，会立刻产生"永久性 update available"与"错误恢复"两类故障。

**判定：Audit → 补状态锚点（P0）→ 才能进入 Authority 切换实施。** 不建议在本轮直接"让 Console updater 退出 mutation authority"。

> 范围勘误：任务书中的 `tests/update/`、`tests/server/routes/update/` 在仓库中不存在；实际测试位于 `packages/create-principles-disciple/tests/`（release-* / installer-journal*）与 `packages/pd-console/tests/server/routes/update*.test.ts`、`packages/pd-console/tests/server/update/`。本审计以实际路径为准。

---

## 1. Update Authority Map

影响 update 生命周期的全部入口（源码逐一核实；"mutation capability" 指对 `~/.pd/runtime` 与 host 扩展目录的写能力）：

| Component | File | Responsibility | Current authority | Mutation capability | Digest verification | Journal integration | Rollback capability | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **ReleaseManager**（编排者） | `packages/create-principles-disciple/src/update/release-manager.ts`（704 行）+ `release-manager-authority.ts`（202 行） | inspect / check / apply（编排：签名元数据 → 下载 → 校验 → 交给 installer 部署）/ rollback（拒绝） | **名义 preferred**（MutationController PREFERRED_MUTATION_AUTHORITY）；**实际生产 0 服务**（见 §2 门控） | 自身零部署写入（ADR-0024 §2.1 边界）；写 `~/.pd/trust`、`~/.pd/channels`、`~/.pd/releases` 缓存与 staging | **最强**：TUF 链（`trust-metadata.ts`）+ release-asset 全量 manifest 校验（`apply-payload.ts`） | ✅ 与 installer 共用同一 journal 文件（planned→downloaded→verified，之后 installer 续写至 confirmed） | ❌ `rollback()` 显式拒绝（`release-manager.ts:489-496`） | 低（当前不可达）；切换后高（见 §4） |
| **Console updater（legacy）** | `packages/pd-console/src/server/routes/update.ts`（2084 行） | /api/update/{check,apply,apply-full,rollback} 的实际实现：npm registry 检查、tarball 下载解包、插件 diff 增量更新、全量更新、备份恢复 | **事实权威**（4 个 kind 全部注册为 `legacy-console-updater`，`update.ts:1790-1793`） | **最宽**：直接 copyDirRecursive 到 `~/.pd/runtime/{plugin,console,core,host-runtime,pd-cli,...}` 与 `~/.openclaw/extensions/principles-disciple`；备份到 `~/.pd/backups` | **零**：全文件无 sha256/digest/verify（ADR-0024 F2 至今未修） | ❌ 零 journal 写入（grep 证实，仅注释提及） | ✅ 自有 `doRollbackUpdate`（依赖 update-history 里的 backupPath） | **高**：这是当前实际执行更新的路径，却是治理最弱的一环 |
| **Installer** | `packages/create-principles-disciple/src/installer.ts`（2953 行） | 唯一 direct artifact deployment authority（ADR-0024 §2.1）：backup rename-swap → 组件部署 → console probe → host installers → commit | 合法部署权威（install / update / reinstall） | `~/.pd/runtime/*` + 扩展副本（`pluginInstallDirs`，`installer.ts:150-153`）+ install manifest | ✅ digest preflight + `preflightSelfContainedReleaseAsset` | ✅ PRI-664 已接 journal（本机实证 3 份 install journal 到 confirmed） | ⚠️ 失败时 restoreBackup（`:686`）；**成功即 `cleanupBackup` 删除备份（`:2767`）**——commit 点之后无回滚物 | 中 |
| **pd-cli** | `packages/pd-cli/src/commands/*`（无任何 update 命令） | 无更新能力；只在 console.ts 等处提示 "Re-run installer: npx create-principles-disciple" | 无 | **零** | n/a | n/a | n/a | 无（非 authority，风险=0） |
| **Desktop Companion** | `packages/pd-companion/src/lib/poller.ts`（`/api/update/check` 只读轮询，6h 间隔）、`main/main.ts:628-652`（版本变化 → 重启 console） | 通知 + 托管 console 进程；不执行更新 | 无（消费者） | **零**（只写自身 state 文件，符合 ADR-0024 D-1 第 4 条） | n/a（信任 console 响应） | n/a | n/a | 低 |
| **legacy-migration**（潜在写入者） | `create-principles-disciple/src/update/legacy-migration.ts`（317 行） | legacy-overlay → dual-slot 迁移；**唯一**的 `writeActiveRecord` / `ensurePdHomeLayout` 调用方 | 已建成、**无生产接线**（零外部消费方，同 ADR-0024 F3） | `~/.pd/{trust,channels,releases,staging,transactions}` + active.json | ✅（消费 trust-metadata） | ✅ | 自有 history 事件（`update-history.ts` 的 `appendHistoryEvent`） | 低（不运行即无风险；但它是 RM 可用的前置） |
| **MutationController**（纯路由） | `pd-console/src/server/update/mutation-controller.ts`（204 行） | kind 注册表 + preferred/fallback 解析 + `X-PD-Mutation-Authority` / `X-PD-Mutation-Fallback-Reason` 头 | 非 authority（自身零写入，有迁移测试断言） | 零 | n/a | n/a | n/a | 无 |

**Authority 结论**：map 上只有两个真实 mutation authority（installer=合法、console updater=存量债务）；ReleaseManager 是"有决策权、无执行记录"的编排者；CLI 与 Companion 不在 mutation 面上。

---

## 2. Capability Matrix（ReleaseManager）

| Capability | 状态 | 证据与说明 |
| --- | --- | --- |
| check update | **PASS**（代码）/ **生产不可达** | `release-manager.ts:311-339`：签名 channel 文档（TUF target `channels/<ch>.json`）+ `evaluateReleaseAdvancement` 策略 + legacy shadow 对比。但生产 `metadataBaseUrl` 无供给（见门控） |
| download | **PASS** | `apply-payload.ts` `downloadReleaseAsset`：TUF 精确 digest 校验的 artifact 下载进事务 staging |
| verify | **PASS** | `trust-metadata.ts`（TUF 链）+ `extractAndVerifyReleaseAsset`（identity + whole-payload digest preflight） |
| stage | **PASS** | `~/.pd/staging` + journal planned→downloaded→verified（`release-manager.ts:410-426`） |
| activate | **PASS**（经 installer） | `release-manager.ts:432-445` 调 `install(..., journal)`；installer 走 staged→probed→activated→confirmed，本机 journal 实证该链路工作 |
| rollback | **MISSING** | 三重缺失：① `RM.rollback()` 显式拒绝（`release-manager.ts:489-496`）；② `rollback-policy.ts` 零消费方；③ installer 成功即删备份（`installer.ts:2767`），RM 更新**没有可回滚物**；legacy 回滚只认 update-history 里的备份目录 |
| history | **MISSING** | RM 不写任何 update-history。唯一的 cpd 侧实现 `update-history.ts:appendHistoryEvent` 只有 `legacy-migration.ts:293` 一个消费方；console 私有实现（`routes/update-history.ts`）与之**双轨并存、schema 不同** ⇒ ADR-0024 D-7 未收敛 |
| journal | **PASS**（自身纪律）/ **系统级 PARTIAL** | RM 与 installer 共用 11 态 journal（同一文件续写）。但 journal 只记录 installer/RM 的 mutation——**console updater 的 mutation 零 journal**（本机实证：journal 最后 confirmed=1.147.5 @09-06，实际 runtime=1.230.2），ADR-0024 D-2"所有 mutation 强制 journal"在系统层面未成立 |
| gateway coordination | **PASS** | RM.apply 传 `stopGateway: true` → installer 内部 stop/probe/restart（`installer.ts:743+`）；legacy 路径另有自己的协调（有 Gate A 特征化测试保护） |
| host installer | **PASS** | `install()` 内 `runHostInstallers`（`installer.ts:2728`）；OpenClaw 扩展副本由 `pluginInstallDirs` 覆盖（canonical plugin 目录 + `~/.openclaw/extensions/principles-disciple`） |
| compatibility preflight | **PASS** | installer 在 `install()` 内执行 `runLegacyRuleContractPreflight`（`installer.ts:2497`，子进程 `pd runtime compatibility-scan`，fail-closed 状态分类）；RM.apply→install 即继承。console legacy 路径另有自己的 read-model 预检（`update.ts:60-72`），双实现冗余但安全 |

**生产可达性门控（本机只读实证，2026-09-08）**：

| 门控 | 现场状态 | 后果 |
| --- | --- | --- |
| `PD_RELEASE_METADATA_URL` env | **全仓无供给方**（仅 console 路由 `update.ts:1874/1939/2028`、测试、文档引用；installer/CI/配置均不设置）；本机未设置 | `metadata_source_unconfigured` ⇒ 4 个 kind 全部 not ready |
| `~/.pd/trust`、`~/.pd/releases` | 不存在 | 即使设了 URL，check 的 TUF 元数据链无根 ⇒ `metadata_refresh_failed` |
| `~/.pd/active.json` | **不存在**（且无人会写，见 §3 F-2） | `inspect().layout` 落到 `legacy-overlay`（扩展目录标记存在）⇒ `apply()` 抛 `legacy_layout_not_supported` |
| `~/.pd/transactions` | 存在（3 份 install journal，PRI-664 生效） | 唯一通过的 readiness 条件 |
| 特性开关 | 两个开关均 default ON（`feature-flag-contract.ts:229,238`，2026-09-07 Owner 毕业） | 开关已不是障碍——**障碍在供给与状态** |

> 文档漂移提示：`docs/architecture/PRI-698-phase4-preflight-analysis.md:30` 仍写 "release_manager_shadow (quiet, default **off**)"，与当前注册表（default ON）不符；同文 §1 描述的 "installer 不写 journal" 也已被 PRI-664 取代。建议随 Phase 2 一并修订。

---

## 3. Legacy Updater Dependency Analysis（`pd-console update.ts` 未迁移能力清单）

按"如果明天删掉 legacy 实现，会丢什么"逐项核对：

| 能力 | legacy 位置 | RM 侧现状 | 迁移缺口 |
| --- | --- | --- | --- |
| **UI contract（/check 响应体）** | `doCheckForUpdates`（`update.ts:443`）→ `{hasUpdate, currentVersion, latestVersion, codexInstalled}`，degraded ERR-002 形状 | governed check **逐字节复用 legacy 计算的响应体**（`update.ts:1912-1917`），契约未破坏 | **无缺口**（但 RM 自身没有产出该契约的原生实现——阴影对比跑完仍由 legacy 计算正文） |
| **API response shape（apply/apply-full）** | `doApplyUpdate` 返回 `{success,message,reason?,nextAction?,newVersion?,updatedFiles?,partialUpdate?}`；`doInlineFullUpdate` 返回 `{...,requiresRestart}`，前端 `validators.ts:2332` 校验 | RM apply-full dispatch 已映射到 legacy full-update 契约（`update.ts:1958-1998`） | 增量 /apply 的 `updatedFiles`/`partialUpdate` 字段无 RM 对应物（见 §5 P2-7） |
| **增量更新（plugin diff，kind=`apply`）** | `doApplyUpdate`（`update.ts:536-807`）：diff → 逐文件覆盖 → ext 副本漂移修复（PR #1526） | **RM 结构性不实现**（`release-manager-authority.ts:153-156`：plugin diff 不是 RM 机制，恒 `rollback_not_available` fallback） | **最大缺口**：UI 上的"增量更新"按钮只有 legacy 能服务 |
| **gateway restart** | `doInlineFullUpdate` 自带 stop/restart + Gate A 特征化测试 | installer 内等价能力（RM 路径继承） | 无缺口 |
| **backup handling** | 更新前把插件树**复制**进 `~/.pd/backups` 保留目录（CP-4/R5），backupPath 记入 history → /rollback 的唯一回滚物 | installer 是 **rename-swap + 成功即删**（commit 语义），RM 更新无回滚物 | **缺口**：两种备份哲学冲突；RM 路径的回滚必须靠 dual-slot previous 槽（Phase 2） |
| **history writing** | `appendUpdateHistory`（workspace 私有实现，12 处调用）写 `.pd/update-history.json`（含 refusal/failure/backupPath） | RM 路径零写入 | **缺口**：UpdatePage 历史区与回滚入口对 RM 更新不可见；且 D-7 要求收敛为 cpd 单实现，至今双轨 |
| **compatibility checks** | console 侧 read-model 预检（`update.ts:60-72`）+ installer 侧子进程扫描（`:2497`） | RM→install 继承 installer 扫描 | 无缺口（双实现冗余可后续收敛） |
| **其他 legacy 专属** | staged-package identity 守卫、版本推进 drift 守卫（`:1502-1531`）、skill 语言重放（`:1439`）、OpenClaw 扩展副本刷新（CP-5，`:1448-1453`）、resolution links + quarantine（PRI-665）、`sweepStaleUpdateTempDirs`（CP-8） | identity/推进守卫由 RM 的 release-policy + asset manifest 等价覆盖且更强；扩展副本/skill 语言由 installer 覆盖；**staging 残留清扫与 resolution-link quarantine 为 legacy 专属** | 小缺口：staging 清扫应随 RM 常态化 |

**额外事实（状态真相缺口，本审计核心发现）**：

- **F-1（journal 与 runtime 矛盾）**：本机 `~/.pd/transactions/` 最后两笔 confirmed 记录 `productVersion 1.147.5`（09-06 20:54 / 21:13），而 `~/.pd/runtime/plugin/package.json` = **1.230.2**，mtime（09-06 20:50）早于两笔事务。即：**journal 的 confirmed 并不可靠地描述 runtime 实际状态**；若以此做恢复/-active 推导，会还原到错误版本。
- **F-2（active.json 无人写）**：`writeActiveRecord` 全仓唯一调用点在 `legacy-migration.ts:278`；installer 与 RM.apply 的成功路径都不写。dual-slot 状态机（active/previous/generation）**没有锚点**——即使 RM.apply 成功，下次 `inspect()` 仍报旧 release ⇒ "check 说有更新 → apply → check 仍说有更新" 的永久循环。
- **F-3（历史三轨）**：同一台机器上存在三套互不一致的记录——① 事务 journal（机器全局，只记 installer/RM）；② workspace `.pd/update-history.json`（per-workspace，console 私有 schema，本机 7 条，记录了 1.76.1→1.230.0 的 console 更新、零 journal 对应）；③ plugin package.json（console/Companion 的版本读取源）。被更新的 runtime 是机器全局的，历史却是 per-workspace 的 ⇒ 记录与被描述对象作用域错位。版本真相（active.json vs package.json vs npm registry）三者并存，违反 P4。

---

## 4. Migration Risk Analysis（如果现在让 Console updater 退出 mutation authority）

| 受影响面 | 影响 | Breaking risk |
| --- | --- | --- |
| **Desktop Companion** | 只消费 `/api/update/check`（governed check 提供 byte-identical legacy 响应体）+ 版本监视（读 plugin package.json，installer 会刷新两份插件目录）。RM 化后行为不变 | **Low** |
| **Web Console UI** | ①"增量更新"（/apply）无 RM 实现，按钮直接失效；②UpdatePage 历史区/回滚按钮依赖 per-workspace history + 备份目录，RM 更新两者皆不产生 → 历史空白、无法回滚；③用户对"更新了但没有历史记录"零容忍 | **High** |
| **CLI** | 无更新命令，无影响 | **None** |
| **OpenClaw integration** | gateway stop/restart、扩展副本刷新、skill 语言、host installer 全部由 installer 承担（RM.apply 传入 host/stopGateway）；legacy 增量路径独有的 ext-copy 漂移修复在 RM 全量部署下被覆盖 | **Low** |
| **existing installation** | 全部现存安装从 RM 视角都是 `legacy-overlay`（无 active.json/releases）⇒ apply 直接 `legacy_layout_not_supported`；必须先经 legacy-migration 迁入 dual-slot，而该迁移**无生产接线**；叠加元数据源缺失，RM 当前对 100% 的现存安装不可服务 | **High**（对"切换"这个动作而言） |
| **恢复语义** | F-1：journal 不能作为恢复依据；若切走 legacy 而 RM 又依赖该 journal 做恢复感知，故障恢复会还原错误版本 | **High** |

**总评**：现架构（preferred=RM、fallback=legacy、每请求 `X-PD-Mutation-*` 头可观测）是正确的过渡形态；**当前不可摘除 legacy**。摘除的前置 = §5 的 P0/P1 关闭。

---

## 5. Recommended Next Implementation Steps

> 原则遵循任务书固定链：Audit → Authority Map → Decision → Implementation → Delete old path。以下 P0 不做完，"Delete old path" 不可启动。

### P0（必须先做）

**P0-1 供给 release metadata 源与配置面**
- why：两个开关已 default ON 但 RM 生产 0 服务——毕业是空转。`PD_RELEASE_METADATA_URL` 目前是"只能手工设的 env"，没有 installer 写入、没有配置文件落点、没有 CI 供给；`~/.pd/trust` 无人创建。
- 做什么：决定 metadataBaseUrl 的正式来源（建议：installer 写入 `~/.pd/install.json` 的新字段或独立配置，console 读取；env 作为覆盖项），发布管线补齐 `channels/<ch>.json` + `releases/<id>/metadata.json` + artifact 的签名 target；`ensurePdHomeLayout` 接入安装/迁移路径。
- expected benefit：governed check 与 apply-full 真正可达；shadow 对比开始产生真实 parity 证据。
- risk：低——不可达时全部 explicit fallback（现状语义不变）；主要是管线工作量与 URL 可用性运维。

**P0-2 在 commit 点锚定 active record（dual-slot 状态锚）**
- why：F-2。不写 active.json，RM.apply 成功后状态机不前进，产生永久"有更新"循环与错误代际。
- 做什么：`install()` confirmed 点（或 RM.apply 成功返回前）调用 `writeActiveRecord`，**release 身份必须取自实际部署的 artifact manifest**，而不是 installer bundle 版本号（F-1 的教训）；同时裁决唯一版本真相（建议：active.json 为 dual-slot 权威，plugin package.json 降级为派生展示，P4）。
- expected benefit：inspect/check/apply 的状态闭环成立；journal confirmed ⇔ active record 可互相校验。
- risk：中——触碰 commit 关键路径；必须有 installer-journal-sequence 类回归测试；身份来源改错会放大 F-1。

**P0-3 让 journal 覆盖所有 mutation（D-2 合规）**
- why：F-1/F-3。ADR-0024 D-2 说"所有 runtime mutation 必须走 journal"，但现实是实际执行更新的 console 路径零 journal——journal 现在不是 runtime 的 single source of truth。
- 做什么（二选一，倾向 a）：a) console 三条 mutation 路径以 `actor=console-updater` 写入同一 journal（复用 `appendJournalTransition`，不建第二套）；b) 在 P0-1/P0-2 落地后，把 legacy 路径的 mutation 能力禁用（路由保留、执行拒绝），强制走 RM。
- expected benefit：恢复感知读取（Phase 3 recovery）有正确输入；audit 面完整。
- risk：a 低（追加写）；b 高（等价于提前切换，依赖 P0-1/P0-2 完成）。

### P1（之后做）

**P1-4 History 收敛（D-7）+ RM 更新可回滚的历史与备份**
- why：UI 历史与回滚入口是 Owner 可见性的一部分；两套 history 实现 schema 不同（console: id/timestamp/from/to/success/kind/backupPath；cpd: kind/direction/outcome）。
- 做什么：console 的 `routes/update-history.ts` 收敛为读模型，写入统一走 cpd `update-history.ts`；RM.apply 的 confirmed/refused/failed 终态同步追加 history；裁决 history 作用域（runtime 是机器全局的，建议 history 也上收到 `~/.pd/`，workspace 文件保留为派生缓存或迁移期双写）；更新型事务在 commit 前保留备份（或写入 previous 槽）直到 Phase 2 回滚可用。
- expected benefit：RM 更新在 UI 上可见、可回滚；单一审计源。
- risk：中——作用域迁移涉及既有 7 条生产数据；schema 映射要保真。

**P1-5 现存安装的 dual-slot 迁移接线**
- why：legacy-migration/bootstrap-protocol 零生产消费方；不接线则所有现存安装永远被 RM 拒绝。
- 做什么：把迁移作为一次显式 updater 事务（写 journal + history + active record），在 P0-2 的锚点语义上运行；先在本机 shadow 验证。
- expected benefit：RM 的服务面从 0% 安装扩展到 100%。
- risk：中——单向迁移，需要自己的回滚说明与验收。

**P1-6 Rollback Phase 2（same-version restore）**
- why：capability matrix 中唯一 MISSING 的核心能力；`rollback-policy.ts` 已建成无消费方。
- 做什么：按既有 Phase 2 计划，先证明 same-version restore，再替换 legacy backup-dir 回滚；`ROLLBACK_AVAILABLE` 常量翻转即开关。
- expected benefit：完成能力矩阵；"Delete old path" 的最后一个功能前置。
- risk：中——回滚错误比更新失败更糟，必须先有恢复演练。

### P2（可以延后）

**P2-7 裁决增量 /apply 的命运**
- why：plugin-diff 不是 RM 机制（结构性 not-ready）；UI 仍暴露该按钮。
- 做什么：Owner 决策——a) 把增量机制移植进 RM 的 payload 体系（工作量大）；b) 在 UI 降级/移除增量入口，统一走 apply-full（签名全量下载，代价是带宽）。建议 b + 在 check 响应里给出体积提示。
- expected benefit：消灭"UI 有按钮但永远 fallback"的死面。
- risk：低——功能取舍，非正确性。

**P2-8 文档与冗余收敛**
- why：`PRI-698-phase4-preflight-analysis.md` 的开关默认值与 installer-journal 描述已过期；console 与 installer 双兼容预检、双 backup 位置语义需要在 Phase 2 文档里定稿。
- risk：无。

### 明确不做（本轮边界）

- 不删除 legacy updater、不翻转 ROLLBACK_AVAILABLE、不迁移数据、不修改 runtime——全部留待 P0 关闭后按 Decision → Implementation → Delete old path 推进。

---

## 6. Linear Update

完成后在 **PRI-698** 追加评论（不新建 issue），标题 `Phase 0 Architecture Audit Completed`，内容含：本报告路径、§0 结论、§3 三条核心发现（F-1/F-2/F-3）、建议下一步（P0-1/2/3）。

---

## 验收对照

- ✅ 完整 authority map（§1，7 个组件）
- ✅ capability matrix（§2，11 项 PASS/PARTIAL/MISSING）
- ✅ 明确 readiness 判断（§0：NOT READY + 门控实证）
- ✅ 风险列表（§4 + 各步骤 risk）
- ✅ 下一步实施建议（§5，P0/P1/P2，每项 why/benefit/risk）
- ⏳ Linear 工单审查记录（§6，评论提交后达成）
