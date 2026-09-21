# PD Package / Release System Audit

> 调查性质：只读调研（无代码/配置变更、无 PR、无工单）。
> 调查日期：2026-09-20 · 基线：`main` @ `f3ef3102` · 工作树干净。
> 方法：`git ls-files` + 源码/CI/配置直读；文档仅作线索。事实均附 `文件:行`；推断单独标注。
> 目的：为"是否引入第三方发布工具（Changesets / Nx Release / Lerna / semantic-release）替代部分自研能力"提供事实依据。本报告不给实施方案。

---

## Executive Summary

**当前 PD 发布体系中，适合第三方替换的只有"7 个 npm 包的版本号决策 + changelog 生成"这一层；必须自研保留的是 ReleaseManager/installer/签名元数据构成的"已安装运行时更新链"——因为所有候选第三方工具都止步于"把包发布进 registry"，而 PD 的真实发布终点是"把一个签名过的 runtime bundle 安全地装进并升级 `~/.pd/runtime`"，这中间隔着安装器打包、TUF 信任链、事务日志和 `active.json` 提交，没有任何第三方工具覆盖这段。**

一句话边界：**Changesets 能替代的是"版本号怎么变"，替代不了"版本号之外的一切"；而 ReleaseManager 恰恰生活在"版本号之外"的那半边。**

---

## Architecture Diagram

```
┌──────────────────────────── 构建/发布侧（CI） ────────────────────────────┐
│                                                                            │
│  developer ─PR→ main ──(push path-filter)──▶ publish-npm.yml               │
│                                    │   ├─ detect（变更包矩阵，AUTO）        │
│                                    │   ├─ release-reproducibility（门）     │
│                                    │   ├─ bump 分析（conventional commits）  │
│                                    │   └─ Publish 1/7 → 7/7（依赖序，AUTO）  │
│                                    │        npm publish --provenance        │
│                                    │   companion-release.yml（companion-v*） │
│                                    └─ release-metadata.yml（人工 dispatch） │
│                                          ├─ build-release-asset ×3 平台     │
│                                          ├─ ed25519 签名 + TUF 链           │
│                                          ├─ gh-pages（channels/releases）   │
│                                          └─ pd-assets GitHub Release（tar） │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │
        npm registry ◀─ 7 packages   │        ClawHub · gh-pages · GH Release
                                     ▼
┌──────────────────────────── 更新/安装侧（本机） ───────────────────────────┐
│                                                                            │
│  npx create-principles-disciple ──▶ ~/.pd（install.json / active.json）     │
│                                                                            │
│  ReleaseManager  packages/create-principles-disciple/src/update/           │
│    inspect() / check() / apply()                                           │
│      check: channels/<c>.json（TUF 验签）→ releases/<id>/metadata.json      │
│      apply: trusted download → sha256 校验 → journal → installer()         │
│        installer.ts ──▶ ~/.pd/runtime（双 slot）+ active.json 提交          │
│                                                                            │
│  Console /apply-full ──▶ bootstrap-executor（独立进程）──▶ apply()           │
└────────────────────────────────────────────────────────────────────────────┘
             （两条链唯一的汇合点：产品版本来自根 package.json，
               经 CI 盖章进 _release/product-identity.json
               ——ReleaseManager 从不读任何 package 版本）
```

---

## Part 1 — Package Inventory

### 1.1 全部 package（29 个被 git 跟踪的 package.json）

**A. 规范 workspace 成员（`package.json:7-9` `workspaces: ["packages/*"]`，共 10 个）**

| Package name | 路径 | private | version | 类型 |
|---|---|---|---|---|
| `@principles/core` | `packages/principles-core` | 否 | 1.74.1 | npm package（发布单元 1/7） |
| `@principles/install-layout` | `packages/install-layout` | 否 | 0.2.0 | npm package（发布单元 2/7） |
| `@principles/host-runtime` | `packages/host-runtime` | 否 | 0.1.0 | npm package（发布单元 3/7） |
| `@principles/codex-adapter` | `packages/codex-adapter` | 否 | 0.1.0 | npm package（发布单元 4/7） |
| `@principles/pd-cli` | `packages/pd-cli` | 否 | 1.74.1 | npm package + CLI bin `pd`（发布单元 5/7） |
| `principles-disciple` | `packages/openclaw-plugin` | 否 | 1.76.1 | plugin（npm + ClawHub，发布单元 6/7） |
| `create-principles-disciple` | `packages/create-principles-disciple` | 否 | 1.74.1 | installer component（发布单元 7/7） |
| `@principles/pd-console` | `packages/pd-console` | **是** | 0.1.0 | application（**不发 npm**，仅随 installer 打包分发） |
| `@principles/pd-companion` | `packages/pd-companion` | **是** | 0.1.2 | application（Electron .exe，走 GitHub Release） |
| `@principles/website` | `packages/website` | **是** | 1.0.0 | application（VitePress，Cloudflare Pages） |

