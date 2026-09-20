# PD Version Model — 产品版本与组件版本语义模型

> **状态**: Active
> **最后更新**: 2026-09-20（PRI-877）
> **关联**: `docs/adr/0023-pd-installation-architecture-decisions.md` §2.5（三轴版本模型）、
> `docs/architecture/VERSIONING_AND_COMPATIBILITY.md`（schema 演化与兼容性规则，本文不覆盖）、
> `docs/process/release/RELEASE_PROCESS.md`、`docs/research/package-release-system-audit.md`
>
> 本文回答一个问题：**PD 仓库里每一个"版本号"到底是什么意思、谁有权写、谁在读、
> 哪些必须相等、哪些天然允许不相等。**
> 它不定义发布流程步骤（见 RELEASE_PROCESS），不定义 schema 迁移（见 VERSIONING_AND_COMPATIBILITY）。

---

## Overview

PD 同时存在多条**语义不同**的版本线。它们回答不同的问题：

| 问题 | 由哪条版本线回答 |
|---|---|
| 用户安装的 PD 产品是什么版本？ | **Product Version**（产品版本） |
| 某个 npm 组件库自身进化到哪一步了？ | **Component Version**（组件版本） |
| 这台机器上安装的 runtime 具备哪些能力？ | **Runtime Capability Version**（runtime pins） |
| 这个发布包是怎么产生、怎么被信任、装到哪一代的？ | **Distribution Version**（分发/安装版本） |

**核心结论：这四类版本是不同问题的答案，天然取不同数值。它们不相等不是 bug；
把任何一条"对齐"到另一条，几乎都是错误操作。**

唯一的例外是"必须一致对"（见 Version Relationship）：同一份发布物内部的
若干字段（如 plugin manifest 与其 package.json）描述的是同一件事，必须相等。

历史教训（PRI-874 版本治理收尾，随 PR #1781 落地）：产品版本曾经"四张皮"
（repo 根 manifest 1.76.1 / 线上 channel 2.1.0 / npm 插件线 2.0.x / 本机 active.json 1.74.1），
每个字段各自正确、互相之间无同步义务——但因为没有人写下"哪条线回答哪个问题"，
AI Agent 反复把它们误读为"需要同步的不一致"。本文就是那份写下来的模型。

---

## Version Categories

### Product Version

**它回答：用户安装的 PD 是什么版本。**

| 项 | 内容 |
|---|---|
| 权威存储 | 仓库**根** `package.json` 的 `version` 字段（monorepo 聚合根，private，永不发布到 npm） |
| 唯一读取器 | `scripts/resolve-product-version.mjs` —— 所有发布入口（npm 列车产品身份盖章、release metadata、installer stamp、channel 元数据）统一经它解析 |
| 形态 | 严格 `x.y.z`（非此格式直接 fail-closed 退出） |
| 修改方式 | **仅通过显式的版本推进提交**落在 main（PR + Owner merge）。CI 在 runner 内的 sed 覆写不落回 main |
| 用户看到什么 | `pd version --json` 的 `productVersion`（读自安装态，见 Distribution）；Console 更新界面；GitHub Release 说明 |
| 何时变化 | 发布列车准备发新版本时，由 Owner/发布流程决定并先行落到 main |
| 守卫（PRI-874 起） | `scripts/check-product-version-channel.mjs`：解析出的产品版本**低于**线上签名 channel 指针时拒绝发布（防止发布即降级所有已装 runtime）；`product-version-drift.yml` 每日监控 main 根 manifest 与 channel 指针的漂移 |

**产品版本 ≠ git tag。** 仓内 `v1.245.x`、`v2.0.x` 这类 tag 是**插件 npm 版本线**的
发布产物（`publish-npm.yml` 仅在发布 `openclaw-plugin` 时打 tag，版本取插件包自己的
bump 值），不是产品版本标记。查找"当前产品版本"永远看根 manifest，不看 tag。

### Component Version

**它回答：某个可独立发布的组件库自身进化到哪一步。**

发布单元共 7 个（npm 列车 1/7 → 7/7）：

