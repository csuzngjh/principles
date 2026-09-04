# ADR-0023 Review Summary — PD Installation Architecture Decisions

> **Date**: 2026-09-04
> **Subject**: [ADR-0023: PD Installation Architecture Decisions](../adr/0023-pd-installation-architecture-decisions.md)（Status: **Accepted**）
> **Inputs**: [`PD_Installation_Architecture_v2.md`](PD_Installation_Architecture_v2.md)（Proposed）、[`PD_Current_Environment_Topology_Audit.md`](../audit/PD_Current_Environment_Topology_Audit.md)（只读拓扑审计）、本次会话对仓库/安装器/安装现场的复核
> **Scope**: 审查与记录。**不含任何实施动作**（无生产代码修改、无 runtime 修复、无副本删除、无迁移执行）。

---

## 1. 当前事实依据

本节列出决策所依据的**已核实事实**。每条标注核验方式。

### 1.1 安装与运行时

| # | 事实 | 核验方式 |
|---|---|---|
| F1 | `~/.pd/runtime` 含 8 个组件目录：`core`、`host-runtime`、`codex-adapter`、`install-layout`、`pd-cli`、`console`、`plugin`、`bin`。**runtime 不持有任何数据**（无 db、无 workspace 数据） | 目录枚举 + 全树扫描 |
| F2 | 代码已存在完整 canonical 发布模型（`~/.pd/active.json` + `releases/<releaseId>/metadata.json` + 事务日志 + 回滚策略），位于 `packages/create-principles-disciple/src/update/`；但 **`installer.ts` 全文件不引用 ReleaseManager、从不写 `active.json`** | 源码 grep + 安装现场核对（无 active.json、无 releases/、无 bootstrap/、无 logs/history.jsonl） |
| F3 | `pd version --json` 实测：`source: official-legacy-overlay`、`health: degraded`、产品版本取自宿主插件 package.json、`releaseId` 全 0 | CLI 实际执行 |
| F4 | 安装器为 `core`/`host-runtime`/`codex-adapter`/`principles-disciple` 建 junction 的代码**全部带 `if (!existsSync)` 守卫**；现场 `readlinkSync` 全部 EINVAL，**一条链接都未建成** | 源码 + 现场 readlink 验证 |
| F5 | 安装器注释明确："Supported release assets are self-contained: installation **validates** the copied component and never resolves dependencies or runs lifecycle scripts."（旧 npm 路径降级为 opt-in，开关 `PD_ALLOW_LEGACY_NPM_INSTALL`） | `prepareBundledComponentDependencies()` 源码 |
| F6 | 2026-09-03 15:06，`runtime/console/dist/server.js`、`runtime/core/dist/index.js`、`runtime/plugin/dist/bundle.js` 及两个 package.json 被写成占位文本。前者已恢复（备份 `.tampered-20260904.bak`），**`core/dist/index.js`、`plugin/dist/bundle.js` 与两个 package.json 至今未恢复**。系统仍可运行，因这些文件恰好无加载路径命中 | 文件时间戳 + 内容检查 |
| F7 | 安装器随包分发的 `core/package.json`、`pd-cli/package.json` **含完整 name/version/type（1.74.1）** → 安装器不产生 `{}`，证明 F6 的写入来自安装器之外 | 随包 manifest 核对 |
| F8 | `openclaw-plugin` 源码有 **9 个文件** import `@principles/host-runtime`；但 `scripts/bundle-plugin.mjs:386` 显式 `removeBundledDependency(plugin, '@principles/host-runtime')` → **声明依赖 ≠ 编译依赖** | 源码 + 打包脚本 |
| F9 | console 实际从**自己的** `node_modules/principles-disciple` 副本加载 `governance-audit`（8 处源文件 import）。插件共 **3 份**物理副本：`runtime/plugin`、`~/.openclaw/extensions/principles-disciple`、`console/node_modules/principles-disciple` | import 分析 + 目录核对 |
| F10 | `INSTALL_HOSTS = ['codex', 'openclaw']`。**Claude Code 不是已支持宿主**（ADR-0020 §1 仅 "anticipated"） | `install-layout/src/index.ts:6` |

