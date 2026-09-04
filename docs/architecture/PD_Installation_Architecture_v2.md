# PD Installation Architecture v2.0

> **Status**: Proposed — 需要 Owner 决策后才能进入 Accepted（ADR 治理硬原则：涉及 Owner 决策的文档不得由 Agent 自行标 Accepted）
> **Date**: 2026-09-04
> **Type**: 架构文档（非实施文档）
> **Inputs**: `docs/audit/PD_Current_Environment_Topology_Audit.md`（只读拓扑审计）+ 本次对仓库/安装器/运行时关系的复核
> **Scope**: 安装与运行环境的**边界定义**。本文档不修改任何生产代码，也不修复审计中发现的任何缺陷。
> **Related**: ADR-0020（宿主适配器与多平台抽象）、`packages/install-layout`（布局契约）、`packages/create-principles-disciple/src/update/*`（ReleaseManager 子系统）
>
> **Decision status**: See [ADR-0023](../adr/0023-pd-installation-architecture-decisions.md) for accepted decisions.（ADR-0023 — Status: **Accepted**，2026-09-04，Decider: Owner。本文档中与其冲突之处以 ADR-0023 为准，尤其：依赖策略改为分层（§2.3）、runtime 写入者扩充为 installer/updater/repair tool（§2.1）、版本轴第二项为 Runtime Build ID（§2.6）、workspace 状态收敛改为逻辑统一不物理迁移（§2.5/P5）。审查报告见 [ADR-0023-review-summary.md](ADR-0023-review-summary.md)。）

---

## 0. 验证基础（本文档不是基于审计推断，而是基于复核）

复核时读取的实证来源：

| 类别 | 具体文件/位置 |
|---|---|
| 布局契约 | `packages/install-layout/src/index.ts`（INSTALL_LAYOUT_VERSION=1、mode=canonical/legacy、hosts=codex/openclaw、六类路径、三个入口解析函数） |
| 安装器实现 | `packages/create-principles-disciple/src/installer.ts`（2360 行）、`src/uninstaller.ts`、`src/installers/{openclaw,codex}-host-installer.ts` |
| 打包契约 | `packages/create-principles-disciple/scripts/bundle-plugin.mjs`（依赖重写/移除规则） |
| 发布子系统 | `packages/create-principles-disciple/src/update/`（release-manager、transaction-journal、rollback-policy、bootstrap-protocol、release-identity、product-identity…） |
| 版本读取 | `packages/pd-cli/src/services/version-report.ts`（canonical vs legacy-overlay 判定） |
| 安装现场 | `~/.pd/**`、`~/.openclaw/extensions/principles-disciple/**`、`D:\Program Files\PD Companion\resources\app.asar`、`D:\.openclaw\workspace/**` |
| 宿主 | npm 全局 `openclaw@2026.9.1`，`~/.openclaw/openclaw.json` |

**结论：审计报告的观察基本属实，但对若干现象的"成因"判断需要修正。** 修正见 §1.5——这些修正直接改变 v2 的设计落点。

---

## 1. 现状映射（As-Built）

### 1.1 安装时模型（installer 到底做了什么）

`installer.ts` 的实际行为（逐条对应代码）：

1. **组件落盘**：`installBundledCore / installBundledHostRuntime / installBundledCodexAdapter / installConsole / syncPdCli` —— 每个组件先 `rmSync` 目标目录，再从随包目录 `cpSync` 到 `~/.pd/runtime/<组件>`。
2. **插件双份部署（设计如此）**：`pluginInstallDirs()` 返回 `[runtime/plugin, ~/.openclaw/extensions/principles-disciple]` 两个目录并依次 `fse.copy`；源码注释明确说明"保持 canonical 包就绪，便于以后挂其它宿主"。
3. **`core` 链接**：插件副本内 `core` 目录以 junction/symlink 指向 `~/.pd/runtime/core`（`if (!existsSync)` 守卫）。
4. **依赖准备**：`prepareBundledComponentDependencies()` —— 注释明确："Supported release assets are self-contained: installation **validates** the copied component and never resolves dependencies or runs lifecycle scripts. The old npm path remains opt-in"（开关 `PD_ALLOW_LEGACY_NPM_INSTALL`）。
5. **node_modules 链接（关键）**：`syncPdCli()` 会为 `@principles/core`、`host-runtime`、`codex-adapter`、`principles-disciple` 创建 junction，但**全部带 `if (!existsSync(...))` 守卫**；`installConsole()` 同理为 `principles-disciple` 建链接。
6. **PATH shim**：`installGlobalPdShim()` 向 npm 全局 bin 写 `pd.cmd` / `pd.ps1`；`uninstaller.ts` 负责移除。
7. **清单**：`writeInstallManifest()` 写 `~/.pd/install.json`（layoutVersion / mode / hosts / workspaces）。**installer.ts 全文件不引用 ReleaseManager、不写 `active.json`。**

