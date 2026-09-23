# Asset Deduplication SPEC-P1 — Canonical Symlink Compatibility Audit

> 状态：**只读审计**。本 PR 不含任何代码变更、不改 build scripts / installer / manifest 逻辑 / release layout / package.json / lockfile / ADR，不进入实施。
> 取证基线：分支 `ai/adhoc-20260923-canonical-symlink-audit-7c3e1b`（base main@bc2ecade）；所有 file:line 以该 commit 为准。
> 前置：Phase 0 审计 `docs/release/asset-deduplication-feasibility-audit.md`（fb02356e）；SPEC-P0 prebuild 剪枝 PR #1857。

## Executive Summary

**结论一句话：asset 内 symlink（原始 Option B）被现有信任模型在四个环节全部硬拒，且 Windows 生产解包器实测无法解出 symlink 条目；archive 级去重（Option C）对"整包目录冗余"这一 PD 冗余主形态技术上不成立（Windows 无法对目录做 hardlink）。唯一有生产先例、契约零破坏的拓扑改变路径是 B′：资产保持无链接，由 installer 在部署期把物化拷贝替换为 canonical junction（PRI-711 `ensureCodexAdapterResolution` 机制的推广）。**

判定摘要（对照任务决策树）：本次审计落在**情况 B 的变体**——runtime 侧（installer / rollback / uninstall / Windows junction）全部绿灯且有实测证据；manifest / archive 侧不支持 asset 内链接（这是刻意设计的信任边界，不是缺陷）。按决策树"不做 asset 内 symlink"；但 archive dedup（C）也已被否，故剩下的唯一去重路径是部署期建链（B′），它不属于"资产拓扑改变"，风险等级从"重造信任模型"降为"扩展一个已验证的 installer pass"。

| 问题 | 判定 | 关键证据 |
| --- | --- | --- |
| Q1 Manifest 支持 symlink？ | **否 — 检测即拒（不展开）** | `release-asset-manifest.ts:74-76`；实测见 §Q2 |
| Q2 Archive 保留 link？ | **构建器拒收 link 输入；tar 格式本身支持但生产链路不用** | `deterministic-release-archive.mjs:27` + bsdtar 实测 |
| Q3 Installer 保/扩/删？ | **链接活不到 installer：解包或 preflight 阶段即中止；部署 cpSync 默认展开** | `apply-payload.ts:293-303,327-328`、`installer.ts:2197` |
| Q4 升级/回滚安全？ | **junction 对整树 rename/删除安全（实测）；asset 内链接方案在解包即死** | 实验 §Q4 |
| Q5 PRI-711 是哪类？ | **(A) runtime 解析修复，非 asset 去重；平台分叉/幂等替换模式可直接复用** | `installer.ts:2384-2439` |
| Q6 Windows 现实？ | **junction 免管理员免 Developer Mode（生产在用+实测）；原生 symlink 解包失败（实测）** | `installer.ts:2037` + 实验 §Q6 |
| Q7 选项 | A=安全浪费；B=否定；C=否定；**B′（部署期 junction）=有条件推荐** | §Options |

## 1. Current Release Contract（现行资产契约）

自包含发布资产的完整性链条（构建→分发→安装）由五道无链接假设构成：

1. **构建输入扫描**：`scripts/build-release-asset.mjs:94` — release 输入树含 symlink 即 `throw 'Release input contains a symlink'`。
2. **payload 枚举**：`build-release-asset.mjs:144` 与 `src/update/release-asset-manifest.ts:74-76`（同一规则的双实现：构建期与校验期）— `entry.isSymbolicLink()` → `ReleaseAssetManifestError('asset_path_unsafe', 'Release asset must not contain symlinks')`；非普通文件条目同样拒绝（:81）。
3. **manifest 数据模型**：`release-asset-manifest.ts:6-10` — 记录类型只有 `{path, sha256, size}` 普通文件；`parseReleaseAssetManifest`（:106）要求安全相对路径 + 64 位 hex digest，无 link 条目类型。
4. **归档构建器**：`scripts/deterministic-release-archive.mjs:27` — 输入含 symlink 即抛 `Release archive input contains a symlink`。归档为 store 格式 ustar（P0 实测首 header），mtime/模式归一，逐字节确定。
5. **烟测断言**：`tests/release-asset-smoke.test.ts:130`（解包 onentry 拒 `SymbolicLink`/`Link`）、`:202`（解包后全树 lstat 无 symlink）。