**B. 嵌套 bundle 副本（在 installer 内，由 `bundle-plugin.mjs` 生成、但被 git 跟踪）**

| Package name | 路径 | private | version | 说明 |
|---|---|---|---|---|
| `@principles/core` | `packages/create-principles-disciple/core` | 否 | **1.278.6** | 与 A 组同名不同版本（打包时被 npm registry 的实际版本覆写） |
| `@principles/install-layout` | `.../install-layout` | 否 | **0.2.3** | 同上（canonical 0.2.0） |
| `@principles/pd-cli` | `.../pd-cli` | 否 | **1.147.11** | 同上（canonical 1.74.1） |
| `@principles/pd-console` | `.../console` | 是 | 0.1.0 | 同上 |

> **事实（重要）**：4 个 name 在仓内存在两份（`packages/*` 与 `packages/create-principles-disciple/*`），版本互相漂移；`git ls-files` 确认这 4 个嵌套 `package.json` 均被跟踪。嵌套副本的依赖被改写为 `file:` 引用（`bundle-plugin.mjs:444-484`），canonical `packages/pd-cli` 用的是 semver range（不是 `file:`）。任何按 package.json 做 workspace 全量扫描的工具都会撞上这批"同名不同版本"的幽灵成员。

**C. 非发布单元（internal / fixture，11 个）**

| Package name | 路径 | private | version | 类型 |
|---|---|---|---|---|
| `principles-disciple-monorepo` | 根 | 是 | 1.76.1 | other（聚合根；**产品版本权威，见 Part 2**） |
| `homepage-demo` | `packages/website/video/homepage-demo` | 是 | — | other（视频 demo 资产） |
| `@principles/nocturnal-benchmark` | `scripts/nocturnal` | 否 | 0.1.0 | internal library（离线评测） |
| `@principles/nocturnal-trainer` | `scripts/nocturnal/trainer` | 否 | 0.1.0 | internal library |
| `inventory-cli` / `report-exporter` / `orders-api` 等 5 个 fixture | `scripts/dev/pipeline-closure-lab/scenarios/**` | 是 | 1.0.0–2.4.1 | other（实验室夹具） |
| `trap-00/01/03-*` ×3 | `tests/e2e-fixtures/**` | 否 | 1.0.0 | other（e2e 陷阱夹具） |

### 1.2 Package 依赖图

**A 类：由 package.json 明确表达（canonical packages/\*，按依赖方向）**

```
@principles/codex-adapter ─▶ @principles/core, @principles/host-runtime, @principles/install-layout
@principles/host-runtime  ─▶ @principles/core, @principles/install-layout
@principles/pd-cli        ─▶ @principles/core, codex-adapter, host-runtime, install-layout, principles-disciple
principles-disciple(插件) ─▶ @principles/core (dependencies)；@principles/host-runtime (devDependencies)
@principles/pd-companion  ─▶ @principles/install-layout
@principles/pd-console    ─▶ core, host-runtime, install-layout, create-principles-disciple, principles-disciple
create-principles-disciple─▶ @principles/install-layout（^0.2.0）
@principles/website       ─▶ @principles/core (devDependencies)
@principles/core          ─▶ （无内部依赖，位于最底层）
```

**B 类：由脚本/复制逻辑隐含（package.json 里没有的边）**