### 1.2 Workspace 状态

| # | 事实 | 核验方式 |
|---|---|---|
| F11 | workspace 有**四个**状态根（v2 文档 §2.5 W1 仅描述两个）：`.pd`（治理）、`.state`（轨迹/运行时）、**`.principles`**（身份：PROFILE.json / PRINCIPLES.md / THINKING_OS.md / DECISION_POLICY.json）、**`memory/`**（Agent 记忆：MEMORY.md / evolution.jsonl / okr / pain / logs） | 现场目录枚举（v2 文档差异 **D1**） |
| F12 | 后两个根含 **Owner 直接编辑**的 Markdown 文件 | 文件内容与用途核对 |
| F13 | `.state` 内存在两套命名：生产代码写 `trajectory.db`（host-runtime / pd-cli / openclaw-plugin 共识），`principles-core/src/evolution-store.ts:56` 写 `.trajectory.db`（带点前缀）。现场磁盘只有前者 → **一次未完成的重命名已发生过** | 源码 grep + 现场核对（差异 **D4**） |
| F14 | 路径常量 `PD_DIRS` / `PD_FILES` 存在，但**位于宿主适配器包内**（`openclaw-plugin/src/core/paths.ts`），且 host-runtime 与 pd-cli 仍硬编码 `path.join(workspaceDir, '.state', 'trajectory.db')` → 常量层未被普遍消费 | 源码 grep（差异 **D5**） |

### 1.3 CLI / 外壳 / 校验

| # | 事实 | 核验方式 |
|---|---|---|
| F15 | PATH 解析链分叉：npm 全局 `pd.cmd`（2026-09-01）指向**已不存在的** legacy 路径 `~/.openclaw/extensions/principles-disciple\bin\pd.cmd`；`~/bin/pd` 是**安装器所有权之外**的手工包装器；另有 decoy `~/bin/openclaw.cmd`。真实入口 `~/.pd/runtime/bin/pd.cmd` | shim 内容 + 路径存在性验证 |
| F16 | PD Companion 位于 `D:\Program Files\PD Companion`（Electron 39.8.10），通过 `getConsoleServerEntry()` 解析 `~/.pd/runtime` 并拉起 console(:3100)，**不自带 runtime** | app.asar 字符串分析 + 运行日志 |
| F17 | **Companion 的 electron-updater 未接线**：`packages/pd-companion/src` 中 `electron-updater` / `autoUpdater` 零引用；`package.json` 的 `build` 为空对象 `{}`，无 `publish` 配置 → v2 文档"Companion 走 electron-updater 独立通道"的**前提不成立** | 源码 grep + manifest 核对（差异 **D3**） |
| F18 | **`pd doctor` 命令不存在**。pd-cli commands 下仅有 `config-doctor`、`health`、`runtime-artifact-repair`、`runtime-canary`、`runtime-compatibility-scan`、`runtime-diagnostics-export`、`version` → v2 文档 P3 退出判据"pd doctor 无 degraded 项"**无法按原文执行** | 命令目录枚举（差异 **D2**） |
| F19 | pd-cli **无 `update` 命令**；产品更新路径目前只在安装器侧 | 命令目录枚举（差异 **D7**） |
| F20 | Companion 日志出现 `console_started version:"2.0.0"` —— 该版本号取自 plugin 包，**是误用**（外壳在报告插件版本） | 日志分析 |

### 1.4 对 v2 架构文档的差异记录（**只记录，未修改 v2 文档**）