### 1.2 加载时模型（谁真正加载谁）

| 消费者 | 加载对象 | 实证 |
|---|---|---|
| OpenClaw 宿主 | `~/.openclaw/extensions/principles-disciple/dist/bundle.js`（30MB 自包含） | 宿主按 `openclaw.json` 的 `plugins.entries` 发现；bundle 内无 `@principles/*` 外部 import |
| pd-cli | 自身 `node_modules/@principles/{core,host-runtime,codex-adapter,install-layout}` | 69 个 dist 文件 import `@principles/core`；这些是**真实目录副本**（非 junction，`readlinkSync` 返回 EINVAL），内容与 canonical core 构建逐字节一致（md5 `fc9605f7…`，4677B） |
| console | 自身 `node_modules/@principles/core` 等 + `node_modules/principles-disciple/governance-audit` | 8 个源文件 import `principles-disciple/governance-audit`；`console/node_modules/principles-disciple` 是**插件的第 3 份物理副本**（30MB 完好） |
| Companion | `getConsoleServerEntry()` → `~/.pd/runtime/console/dist/server.js` | app.asar 内含 `path.join(runtimeDir,'console')`、`getConsoleServerEntry`；日志 `spawning_cli → console_started port:3100` |

**推论**：安装器"单副本 + 链接"的设计意图，在 npm 的 `file:` 依赖复制语义（`install-links` 默认行为）与 `if (!existsSync)` 守卫共同作用下**整体失效**——链接一条都没建立（`readlinkSync` 全部 EINVAL），实际形成"每个组件各抱一份依赖副本"。

### 1.3 状态模型

- 运行时目录 `~/.pd/runtime` **不持有任何数据**（已核实：无 db、无 workspace 数据）。
- 全部持久状态在 workspace：`D:\.openclaw\workspace\.pd\`（config.yaml、state.db、telemetry）与 `D:\.openclaw\workspace\.state\`（trajectory.db、blobs、principles、sessions、exports、legacy-archive）**两个并列根**。
- 机器级状态在 `~/.pd`：`install.json`、`owner.json`、`product-telemetry.json`（consent）。

### 1.4 关键缺口：canonical 发布状态从未被写入

`version-report.ts` 的判定链（已复核）：

```
active = ~/.pd/active.json
若 active 缺失 且 ~/.openclaw/extensions/principles-disciple 存在
   → buildLegacyOverlayReport()   // source='official-legacy-overlay', health='degraded',
                                  // version 取自 extension/package.json
若 active 缺失 且 ~/.pd 不存在 → not_installed
若 active 缺失（其它）           → active_record_missing
若 active 存在 → 读 releases/<releaseId>/metadata.json
                 → 组件版本来自 releases/<id>/<component>/package.json
                 → health = healthy / degraded / corrupt（按 digest 比对）