| 包名 | 路径 | 说明 |
|---|---|---|
| `@principles/core` | `packages/principles-core` | 领域/运行时核心 |
| `@principles/install-layout` | `packages/install-layout` | 安装布局 |
| `@principles/host-runtime` | `packages/host-runtime` | 宿主中立运行时 |
| `@principles/codex-adapter` | `packages/codex-adapter` | Codex 宿主适配器 |
| `@principles/pd-cli` | `packages/pd-cli` | `pd` CLI |
| `principles-disciple` | `packages/openclaw-plugin` | OpenClaw 插件（npm + ClawHub 双出口） |
| `create-principles-disciple` | `packages/create-principles-disciple` | installer 组件 |

关键事实：

* **组件版本号是发布过程的输入，不得充当产品版本**（ADR-0023 §2.5 明文；
  更新系统设计文档："a release never borrows its product version from an npm package's latest"）。
* 组件版本由 CI 发布列车 bump（conventional-commits 启发式，人工 dispatch 可覆盖），
  bump 是**纯文件编辑**——在共享多包 CI 树内禁止 `npm version`（ERR-131：它触发 install
  图操作，曾炸掉列车 4/7）。
* 源树里看到的组件版本（如 core 1.74.x）与 npm 上的实际版本线（core 1.28x）**刻意不同步**：
  runner 在发布时以 registry 现值重置再 bump，改动不回写 main。因此
  **"仓库里的组件版本落后于 npm" 是常态，不是漂移事故。**
* `private` 应用（pd-console / pd-companion / pd-console 版本）不发 npm，其 version 只是
  仓内标记：console 只随 installer 打包分发；companion 走 `companion-v*` tag + GitHub Release
  独立版本线（桌面外壳生命周期与产品独立，Owner 需认知两个版本号，见 ADR-0023 §2.7）。
* `packages/create-principles-disciple/{core,pd-cli,install-layout,console}/package.json`
  是 **bundle-plugin.mjs 的打包副本**（同名不同版本的"幽灵成员"），其版本在打包时从
  npm registry 现取覆写。**它们不是维护对象，任何情况下不应手工编辑。**

### Runtime Capability Version

**它回答：这台机器/这个工作区的 `$pd-setup` 应当安装哪些精确版本的 runtime 组件，
才能保证行为正确。**

| 项 | 内容 |
|---|---|
| 权威文件 | `plugins/principles-disciple/runtime-version.json`（三个 pin：`core`、`hostRuntime`、`codexAdapter`） |
| 修改者 | **仅人工**（Owner 级决策）。文件内 `note` 字段记录了 Owner 控制下限（如 hostRuntime ≥ 0.1.1 才有 activation guard） |
| 验证 | `npm run check:runtime-pin` → 真实打包能力探针（验证的是**能力**存在，不只是版本字符串匹配） |
| 为什么和 workspace 组件版本不同 | pin 必须指向 **npm 上真实存在**的版本。workspace 版本是"working-tree-only 数字"，npm 线在其前面跑。note 原文："1.74.1 was a working-tree-only number — the npm line is 1.250+" |
| 为什么可能和"最新版"不同 | pin 的语义是**已验证能力的最小锁定**，不是"追新"；升级 pin 要求同次发布内 `check:runtime-pin` + npm smoke + install 测试全绿 |

### Distribution Version

**它回答：一个发布包怎么产生、是否可信、装到了哪一代、当前安装处于什么状态。**
由以下字段组成，全部位于"registry 之后"的更新链（ReleaseManager→installer）：