| 隐式边 | 证据 |
|---|---|
| `@principles/pd-console` ─▶ `create-principles-disciple`（console 变更强制 installer 重发，但不是 installer 的 package.json 依赖） | `publish-npm.yml:225-238`（"console ships only in the installer"）；`bundle-plugin.mjs:54-55`（CONSOLE_SRC/DEST 复制） |
| installer 打包时把 6 个 sibling 包（plugin/pd-cli/console/core/host-runtime/codex-adapter/install-layout/**release-manager**）dist 复制进自身载荷 | `bundle-plugin.mjs:50-63,70-71`（复制映射）、`create-principles-disciple/package.json:20-33`（`files[]` 白名单） |
| 嵌套副本依赖在打包时被改写成 `file:` 引用 | `bundle-plugin.mjs:444-484` |
| 嵌套副本的版本不来自源码树，而是打包时 `npm view <pkg> version` 现取 | `bundle-plugin.mjs:689-728` |
| runtime pins（`plugins/principles-disciple/runtime-version.json`）指向"必须存在于 npm"的版本，与 workspace 版本刻意不同步 | 该文件 `note` 字段原文："Pins must reference versions that EXIST on npm (1.74.1 was a working-tree-only number — the npm line is 1.250+)" |
| `openclaw.plugin.json` 与 plugin `package.json` 两个 version 字段靠 sed 对齐 | `publish-npm.yml:469-495`；`scripts/sync-version.sh:57-62` |

---

## Part 2 — 当前版本管理机制

### 2.1 当前版本来源是什么？

**没有单一来源；至少 6 层并行版本号，各自权威不同：**

| # | 位置 | 当前值 | 写入者 | 读取者 |
|---|---|---|---|---|
| 1 | 根 `package.json` `version`（**产品版本权威**） | 1.76.1 | CI sed（`publish-npm.yml:479-486`，仅 plugin 路径）+ `scripts/sync-version.sh:64-69` | `scripts/resolve-product-version.mjs:17-19`（发布列车的产品身份盖章） |
| 2 | 各发布包 `package.json` `version` | 见表 | CI（**直接文件编辑**，非 `npm version`：`.github/actions/publish-npm-package/action.yml:190+`；ERR-131 后改为纯编辑） | npm 依赖解析、列车顺序门 |
| 3 | `packages/openclaw-plugin/openclaw.plugin.json` `version` | **1.198.1（与 1.76.1 漂移）** | CI sed（`publish-npm.yml:471-474`，含 `dist/` 副本） | OpenClaw 宿主加载器 |
| 4 | `plugins/principles-disciple/runtime-version.json` | codexAdapter 0.4.3 / hostRuntime 0.7.4 / **core 1.284.13** | **纯人工**（note 字段要求配 `check:runtime-pin`） | `check:runtime-pin` → `verify-pinned-runtime-capability.cjs`（`$pd-setup` 装哪些版本） |
| 5 | installer `package.json` 内 `pd.bundledPluginVersion` | 1.245.2 | 打包时盖章（`bundle-plugin.mjs:641-643`） | 诊断 |
| 6 | git tag `v<semver>`（119 个，另有 `companion-v*`） | 最新 v1.77.1 | CI 发布成功后 `git tag -a`（`publish-npm.yml:568`、`action.yml:400`） | `publish-npm.yml` 周更跳过逻辑（commits since last tag） |
| 7 | 安装态 `~/.pd/active.json`（productVersion/releaseId/generation） | 本机 1.74.1（据 audit） | installer 提交点（`installer.ts:305`→`transaction-journal.ts:289` `writeActiveRecord`，journal-first） | `ReleaseManager.check/apply`（`release-manager.ts:229,376`） |
| 8 | 签名渠道元数据 `channels/<channel>.json`、`releases/<id>/metadata.json`（gh-pages） | — | `publish-release-metadata.mjs`（`release-metadata.yml:555`，需 `PD_RELEASE_SIGNING_KEY`） | `ReleaseManager.check()`（`release-manager.ts:523`，TUF 验签） |

**架构规则（有据）**：组件包版本明确**不得**充当产品版本。`docs/adr/0023-pd-installation-architecture-decisions.md`：组件 package.json version 是"发布过程的输入，不得充当产品版本"；更新系统设计文档：`"a release never borrows its product version from an npm package's latest"`（`docs/superpowers/specs/2026-08-25-commercial-grade-update-system-design.md`）。

**已知漂移（事实记录在案）**：`docs/audit/update-chain-expert-brief-20260919.md` §3.4"版本号四张皮"——active.json 1.74.1 / main 根 manifest 1.76.1 / npm `principles-disciple` 2.0.0（9/19 由 push 自动列车经 major 发布）/ npm installer 线另有 1.143.2、1.284.20 等；遗留单 PRI-849"版本权威统一"未闭环。

### 2.2 一次真实发布需要修改哪些地方？

以 `full-product` 列车（7 包全发）为例：

**CI 自动完成（不 commit 回 main，仅在 runner 内）：**
1. 7 个发布包各自的 `package.json` version（列车 bump，直接编辑）；—— `action.yml:190+`
2. `packages/openclaw-plugin/openclaw.plugin.json` 及其 `dist/` 副本版本（sed）；—— `publish-npm.yml:469-495`
3. 根 `package.json` `version`（sed，产品版本）；—— `publish-npm.yml:479-486`
4. `README.md` / `README_ZH.md` 版本徽标（sed）；—— `publish-npm.yml:469-495`
5. installer 载荷内 `_release/product-identity.json`（产品身份盖章）；—— `action.yml:267-290`
6. git tag `v<version>` + GitHub Release（softprops/action-gh-release）；—— `publish-npm.yml:568,575`
7. ClawHub marketplace 同步（`clawhub package publish`，continue-on-error）；—— `publish-npm.yml:641`

**人工必须完成：**
8. `plugins/principles-disciple/runtime-version.json` 三个 pins（随后跑 `check:runtime-pin`；`MERGE gate` 是自动验证，但**改值是人工**）；
9. `release-metadata.yml`（`workflow_dispatch`，`mode=publish`，持 `PD_RELEASE_SIGNING_KEY`）——渠道指针与签名元数据发布；
10. `companion-v*` tag 推送（若要发 Companion .exe）；
11. CHANGELOG 起草——`docs/process/release/release-go-no-go-checklist.md:108-109` 明确记录过"CHANGELOG 过期 = BLOCKED"。

**遗留但未接线（事实：无 workflow/npm script 引用）：** `scripts/release.sh`（交互式 `npm whoami`→bump→sed 6 文件→publish）与 `scripts/sync-version.sh`（从 git tag 同步 6 个文件，亲读确认目标：plugin package.json、installer package.json、openclaw.plugin.json、根 package.json、README×2）。推断为 semantic-release 时代遗产。

---

## Part 3 — ReleaseManager 调查（重点）

> 定位修正：**`ReleaseManager` 名不副实**。它不是"发布管理器"，是"已安装运行时的**更新管理器**"（类自述："inspect / check / apply only … performs ZERO deployment-side filesystem mutation"，`packages/create-principles-disciple/src/update/release-manager.ts:265`）。评估替换时把它当发布管理器会得出错误结论。

### 3.1 当前职责

| 能力 | ReleaseManager 是否负责 | 是否 PD 特有 | 证据 |
|---|---|---|---|
| version bump（包版本） | **NO** | NO | 在 CI：`action.yml:190+`、`publish-npm.yml:443,455` |
| changelog 生成 | **NO** | NO | GitHub workflow 从 PR 合成：`action.yml:348-365` |
| git tag 创建 | **NO** | NO | `action.yml:400` |
| npm publish | **NO** | NO | `action.yml:372` |
| 依赖/影响分析 | PARTIAL（仅版本序/降级守卫） | NO | `release-policy.ts:78-152`（`sequence_regression`/`downgrade_blocked`） |
| 发布分支 / 预发渠道 | PARTIAL（渠道是指针元数据，非分支） | YES | `product-identity.ts:10`、`channel-metadata.ts:53` |
| **artifact build/bundle（消费侧）** | YES | **YES** | `apply-payload.ts:311-338`（tar 解包 + `_release/manifest.json` 门 + installer preflight） |
| **runtime 打包（`~/.pd/runtime` 载荷）** | YES（委派 installer） | **YES** | `release-manager.ts:458-471` → `installer.ts`；布局 `install-layout/src/index.ts:140` |
| **installer 装配校验** | YES | **YES** | `installer.ts:780-830`（release-manager 组件形态门）、`installer.ts:2150-2250`（捆绑安装+import 冒烟） |
| **active.json / 安装态盖章** | YES（只读；唯一写者是 installer） | **YES** | `installer.ts:290-330` `commitInstallerActiveRecord`；RM 读 `release-manager.ts:227` |
| manifest 校验 | YES（校验；生成侧 `createReleaseAssetManifest` 仅测试调用） | **YES** | `release-asset-manifest.ts:163,181` |
| **rollback / 备份恢复** | 部分（自动恢复在 installer；RM 事务侧恢复） | **YES** | `installer.ts:1104-1137`；`transaction-journal.ts:380-471` `recoverUnfinishedTransaction` |
| **DB/破坏性迁移门** | PARTIAL（只做兼容性**策略**拒绝） | **YES** | `release-manager.ts:384-395`（`destructive_migration_requires_maintenance` 拒绝） |
| 渠道元数据（消费/生产） | YES（消费 TUF 链；生产在 CI publisher） | **YES** | `release-manager.ts:523-557`；`release-metadata.yml`；`release-metadata-publisher.ts` |
| **签名/校验（TUF + sha256 + ed25519）** | YES | **YES** | `trust-metadata.ts:97-173`；`apply-payload.ts:155-163`；`release-metadata-publisher.ts:684-720` |
| **自托管 registry（gh-pages 元数据 + GH Release 资产）** | YES | **YES** | `release-metadata-source.ts:103-133`；`release-metadata.yml:598-600+` |

**结论（事实归纳）**：通用发布能力（bump/changelog/tag/publish）**一项都不在** ReleaseManager；它的全部职责是 PD 特有的"安全地把 runtime 装进 `~/.pd` 并原子升级"。

### 3.2 输入输出

```
输入：
  pdHome (~/.pd 布局) + metadataBaseUrl(PD_RELEASE_METADATA_URL / install.json.releaseMetadataUrl)
  channel ∈ {stable, candidate}
        │
        ▼
 ReleaseManager（inspect/check/apply 三方法；session: apply 走独立 bootstrap-executor 进程）
        │  check:  install.json→TUF 验签→channels/<c>.json→releases/<id>/metadata.json→政策决策
        │  apply:  决策→兼容性预检→事务 journal→下载/校验→委派 installer()
        ▼
输出：
  InstallStatus（布局/productVersion/releaseId）      （只读）
  UpdateCheck（candidate + decision + TrustedReleaseTarget）
  ApplyOutcome{ applied(productVersion, transactionId, journalPath) | no_update(reason, note) }
副作用仅经 installer.ts：~/.pd/runtime 双 slot 写入 + active.json 提交（journal-first）
```

生产接线（全部核实）：Console `packages/pd-console/src/server/routes/update.ts:210-214` → `create-principles-disciple/update-console`（注册 seam，`console-surface.ts:16-43`）→ `createReleaseManagerAuthority`（4 点就绪门）；apply 经 `spawn` 独立 executor（`update.ts:98-113`）→ `bootstrap-executor.ts:54-59` → `handleBootstrapRequest`（`bootstrap-protocol.ts:133`）→ `ReleaseManager.apply`。**pd-cli 不接 ReleaseManager**（只做版本报告，`services/version-report.ts`）。

---

## Part 4 — 发布流程真实链路（逐步标注自动/人工）

```
1. Developer change                          人工
2. PR + verify:merge 门（ci.yml:88 9+道门）   AUTO
3. merge to main                            人工（Owner，AGENTS.md §23）
4. push 触发 publish-npm.yml → detect         AUTO（路径过滤；plugin 或 console 变更强制列车)
5. release-reproducibility 全矩阵              AUTO（发布前置门）
6. bump 决策：conventional commits 启发式      AUTO 启发 / 人工可覆盖（dispatch version_bump）
   （feat!/!→major, feat→minor, 其他 patch；action.yml:60-88）
7. 逐包 build（依赖序）+ pack --dry-run + registry 依赖验证   AUTO
8. npm publish --provenance --access public ×7（顺序列车 1/7→7/7）  AUTO
9. 版本 sed 同步（plugin manifest/根/README，仅 runner 内）   AUTO
10. git tag + GitHub Release                  AUTO
11. ClawHub 同步（continue-on-error）          AUTO best-effort / 失败人工兜底
12. release-metadata 发布（mode=publish）      人工 dispatch（持签名密钥）；计数器 AUTO 派生
13. Companion .exe（companion-v* tag）         人工推 tag → AUTO 构建/上传
14. 每周五 04:00 UTC cron 自动发（有 commit 才发）  AUTO
```

事实补充：`publish-npm.yml:451` 注释"tag-only release; we no longer push to main"；`detect` 在 schedule 路径 0 commit 时跳过（`publish-npm.yml:143-160`）。**推断**：周更 cron 是事实上的常规发布节奏，dispatch 是例外（依据 cron + 注释）。

---

## Part 5 — Installer / Runtime / Plugin

### 5.1 runtime 是否独立版本？—— 是，且是四层并行版本

| 层 | 例值 | 权威 | 说明 |
|---|---|---|---|
| workspace 组件 npm 版本 | core 1.74.1 / codex-adapter 0.1.0 | 各 package.json | 发布**输入**，不充当产品版本（ADR-0023） |
| runtime pins（安装器实装版本） | core **1.284.13** / codexAdapter 0.4.3 / hostRuntime 0.7.4 | `plugins/principles-disciple/runtime-version.json`（人工） | 必须存在于 npm；note 明示与 workspace 线不同步 |
| 产品版本 | 1.76.1 | 根 package.json（`resolve-product-version.mjs:17-19`） | 列车盖章进 `_release/product-identity.json` |
| 安装态版本 | active.json productVersion+releaseId+generation | installer 提交点 | 更新链唯一可信本地状态 |

结论：runtime **不是**"随 package 版本"的单一实体；四层各有权威，任何把"一个 semver 管所有包"的模型都会破坏第 2、3 层。

### 5.2 installer 如何知道安装哪个版本？

不走 npm dist-tags。链路（全部有代码证据）：

```
install.json.releaseMetadataUrl (release-metadata-source.ts:103-133)
  → channels/<channel>.json      TUF 验签（release-manager.ts:523-557）
  → releases/<releaseId>/metadata.json   （signing + publicationSequence 单调计数）
  → 平台/arch/nodeAbi 资产选择 + sha256+size 校验（apply-payload.ts:155-180）
  → trusted target 解析（tuf-js, trust-metadata.ts:97-173）
  → tar 解包 + _release/manifest.json 门 + installer preflight（apply-payload.ts:311-338）
  → installer.install()：双 slot 写入、备份/恢复、active.json 提交（installer.ts:290,1104-1137）
  → 事务 journal（~/.pd/transactions/<id>.jsonl）全程可恢复（transaction-journal.ts:380-471）
```

"能不能升"由策略决定而非版本号大小：`release-policy.ts:78`（`evaluateReleaseAdvancement`：`sequence_regression`、`downgrade_blocked`）+ 内联破坏性迁移拒绝（`release-manager.ts:384-395`）。npm 上的 `create-principles-disciple` 自身版本只是引导安装器版本，**不是**产品版本。

### 5.3 OpenClaw plugin 发布方式

```
packages/openclaw-plugin (principles-disciple)
  → build → npm publish --provenance --access public
  → openclaw.plugin.json（独立 version 字段，sed 同步，当前 1.198.1 漂移）
  → ClawHub marketplace 同步（clawhub.ai，publish-npm.yml:641）
  → 安装位置：~/.openclaw/extensions/principles-disciple（AGENTS.md §1.1 装机结构）
  → 升级双通道：(a) npm/ClawHub 侧插件包升级；(b) PD runtime 更新链（ReleaseManager→installer 写 ~/.pd/runtime，
    插件 core 为指向 runtime 的链接——"两套安装链写同一插件位置"问题记录在
    docs/audit/install-mjs-dev-prod-isolation-review-20260920.md）
```

---

## Part 6 — 关键假设核验

### 假设 A："PD 可以使用 Changesets 管理 package version" → **部分支持**

支持面：7 个发布单元都在 `packages/*` workspace 内、依赖边是真实 package.json 边；它们本来就是**独立版本号**（与 `.changeset/config.json:7-9` 的 `fixed: []`、`updateInternalDependencies: "patch"` 兼容）。这一层确实可由 Changesets 的 `version` 命令 + 声明式 changeset 文件替代 conventional-commits 启发式，并顺带产出 changelog（现状：4 个 CHANGELOG 三种格式全部陈旧）。

不支持面（事实）：

1. **产品版本不在包版本里**：产品版本=根 `package.json`（`resolve-product-version.mjs:17-19`），ADR-0023 与更新系统设计文档双重禁止"从 npm latest 借产品版本"。Changesets 没有"产品版本"概念。
2. **隐式依赖边不可见**：`pd-console`→installer（`publish-npm.yml:225-238`、`bundle-plugin.mjs:54-55`）不在任何 package.json 的 depends 里；Changesets 只认声明的依赖图。
3. **workspace 版本与 npm 线已经分叉**：`runtime-version.json` note 原文 "1.74.1 was a working-tree-only number — the npm line is 1.250+"；`docs/audit/update-chain-expert-brief-20260919.md` §3.4"四张皮"未收敛（PRI-849 开放）。在一号多版未对账前引入统一 bump 工具会把漂移固化。
4. **幽灵同名包**：4 个 `@principles/*` name 在 `packages/create-principles-disciple/*` 有同名不同版本的跟踪副本（core 1.278.6 vs 1.74.1 等）。`@changesets/cli` 的 workspace 扫描/`changeset version` 需要先确认会不会把这些生成物纳入影响面（本次为只读调查，未实测——列入 Unknowns）。
5. **ERR-131 教训**：共享多包 CI 树里 version bump 必须是纯文件编辑（`npm version` 触发 install 图操作曾炸掉列车 4/7；记录 `docs/process/error-management/records/occurrences/P-ERR-131/OCC-20260919T014126Z-8dxezj.md`）。新增工具若在 CI 内跑 `changeset version`，须先证明它不会触发同类 install 图行为。
6. **现状是"装而未用"**：`.changeset/` 只有 README+config（零 pending changeset，CI 零调用），`@changesets/cli` 在 `package.json:68`。它是 dependabot 留下的，不是现役机制。

### 假设 B："PD 可以删除自研版本依赖分析逻辑" → **仅 npm 传输层部分支持；整体不支持**

- **可删/可替（npm 层）**：conventional-commits→bump 启发式（`action.yml:60-88`）、列车依赖序发布（`publish-npm.yml:764-828`）、registry 依赖验证（`action.yml:90-130`）——属于通用 monorepo 发布空间，Nx Release/Changesets 覆盖。替代前提：先完成假设 A 的 1–5 号障碍处置。
- **不可删（PD 特有）**：`check:runtime-pin`（`plugins/principles-disciple/scripts/verify-pinned-runtime-capability.cjs`，验证运行时能力而非版本序）、`bundle-plugin.mjs` 隐式边复制+`file:` 改写、`resolve-product-version.mjs` 产品版本权威、`openclaw.plugin.json`/README sed 同步、gh-pages 签名元数据与 ClawHub/Companion 三条非 npm 出口。删任何一项都会破坏现有门或装机结构。

### 假设 C："ReleaseManager 可以保留，只负责 PD 特有发布逻辑" → **支持（现状已经如此）**

事实：ReleaseManager 不 bump、不出 changelog、不打 tag、不 publish（§3.1 矩阵全 NO）；它做的是安装态检查、TUF 验签、候选决策、受信下载校验、事务日志、委派 installer、active.json 提交——全部位于"registry 之后"的 software-distribution-to-installed-runtime 层，四个候选工具没有一个覆盖这段。它的接口（`inspect/check/apply` + `ReleaseManagerError` 8 个 reason 码）和 seam（`create-principles-disciple/update-console`，`console-surface.ts:16-43`）已经收得很紧。**保留即可，无需改动；唯一建议是文档里停止称它为"发布管理器"。**

### 假设 D："Changesets 可以作为 ReleaseManager 上游输入" → **分层回答：整体发布链的上游——可行；ReleaseManager 的代码输入——不成立**

- ReleaseManager 的输入契约是 `releaseId / publicationSequence / 签名渠道元数据`（`release-manager.ts:90-104` 类型；生产方 `release-metadata.yml` + `publish-release-metadata.mjs`），**从不读任何 package 版本**；设计规则明文禁止从 npm latest 借版本。
- 若引入 Changesets，真正变化的接缝在"merge → build-asset → release-metadata 发布"这一段：列车仍需写 `_release/product-identity.json`（`action.yml:267-290`）、仍要人工更新 runtime pins（Part 5.1 第 2 层）。Changesets 插得进去的位置是**版本如何计算**，而不是 ReleaseManager 的任何接口。
- 结论："上游输入"若指 ReleaseManager 的代码依赖——不成立；若指发布链上游的阶段替换——可行，且与 ReleaseManager 无耦合，可独立评估。

---

## Part 7 — 第三方工具适配评估（仅基于 PD 事实）

| 工具 | 可能解决的问题 | 可能冲突 |
|---|---|---|
| **Changesets** | 7 个 npm 包的版本 bump 决策（替代 conventional-commit 启发式）；changelog 生成（现状 4 个 CHANGELOG 三格式全陈旧）；声明式 changeset 替代 commit 消息解析 | 无"产品版本"概念（与根 manifest 权威冲突）；看不见 console→installer 隐式边；幽灵同名嵌套包的影响面未验证；CI 内运行有 ERR-131 复发风险；目前 installed-but-unused，"启用"是明确决策而非升级 |
| **Nx Release** | 依赖图感知的多包顺序发布、任务编排（替代 `package.json:11` 手排 build 链） | 需引入全新工具链（nx.json 缺失、当前是 npm workspaces）；与自排列车/ERR-131 纯编辑约束、platform-specific 资产矩阵冲突；7 个包的规模对 nx 是净增认知负担 |
| **Lerna** | 经典 monorepo 版本+发布 | 与 Changesets 同域但更陈旧；同样不覆盖产品版本/installer 打包/发布元数据；会在现有顺序敏感列车旁引入第二个 orchestrator |
| **semantic-release** | 单仓版本自动化 + changelog | **已被仓史否决**：commit `e4e48da3c`（2026-08-05）显式删除语义发布配置及依赖；它按"单版本/仓"运作，与 7 独立包版本 + 产品版本双轨结构性冲突 |

---

## Findings（事实清单，均可复核）

**F1.** npm workspaces（`package.json:7-9`），29 个跟踪 package.json；其中 **7 个真实发布单元**（`publish-npm.yml:764-828` 列车 1/7–7/7；`action.yml:372` `npm publish --provenance --access public`）。
**F2.** 三个 `private` 应用根本不发 npm：pd-console 只随 installer 打包（`bundle-plugin.mjs:54-55`）；pd-companion 走 `companion-release.yml` GitHub Release；website 走 Cloudflare Pages。
**F3.** 版本号至少 6+1 层并行（Part 2.1 表）；产品版本权威=根 package.json（`resolve-product-version.mjs:17-19`）；安装态权威=active.json（installer 写，ReleaseManager 只读）。
**F4.** Changesets **已安装未使用**：`.changeset/` 仅 README+config、零 pending、CI 零调用；`@changesets/cli` 在 `package.json:68`。Nx/Lerna/turbo/rush 全缺；semantic-release 于 2026-08-05 被主动移除（`e4e48da3c`）。
**F5.** 4 个 CHANGELOG（根 semantic-release 风、plugin+installer changesets 风、core Keep-a-Changelog 风）全部**过期**；go/no-go checklist:108-109 曾记录"CHANGELOG 过期=BLOCKED"。
**F6.** `scripts/release.sh` / `scripts/sync-version.sh` 存在但**无任何 workflow/npm script 引用**（推断为 legacy；无法证明无人手工使用）。
**F7.** ReleaseManager（`update/release-manager.ts:265`）零通用发布能力；职责 100% PD 特有更新链；生产唯一入口 Console 经注册 seam + 独立 executor 进程调用；pd-cli 不接它。
**F8.** 更新链安全模型：TUF 验签（tuf-js）+ sha256 + ed25519 元数据签名 + 单调 publicationSequence + 事务 journal + 破坏性迁移拒绝——这是第三方工具完全不涉及的层。
**F9.** 4 个 `@principles/*` 同名包在 installer 内存在 git 跟踪、版本漂移的副本（core 1.278.6/1.74.1 等），依赖为打包时生成的 `file:` 引用。
**F10.** workspace 版本与 npm 已发布版本线已分叉（runtime-version.json note 明示"npm line is 1.250+"；audit §3.4"四张皮"），遗留 PRI-849。
**F11.** ERR-131（2026-09-19）：共享多包 CI 树内 `npm version` 触发 install 图操作 → release train 4/7 失败；修复=bump 改为纯 package.json 文件编辑（`action.yml:190+`）。**对任何新增版本工具都是硬约束。**
**F12.** openclaw.plugin.json 版本漂移事实存在（1.198.1 vs 1.76.1），CI 发布时 sed 覆写；漂移是否有意无注释（Unknown）。

**推断（非事实）**：周更 cron 为常规发布节奏；installer 嵌套副本为 bundle-plugin.mjs 的生成物（版本盖章源码见 `bundle-plugin.mjs:689-728`，但 git 中为何保留跟踪副本无法从代码证明意图）。

---

## Unknowns（本次只读调查无法确认）

1. **哪个 CI 真正执行发布**：`.github/workflows/publish-npm.yml` 与 `.cnb.yml` 并存，workflow 中出现 `secrets.n`/`NPM_READ_TOKEN` 等 CNB 风格命名；GitHub Actions 是否为实际执行环境无法离线证实。
2. **npm registry 当前真实版本线**（7 包各自 latest/dist-tags，是否真有 2.0.0）：只读+无网络未验证；依据仅为 audit 文档记录。
3. **Changesets 对幽灵同名包的行为**：`changeset version` 是否波及 `create-principles-disciple/*` 嵌套副本——未实测（会触发写入，超出只读边界）。
4. **release-metadata.yml publish 模式的历史执行情况**与线上 `~/.pd` 实态（仓库外，无运行时取证）。
5. **data-compatibility 拒绝所引用的"维护性迁移流程"**：`release-manager.ts:384-395` 引用该概念，但实现未在仓内找到。
6. **签名密钥的运营仪式**（持有人/轮换）：`trust-root-provisioning.ts`、`generate-trust-root.mjs` 有代码，流程不在代码内。
7. **`.changeset/` 是有意保留还是历史残留**：无注释可证。
8. **openclaw.plugin.json 1.198.1 漂移是否有意**：无注释；CI 发布时覆写。
9. **CHANGELOG 治理口径**：go/no-go checklist 要求起草，但无任何自动化校验 CHANGELOG 与版本一致（check 脚本清单中无 changelog 项）。

---

## Recommendation（下一阶段应验证什么——不含实施方案）

按优先级，下一阶段只做**消歧/实测**，不动代码：

1. **版本权威对账（最高优先，对应 PRI-849）**：联网只读取 npm registry 7 包 latest + dist-tags，与根 manifest / runtime-version.json / 最新 active.json 对照，确认"四张皮"是否仍成立、哪层是事实权威。这是一切工具评估的前置——一号多版未对账前，任何"统一 bump"方案都是在流沙上盖楼。
2. **确认实际 CI 平台与 secrets 语义**：GitHub Actions vs CNB，`secrets.n` 命名之谜；工具引入的执行环境先要对。
3. **Changesets 幽灵包实测**（隔离环境、可丢弃副本上）：`changeset version --dry-run` 观察作用面是否包含 `create-principles-disciple/*` 嵌套副本与 `pd-console`；同时验证 ERR-131 复发风险（是否触发 install 图操作）。**这是假设 A 能否成立的唯一决定性问题。**
4. **隐式依赖边显式清单化**：console→installer、plugin manifest→host、ClawHub、runtime pins→npm、companion-v* 五条非 package.json 边写成受控清单——它同时是"可替换面"的边界定义。
5. **产品版本契约三处口径核对**：`resolve-product-version.mjs` / ADR-0023 / 更新系统设计 spec 关于"产品版本≠包版本"的表述是否完全一致；不一致处先修文档再谈工具。
6. **ReleaseManager 术语纠正**：在 docs 中把"ReleaseManager=发布管理器"的误导性表述改为"运行时更新管理器"，避免后续调研重复本报告第 3 节的定位纠偏。

**不推荐的下一步**（基于事实）：直接引入 Nx Release（规模不匹配、双 orchestrator 冲突）、重启 semantic-release（仓史已否决）、或把 ReleaseManager 纳入任何第三方工具的替换评估对象（其职责位于所有候选工具射程之外）。

---

*报告完。本调查未修改任何源码/配置，未建 PR/工单；产出仅此文档。*
