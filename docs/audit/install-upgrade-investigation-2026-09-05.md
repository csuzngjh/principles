# PD Install & Upgrade Reliability Investigation — 2026-09-05

> 性质：**只读调查 + 每确认问题一个修复 PR**。调查阶段未修改任何生产代码；全部实验在 `D:\pd-install-lab\` 隔离沙箱（HOME/USERPROFILE 重定向）中进行，生产安装只读取证。
> 调查纪律：不为通过安装测试降低检查、忽略失败或自动修复异常。安装失败不可怕，静默安装成功但功能缺失才是最高风险。
> 基线：`origin/main@c45c829a3`（含 PR #1518 PRI-686）；分发结论独立复核自 Pipeline Health Audit v1（PR #1519，2026-09-05）。

---

# Executive Summary

**总裁定：FAIL（新用户交付链断裂；已装用户升级链"表面成功、实际半生效"）。**

支撑结论的三组核心事实（全部 lab/生产只读实证）：

1. **新用户今天无法安装 PD（P0）**：npm 发布的 installer 包结构性缺失自包含资产 `_release/`（发布管线从不产出）且 files 白名单漏掉 `codex-adapter`——官方唯一新装通道 `npx create-principles-disciple --yes` 双路径必败（E-001/E-002），与 Audit v1 结论一致并给出精确根因。
2. **已装用户的"成功升级"实际只生效一半（P0，新发现）**：console `/apply-full` 更新 canonical 运行时树，但**从不刷新 `~/.openclaw/extensions/principles-disciple`——OpenClaw 实际加载的完整插件副本**。lab 实证升级后 ext 副本 bundle.js 与 canonical 内容 hash 不同（E-018/E-019）；生产只读取证显示 ext 副本(30MB, 09-03) 与 canonical(3.5MB, 1.230.0) 已分化两份（E-020）。同时 `pd --version` 读 ext 副本 → 永远报告旧版本。
3. **增量更新与回滚通道双双结构性不可用（P0）**：`/apply` 守卫拒绝 canonical 布局（必拒 400，E-012）；full update 不创建备份而 `/rollback` 需要显式 backupDir → **今日系统不存在任何可用的回滚路径**（代码证据）。

正面结论（机制健全的部分）：升级的状态迁移**完美**（DB 全表行数升级前后一致、config/flags 原样保留、schema 不变）；升级中断恢复**健壮**（kill 于 staging 阶段零生产变更，重试即成功，E-016/E-017）；自包含发布物在资产存在时安装链**完全正常**（E-005）——断裂纯在发布管线与更新流的收尾环节，不在安装器核心机制。

---

# Phase 0 — Investigation Context

```yaml
investigation:
  repository: https://github.com/csuzngjh/principles.git
  commit: c45c829a3 (origin/main, Merge PR #1518 PRI-686 workspace-resolver-alignment)
  current_version:  # npm 实测 2026-09-05
    principles-disciple (plugin): 1.230.0
    create-principles-disciple (installer): 1.132.2
    @principles/pd-cli: 1.147.5
    @principles/core: 1.277.2
    @principles/install-layout: 0.2.1
    @principles/host-runtime: 0.3.3
  target_version:
    - npm 通道: 1.230.0 / 1.132.2（升级测试目标）
    - 本地构建: origin/main@c45c829a3 自包含发布物（791.6MB payload / 884.9MB asset.tar）
  install_source: [npm self-contained, npm legacy, console /apply, console /apply-full, console /rollback, local bundle]
  environment:
    os: Windows 11 26200
    node: v26.7.0
    npm: 11.19.0
    host: OpenClaw 2026.9.1 (ad6fe23)
  previous_pd_version: 1.229.0  # 本机生产升级前版本
  upgrade_path:
    - 生产史: 1.227.0 → 1.229.0 → 1.230.0 (console /apply-full)
    - lab: 源码构建基座(1.76.1) → npm 1.230.0 (console /apply-full)
  notes:
    - IPv6 loopback ::1 被 VPN WFP 拦截（ERR-111）：console 一律 127.0.0.1
    - 沙箱方法：子进程重定向 HOME/USERPROFILE/APPDATA/LOCALAPPDATA → D:\pd-install-lab\home{,2,3}；
      getHomeDir() 优先读 HOME（mvp-config.ts:232-237），os.homedir() 走 USERPROFILE，双重覆盖；
      网关检测读重定向后配置（无配置 → isRunning=false）→ 全部系统写入落入沙箱
    - 生产安装（D:\.openclaw\workspace、真实 ~/.pd、真实 ~/.openclaw）只读取证，绝不变更
```

---

# Installation Matrix

| Scenario | Result | 证据 |
|---|---|---|
| fresh install (npx 自包含) | **FAIL** — `self_contained_asset_identity_invalid` | E-001 |
| fresh install (npx legacy) | **FAIL** — codex-adapter 缺失 + 半安装残留 | E-002/E-003 |
| fresh install (本地自包含发布物) | **PASS** — 全组件 verified | E-005 |
| upgrade (console /apply-full, 原地) | **PARTIAL** — canonical 更新成功，但 ext 插件副本不刷新、无回滚备份 | E-009/E-010/E-018/E-019 |
| upgrade (remove → install latest) | **FAIL** — 受 fresh install 断裂阻断（同一 P0） | E-001 推论 |
| rollback | **FAIL** — full update 无备份，/rollback 无可用 backupDir；/apply（唯一建备份通道）被守卫废掉 | 代码证据 + E-012 |
| failed upgrade recovery (kill 中断) | **PASS** — 零生产变更，重试成功 | E-016/E-017 |
| failed install recovery (重跑安装器) | **PASS** — force 模式干净覆盖残留 | E-015（但残留本身是 CP-6） |

---

# Phase 1 — Installation Path Matrix（通道清单与实测）

| # | 通道 | 命令/入口 | 结果 |
|---|---|---|---|
| A | npm 自包含 | `npx create-principles-disciple --yes`（README.md:42-64 主通道） | **FAIL**（E-001） |
| B | npm legacy | A + `PD_ALLOW_LEGACY_NPM_INSTALL=1` | **FAIL**（E-002/E-003） |
| C | console 增量 | `POST /api/update/apply` | **FAIL** — 守卫必拒 canonical（E-012） |
| D | console 全量 | `POST /api/update/apply-full` | **PARTIAL**（成功但半生效，见 CP-5/CP-4） |
| E | console 回滚 | `POST /api/update/rollback` | **FAIL** — 无备份可用（CP-4） |
| F | 源码/hermetic | `PD_INSTALL_PLUGIN_DIR` + 自包含发布物 | **PASS**（E-005） |

---

# Confirmed Problems

## CP-1（P0）npm installer 包结构性缺失自包含资产 → npx 默认通道必败

- **Problem**：`preflightSelfContainedReleaseAsset`（installer.ts:2119-2147）默认路径要求包内 `_release/asset.json`；npm 发布的包从未含它。
- **Evidence**：E-001（沙箱复现 exit 1 + `self_contained_asset_identity_invalid`）；tarball 清点 0 条 `_release`（E-021）；发布管线全程无 `build:release-asset`（publish action 构建步骤只有 bundle）；`files` 白名单不含 `_release`。
- **Reproduction**：`npx --yes create-principles-disciple@latest --yes --json`（任何机器）。
- **Root Cause**：双层——① 发布动作（.github/actions/publish-npm-package/action.yml Build target package）从不运行 `build:release-asset`；② 即使运行，`files` 白名单也会把 `_release/` 过滤掉。reproducibility 门禁（release-reproducibility-full.yml L51-55）双构建并字节比对的资产被直接丢弃，从未接入分发。
- **Impact**：新用户无法安装（产品不可获得）；`/apply` 错误提示引导用户"运行官方安装器修复"（update.ts:1063）——而官方安装器本身必败 → 错误恢复路径也断裂。
- **Priority**：P0。

## CP-2（P0）npm 包缺 codex-adapter 组件 → legacy 通道必败

- **Problem**：legacy 安装路径要求 `pluginDir/codex-adapter`（installer.ts:1430-1440）；发布包不含。
- **Evidence**：E-002（`Bundled @principles/codex-adapter not found`）；tarball 清点 0 条 codex-adapter（E-021）；`git log -S '"codex-adapter"'` 证明 files 白名单**从未**包含它（bundle-plugin.mjs 复制了，pack 过滤掉）。
- **Root Cause**：`packages/create-principles-disciple/package.json` `files` 漏列 `codex-adapter`。
- **Impact**：唯一 fallback 通道不可用；CP-1 的应急出口也被堵死。
- **Priority**：P0。

## CP-3（P0）console /apply 守卫拒绝 canonical 布局 → 增量更新通道不可用

- **Problem**：`legacyApplyMutation`（update.ts:1552）要求 targetDir 在 workspace/extensions/backups 三根内；canonical 布局 pluginDir=`~/.pd/runtime/plugin` 三者皆不在 → 必拒。
- **Evidence**：E-012（lab 实测 HTTP 400 `targetDir must be within workspace or extensions directory`）；代码 update.ts:123-135 + installed-layout.ts:75-77。
- **Root Cause**：`validatePathInWorkspace` 的允许根清单未随 canonical 布局（ADR-0020/ERR-097 迁移）更新——守卫保护的是旧物理布局。
- **Impact**：增量更新（保留 node_modules 的轻量更新）对 canonical 安装完全不可用；也是 CP-4 回滚不可用的共因。
- **Priority**：P0。

## CP-4（P0）回滚结构性不可用

- **Problem**：full update 不创建备份；`/rollback` 需显式 `backupDir`（update.ts:1590-1604）；唯一创建备份的 `/apply` 被 CP-3 废掉。
- **Evidence**：`doInlineFullUpdate`（update.ts:1049-1443）全程无 backup/reservePdBackup 调用（rg 证实）；升级成功后 update-history 无 backupDir 字段（E-010）。
- **Impact**：升级即单向门——出问题只能重装（而新装通道 CP-1 断裂）。违反 mvp-q-3-how-disabled（升级无退路）。
- **Priority**：P0。

## CP-5（P0）`/apply-full` 不刷新 OpenClaw 实际加载的 ext 插件副本

- **Problem**：`extDir = layout.pluginDir`（update.ts:1067）只指向 canonical `~/.pd/runtime/plugin`；`~/.openclaw/extensions/principles-disciple`（installer 经 installs.json 注册给 OpenClaw 的加载目标，openclaw-host-installer.ts:297-311）从不被更新。
- **Evidence**：
  - lab：升级 1.76.1→1.230.0 后 ext package.json=1.76.1、canonical=1.230.0、`pd --version`=1.76.1（E-018）；ext bundle.js（3,493,401B）与 canonical bundle.js（3,492,272B）hash 不同——**ext 是完整旧代码副本，非薄适配器**（E-019）。
  - 生产只读：ext 副本（30,005,016B, mtime 09-03）vs canonical（3,492,272B, 1.230.0）——两份已分化（E-020）；生产 openclaw.json plugins.entries 无自定义路径 → OpenClaw 经 extensions/ 扫描加载 ext 副本。
- **Root Cause**：canonical 布局迁移（ADR-0020）时 full update 流程只更新 layout.* 目录，未覆盖 OpenClaw 发现路径的 ext 副本。
- **Impact**：**"成功升级"后 OpenClaw 网关内运行的 hooks/commands 仍是旧代码**（pain 检测、/pd-pain 等插件面停留在安装时版本）；`pd --version` 永报旧版（版本权威分裂的生产表现）。这是"静默半生效"——比安装失败更危险的那一类。
- **Priority**：P0（升级通道的核心正确性缺陷）。

## CP-6（P1）installer 失败路径半安装残留 + 虚假状态声称

- **Problem**：安装失败后留下无清单的半安装 runtime，且失败消息声称"未修改/已回滚"与事实不符。
- **Evidence**（两形态）：
  - legacy 失败（E-003/E-004）：消息称 "The existing install was not modified"，实际 `~/.pd/runtime/{core,host-runtime}`（含 node_modules）已落盘，事务日志 planned→failed 无补偿清理。
  - console 验证失败（E-013/E-014）：消息称 "Installation rolled back — plugin and CLI are not activated"，实际 `~/.pd/runtime` 全 9 组件目录 + `~/.openclaw/extensions/principles-disciple` 完整插件副本均在，仅缺 install.json 与 workspace。
- **Root Cause**：失败路径的清理（journal 补偿）未覆盖已部署组件；消息文案描述的是"意图"而非"事实"。rc-9/cli-5 精神违反——降级/失败的可观测性依赖准确的状态声称。
- **Impact**：后续安装/状态检查面对无清单半安装树；OpenClaw 可能发现并加载孤儿插件（指向不存在 workspace 的运行时错误）。
- **Priority**：P1。

## CP-7（P1）发布管线构建顺序缺陷 → 下次 installer 发布必失败

- **Problem**：PRI-672（b13cbad05，09-05 01:45）引入 pd-console 对 `create-principles-disciple/dist/update/release-manager-authority.js` 的 type-only import（update.ts:1659/1766）；publish action 的 installer 分支**先建 pd-console 后建 installer**（action.yml Build target package）→ console tsc TS2307。
- **Evidence**：本地按 action 顺序复现失败、按门禁顺序（installer 先）成功（E-022）；npm 1.132.2 发布于 01:09 早于 PRI-672 提交（01:45）→ 断裂尚未在 CI 显形；reproducibility 门禁顺序不同（root build 含 installer）掩盖了该缺陷。
- **Impact**：下一次任何触发 installer 发布的 merge 都会在 publish 7/7 步骤失败 → plugin 已发布而 installer 未发（lockstep 断裂，正是管线注释里警告的场景）。
- **Priority**：P1（确定性故障，只是尚未触发）。

## CP-8（P2）更新 staging 临时目录永久泄漏

- **Evidence**：TEMP 内累积 ~140 个 `pd-update-*` 目录（2026-08-29 至今，含生产 console 的历史更新）；kill 中断的本次更新新增 `pd-update-hYA16t`（E-016）。
- **Root Cause**：正常完成路径会清理自身 tempDir，但无陈旧目录清扫；进程崩溃残留无人回收。
- **Impact**：磁盘缓慢泄漏（每目录数十 MB 组件树）。
- **Priority**：P2。

## CP-9（P2）installer 要求 workspace 预存在，但仅在模板步骤顺带创建

- **Evidence**：E-013——`--workspace` 指向不存在目录：console 验证（步骤靠前）要求其存在而失败；workspace 创建只发生在 `copyCoreTemplates` 的 `fse.ensureDir`（installer.ts:1744，步骤靠后）。仓库自带 smoke 测试全部预创建 workspace 目录，掩盖了该缺陷。
- **Impact**：显式指定新 workspace 路径的安装必失败（并触发 CP-6 残留）。
- **Priority**：P2。

## CP-10（P2）EPERM 错误泛化归因 → 误导性排障指引

- **Evidence**：update.ts:1413-1430 把任何 EPERM/EBUSY/EACCES 映射为 `file_locked` + "gateway may still be running" + "restart your computer"；而真实锁持有者可能是 console 自身（自更新）。Audit v1 在生产观测到该自锁（§1.2）；本 lab 升级成功未复现（console 更新跳过 node_modules，dist .js 在 Windows 可覆写）——发生条件待定，但错误归因代码缺陷确定存在。
- **Priority**：P2。

## 已核实为"已修复/已闭合"（无需行动）

| 历史风险 | 结论 | 证据 |
|---|---|---|
| PRI-665 createResolutionLink 不分链接/物理旧目录 | **已修复**：`reconcileResolutionLink` quarantine+replace 语义（update.ts:895-937，注释明示 PRI-665）；v1.230.0 changelog 含 0da2ab8e（已发布） | 代码 + changelog |
| PRI-669 installer 锁 install-layout@0.1.0 | **已修复**：npm 1.132.2 依赖 `^0.2.0`（E-021 tarball package.json） | tarball |
| ERR-041 "success=true 但组件缺失" | **success 判定已闭合**：E-001/E-002/E-013 均以 success=false + reason + components 部分状态 fail-loud | lab 三例 |
| PRI-686 workspace 分裂 | **今日已合入 main**（PR #1518，含收敛集成测试）；lab 安装 install.json workspaces 字段一致 | git log |

---

# Phase 3 — Release Artifact Consistency Report

**范围说明**：结构性清点完成（组件存在性 + 关键 hash）；因 npm 版本线与源码版本号永久错位（CI 发布时 bump 不回写 main），逐文件三方 hash 表对跨版本比对无意义，故聚焦结构性缺陷。

| 组件 | npm tarball 1.132.2 | 本地自包含 payload | 备注 |
|---|---|---|---|
| plugin | ✅ | ✅ | tarball 内版本被 stamp 为 npm 最新 |
| core | ✅ | ✅ | 同上 |
| host-runtime | ✅ | ✅ | 同上 |
| install-layout | ✅ | ✅ | — |
| pd-cli | ✅ | ✅ | — |
| console | ✅ | ✅ | — |
| codex-adapter | **❌ 0 条目** | ✅ | CP-2 |
| release-manager | ❌（发布早于 PRI-672，预期） | ✅ | 下次发布才会带上 |
| `_release/`（asset.json+manifest） | **❌ 0 条目** | ✅ | CP-1 |
| node_modules（自包含） | ❌ | ✅（791.6MB） | npm 包 8.3MB vs 资产 884.9MB → **npm 内嵌资产不可行** |

关键 hash 证据：升级后 ext 副本 bundle.js `961724C2…`（3,493,401B）≠ canonical `1B258EBE…`（3,492,272B）（E-019）→ ext 为旧完整代码（CP-5）。

版本 stamp 机制发现：`bundle-plugin.mjs:587-589` 自包含构建**有意跳过** npm 版本 stamp（"Preserving source component versions for the immutable release asset"）→ 自包含安装自报源码树版本（1.76.1），npm 包安装报 stamp 版本——两条路径产出的"已安装版本"口径不同（CP-5 的一部分）。源树 `openclaw.plugin.json`=1.198.1 vs package.json=1.76.1 本身已漂移（sync-version.sh 未运行）。

---

# Phase 4 — Version Consistency

- npm 六包版本线完全独立（core 1.277.2 / plugin 1.230.0 / cli 1.147.5 / installer 1.132.2——installer 与 core 差 145 个版本号）；CI 发布时独立 bump、不回写 main → 仓库 package.json 永久 stale。
- `pd --version` 读 ext 目录 package.json（升级后永报旧版，E-018）；console /check 读 canonical（升级后正确）→ **同一系统两个版本口径**。
- 生产实测（只读）：ext=1.76.1 / openclaw.plugin.json=1.198.1 / canonical=1.230.0——三个口径三个值（E-020），与 Audit v1 §1.2 观测一致。
- 根因：CP-5（ext 不更新）+ ext package.json/openclaw.plugin.json 双源不同步。

---

# Phase 5 — State Migration（升级不破坏学习资产）

| 检查 | 结果 |
|---|---|
| state.db 全 21 表行数 | 升级前后**逐一相同**（tasks=2, runs=4 保留） |
| trajectory.db 全 17 表行数 | 相同（pain_events=0——`pd pain record` 的 painId 已发但事件未落 pain_events 表，诊断失败于 LLM 阶段；侧观察，非升级缺陷） |
| schema_version | state=3 / trajectory=1，升级不变 |
| config.yaml | **原样保留**：features（full_chain/repair_loop）、runtimeProfiles（含手工编辑）逐字保留 |
| 升级后 runtime canary | 全结构检查 healthy（schema_conformance/candidate_audit/queue/pd_shim=1.147.5） |

附带发现：新版 console 对 flag 格式要求更严（boolean 被拒并可见告警降级）——配置原样保留但语义按新 schema 校验（rc-9 行为正确）。

---

# Phase 6 — Historical Risk Findings

| Risk | 裁定 |
|---|---|
| R1 ERR-041（success 但组件缺失） | success 判定已闭合；**新形态**为 CP-6（失败时状态声称不可靠） |
| R2 generated artifact 被错误修改 | 未发现 source→bundle 生成物篡改；发现的是"应打包未打包"（CP-1/CP-2）与版本 stamp 口径分裂 |
| R3 Workspace 分裂（PRI-686） | 修复今日合入 main（#1518）；lab 安装 install.json workspaces 一致；深收敛验证属 PRI-686 自身验收 |
| R4 Feature flag 丢失 | 升级保留完好（Phase 5）；风险闭合 |

---

# Phase 2 — Install Lifecycle Lab 详情

**Scenario 1（新装，通道 A/B）**：双 FAIL（E-001/E-002），A 零残留，B 半安装残留（E-003）。
**Scenario 2 Case A（原地升级）**：源码构建基座（自包含发布物，E-005 全绿）→ console /apply-full → 1.76.1→1.230.0 成功（E-009）；版本推进正确（plugin/core/pd-cli/host-runtime 全部到位，E-010）；config/DB 完整保留；升级后 console 重启健康、版本权威一致（E-011）；**但 ext 副本未更新（CP-5）且无备份（CP-4）**。
**Scenario 2 Case B（卸载重装）**：受 CP-1 阻断（重装=新装=必败），记 FAIL。
**Scenario 3（失败升级恢复）**：kill 于下载/staging 阶段 → 生产组件零变更（E-016）；console 重启健康；重跑 apply-full 成功 1.76.1→1.230.0（E-017）。staged-then-swap 设计有效。附带：TEMP 泄漏（CP-8）。
**附加：失败安装恢复**：console 验证失败（workspace 不存在）→ 残留（CP-6/CP-9）→ 创建 workspace 后重跑安装器成功覆盖（E-015）。

---

# Fix Proposal（每问题一 PR，按优先级）

| PR | 问题 | 最小修复 | Why now | Regression risk |
|---|---|---|---|---|
| F-1 | CP-1+CP-2 | `files` += `codex-adapter`；installer 预检改为形态门控：包内无 `_release/asset.json` 且 7 组件齐全（package.json+dist）→ 可见告示后走 npm 安装路径（现 legacy 路径）；`_release` 存在但损坏仍硬失败 | npx 是 README 承诺的唯一新装通道，今日必败；npm 内嵌 791MB 资产不可行，形态门控是最小可行恢复 | 低——自包含路径不变；legacy 路径本就存在（env 门控改形态门控） |
| F-2 | CP-3 | `validatePathInWorkspace` 允许根加入 canonical runtime 根（resolveUpdateLayout 派生） | 增量更新对 canonical 安装必拒 | 低——守卫仍拒绝越界路径 |
| F-3 | CP-5 | `doInlineFullUpdate` 增量步骤：plugin 树同步刷新 ext 副本（复用既有 copyDirRecursive + reapplySkillLanguage） | "成功升级"半生效，OpenClaw 跑旧代码 | 中——ext 覆写需处理网关锁（与既有 gateway stop 逻辑一致）；加集成测试断言 ext 版本推进 |
| F-4 | CP-4 | full update 换文件前对 canonical plugin（+console）创建备份至 backups 根，写入 update-history backupDir，打通 /rollback | 升级目前是单向门 | 中——回滚需正确恢复；补 rollback 集成测试 |
| F-5 | CP-7 | publish action（及 workflow 副本）构建顺序：installer 先于 pd-console | 下次 installer 发布确定性失败 | 极低——纯顺序交换，本地已验证 |
| F-6 | CP-6 | 失败路径：全新安装（无 install.json）失败时清理本次创建的 runtime 组件目录与 ext 副本；消息改为如实描述状态+nextAction | 虚假回滚声称 + 孤儿插件风险 | 中——清理需区分"本次创建"与"既有"；补失败路径单测 |
| F-7 | CP-8 | 更新启动时清扫 >7 天的 pd-update-* 陈旧 temp（best-effort） | ~140 目录泄漏 | 低 |
| F-8 | CP-9 | workspace 目录在组件安装前 ensureDir | 显式新 workspace 路径必败 | 低 |
| F-9 | CP-10 | file_locked 消息如实列出可能锁源（含 console 自更新）+ 正确 nextAction | 误导"重启电脑" | 低 |

**后续工作（不在本任务）**：GitHub Release 平台资产通道（885MB asset.tar 上传 + installer 拉取校验）属 PRI-672 供给侧，建议单独立项；npm 版本线统一/回写机制属发布治理专项。

---

# Evidence Log

| ID | 证据 |
|---|---|
| E-001 | 通道 A 新装失败：exit 1，`self_contained_asset_identity_invalid`，全组件 skipped（沙箱，stdout 存档 evidence/scenario1-channelA-stdout.json） |
| E-002 | 通道 B 失败：`install_failed_before_mutation: Bundled @principles/codex-adapter not found`（evidence/scenario1-channelB-stdout.json） |
| E-003 | B 失败后 `~/.pd/runtime/{core,host-runtime}` 残留 + 事务日志（planned→failed 无补偿）——消息却称 "not modified" |
| E-005 | 本地自包含发布物安装全绿：plugin/cli verified、console configured、features/storyA/manifestActivation 全过 |
| E-006 | 安装后版本快照：8 组件 + ext package.json=1.76.1 vs openclaw.plugin.json=1.198.1（源树漂移复现） |
| E-007 | console /check：current 1.76.1 / latest 1.230.0 / syncPending=false |
| E-008 | 升级前状态：pain record（painId manual_1788595134808_any46jxk）→ 2 个 failed 诊断任务入库 |
| E-009 | /apply-full 成功：1.76.1 → 1.230.0 |
| E-010 | 升级后版本：plugin 1.230.0 / core 1.277.2 / host-runtime 0.3.3 / pd-cli 1.147.5；release-manager/codex-adapter 未动（tarball 不含）；config 原样；update-history 记录成功（无 backupDir 字段） |
| E-011 | 升级后 console 重启健康；/check current=latest=1.230.0；flag boolean→object 严格化可见告警 |
| E-012 | /apply 实测 HTTP 400 `targetDir must be within workspace or extensions directory`（canonical 布局必拒） |
| E-013 | workspace3 不存在 → console 验证失败（3 端口尝试全灭）→ 失败 |
| E-014 | E-013 后实际状态：runtime 全组件 + ext 完整插件副本在盘、install.json 无——消息却称 "Installation rolled back — plugin and CLI are not activated" |
| E-015 | 创建 workspace3 后重跑安装器：成功（force 覆盖残留） |
| E-016 | kill 于 T+6s：组件版本未动（staging 阶段）；TEMP 新增 pd-update-hYA16t + 历史 ~140 个泄漏目录 |
| E-017 | 重启 console 健康 → 重跑 apply-full 成功 1.76.1→1.230.0 |
| E-018 | 升级后 ext package.json=1.76.1 / openclaw.plugin.json=1.198.1 / canonical=1.230.0 / `pd --version`=1.76.1 |
| E-019 | ext bundle.js（3,493,401B, 961724C2…）≠ canonical（3,492,272B, 1B258EBE…）→ ext 为完整旧代码副本；ext 目录非 junction |
| E-020 | 生产只读：ext bundle.js 30,005,016B mtime 09-03 vs canonical 3,492,272B（1.230.0）；openclaw.json plugins 无自定义路径（extensions 扫描加载） |
| E-021 | npm tarball 1.132.2 清点：4209 条目，`_release`/`codex-adapter`/`release-manager` 均 0 条目；deps install-layout ^0.2.0；bundledPluginVersion 1.230.0；files 无 codex-adapter/_release |
| E-022 | 本地构建顺序复现：console→installer 顺序 TS2307 失败；installer→console 成功（CI action 顺序=前者） |

原始输出存档：`D:\pd-install-lab\evidence\`（本机调查资产，不入库）。