| 编号 | 差异 | 去向 |
|---|---|---|
| D1 | workspace 状态根是四个，不是两个 | 已并入 ADR-0023 §2.6 |
| D2 | `pd doctor` 命令不存在 | 已并入 ADR-0023 §3.3，列为开放问题 Q-E |
| D3 | Companion 的 electron-updater 未接线 | 已并入 ADR-0023 §3.2，列为开放问题 Q-D |
| D4 | `.state` 内两套命名（未完成重命名） | 列为开放问题 Q-C 的输入 |
| D5 | 路径常量位于宿主适配器包且未被普遍消费 | ADR-0023 §2.6 要求收敛；列为开放问题 Q-I |
| D6 | `INSTALL_HOSTS` 不含 Claude Code | 已并入 ADR-0023 §2.2；列为开放问题 Q-F |
| D7 | pd-cli 无 update 命令 | 列为开放问题 Q-D 的输入 |
| D8 | 会话内起草的 ADR 编号 0021 与已 Accepted 的 ADR-0021 冲突 | 已解决：废弃该草稿，改用 **ADR-0023** 并置于 `docs/adr/` |

---

## 2. 做出的决策

| # | 决策 | 核心内容 | 主要依据 |
|---|---|---|---|
| **D-1** | Runtime Ownership | `~/.pd/runtime` 是 canonical runtime。允许 installer / updater / repair tool 写入；禁止 Agent / Adapter / Console / 用户脚本直接修改 | F1、F6、F7 |
| **D-2** | Adapter Boundary | Host plugin = Adapter（OpenClaw / Codex / future）。Adapter 不拥有独立 governance runtime | F8、F10；PD 核心价值取向 |
| **D-3** | Dependency Strategy | 分层：Runtime 单 release 内共享依赖；Adapter 允许 bundle isolation，但**必须记录** runtime compatibility + artifact digest | F4、F5、F8、F9 |
| **D-4** | Core Position | `@principles/core` = PD Governance SDK / internal SDK；**不创建重复 façade** | 导出面已含 7 个子路径；AGENTS.md P7 |
| **D-5** | Version Identity | 废除多 package version 混合作为产品版本。三轴：**Product Version** / **Runtime Build ID** / **Schema Version** | F2、F3 |
| **D-6** | Workspace State | **逻辑统一，暂不物理迁移** | F11、F12、F13、F14 |
| **D-7** | Desktop Companion | 独立 release 生命周期；职责 = 启动 / 监护 / UI shell；不拥有 governance runtime | F16、F17、F20 |
| **D-8** | CLI Ownership | 官方入口 `pd`；只允许一个 canonical PATH 来源；清理 legacy PATH 属后续迁移任务 | F15、F19 |
| **D-9** | Runtime Integrity | 分阶段：Phase 1 **warn-only**（发现文件变化 / digest 不一致，但不阻止启动）；Phase 2 迁移稳定后**考虑** enforce | F6 |

### 2.1 与先前建议的三处差异（Owner 裁决优先）

| # | 先前的建议 | Owner 裁决 | 影响 |
|---|---|---|---|
| 1 | 依赖策略全局 Bundle + Digest | **分层**：Runtime 共享 / Adapter 隔离 + 登记 | 实施时需两套机制；Adapter 的摘要登记成为新的正确性负担 |
| 2 | runtime 写入者仅安装器 | **installer / updater / repair tool** | 见开放问题 **Q-A**：repair tool 的边界需定义 |
| 3 | 版本轴为 Product / Component / Schema | **Product / Runtime Build ID / Schema** | 见开放问题 **Q-B**：Runtime Build ID 的生成与可见性需定义 |

---

## 3. 未解决问题

以下**不影响 ADR-0023 的 Accepted 状态**，但需在相应实施任务启动前明确。按风险排序。