| 字段 | 位置 | 生成者 | 读取者 | 含义 |
|---|---|---|---|---|
| `productVersion` + `publicationSequence` | 签名渠道元数据 `channels/<channel>.json`、`releases/<id>/metadata.json`（gh-pages） | `publish-release-metadata.mjs`（人工 dispatch，持 `PD_RELEASE_SIGNING_KEY`），计数器自动派生 | `ReleaseManager.check()`（TUF 验签） | 线上指向哪个产品版本；单调序号是**升降级判定的真轴** |
| `_release/product-identity.json`（`schemaVersion`/`productVersion`/`sourceCommit`） | installer 载荷内 | CI 发布时经 `resolve-product-version.mjs` 解析后盖章 | installer（缺 stamp 的载荷 fail-closed 视为非正式构建） | 这个安装载荷声称自己是哪个产品版本的构建 |
| `active.json`（`schemaVersion:1`/`productVersion`/`releaseId`/`generation`/`transactionId`） | `~/.pd/active.json` | **唯一写者：installer 提交点**（journal-first） | `ReleaseManager`（只读）、`pd version --json`、Console | **已安装产品版本的唯一本机权威**。`pd version` 的产品身份永远读它，不读任何 checkout 的 package.json |
| `install.json`（`layoutVersion`/`mode`/`releaseMetadataUrl`） | `~/.pd/install.json` | installer | 更新链元数据入口 | 安装布局代际 + 元数据源，不是版本 |
| `pd.bundledPluginVersion` | installer `package.json` 的 `pd` 字段 | 打包时盖章（`bundle-plugin.mjs`） | 诊断展示 | "这个 installer 里捆了哪版插件"，纯诊断 |
| 事务 `generation` | `active.json` + `~/.pd/transactions/*.jsonl` | installer/journal | ReleaseManager 恢复逻辑 | 安装提交代数，用于崩溃恢复，非人类可读版本 |

**注意"ReleaseManager"名不副实**：它是**已安装运行时的更新管理器**（inspect/check/apply），
不 bump、不打 tag、不 publish。它的版本输入契约是 `releaseId`/`publicationSequence`/签名
channel 元数据——**从不读任何 package.json 版本**。"能不能升"由策略决定
（`release-policy.ts`：`sequence_regression`/`downgrade_blocked` + 破坏性迁移拒绝），
不是 semver 数字大小。

---

## Version Relationship

### 应当（天然）不同的版本 —— 相等反而是巧合

| 对 | 为什么不要求相等 |
|---|---|
| Product ↔ 任一组件版本 | 不同语义轴（ADR-0023 §2.5）。示例：Product 2.1.0 时 core 可在 npm 1.286.0、pd-cli 1.152.x |
| Product ↔ git tag `v*` | tag 是插件 npm 线的产物；产品版本看根 manifest |
| workspace 组件版本 ↔ npm registry 同包版本 | runner bump 不回写 main；仓库值落后是常态 |
| runtime pins ↔ workspace 组件版本 | pins 指向 npm 实存版本 + 已验证能力，note 明文不同步 |
| runtime pins ↔ "npm latest" | pin 是锁定，不是追新 |
| 嵌套 bundle 副本版本 ↔ canonical 包版本 | 副本在打包时独立盖章 |
| companion 版本 ↔ 产品版本 | 独立生命周期（ADR-0023 §2.7） |

### 必须一致的版本对 —— 有机制强制或发布时同步

| 必须一致的对 | 原因 | 强制机制 |
|---|---|---|
| plugin `package.json` version ↔ `openclaw.plugin.json` version | 同一发布物的两个视图，OpenClaw 宿主加载器读 manifest | CI 发布时 sed 同步（`publish-npm.yml`）；`sync-version.sh` 同样对齐两值 |
| 载荷 `_release/product-identity.json` ↔ 该次列车的产品版本 | 安装身份声明必须与发布声明同源 | 同一 `resolve-product-version.mjs` 解析 + 严格格式校验，格式不合拒绝盖章 |
| channel `productVersion` ↔ `active.json.productVersion`（安装成功后） | 装完的运行时必须如实报告装了什么 | installer 提交点从受信 release 元数据写入 |
| 仓库根 manifest ≥ 线上 channel `productVersion` | 否则下一次发布就是给全体已装 runtime 降级 | `check-product-version-channel.mjs` fail-closed 拒绝发布；`product-version-drift.yml` 每日报警（main < channel 为 FAIL，main > channel 为合法待发布态） |

### 危险的"同步"行为 —— 明令禁止