安装方向的唯一合法链接来源是 **installer 部署期建链**（§Q5），asset 本身承诺零链接。此契约在 PRI/审计中反复出现（Phase 0 报告称"四条安装契约"之三）。

## 2. Q1 — Manifest Compatibility

**Manifest Contract**

| 维度 | Current | Symlink 如果出现在树里 | Evidence |
| --- | --- | --- | --- |
| 记录内容 | 仅普通文件 path/size/sha256 | — | `release-asset-manifest.ts:6-10` |
| 枚举行为 | `lstat` 语义（Dirents） | **拒绝**：`asset_path_unsafe`，不展开 target、不记录 link 本身 | `release-asset-manifest.ts:74-76` |
| 校验行为 | `verifyReleaseAssetManifest(Async)` 重数文件数 + 逐个重算 sha256 | 数量对不上或路径被拒 → 失败 | `release-asset-manifest.ts:163,181` |
| 构建侧 | 同一枚举函数在 manifest 生成前跑 | 构建直接抛错（fail-closed 在发布之前） | `build-release-asset.mjs:144` |

判定：**Supported = No（reject-on-detect）**。manifest 既不支持 link 条目，也不会"展开 target 记录"——它在任何记录动作发生前就把 link 判为 unsafe。这是信任模型的一部分：per-file digest 只对普通文件字节负责；如果展开 symlink 记 target 内容，校验期攻击者（可控 asset 内文件布局）可以让同一 target 被多次记账或以 link 换指——拒收是最小正确语义。

## 3. Q2 — Archive Compatibility

**构建器**：`deterministic-release-archive.mjs:27` 在列条目阶段拒绝任何 symlink 输入，因此**由本仓库产生的 tar 永远不含 link 条目**。"archive 是否保留 symlink"因此只对**外部喂入的 tar** 有意义（例如未来有人改构建器），下表用真实实验回答。

**实测**（D:/tmp/p1-exp，2026-09-23）：手工构造含 `payload/link -> hello.txt`（ustar typeflag '2'）+ 普通文件的合法 tar；`bsdtar tvf` 正常列出该 symlink 条目（格式层支持确认）。解包行为：

| Platform / 解包器 | Archive 行为（实测） | Risk |
| --- | --- | --- |
| Windows **System32 bsdtar**（= 生产 `extractReleaseAssetArchive` 的调用体，`apply-payload.ts:294`） | 普通文件解出；symlink 条目报 `Can't create '\\?\...': Invalid argument`，**非零退出**（即使当前用户是 Administrator） | 生产更新在解包步 `execFileSync` 抛错 → 事务停在 staging，runtime 零改动。fail-loud 但等于**方案 B 在 Windows 直接死亡** |
| Windows **Git Bash GNU tar**（MSYS） | symlink 条目**静默展开**为内容相同的普通文件（`link` → FILE size=11），exit 0 | 危险类：产物字节与"链接树"语义不同；幸而生产不走此二进制，且任何此类产物都会因逐文件 digest 对不上被 manifest 校验拒绝 |
| Linux/macOS 系统 tar | 标准：恢复为真 symlink | 解出的树随即被 preflight `verifyReleaseAssetManifestAsync` 以 `asset_path_unsafe` 拒绝（枚举 lstat 语义） |

判定：**Archive = 不支持（构建器拒收 + 生产解包器 Windows 实测失败 + 校验器拒收链接树）**。三层任何一层都足以否掉"asset 内放链接"。

## 4. Q3 — Installer Compatibility

生产更新链（`release-manager.ts:448-471`）：

```
downloadReleaseAsset（TUF 签名 digest 校验）
→ extractAndVerifyReleaseAsset（apply-payload.ts:311）
    → extractReleaseAssetArchive :293  # spawn 系统 tar xzf（cwd=transactionDir，相对路径）
    → preflightSelfContainedReleaseAsset :327-328（installer.ts:943）
        = identity/target 校验 :948-953 + 全量 manifest 重验 :966-967
→ install(payloadDir, …) :458           # 与手动安装同一 cycle
```

