# PD Release G3 §10.5 — Installer 依赖链接逻辑合并

- 日期：2026-11-03
- 基线：`origin/main` = `ab4b0f2f5`
- 分支：`ai/adhoc-20261103-installer-dependency-link-consolidation-39a366`（独立 worktree `D:\Code\_worktrees\principles\adhoc-20261103-installer-dependency-link-consolidation-39a366`）
- 依据：`docs/specs/PD_Release_Delivery_SPEC_v1.2/SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001.md` §10 第 5 项（“G3 可证明等价的依赖链接/状态逻辑合并”）
- 工单：**PRI-1100** — <https://linear.app/principlesdisciple/issue/PRI-1100/p2-installer-兄弟依赖链接逻辑合并g3-105>（详见 §9）

## 结论（先行）

1. `syncPdCli()` 与 `installConsole()` 中手写的 `file:../` 兄弟组件链接（约 90 行）已删除，收敛到既有 helper `ensureComponentFileDependencyLinks()`；未新建第二套链接框架。
2. 真实的“该链的没链上”缺陷已消除：链接改为在 `installPdCliDependencies()` / `installConsoleDependencies()` **之后**执行，实体副本、错误目标、悬空链接都会被纠正；声明的兄弟组件缺失时 **fail-closed 报错**，不再静默继续。
3. 顺手修正了 `syncPdCli()` 中已被 G3-R4 实验否证的注释（“host-runtime 依赖可通过 plugin node_modules 向上解析”），该说法与实际解析链不符，已随链接块一并删除。
4. 回归：新增独立布局的真实文件系统测试 **10/10 通过**（Windows 上真实 junction + 真实 Node ESM 子进程解析）；安装器 fast 套件 **88 文件 / 1030 通过 / 6 跳过 / 0 失败**；仓库 lint **0 error**（2+1 条既存 warning 位于无关包）。
5. 未实施依赖裁剪、未建立全局共享 node_modules、未改 release-locks / runtime-version.json、未触碰 `~/.pd` / `~/.openclaw`、未发布/部署。

---

## 1. Owner Review Card

1. **Problem**
   安装态的 pd-cli / console 依赖链接由两处手写逻辑各自创建，且用 `!existsSync()` 短路：`npm ci --install-links` 物化的实体目录存在时，正确的运行时链接被静默跳过，程序继续跑但在用副本（G3-R4 实测已确认）。

2. **Before**
   - `syncPdCli()` 在**依赖准备之前**创建 4 条链接，`installConsole()` 创建 2 条链接，均 `!existsSync` 短路。
   - `syncPdCli()` 注释声称 host-runtime 可通过 plugin 的 node_modules 向上解析；隔离实验已否证（向上链为 `runtime/host-runtime → runtime → ~/.pd → $HOME`，到不了 openclaw extensions）。

3. **After**
   - 安装态 pd-cli / console 的 `file:../` 兄弟链接统一由 `ensurePdCliResolution()` / `ensureConsoleResolution()` 调用共享 helper，在依赖阶段之后物化。
   - 实体副本 → 替换为链接；错误目标/悬空链接 → 修复；声明兄弟缺失 → 抛错（安装失败并走既有回滚/清理）。
   - 链接集合改为**由部署后的 package.json 驱动**，不再硬编码名单。

4. **Existing mechanism reused**
   `ensureComponentFileDependencyLinks()`（PRI-911/912 引入，codex/workbuddy adapter 已在用）及其“lstat + realpath 校验 / 物理副本纠正 / 路径穿越拒绝 / fail-closed”语义。

5. **Complexity Delta**
   - New durable source of truth: **NO**
   - New persisted schema/state: **NO**
   - New subsystem/service/background process: **NO**
   - New public abstraction/interface: **NO**（仅新增两个薄导出包装，沿用 codex/workbuddy 既有模式；未引入新的链接框架）
   - New runtime feature flag: **NO**
   - New cross-package dependency: **NO**
   - New host/platform-specific behavior: **NO**
   - New external/network capability: **NO**