| # | 问题 | 为什么重要 | 阻塞哪项实施 |
|---|---|---|---|
| **Q-A** | **"repair tool" 的边界是什么？** D-1 允许 repair tool 写入 runtime，但 F6 事件正是一次"修理式写入"。若 repair tool 不由安装器发布、不写事务日志、不受完整性校验覆盖，等于重开同一个洞 | **这是本次决策中唯一的新增风险敞口** | P3（修复安装完整性） |
| **Q-B** | **Runtime Build ID 的生成规则与可见性**：每次 release 生成？是否单调递增？组件 package.json 的 version 是否保留为发布输入？是否对外可见？ | D-5 的第二轴若无规则则无法实施 | P1（安装生产 canonical 状态） |
| **Q-C** | **Schema Version 的当前值与迁移触发行为**：当前 workspace 状态**无 schema 版本标识**（F13 显示连文件名都发生过未完成的变更）。需先为存量状态打上 schema 版本；且 PV 与 SV 不匹配时是拒绝启动 / 只读 / 自动迁移，未裁决 | 未决则"不匹配时走迁移"无法执行 | P1、P5 |
| **Q-D** | **Companion 是否需要自动更新通道**：D-7 给了独立生命周期，但 F17 显示通道根本不存在（electron-updater 零接线、无 publish）。建通道是**独立的工作量 + 代码签名成本**决策，不只是版本号决策 | 影响 Owner 是否需认知两个版本号、以及维护成本 | 外壳发布计划 |
| **Q-E** | **完整性校验的对外呈现面**：`pd doctor` 不存在（F18）。warn-only 的信息放哪里？新建 `pd doctor` 还是复用 `pd health` / `pd version --json` / `runtime-*` 系列？ | warn 出来的信息若无人看，Phase 1 形同虚设 | P4 |
| **Q-F** | **Claude Code 的 hook 语义**：未支持宿主（F10）。参照 WorkBuddy 取证结论——其 `http` 类型 hook 是 **fail-OPEN** 语义（PD 强制治理在该宿主上不可用）。新宿主语义必须逐家取证 | 未取证则 D-2 无法安全扩展到该宿主 | 未来宿主接入 |
| **Q-G** | **legacy PATH 的清理时点**：保留一个版本周期，还是立即清理？立即清理风险：若用户 shell 依赖 `~/bin/pd`，清理后 `pd` 命令消失 | D-8 已定为后续任务，但时点未定 | P6 |
| **Q-H** | **Adapter 登记机制的具体 schema**：runtime compatibility 与 artifact digest 记在 release 元数据的哪个字段？谁校验？校验失败的行为是什么？ | D-3 的"必须记录"若无 schema 则不可执行 | P2、P4 |
| **Q-I** | **逻辑统一的路径权威放在哪个包**：`PD_DIRS` 需从 `openclaw-plugin` 下沉——到 `principles-core`、`install-layout`，还是新模块？ | D-6 的核心机制，未定则"逻辑统一"无从落地 | P5（逻辑统一部分） |

### 3.1 一处需要澄清的协调关系（非开放问题，但易被误解）

**D-1 的"违规显性失败"与 D-9 的"Phase 1 warn-only"不矛盾，因为它们是两件事：**

| | D-1 写入防护 | D-9 内容校验 |
|---|---|---|
| 管什么 | **谁有权限写** runtime | **runtime 内容是否正确** |
| 机制 | 权限 / 所有权边界 | 摘要比对 |
| 时机 | **可立即执行** | 需先建基线 → Phase 1 warn-only |
| 失败后果 | 写入被拒（EPERM） | Phase 1：仅报告，不阻止启动 |

即：**写入防护可以先上，内容校验必须后上**。混淆二者会导致"要么什么都不敢做，要么把本机直接打挂"。

---

## 4. 后续实施建议

### 4.1 实施阶段的调整（相对 v2 文档 §2.8 的 P0–P6）

v2 文档的 P0–P6 依然有效，但需按 ADR-0023 做三处调整：

| 阶段 | v2 原文 | ADR-0023 调整 |
|---|---|---|
| **P1** | 安装生产 canonical 状态 | 需同时落地 **D-5 三轴模型**（Product Version / Runtime Build ID / Schema Version）。**前置**：先回答 Q-B、Q-C |
| **P5** | workspace 状态收敛（物理合并） | **改为"逻辑统一"**（D-6）：收敛路径权威为单一解析入口 + 阻止未登记状态目录滋生。**物理迁移无限期推迟**，不列入当前实施范围 |
| **P4** | 投影纪律（先 warn-only 再 fail-loud） | 与 D-9 合并为一个完整性校验工作项：**Phase 1 warn-only 是硬约束**，Phase 2 需 Owner 另行确认后启动 |

### 4.2 建议顺序