payload → `~/.pd/runtime` 的落地全部是**逐组件 `cpSync(recursive)`**（installer.ts 部署函数，如 :2196-2197 release-manager、:2320 core、:2338 host-runtime、:2360-2361 codex-adapter）。Node `fs.cpSync` 默认 `dereference: true`——即使有链接活到这一步，也会被**展开成物理拷贝**，绝不会以链接形态进入安装树。

判定：installer 对"archive 里的链接"的答案是 **keep=无 / expand=理论上有（cpSync 默认）/ reject=前两道闸（解包 + preflight）**。链接的实际生产者恰在下游：installer 部署**完成后**创建 runtime 内的 junction（syncPdCli / ensureCodexAdapterResolution / plugin shell，见 §Q5）。也就是说现行架构已经给出了本题的答案形态：**去冗余发生在装机态、由 installer 建链，而不是让链接穿过资产管线**。

## 5. Q4 — Upgrade / Rollback Compatibility

回滚机制 = **整树 rename-swap**：`backupExistingInstall`（installer.ts:1104-1130）把 `~/.pd/runtime` rename 到 `runtime.backup.<ts>`；`restoreBackup`（:1132-1152）在失败时把备份 rename 回来（必要时先 `rmSync` 半成品新树）。卸载 = `fse.remove`（uninstaller.ts:373-376 removeWithRetry）。

对"装机树内含 junction"的四种场景，本机（win32-x64, NTFS, Node junction）实测：

| Scenario | 结果（实测） | 判定 |
| --- | --- | --- |
| **升级**：新 runtime 内部 junction（target 为 `~/.pd/runtime/<component>` 绝对路径）随整树部署 | rename 容器目录后链接照常解析（junction 存绝对 target，容器移动不破坏） | 安全 |
| **回滚**：live runtime 被 rename 成 backup，再把旧 backup rename 回 live | 窗口期内 backup 树中指向 live 路径的 junction 悬空（existsSync=false）；rename-back 后恢复解析。旧树里 installer 建的 junction 全部随树保留 | 安全（悬空窗口内该树不被任何进程按运行时使用——它正是"已退位"的备份） |
| **卸载/清理**：`fs.rmSync(recursive)` 与 **`fse.remove`（uninstaller 实际用的）** 删除含 junction 的树 | 两法实测都**不追链接**：链接被 unlink，target 树（canonical）完好 | 安全（与 git-8 "junction-safe 删除"纪律一致） |
| **repair**（installer repair 模式重跑） | 建链 pass 全部幂等：`existsSync` 跳过或 lstat+realpath 比对后替换（:2422-2431） | 安全 |

风险矩阵唯一实质风险：backup 树与 live 树并存时，backup 内 junction 的绝对 target 指向 live 路径——备份树作为"可整体 rename 回来的冷备"语义成立（回来即有效），但不构成可独立双活的快照。这对现行 rename-swap 回滚模型无影响，因为该模型从不并发使用两棵树。

判定：**Rollback 兼容 = 通过（针对 B′ 部署期建链）**；针对"asset 内链接"则无意义——活不到这一步（§Q2/Q3）。

## 6. Q5 — PRI-711 Mechanism Comparison

`ensureCodexAdapterResolution`（installer.ts:2384-2439，PRI-711）解决的问题是 **(A) runtime 解析**，不是 (B) asset 去重：payload 把 codex-adapter 的 `file:../` 依赖物化成拷贝（或旧安装器根本没建 node_modules），部署后 ESM realpath 解析炸掉（:2369-2372 记录了 1.231.2 事故）。该 pass 把陈旧物理拷贝 `rmSync`（:2430）后替换为指向 canonical runtime 组件的 **Windows junction / Unix 相对 symlink**（:2433-2436），数据驱动自 adapter 自己的 `package.json` 中 `file:../` 声明（:2403-2404），rc-1 守护单段名（:2406-2410）。

**可直接复用于 B′**：
1. 平台分叉建链模式（win junction 绝对 target / unix 'dir' 相对 target）——同一形状出现在 :1465-1469、:2036-2042、:2433-2436，是仓库稳定惯例；
2. "物化拷贝 → canonical 链接"的幂等替换逻辑（lstat + realpath 比对 + 仅删该位置 :2416-2431）；
3. 数据驱动清单：`file:../` ref 扫描（bundle-plugin 改写产物，天然与组件拓扑同步）；
4. 调用时序约束注释（:2379-2382 "MUST run after …"）提示 B′ 需要同样的部署后置排序。