6. **Design reason**
   两处手写逻辑处理的正是 helper 已覆盖的同一语义（`file:../` 兄弟组件链接、运行时根内、幂等、实体副本纠正）。差异仅在于“何时执行”，因此只移动执行时机，不复制语义。

7. **Verification**
   - `tests/dependency-link-consolidation.test.ts` 10 个用例，覆盖 8 项要求（§4）。
   - 真实 Node 子进程从安装布局 `import` 目标包（不是“文件存在”断言）。
   - 安装器 fast 套件、lint 全绿；既有 rollback 套件复跑通过。

8. **Risk**
   - 链接集合现在由部署后的 manifest 决定：若某兄弟组件在包内缺失但 manifest 仍声明 `file:../`，安装会失败（这是有意的 fail-closed）；构建侧需保证 bundle 改写与载荷一致（已有 `rewriteBundledDependency` 在目标缺失时 no-op）。
   - 旧版 npm-distributed 恢复路径（`PD_ALLOW_LEGACY_NPM_INSTALL` + registry 升级）现在按 registry manifest 解析 registry 依赖，而不是强制指向运行时兄弟；该路径未在本机实跑（见 §5）。

9. **Rollback / recovery**
   单 commit 可整体 revert；无数据迁移、无持久状态变更。回滚后旧行为（`!existsSync` 短路）恢复。已建链接无需清理（部署目录由下次安装整体替换）。

10. **Follow-ups（ deliberate out-of-scope）**
    - B2 依赖裁剪（428.6 MB 载荷裁剪）；
    - 跨组件共享 node_modules 布局评估；
    - `ensureBundledPdCliResolution()` 的 `existsSync` 短路（发布包自身 npm 树，语义不同，见 §6）；
    - 升级路径 `/apply-full` 的原样部署不建链（未改）；
    - 观测到的 bundled `core/package.json` 版本漂移（§9）。

---

## 2. 现有链接逻辑分布审计表

| # | 调用点（`packages/create-principles-disciple/src/installer.ts`） | 处理的依赖形态 | 幂等 | `existsSync` 短路 | 特殊语义 | 本轮处置 |
|---|---|---|---|---|---|---|
| 1 | `syncPdCli()` L2234（原 L2256-2326） | `file:../` 兄弟组件：core / host-runtime / codex-adapter / principles-disciple | 否（仅“不存在才建”） | **是**（物理副本静默胜出） | 在依赖准备之前建链；注释含已被否证的向上解析说明 | **收敛**到 `ensurePdCliResolution()`，移除手写块与错误注释 |
| 2 | `installConsole()` L2424（原 L2512-2533） | `file:../` 兄弟组件：plugin、release-manager | 否（同上） | **是** | 目标均为 `runtime/` 兄弟（`installedPluginDir()` = `<runtime>/plugin`） | **收敛**到 `ensureConsoleResolution()` |
| 3 | `ensureComponentFileDependencyLinks()` L2576 | 安装态组件的 `file:../` 依赖（数据驱动） | 是（lstat + realpath 相同则跳过） | **否**（物理副本/悬空链接会被纠正） | 路径穿越拒绝、缺失兄弟 fail-closed、Windows junction / POSIX 相对 symlink | **复用**；本轮补充依赖**名称**的路径段校验 |
| 4 | `ensureCodexAdapterResolution()` L2673 | 安装态 codex-adapter 的兄弟依赖 | 是（helper） | 否 | 无 | 保留 |
| 5 | `ensureWorkbuddyAdapterResolution()` L2717 | 安装态 workbuddy-adapter 的兄弟依赖 | 是（helper） | 否 | 组件缺失 → 可观测 skip（不 fail） | 保留 |
| 6 | `ensureBundledPdCliResolution()` L1652 | **发布包内** pd-cli 的 6 个兄弟组件 | 部分 | **是**（存在即跳过） | 根为包根而非 runtime；两层 node_modules；缺失组件跳过；写的是安装器自身的 npm 树 | **保留**（所有权/根/策略不同，见 §6） |
| 7 | `reconcilePluginCoreCanonicalJunction()` L2780 | plugin 内物化的 `@principles/core` 物理副本 → canonical junction | 是（三门槛 + 备份回滚） | 否 | 身份/声明/版本一致性门槛；失败走既有 console-probe→rollback | 保留（不同安全边界） |
| 8 | `ensureCoreDependency()` L2978 | 仅存在性检查（当前为 no-op） | 是 | — | 无 | 保留 |
| 9 | 升级路径 `/apply-full`（`src/update/**`） | 载荷原样部署 | — | — | 不建链接（`rg symlinkSync|junction` 无命中） | 保留（本轮不扩大范围） |