```

**本机只有 `install.json` + `runtime/`，没有 `active.json`、没有 `releases/`、没有 `bootstrap/bootstrap.json`、没有 `logs/history.jsonl`。** 因此 `pd version --json` 实测输出 `source: official-legacy-overlay`、`health: degraded`、`productVersion 1.76.1`（= extension 的 package.json 版本）、`releaseId` 全 0。

也就是说：**代码里已经存在完整的 canonical 发布模型（ReleaseManager + 事务日志 + 回滚策略 + bootstrap 协议），但 `install()` 命令从不生产它。** 这不是"版本混乱"，而是**两代安装模型并存、新一代未被 adoption**。

### 1.5 对审计报告的修正（重要）

| # | 审计的判断 | 复核后的事实 | 对 v2 的影响 |
|---|---|---|---|
| A | 插件双份部署是"职责混乱/漂移" | **设计如此**：`pluginInstallDirs()` 显式部署 runtime/plugin + 宿主发现目录，为将来挂第二个宿主做准备 | 不是要消除副本，而是要定义"母本 vs 投影"的契约与校验 |
| B | core 5 份副本是"无单一事实源" | 副本由 **npm `file:` 复制语义**产生；安装器的 junction 方案因 `if (!existsSync)` 守卫**从未生效**（现场 0 条链接） | 修复落点是"链接策略失效"，不是"手工删副本" |
| C | core/pd-cli 安装后 `package.json = {}` 是"安装产物丢失身份" | **安装器不产生 `{}`**：随包 `core/package.json`、`pd-cli/package.json` 均含完整 name/version/type（1.74.1）。现场 `{}` 与另外两个占位符文件同为 2026-09-03 15:06 写入 | 属于"安装目录被外部写入"的完整性问题，不是打包缺陷 |
| D | 存在 8 种版本口径 | 实为**两代模型**：legacy-overlay（pd version 实际读取）与 canonical ReleaseManager（从未写入）。另：宿主清单 1.198.1 属宿主市场产物，Companion 0.1.2 属桌面外壳，二者本就是独立版本轴 | 落点是"统一产品身份权威 + 明确其它版本轴的定位"，不是"消灭多版本号" |
| E | 插件"不是薄适配器，是完整部署副本" | 需细化：**源码层面** openclaw-plugin 在 9 个文件 import `@principles/host-runtime`；**清单层面** `bundle-plugin.mjs` 显式 `removeBundledDependency(plugin, '@principles/host-runtime')` —— 依赖被**内联并从清单抹去** | 边界问题是"声明依赖 ≠ 编译依赖"，需二选一并可验证 |
| F | 插件两份拷贝 | 实为**三份**：runtime/plugin、extension、console/node_modules/principles-disciple（后者是 console 运行时真正加载 governance-audit 的那份） | "删副本"前必须先证明无加载路径依赖 |
| G | `pd` 指向 installed runtime | 链路正确，但 **npm 全局 `pd.cmd`（2026-09-01）仍指向 legacy 路径** `~/.openclaw/extensions/principles-disciple\bin\pd.cmd`（该路径已不存在）——这正是 09-03 手工把 `~/bin/pd` 重定向的原因。`~/bin/pd` 是**安装器所有权之外的手工包装器** | PATH 契约必须归口，陈旧 shim 必须纳入安装器清理 |

---

## 2. 目标架构 v2.0

### 2.0 总体形态

```
                       ┌──────────────────────── 发布流水线 ────────────────────────┐
                       │  build → bundle → release asset（含 metadata + digests）   │
                       └───────────────────────────┬───────────────────────────────┘
                                                   │ 安装 / 更新（唯一写入者）
   ~/.pd/                                          ▼
   ├── active.json                ← 唯一权威的产品身份指针（generation, releaseId, productVersion, digest）
   ├── releases/<releaseId>/      ← 不可变发布内容（metadata.json + 各组件 + 摘要）
   ├── runtime/                   ← active release 的**呈现**（materialization），只读，零数据
   ├── bootstrap/bootstrap.json
   ├── logs/history.jsonl         ← 事务日志（安装/更新/回滚的唯一可审计轨迹）
   ├── install.json               ← 只保留布局级事实（layoutVersion/mode/hosts/workspaces），不含产品身份
   ├── owner.json / product-telemetry.json         ← 机器级，非产品身份
   └── backups/

   宿主投影（字节来自 release，位置由宿主发现机制决定，加载前校验摘要）
   ├── ~/.openclaw/extensions/principles-disciple        ← OpenClaw 宿主发现目录
   └── ~/.codex/...                                       ← Codex 宿主（codex-adapter）

   PATH 契约（安装器唯一拥有）
   └── npm global bin: pd.cmd / pd.ps1  →  ~/.pd/runtime/bin/pd.*

   外壳（不含业务逻辑、不携带 runtime）
   └── PD Companion（Electron）→ install-layout 解析 → 校验 → 拉起 console(:3100) → 打开浏览器

   数据（唯一事实源，运行时零数据）
   └── Workspace: <ws>/.pd/…（v2 目标：单一状态根，见 §2.5）