**不可照搬**：
- 它只修 codex-adapter 一个组件、一层 `node_modules`；推广到全组件+嵌套图是新范围（Phase 0 报告估算 @principles 家族真冗余 188.3 MiB）；
- 它跑在 runtime 目录已存在之后——完全不触碰 asset/manifest/archive 契约，这既是它的优点（零信任模型变更）也是它不解决"资产体积"的原因（下载大小不变，省的是装机磁盘与 hoist 维护成本）。

**装机态实证（本机只读检查）**：`~/.pd/runtime/codex-adapter/node_modules/@principles/core` 与 `~/.openclaw/extensions/principles-disciple/core` 均为活 junction（readlink → `C:\Users\Administrator\.pd\runtime\core`）→ 机制在生产 Windows 上常年工作。而 `runtime/pd-cli/node_modules/@principles/core` 是 **PHYSICAL DIR** → 印证 Phase 0 根因：syncPdCli 的 `!existsSync` 分支在 payload 自带物化拷贝时跳过建链——B′ 要修的正是这个绕过。

## 7. Q6 — Windows Reality Check

| 事实 | 证据 |
| --- | --- |
| Junction 创建**不需要**管理员、不需要 Developer Mode | ① 生产代码注释 `installer.ts:2037`（"junction … doesn't require elevated privileges"）；② 全链路 `symlinkSync(..., 'junction')` 无 try/catch 降级、无 EPERM 兜底（:1466/:2038/:2056/:2070/:2090/:2434）——若需要特权，安装早就 fail 了；③ 本机装机态存在真 junction（§Q6 上节）；④ 本次 `fs.symlinkSync(...,'junction')` + `mklink /J` 实测成功 |
| **原生 symlink（非 junction）在 Windows 不可依赖** | bsdtar 解 symlink 条目实测失败（`Invalid argument`，即使 Administrator 且未开 Developer Mode 的本机）；Node 建非 junction 的 'dir' symlink 在未开 Developer Mode 时需 SeCreateSymbolicLink 特权——PD 代码全部走 junction 分支正是为此 |
| tar 二进制选择本身有平台坑（已被现行代码规避） | `apply-payload.ts:285-292` 注释：Git Bash GNU tar 把 `D:\…` 当远程主机，故生产用 cwd+相对路径调 tar；本次实测两 tar 行为分叉（bsdtar 报错 vs GNU 静默展开）再次证明解包器不可互换 |

**Windows 结论**：任何拓扑改变在 win32 上只有一种安全形态——**junction（目录级、绝对 target、installer 部署期创建）**。symlink 形态（tar 携带、构建期物化、跨机复制）在 Windows 全部不成立。

## 8. Q7 — Options Comparison

| | A: 维持物化（现状+P0） | B: asset 内 canonical 链接 | B′: 部署期 junction pass（PRI-711 推广） | C: archive 级去重（装机树不变） |
| --- | --- | --- | --- | --- |
| 省什么 | 仅 P0 已拿到的 99.5 MiB/asset | 资产+装机同时省（~188 MiB 量级） | **只省装机态**；资产大小不变 | 理论上省资产字节 |
| 契约冲击 | 无 | **重写信任模型**：manifest 需 link 条目类型（v2）、4 处构建/校验 guard 反转、smoke 断言反转、**Windows bsdtar 根本解不出**（实测）、cpSync 会展开——链路多处硬死锁 | 资产契约零改动；改 installer 一段部署后置 pass；回滚保护（rename-swap）实测兼容 | **不成立**：PD 冗余形态是整包**目录**重复，tar hardlink 条目（typeflag '1'）只能去重**文件**且要求解包器支持建硬链；bsdtar 对目录链接无能为力的问题同样存在（Windows 目录不能 hardlink，只能 junction——又回到 B 的死锁）；store 格式 tar 也没有内容级去重余地 |
| 风险等级 | 无 | 最高（跨 build/manifest/archive/installer/CI 五层 + 平台不可行） | 中低（单文件级 installer 改动 + 已有生产先例；主要风险=混合树） | N/A（技术上不可达） |
| 生产先例 | — | — | PRI-711 已上线一年、多机验证（本机装机态可见活 junction） | — |

## 9. Recommendation

**Final: B′ — "B with conditions" 的落地形态 = 部署期 canonical-junction pass；asset 内 symlink（原 B）与 archive dedup（C）均判定为不可行。**