结论：**只有 #1 / #2 与 helper #3 语义可证明等价**（同一目标根、同一依赖形态、同一纠正策略），因此只合并这两处；#6 / #7 的根目录、所有权、失败策略不同，按“不同安全边界一律保留”处理。

---

## 3. 改动清单（文件:行）

| 文件 | 行 | 改动 |
|---|---|---|
| `packages/create-principles-disciple/src/installer.ts` | `-200..203` | 删除已无引用的 `installedPluginDir()` 浅包装 |
| 同上 | `-2256..-2326` / `+2252..2258` | 删除 `syncPdCli()` 内 4 段手写链接块（含错误注释），替换为“由 `ensurePdCliResolution()` 在依赖阶段之后物化”的说明 |
| 同上 | `-2512..-2533` / `+2444..2447` | 删除 `installConsole()` 内 2 段手写链接块 |
| 同上 | `+2606..2610` | helper 增加依赖名 `^(@scope/)?name$` 校验（`rc-1`：依赖名也是 manifest 输入，不能穿越 `node_modules`） |
| 同上 | `+2637..2662` | 新增 `ensurePdCliResolution()` / `ensureConsoleResolution()`（薄包装，复用 helper） |
| 同上 | `+4447..4450` | `install()`：`await installPdCliDependencies()` 之后调用 `ensurePdCliResolution()` |
| 同上 | `+4481..4484` | `install()`：`await installConsoleDependencies()` 之后调用 `ensureConsoleResolution()` |
| `packages/create-principles-disciple/scripts/bundle-plugin.mjs` | `804..818`、`852..855` | 注释从 `syncPdCli()` 改为 `ensurePdCliResolution()`，与实际实现一致 |
| `packages/create-principles-disciple/tests/dependency-link-consolidation.test.ts` | 新增 | 10 个真实文件系统/真实子进程回归用例 |
| `packages/create-principles-disciple/tests/mvp-config.test.ts` | `2114..2170` | 旧实现源码断言改为新契约断言（helper 复用、无手写块、顺序契约） |
| `packages/create-principles-disciple/tests/installed-topology-invariants.test.ts` | `250..256` | 两条链接断言迁出（fixture 无依赖、helper 数据驱动无链接可断言），链接契约由新套件覆盖 |
| `packages/create-principles-disciple/tests/release-upgrade-gate.test.ts` | `535..538` | 修正已过时的 `syncPdCli` 注释，不改断言 |
| `.changeset/dependency-link-consolidation.md` | 新增 | `create-principles-disciple: patch` 发布意图声明 |

---

## 4. 8 项回归的真实输出

命令（worktree 内）：

```powershell
cd packages/create-principles-disciple
npx vitest run tests/dependency-link-consolidation.test.ts --reporter=verbose
```

真实输出（节选，逐条对应 8 项要求）：