```
P0  冻结与取证          ── 基线清单（路径 + 摘要 + mtime）
 ↓
P1  安装生产 canonical  ── 落地 D-5 三轴模型        ⚠ 前置：Q-B、Q-C
 ↓
D-1 写入防护（可提前）  ── 与 P1 并行，不依赖基线    ⚠ 前置：Q-A
 ↓
P3  修复安装完整性      ── 消除 F6 的占位符文件      ⚠ 前置：Q-A
 ↓
P2  依赖解析收敛        ── 落地 D-3 分层策略        ⚠ 前置：Q-H
 ↓
P4  完整性校验 Phase 1  ── warn-only（D-9）         ⚠ 前置：Q-E
 ↓
P6  PATH 契约归口       ── 落地 D-8                ⚠ 前置：Q-G
 ↓
P5  逻辑统一            ── 路径权威收敛（D-6）       ⚠ 前置：Q-I
```

**为什么 P3 在 P2 之前**：P2（依赖收敛）会改变组件布局，若在存在损坏文件的前提下收敛，会把"哑弹"一起收进新结构，届时更难归因。先重铺干净，再收敛布局。

**为什么 P5 最后**：它是唯一涉及路径权威变更、且紧邻 Owner 知识资产的工作；放到最后可以让前面的阶段积累出的校验机制为其兜底。

### 4.3 每条实施的前置条件

| 阶段 | 前置条件 | 退出判据 | 回滚 |
|---|---|---|---|
| P0 | 无 | 基线文件产出 | 解锁 |
| P1 | **Q-B（Runtime Build ID 规则）、Q-C（Schema Version 初值）** | `pd version --json` 输出 `source=official-installer`、`health=healthy`、releaseId 非全 0 | 保留 legacy-overlay 兜底路径 |
| D-1 写入防护 | **Q-A（repair tool 定义）** | 非安装器写入被拒且可归因 | 解除防护 |
| P3 | **Q-A**；先停服（避免文件占用） | 全部组件通过摘要校验 | 从上一次 release 回滚 |
| P2 | **Q-H（登记 schema）** | 单 release 内 SDK 权威副本数 = 1（有自动化断言） | 保留旧副本直至验证通过 |
| P4 | **Q-E（呈现面）** | 观察期内零误报 | warn-only 开关 |
| P6 | **Q-G（清理时点）** | 全新 PATH 解析链只有一条且指向 canonical runtime bin | 保留旧 shim 一个版本周期 |
| P5 | **Q-I（路径权威归属）** | 全部读写路径经唯一解析入口 | 代码回退（无数据移动，回滚成本低） |

### 4.4 跨阶段的三条硬约束

1. **先建基线，再谈严格化。** 在 P1 产出摘要基线之前，任何 digest 比对都无对象可比。
2. **先证明无加载路径依赖，再删任何副本。** 反例就在本机：console 实际从自己的 `node_modules/principles-disciple` 副本加载 `governance-audit`（F9）；先删它，console 当场崩。
3. **每次实施都要有回滚演练。** `transaction-journal.ts` / `rollback-policy.ts` 存在，但本机从未产生过 `active.json`，等于**回滚链路在该机器上零演练**。P1 必须包含一次真实回滚演练。

---

## 5. 本次任务的实际动作（可审计清单）

| 动作 | 对象 | 类型 |
|---|---|---|
| 创建 | `docs/adr/0023-pd-installation-architecture-decisions.md`（Status: Accepted） | ADR |
| 创建 | `docs/architecture/ADR-0023-review-summary.md`（本文件） | 审查报告 |
| 修改 | `docs/architecture/PD_Installation_Architecture_v2.md` —— 仅新增 `Decision status` 指向块，**未重写** | 文档引用更新 |
| 删除 | `docs/architecture/ADR-0021-PD-Installation-Architecture-Decisions.md`（会话内起草的草稿，编号与已 Accepted 的 ADR-0021 冲突，内容已并入 ADR-0023 与本文件） | 冲突清理 |
| 提交 | `docs: finalize PD installation architecture decisions ADR-0023` | 仅文档 commit，未创建 PR |

**未执行**：任何生产代码修改、installer 改动、runtime 修复、副本删除、workspace 搬迁、版本迁移。