```

### 2.1 Runtime 边界

**定义**：`~/.pd/runtime` 是一台机器上**唯一的可执行代码位置**；它是"当前 active release 的呈现"，不是一堆各自复制的目录集合。

规则：

- **R1 单一写入者**：只有安装器（含其 bootstrap/release 协议）可以写 `~/.pd` 树。Agent、开发流程、手工脚本均不得写入。违反方式必须是**显性失败**（EPERM / 完整性校验失败），而不是静默覆盖——本机 2026-09-03 15:06 事件正是"静默写入"造成的哑弹。
- **R2 内容 = release，不是组件并集**：组件集合固定为 `{core, host-runtime, adapters, pd-cli, console, plugin, install-layout, bin}`；每次安装/更新以**整体替换**为单位，不做逐组件拼装（消除"部分组件来自旧版本"的漂移）。
- **R3 零数据不变式**：runtime 目录不得出现任何 `.db` / workspace 数据 / 用户配置。该不变式今天成立，v2 将其写入校验。
- **R4 只执行不信任**：加载前校验摘要；校验失败按 ERR-040 语义 **fail loud**（`pd-cli/dist/commands/console.js` 中已有 `runtime_dependency_broken` 的雏形，v2 将其提升为统一契约）。
- **R5 布局解析唯一入口**：所有组件（CLI / console / Companion / 未来宿主）只能通过 `@principles/install-layout` 解析路径，禁止硬编码第二处路径（本机 `~/bin/pd` 与 npm 全局 `pd.cmd` 的硬编码分叉就是反例）。

取舍：整体替换比逐组件更新更"重"（更新包更大、无法单组件热修），但它把"版本一致性"从约定变成结构保证。MVP 阶段优先正确性。

### 2.2 Adapter 边界

**定义**：宿主包（`openclaw-plugin`、`codex-adapter` 等）是**薄协议适配器**：只做宿主协议翻译，业务编排统一在 `@principles/host-runtime`（ADR-0020）。

规则：

- **A1 声明边界 = 编译边界**（新增，针对 §1.5-E 的发现）。允许两种形态，二选一并在发布元数据中记录选择：
  - **形态 L（Link，首选）**：适配器声明 `@principles/host-runtime` 依赖，构建时**不内联**，运行时从 runtime 解析。
  - **形态 B（Bundle+Digest）**：内联 host-runtime，但发布元数据必须记录被内联组件的 release 与摘要，使版本身份仍可验证。
  - **禁止**：内联且清单不声明（当前 openclaw-plugin 的状态）。
- **A2 部署位置由宿主发现机制决定，字节由 release 决定**。宿主目录（`.openclaw/extensions/...`）是**投影**：可以是链接，也可以是副本，但必须 (a) 由安装器写入，(b) 加载前可按摘要校验，(c) 在 release 元数据中登记。
- **A3 适配器不得反向被业务依赖**：console 通过 `principles-disciple/governance-audit` 依赖插件包（现状 8 处）——v2 需明确：这类"治理只读导出"必须从**插件包的公开导出面**取（现状即如此），且不得演化成"console 依赖宿主插件的实现细节"。长期目标是把共享治理只读面下沉到 `host-runtime` 或 core，由 console 直接消费。
- **A4 新增宿主不得另起旁路**：沿用 `installers/<host>-host-installer.ts` 的 HostInstaller 接口。

### 2.3 Console / Desktop 关系

**定义**：Console 是唯一的 Owner 界面服务（HTTP + Web UI），属于 runtime；Desktop（PD Companion）是**无业务逻辑的启动/监护外壳**。

规则：

- **C1 外壳不携带 runtime**：Companion 只做四件事——按 install-layout 解析 runtime、校验完整性、拉起 console、监护与重启。它不得嵌入任何治理逻辑，也不得自带 core/plugin 副本。（现状符合，v2 固化为契约。）
- **C2 错误必须可归因**：Companion 不得吞掉子进程 stderr（本机 `console_launch_failed` 只报 `console_exited_with_code_1`，排查需绕开 CLI 手工跑 server）。失败时必须给出"哪项校验失败 + 建议动作"。
- **C3 版本轴分离**：Companion 有**自己的**版本号（Electron 外壳，独立发布通道 electron-updater），**不得**代表产品版本（现状日志里 `console_started version:"2.0.0"` 取自 plugin 包，属误用）。
- **C4 一 workspace 一 console 实例**，端口从 `PD_CONSOLE_PORT_BASE`（默认 3100）分配——沿用现有实现，不做改动。
- **C5 外壳可缺失**：Companion 不是运行 PD 的必要条件；CLI 与宿主链路必须在其缺席时完整可用。

### 2.4 SDK 关系

**定义**：仓库中**没有**独立的 `sdk` 包；`@principles/core` 是事实上的 SDK（package.json 已声明子路径导出：`./runtime-v2`、`./trajectory-store`、`./principle-tree-ledger`、`./prompt-builder`、`./evolution-store`、`./quality-scorecard`、`./host`）。

规则：

- **S1 明确"core = 内部 SDK"，并按子路径声明稳定性等级**（导出面即契约）。**不新建 `packages/sdk`  façade**——按 P7（禁止投机性抽象），当前没有第二种实现，加壳只会增加认知负担。若未来出现外部消费者，再评估。
- **S2 每个 active release 内，SDK 只允许一份物理副本**。现状 5 份（runtime/core + 4 处 node_modules 副本）必须收敛；非运行时消费者（website、测试、开发工作树）从 workspace 依赖解析，**不得**从 `~/.pd` 取。
- **S3 依赖解析策略显式化**：不要依赖 npm 的 `file:` 复制语义 + `if (!existsSync)` 守卫（已证明失效）。要么统一为链接（形态 L），要么统一为"安装时复制一份并在元数据登记"（形态 B）。
- **S4 适配器/CLI/console 的 SDK 版本必须与 release 元数据一致**，差异即 `degraded`/`corrupt`。

### 2.5 Workspace 状态所有权

**定义**：所有持久事实属于 Workspace，不属于安装根；安装根只持有"发布 + 清单 + 机器级 consent + 日志"。

规则：

- **W1 单一状态根**（目标）：现状 `.pd`（治理：config/state.db/telemetry）与 `.state`（轨迹：trajectory.db/blobs/principles/sessions/exports/legacy-archive）两个并列根，v2 目标收敛为一个 workspace 状态根下的命名空间。
- **W2 运行时无状态**：`~/.pd/runtime` 零数据不变式（R3）。
- **W3 写入者**：只有代表 Owner 行事的运行时组件可写 workspace 状态；schema 迁移必须走**显式、可回滚、有日志**的迁移步骤，安装器不得静默改写。
- **W4 安装根只保留**：release store、active 指针、install manifest（布局级）、机器级 consent、owner.json、日志/事务历史。
- **W5 宿主与 console 共享同一 workspace 事实源**，不得各自维护投影（投影必须可重建，见 P4 单一事实源原则）。
- **W6 多 workspace**：`install.json.workspaces` 已是权威登记（PRI-624 Slice C，Companion 据此派生 per-workspace worker），v2 沿用并作为卸载时 `removeSharedRuntime` 判定的输入。

### 2.6 版本身份模型

**唯一权威**：active release 记录。

```
产品身份   = ~/.pd/active.json  →  releases/<releaseId>/metadata.json
            （generation / releaseId / productVersion / releaseMetadataDigest）