```
 ✓ 1. replaces npm-materialized physical copies with runtime sibling links 30ms
 ✓ 2. a correct link is idempotent (second pass does not recreate it) 14ms
 ✓ 3a. a link aimed at the wrong sibling is repaired 11ms
 ✓ 3b. a dangling link (target removed) is repaired 10ms
 ✓ 4. a missing sibling fails closed (no silent skip, no link for the missing dep) 8ms
 ✓ 5a. a sibling target ref that escapes the runtime root is rejected 22ms
 ✓ 5b. a dependency NAME that escapes node_modules is rejected 14ms
 ✓ 6. Windows uses an absolute junction target; POSIX uses a relative dir symlink 9ms
 ✓ 7. pd-cli and console resolve their declared packages from the installed layout 109ms
 ✓ 8. a failed link pass mutates ONLY the deployed component tree (rollback premise) 11ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

| 要求 | 实现方式 | 证据 |
|---|---|---|
| 1. 实体副本 → 链接 | 对 pd-cli 6 条、console 5 条依赖全部预置“stale 实体副本”，调用后断言 `lstat().isSymbolicLink()` 为真、`realpath` 指向运行时兄弟，且读到的是兄弟内容而非 stale 内容 | 用例 1 |
| 2. 正确链接幂等 | 第二次调用后 `ino/birthtimeMs/mtimeMs/realpath` 完全一致（未删除重建） | 用例 2 |
| 3. 错误/悬空链接修复 | 指向错误兄弟的 junction、目标被删除后的悬空 junction 均被重建为正确链接 | 用例 3a/3b |
| 4. 缺失兄弟 fail-closed | 删除 `host-runtime` 后 `ensurePdCliResolution()` 抛出 `/missing/`，且不创建该依赖的链接 | 用例 4 |
| 5. 路径穿越拒绝 | `file:../../outside` → `unsupported file dependency ref`；依赖名 `../../evil` → `unsupported dependency name`；均不产生任何链接 | 用例 5a/5b |
| 6. Windows junction / POSIX symlink | Windows 上真实 junction：`readlink` 为绝对路径且指向运行时兄弟；POSIX 分支断言链接目标为**相对**路径（该分支在 Linux CI 上真实执行） | 用例 6 |
| 7. 真实模块解析 | 用 `spawnSync(process.execPath, [<component>/dist/probe.js])`，由 ESM 实际 `import` 全部声明依赖并输出 marker；pd-cli 6 项、console 5 项全部返回兄弟包 marker（非 stale） | 用例 7 |
| 8. 失败不留半链状态 | 失败用例断言：创建出的全部链接都位于 `<runtime>/component/node_modules` 内，运行时**顶层**条目快照完全不变；`install()` 既有的整树恢复/清理（`restoreBackup` / fresh-install 清理）覆盖该变更面 | 用例 8 + 既有回滚套件复跑 |

补充真实输出：

```
# 安装器 fast 套件（tests 目录，排除 smoke / release-asset-smoke / release-upgrade-gate / release-junction-lifecycle）
 Test Files  88 passed (88)
       Tests  1030 passed | 6 skipped (1036)