按任务决策树逐条对号：
- manifest 支持 symlink？否（刻意拒绝）。archive 保留？否（构建器拒收+生产解包器实测失败）。→ 落入"情况 B：不做 asset 内 symlink"。
- "研究 archive dedup"分支：本报告已给出否定结论（目录冗余形态 vs hardlink 语义 + Windows 无目录硬链），无需另开研究票。
- Windows rollback 风险（情况 C 触发条件）：对 B′ 而言实测不存在（rename 保链接、删除不追链、悬空窗口只在冷备期）。

若 Owner 批准 B′，实施前需要的额外 SPEC（对应审计发现）：
1. **SPEC-P1′（installer pass 推广）**：`ensureCodexAdapterResolution` 泛化为多组件（core/host-runtime/plugin/console/pd-cli/release-manager + 嵌套 `@principles/core/node_modules`）的替换清单与收敛性论证；修复 syncPdCli `!existsSync` 绕过（§Q5 末）；保持"仅动 runtime 树内、junction 绝对 target"惯例。
2. **SPEC-P1′-e2e（升级/回滚回归）**：带 junction 的 runtime 真机 rename-swap 回滚 e2e（现行已知缺口：rollback 无 e2e，见 Phase 0 记忆）+ 卸载 fse.remove 路径回归（不追链为断言项而非假设）。
3. **SPEC-P1′-verify（装机态一致性断言）**：现有 `verifyNativeModules`/storyA 验证在混合树（junction+物理拷贝并存）下的行为重测；决定是否需要"重复度报告"构建期守卫（Phase 0 A 类建议）作为先行观测。
4. （可选前置）**度量腿**：B′ 的收益全部体现在装机态而非资产——若 Owner 的核心诉求其实是**下载体积**，B′ 不解决，应回头评估跨组件 bundle 合并（另一族问题）。

**最大风险**（若做 B′）：pass 覆盖面不全导致 junction/物化拷贝混合树，故障形态是偶发 ERR_MODULE_NOT_FOUND 或双拷贝漂移——与 PRI-711 修掉的 1.231.2 事故同类；这正是要求上面 SPEC-P1′-e2e 而非小补丁的理由。

## 10. Not Included（有意排除）

- 任何代码/脚本/配置修改（本审计零代码变更、无 PR 实施意图）；
- 资产下载体积优化路线（B′ 不改变 asset 字节；跨组件 bundle 合并属另一决策域）；
- Linux musl / arm64 装机态行为（P0 已覆盖构建侧；B′ 的 unix 分支沿用 'dir' 相对链接惯例，本机无法实测，留实施 SPEC）;
- npm-distributed 安装形态（非自包含链路的 tar 解包 installer.ts:1969 属 legacy 路径，不在资产去重问题域内）。

## Appendix — 实验记录（全部可复跑）

| # | 实验 | 结果 | 位置 |
| --- | --- | --- | --- |
| E1 | `mklink /J` + `fs.symlinkSync(...,'junction')` 非特权创建 | 成功（Administrator 常规 shell） | D:/tmp/p1-exp |
| E2 | `fs.rmSync(recursive)` 删含 junction 树 | 链接删除，canonical target 完好 | E2 |
| E3 | `fse.removeSync`（uninstaller 同款 fs-extra）删含 junction 树 | 同上，target 完好 | E3 |
| E4 | 手工 ustar（typeflag '2' symlink 条目）→ `bsdtar tvf` | 正常列出（格式层支持） | link-archive.tar |
| E5 | System32 bsdtar 解 E4 | symlink 条目 `Invalid argument` 失败、非零退出；普通文件成功 | extract_bsd |
| E6 | Git Bash GNU tar 解 E4 | symlink **静默展开**为普通文件（11B），exit 0 | extract_gnu |
| E7 | junction 所在容器目录 rename | 链接保持解析（绝对 target 随树无关） | tree_d |
| E8 | junction target 目录 rename-away / rename-back | 窗口期悬空 / 复原即有效 | E8 |
| E9 | 装机态只读 lstat/readlink（`~/.pd/runtime`, `~/.openclaw/extensions`） | codex-adapter 与 plugin shell 为活 junction；pd-cli 为物理拷贝（syncPdCli 绕过证据） | 本机 |