组件版本   = releases/<releaseId>/<component>/package.json（plugin/console/core/pd-cli/host-runtime/install-layout）
健康状况   = healthy（摘要匹配） / degraded（缺 release 元数据） / corrupt（摘要不匹配）
```

规则：

- **V1 组件不得自报产品版本**：`pd --version` 的产品版本只能来自安装状态（现有 `version-report.ts` 注释已如此声明，v2 使其可被执行：安装必须生产 active.json）。
- **V2 `install.json` 只承载布局级事实**（layoutVersion / mode / hosts / workspaces），不得承载产品身份。
- **V3 保留 legacy-overlay 兜底，但必须"显性 + 可行动"**：`source: official-legacy-overlay` + `health: degraded` + nextAction 指向官方安装器。v2 的目标是让该分支**罕见**——安装器完成 Phase 1 后即不再落到此分支。
- **V4 宿主清单版本（openclaw.plugin.json）是宿主市场产物，不是产品身份**：必须在打包时从 release 元数据派生，禁止手工编辑（现状两处副本同一份 1.198.1，与产品版本 1.76.1 无关且无法对齐）。
- **V5 桌面外壳版本独立成轴**（Companion / electron-updater），与产品版本解耦（C3）。
- **V6 版本轴收敛为三条**：产品 release、宿主市场清单、桌面外壳。其余（npm 包版本、update-history 记录）是**发布过程的输入**，不是运行时身份。

### 2.7 Artifact 归属

| 产物 | 生产者 | 唯一写入者 | 读取/执行者 | 校验方式 |
|---|---|---|---|---|
| `~/.pd/releases/<releaseId>/` | 发布流水线 | 安装器 / bootstrap 协议 | 安装器（激活时） | metadata.json + 摘要 |
| `~/.pd/active.json` | ReleaseManager | ReleaseManager（事务日志） | 全部组件 | 结构 + digest 比对 |
| `~/.pd/runtime/**` | 安装器（release 呈现） | **仅安装器** | CLI / console / Companion / 宿主 | 加载前摘要校验（R4） |
| `~/.pd/install.json` | 安装器 | 安装器 | 全部组件 | `parseInstallManifest()` |
| `~/.pd/logs/history.jsonl` | 事务日志 | ReleaseManager | `pd version` / 运维 | 追加式 |
| `~/.openclaw/extensions/principles-disciple` | 安装器（投影） | 安装器 | OpenClaw 宿主 | 投影摘要登记（A2） |
| `~/.codex/**`（Codex 宿主投影） | 安装器（投影） | 安装器 | Codex 宿主 | 同上 |
| npm global `pd.cmd` / `pd.ps1` | 安装器 | 安装器 | 用户 PATH | 必须指向当前布局（现状陈旧，见 G） |
| `~/bin/pd` | ❌ 手工（非安装器所有） | — | — | **v2：不支持，应被 PATH 契约取代** |
| `D:\Program Files\PD Companion` | electron-builder（独立通道） | 安装程序 / electron-updater | 用户 | 外壳自带版本 |
| workspace `.pd` / `.state` | 运行时（代表 Owner） | 运行时 | 宿主 / console / CLI | 迁移有日志（W3） |
| 源码 `packages/**/dist` | 构建 | 构建 | 开发工作树 | **永远不是安装源** |

### 2.8 迁移策略

原则：**先建立可验证的权威，再收敛副本，最后才修复损坏**。每一步都有退出判据与回滚路径，且都不修改业务语义。

| 阶段 | 目标 | 退出判据 | 回滚 |
|---|---|---|---|
| **P0 冻结与取证** | 冻结 `~/.pd/runtime`（只读锁纳入正式机制而非临时脚本），生成基线清单（路径 + 摘要 + mtime） | 基线文件产出；runtime 处于只读 | 解锁 |
| **P1 安装生产 canonical 状态** | 安装/更新写入 `active.json` + `releases/<id>/` + bootstrap 记录 + 事务日志 | `pd version --json`：`source=official-installer`、`health=healthy`、`releaseId` 非全 0 | 保留 legacy-overlay 兜底路径（V3），安装失败回退到现状行为 |
| **P2 依赖解析收敛** | 把"npm `file:` 复制 + 失效守卫"换成显式策略（形态 L 或 B，需 Owner 决 策 §3-Q1） | 每个 active release 内 SDK 副本数 = 1（有自动化断言） | 保留旧副本直到新策略通过验证 |
| **P3 修复安装完整性** | 用 release 重新铺装，消除占位符文件（core/dist/index.js、plugin/dist/bundle.js、两个被清空的 package.json）与来源不明的 pd-cli dist | 全部组件通过摘要校验；`pd doctor` 无 degraded 项 | 重新安装 / 从上一次 release 回滚 |
| **P4 投影纪律** | 宿主目录与 console 依赖副本登记为"投影"，加载前校验；**先 warn-only 观察期，再 fail-loud** | 观察期内零误报后切换严格模式 | warn-only 开关 |
| **P5 workspace 状态收敛** | `.pd` / `.state` 合并到单一状态根（带备份与日志的迁移） | 迁移后全部读写路径指向新根；旧根转只读归档 | 备份还原 |
| **P6 PATH 契约归口** | 安装器拥有 `pd` on PATH；清理陈旧 shim（`~/bin/pd`、指向已不存在路径的 npm 全局 pd.cmd、decoy `openclaw.cmd`） | 全新 PATH 解析链只有一条且指向 `~/.pd/runtime/bin` | 保留旧 shim 一个版本周期 |

---

## 3. 迁移风险（只识别，不解决）

1. **热修复风险**：P3 重铺 runtime 时，若 Companion/console/宿主正在运行，会遇到文件占用（本机已有 `EBUSY` 类噪音）。必须先停服。
2. **链接策略的平台风险**：形态 L 依赖 junction/symlink；Windows 无提权场景、部分工具链/杀软对 junction 处理不一致，且 npm `install-links` 默认把 `file:` 依赖变成副本——与链接策略直接冲突（现状就是被它打败的）。
3. **删除副本的顺序风险**：必须先证明"没有加载路径依赖这份物理副本"。反例就在本机：console 实际从**自己的** `node_modules/principles-disciple` 副本加载 `governance-audit`；若先删它，console 当场崩。
4. **严格化的"把哑弹变炸弹"风险**：本机今天处于"有 3 个损坏文件但系统能跑"的状态。P4 一旦 fail-loud，会先把这类机器**打挂**。因此 P4 必须先 warn-only。
5. **版本输出消费方风险**：`pd version --json` 从 legacy-overlay 切到 canonical 后，字段来源与 `health`/`source` 取值会变化；任何依赖旧输出形态的脚本/看板需同步。
6. **多宿主与卸载判定风险**：`uninstaller.ts` 的 `removeSharedRuntime` 由 `install.json.hosts` 决定；迁移期间 hosts 登记不准确会导致误删共享 runtime 或残留。
7. **回滚能力未经实测风险**：`transaction-journal.ts` / `rollback-policy.ts` 存在，但本机从未产生过 active.json，等于**回滚链路在该机器上零演练**。P1 必须包含一次真实回滚演练。
8. **双通道更新风险**：Companion 走 electron-updater 独立通道，产品走 ReleaseManager；两个通道的节奏不同会持续制造"桌面版本 ≠ 产品版本"的观感，需要在 UI 上可解释，而不是靠用户猜。
9. **Agent 写入风险（根因）**：本机 2026-09-03 15:06 的占位符写入事件说明"安装目录被非安装器写入"是真实发生的。任何只修文件、不修写入权限与校验机制的方案都会被重演。

---

## 4. 需要 Owner 决策的问题（未决，不得由 Agent 自行拍板）

| # | 决策 | 选项 |
|---|---|---|
| Q1 | SDK/依赖解析形态 | **L（链接，符合 ADR-0020 薄适配器）** vs **B（打包内联 + 摘要登记，更抗平台差异）** |
| Q2 | 宿主投影形态 | 链接投影 vs 副本投影（需考虑 OpenClaw 宿主对链接目录的兼容性） |
| Q3 | 适配器内联政策 | 是否强制 openclaw-plugin 停止内联 host-runtime（形态 L 的必然结果） |
| Q4 | SDK 定位 | core 提升为"具名 + 子路径稳定性等级"的内部 SDK，还是维持内部包（不新建 façade 是本文档建议） |
| Q5 | Workspace 状态 | 单一状态根（P5）还是两个显式命名空间长期并存 |
| Q6 | 桌面外壳 | 是否维持独立发布/更新通道，还是纳入 ReleaseManager 统一编排 |
| Q7 | PATH 契约 | 安装器是否接管 `~/bin`，以及陈旧 shim/decoy 的清理时点 |
| Q8 | 严格化节奏 | P4 warn-only 观察期多长；发现 degraded 时是否阻断使用 |
| Q9 | 安装目录防护 | 只读锁是否成为安装器的正式能力（manifest 化），而不是维护者脚本 |

---

## 5. 明确不做的事（本文档范围内）

- 不修复被占位符覆盖的 `runtime/core/dist/index.js`、`runtime/plugin/dist/bundle.js`；
- 不删除任何 core / plugin 的重复副本；
- 不统一或改写任何版本号；
- 不修改 `installer.ts`、`install-layout`、任何包的生产代码；
- 不清理 `~/bin/pd`、陈旧 npm shim、workspace 旧库（`.hygiene-quarantine-*` / `e2e/.state`）。

这些是 §2.8 中 P3/P5/P6 的实施任务，**必须在 §4 的 Owner 决策落地之后**才启动。

---

## 6. 验收

- [x] 架构文档创建：`docs/architecture/PD_Installation_Architecture_v2.md`
- [x] 当前现实已映射（§1，含对审计的 7 项修正）
- [x] 目标架构已定义（§2.1–2.7 八项边界）
- [x] 迁移风险已识别（§3，9 项）
- [x] 迁移策略已定义（§2.8，P0–P6，含退出判据与回滚）
- [x] Owner 决策项已列出（§4，9 项）
- [x] **零生产代码改动**