```

```
# 仓库 lint
[lint-by-package] summary: 12/12 packages ok
✖ 2 problems (0 errors, 2 warnings)   # principles-core，既存、无关
✖ 1 problem  (0 errors, 1 warning)    # workbuddy-adapter，既存、无关
```

```
# 受影响既有套件（单独复跑）
tests/installed-topology-invariants.test.ts   pass
tests/backup-restore-partial.test.ts          pass
tests/delivery-surface-parity.test.ts         pass
tests/codex-adapter-resolution.test.ts        pass
tests/rollback-policy.test.ts                 pass
tests/mvp-config.test.ts                      pass
tests/plugin-core-junction.test.ts            pass
tests/global-shim-lifecycle.test.ts           pass
```

---

## 5. 被测试证实的 vs 仅凭代码审查判断的

**被测试证实的：**
- 实体副本替换、幂等、错误目标/悬空链接修复、缺失兄弟 fail-closed、两种路径穿越拒绝、Windows junction 形态、分散组件真实 ESM 解析、失败仅触及组件子树。
- 安装器整体 install 流程在“无 `file:` 依赖”的沙箱 fixture 下仍可 settle（拓扑不变量套件通过）；既有回滚套件未回归。

**仅凭代码审查判断（未在本机实跑）：**
- `release-upgrade-gate.test.ts`（opt-in，需构建候选 N 载荷）：本轮只改其过时注释；其 `expectCanonicalRuntimeLayout` 只断言内容新鲜度，链接化后 `readPackageJson` 仍跟随链接，结论不受影响。
- 旧版 `npm-distributed + PD_ALLOW_LEGACY_NPM_INSTALL` 路径：`tryUpgradePdCliFromNpm()` 会把 pd-cli package.json 换成 registry manifest（caret 依赖），随后 npm install 物化 registry 副本；合并后的 helper 只处理 `file:../`，因此该路径改按 registry manifest 解析，而不是像旧代码那样强制指向运行时兄弟。这是与旧行为的**有意差异**，未实跑（需要 registry 网络安装）。
- `/apply-full` 升级路径不建链接（部署载荷原样），因此升级态的 pd-cli 仍可能保留载荷物化副本；本轮未改，属 G3-R4 已记录的后续候选。
- `ensureBundledPdCliResolution()` 保留 `existsSync` 短路的原因：它写的是安装器自身的 npm 树（可能含合法的 registry 依赖），替换为链接会改变安装器自身运行时；与“安装态组件私有 node_modules”不是同一所有权边界。

---

## 6. 有意的保留差异（未合并）

1. `ensureBundledPdCliResolution()`：发布包根布局、两层 `node_modules`、缺失组件容忍、安装器自身依赖树 → 不并入 runtime helper。
2. `reconcilePluginCoreCanonicalJunction()`：仅处理 plugin 的 core 物理副本，带身份/声明/版本三门槛与备份回滚 → 不做通用化。
3. `ensureWorkbuddyAdapterResolution()` 的“组件缺失可观测跳过”：与“声明缺失 fail-closed”不同，保留其既有安装策略。
4. `installConsole()` 的 `principles-disciple` 链接目标 `installedPluginDir()` 实际就是 `<runtime>/plugin`（审计确认，注释中“扩展目录根”的说法是过时的），与 `file:../plugin` 完全等价，因此无需覆盖机制。

---

## 7. 回滚方式

- 代码：revert 单个 PR commit 即可；无数据库/迁移/持久状态。
- 已物化链接：随下次安装整目录替换；如需手工恢复，删除 `runtime/{pd-cli,console}/node_modules/{@principles/*,principles-disciple,create-principles-disciple}` 后重跑安装。
- 不涉及 release-locks、runtime-version.json、feature flag。

---

## 8. 范围外发现（只记录，不修改）

1. `packages/create-principles-disciple/core/package.json` 在本地 `test:fast` 运行后会被写成 `version: 2.1.0`（提交态为 `2.0.0`，而 `packages/principles-core/package.json` 为 `2.1.0`）。该文件为测试/构建副作用，本轮已用 `git restore` 恢复、未提交。是否为“bundled manifest 陈旧”缺陷需另行确认。
2. `syncPdCli()` 原注释中“host-runtime 依赖通过 plugin node_modules 向上解析”的说法与实际解析链不符（G3-R4 已实证）；本轮已随链接块删除，未扩大改动。
3. `ensureBundledPdCliResolution()` 仍存在 `existsSync` 短路（见 §5 保留理由）。
4. `scripts/bundle-plugin.mjs` 中“the installer and /apply-full create the resolving node_modules/create-principles-disciple link”注释与实际不符：审计（`rg symlinkSync|junction` 于 `src/`）未在 `/apply-full` 路径发现链接逻辑。属文档漂移，本轮未改代码。

---

## 9. Linear 工单

- 工单：**PRI-1100** — <https://linear.app/principlesdisciple/issue/PRI-1100/p2-installer-兄弟依赖链接逻辑合并g3-105>
- 首次 `create` 曾返回 `linear_graphql_error`（工作区 free issue limit）；重试后成功。
- 已检索既有工单：无对应 G3 §10.5 工单（PRI-912/913 是 `@principles/core` canonical junction 及其生命周期，属上游而非本任务）。
- PR 标题含 `(PRI-1100)`，正文第一行 `Fixes PRI-1100`。