| 禁止操作 | 风险 |
|---|---|
| 把所有 `packages/*/package.json` version 改成产品版本 | 制造与 npm registry 的假冲突；破坏 7 包独立版本线；违反 ADR-0023（组件版本是发布输入，不是产品镜像） |
| 用 `sync-version.sh`（PRI-874 前形态）或手工把 **git tag 值写入根 package.json** | tag 是插件线版本，写进根 manifest 就是把组件版本冒充产品版本——正是 PRI-874 修掉的旧脚本行为（现该脚本已跳过根 manifest） |
| 把根 manifest "对齐"到 npm 上插件包最新版 | 更新系统设计明文禁止 "borrow its product version from an npm package's latest" |
| 在 CI/共享树内跑 `npm version` 做 bump | ERR-131：触发 install 图操作，炸发布列车；bump 必须是纯文件编辑 |
| 未跑 `check:runtime-pin` 就改 runtime-version.json pins | pins 是安全/能力地板（如 PRI-810 activation guard 下限），盲改可装出缺守卫的 runtime |
| 手工编辑 `~/.pd/active.json`、`install.json`、嵌套 bundle 副本 | 越界写安装态/生成物（AGENTS.md §1.1 装机目录保护） |
| 把"看到版本号不一致"当作 bug 顺手修 | 跨类不等是模型的正确状态；只有上表"必须一致对"的不等才是 bug |

---

## Version Ownership

| 版本线 | 唯一作者 | 消费者（只读） | 人工可改？ | 允许自动同步？ |
|---|---|---|---|---|
| 根 `package.json` version（Product） | 显式版本推进提交（Owner merge 落 main） | `resolve-product-version.mjs` → 所有发布入口；channel guard | 是（且**只能**经显式提交） | 否。除发布流程外任何工具不得写 |
| 组件 `package.json` version | CI 列车 bump（runner 内，不回写）；例外：人工同步经 `sync-version.sh` 且**不含根 manifest** | npm 依赖解析、registry | 是（发布任务明确要求时） | 仅限发布流程既有 sed 步骤；禁止跨包互相推导 |
| plugin manifest version | CI 发布时与 plugin 包同步 | OpenClaw 宿主 | 否（属发布流程产物） | 仅与 plugin 包这一对，见上表 |
| runtime-version.json pins | **人工（Owner）** | `$pd-setup`、`check:runtime-pin` | 是，但必须随 `check:runtime-pin` + smoke 验证 | **永远否** |
| channel/release 签名元数据 | CI publisher（人工 dispatch + 签名密钥） | ReleaseManager（TUF 验签） | 否 | 由发布流程产生，不可手工伪造 |
| `active.json` / `install.json` | **仅 installer** | ReleaseManager、`pd version`、Console | 否（AGENTS.md §1.1） | 否 |
| 嵌套 bundle 副本 / `pd.bundledPluginVersion` | `bundle-plugin.mjs` 打包时 | 诊断 | 否 | 打包时自动盖章，与源树无关 |
| git tag `v*` / `companion-v*` | CI（插件线）/ 人工推 tag（companion） | 周更跳过逻辑、GitHub Release | 否 | 否 |

---

## Update Rules

一次正式发布中各版本线的推进次序（流程细节见 RELEASE_PROCESS，此处只列版本语义）：

```
1. 产品版本推进提交落 main          （根 package.json，显式 PR，Owner merge）
2. 组件 bump 决策                   （CI 列车自动 / dispatch 覆盖）
3. npm publish ×7                   （runner 内 sed 同步 plugin manifest / README 徽标）
4. git tag v<插件版本>              （插件线，非产品版本）
5. release-metadata 发布            （签名 channel：productVersion=解析值, publicationSequence+1）
6. runtime pins 更新                （人工；同次发布内 check:runtime-pin 通过）
7. 已装端 apply                     （active.json 由 installer 提交，productVersion 来自 release 元数据）
```

不变量：步骤 1 的版本必须 ≥ 线上 channel（否则步骤 3/5 被 guard 拒绝）；
步骤 5 之后 drift monitor 保持 main ≥ channel；步骤 7 之后本机 `pd version`
的 `productVersion` 等于步骤 5 的 channel 值。

---

## AI Agent Modification Rules

**任何版本字段都是"需要任务授权的数据"，不是"看到漂移就该修的状态"。**

### Allowed（允许）

* 修改任务/SPEC **逐条点名**的版本字段；
* 发布流程本身要求的同步（CI 既有步骤、`sync-version.sh` 覆盖的组件对）；
* 更新文档中引用的版本示例（本文档自身除外，需 Owner 批准）。

### Forbidden（禁止，除非任务明确要求）

* 把任何一个 version "同步"到另一个 version（跨 Category 一律禁止）；
* 根据一个版本字段**推导**另一个（"npm latest 是 2.0.1，所以产品该是 2.0.1"——不成立）；
* 修改 `runtime-version.json` pins（Runtime Capability 永远是人工/Owner 决策 + 能力验证）；
* 修改根 `package.json` version（Product 只能经显式版本推进提交，由发布任务或 Owner 发起）；
* 手工写 `~/.pd/**`（active.json / install.json / runtime 载荷 / 嵌套副本）；
* 在 CI 或多包共享树内引入 `npm version` 类工具链（ERR-131）；
* 为"消除"跨类版本不等而扩大 PR 范围——那是本文档定义的**正确状态**。

### 面对模糊指令的行为契约

用户或任务说 **"更新 PD 版本"** 时，这句话有至少四种含义，AI **不得自行选择**，
必须先问清是哪一种：

1. **产品版本**（根 package.json → 走发布流程的显式推进提交）；
2. **某个组件包的版本**（哪个包？发布 bump 还是仓内标记？）；
3. **runtime 能力版本**（runtime-version.json 的哪个 pin？能力验证谁跑？）；
4. **已安装运行时的更新**（跑 ReleaseManager/Console 更新，不改任何仓内文件）。

提问之外允许做的：读现状、报告各版本线的当前值和漂移方向（对照本文
"应当不同 / 必须一致"两表），把结论交给决策者。

---

## Examples

以下取 2026-09-20 实际值（PRI-874/849 版本治理收尾合并前后各一列，均为**合法状态**）：

| 版本线 | 合并前 | 合并后 | 各自正确的解读 |
|---|---|---|---|
| Product（根 manifest） | 1.76.1 | **2.1.0**（补齐孤儿提交 79226910 的权威落地，PRI-849） | 用户看到的"PD 版本" |
| 线上 channel 指针 | 2.1.0 | 2.1.0 | 合并前 main < channel = drift monitor 的 FAIL 类；合并后消除 |
| `@principles/core`（npm 线） | 1.284.x | 1.286.0 | 组件进化计数，与产品版本无换算关系 |
| core workspace 源树值 | 1.74.1 | 1.74.1（仍落后） | working-tree-only，正常 |
| runtime pin `core` | 1.284.13 | 人工随发布更新 | npm 实存 + 能力已验证的锁定 |
| `@principles/pd-cli`（npm） | 1.152.10 | ≈同 | 独立组件线 |
| 插件 `principles-disciple`（npm + tag） | 2.0.1（tag `v2.0.1`） | ≈同 | 插件流版本；tag 与它同源，与产品版本无关 |
| `openclaw.plugin.json`（源树） | 1.198.1（漂移待对账） | 发布时被 CI 对齐 | 与 plugin 包**必须一致**的字段 |
| 本机 `active.json` productVersion | 1.74.1（bundled 安装） | apply 后 = channel | 已装产品版本唯一本机权威 |

一个不了解 npm 的 Owner 用这张表即可回答：

* **"用户当前 PD 是什么版本？"** → 已装机器看 `pd version`（active.json）；
  仓库要发布的看根 manifest。两者都叫"PD 版本"，其余都不是。
* **"core 版本是什么意思？"** → core 组件自己的进化计数；它大、它小、它和
  PD 版本号长得都不一样，都不代表 PD 版本有问题。
* **"runtime pin 为什么可能不同？"** → pin 锁定的是"经验证能力齐备的 npm 实存版本"，
  追新和追齐都不对，它是安全地板。
* **"为什么不能全部同步？"** → 因为它们回答不同的问题；同步等于销毁信息
  （见 "危险的同步行为" 表中每行的具体破坏后果）。
