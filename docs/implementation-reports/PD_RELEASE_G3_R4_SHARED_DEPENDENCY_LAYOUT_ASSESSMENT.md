# PD Release G3-R4 — 共享依赖布局评估

- 日期：2026-11-03
- 阶段：SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001 §4 / §10 最后一项（跨组件共享依赖布局评估）
- 模式：**Assessment（只读评估）**，不授权、也未执行任何依赖布局重构
- 基线：`origin/main` = `d9bd67dca`（fetch 后确认）
- 证据目录：`.tmp/g3r4/`（scripts 与实验布局，gitignored；不进入提交）

---

## 0. 结论（先读这里）

**裁定：`TARGETED_CHANGE_CANDIDATE`。**

- 物理重复是**真实且巨大**的：安装态 `~/.pd/runtime` 共 **775.9 MB / 132,172 文件**，其中可归因于"同包同名多份物理副本"的字节为 **562.3 MB（72.5%）**；按"每组件只保留自身声明依赖闭包"重新计算，可**实测减少 428.6 MB（−55.2%）**。
- 但**不建议本轮或紧接本轮进入实施**，理由不是技术上不可行，而是：
  1. SPEC §10 第 5 项（依赖链接/状态逻辑合并）**尚未完成**（见 §2），而任何去重都建在链接语义之上；
  2. 逐组件裁剪依赖闭包需要一条新的**机械化解析审计门**（否则会把今天被 hoisting 掩盖的"未声明直依赖"变成线上 `ERR_MODULE_NOT_FOUND`）；
  3. 收益形式是安装体积与下载体积，**不改变任何 Owner 可见的产品能力**，优先级应低于队列中的功能项。
- 明确**不建议**的方案：新建 `~/.pd/runtime/node_modules` 这类"全局共享依赖树"。它需要在发布侧引入新的 union lock（第二个版本权威）、改写 installer 的组件自足契约，且无法覆盖 OpenClaw / WorkBuddy 宿主内进程（它们不能向上翻到 runtime 树），净收益只比逐组件裁剪多约 60 MB，复杂度代价远高于收益。
- 三个值得 Owner 关注的问题见 §12；其中**优先级最高的是 cohort pin 漂移**，它与本次去重无关，但比去重更要紧。

---

## 1. 基线与执行纪律

| 项 | 事实 |
|---|---|
| 本轮起点 | `git fetch origin` → `origin/main = d9bd67dca` |
| 用户给出的基线 `86a16a43f` | 是 **PR #2313（G3.3 H1/H2 加固）的 merge commit**，仍是 `origin/main` 祖先 |
| 自 `86a16a43f` 之后 main 的推进 | `6ed14c02f`（PRI-1085 Phase B，与发布无关）、`d9bd67dca`（#2314 Version Packages） |
| 之前我经手的 `8e0cdc607` | 是 `86a16a43f` 之前更早的基线（G3.1/G3.2 上游），diff 即上述 G3 系列合并 |
| primary checkout | `D:\Code\principles`，含 ~22 个未提交/未跟踪条目，**全程未清理、未覆盖** |
| worktree 变更 | **未执行任何 worktree add/remove/prune**：`.git/pd-worktree-mutation.lock` 在本轮开始时由另一会话持有（另一会话正在做 worktree 回收，与用户提示一致） |
| 交付文档落点 | 因 worktree 变更互斥锁被占用，本文以**未跟踪文件**写入 primary checkout 的 `docs/implementation-reports/`（不提交、不建 PR），与该目录已有未跟踪报告一致 |
| `~/.pd` / `~/.openclaw` | **仅只读观察**（目录枚举、大小统计、读 package.json / lstat），未做任何写入 |
| 依赖解析 | 未运行 `npm install` / `npm ci` / `npm dedupe` / `npm version`；全部解析实验在 `.tmp/g3r4/lab` 隔离目录内完成 |
| 发布动作 | 未执行 publish / Release / deploy / workflow dispatch |

---

## 2. §10 前置项状态（依赖链接/状态逻辑合并）

**状态：未完成（NOT MERGED）。** 本轮只记录，不并入。

证据（当前代码，`packages/create-principles-disciple/src/installer.ts`）：

| 位置 | 现状 |
|---|---|
| `syncPdCli()` — [installer.ts:2235](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2235) | pd-cli 专用链接逻辑；只在 `!existsSync(linkPath)` 时建链（[2261](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2261) / [2280](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2280) / [2294](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2294)） |
| console 链接 — [2513](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2513) / [2526](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2526) | 只补 plugin / release-manager 两个链接，**core / host-runtime 无链接** |
| `ensureComponentFileDependencyLinks()` — [2619](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2619) | 适配器用的通用实现（会**替换**已存在的实体目录） |
| `ensureCodexAdapterResolution()` / `ensureWorkbuddyAdapterResolution()` — [2685](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2685) / [2729](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2729) | 仅适配器接入通用实现 |

也就是说：**通用 helper 已存在（adapter 用），但 pd-cli / console 仍是各自定制逻辑，且 pd-cli/console 的"存在即跳过"守卫会被 `npm ci` 物化出来的实体目录静默打败**——这正是 §3 中 3 份 `@principles/core` 实体副本的来源。此项属于 §10 第 5 项范围，本轮不修复。

---

## 3. 当前真实安装布局（A–G）

以 `~/.pd/runtime` 实测（lstat 计数，**不跟随 junction/symlink**；Node v26.7.0 / Windows）：

| 组件（物理目录） | 总大小 | 文件数 | 其中 `node_modules` | 说明 |
|---|---:|---:|---:|---|
| `core` | 96.22 MB | 17,763 | 86.44 MB | 规范树；7 个直接三方依赖 |
| `host-runtime` | 96.97 MB | 17,855 | 96.15 MB | 自带完整依赖树 + 一份实体 core 副本 |
| `console` | 192.35 MB | 27,758 | 187.41 MB | 自带完整依赖树 + 实体 core 副本 + UI 构建工具链 |
| `pd-cli` | 105.30 MB | 18,644 | 102.74 MB | 自带完整依赖树 + 实体 core 副本 |
| `codex-adapter` | 86.73 MB | 16,183 | 86.44 MB | core/host-runtime 是 **junction**，但树内仍是完整 core 依赖图 |
| `workbuddy-adapter` | 86.65 MB | 16,173 | 86.44 MB | 同上 |
| `release-manager` | 94.25 MB | 17,475 | 92.78 MB | installer 包副本（17 个直接依赖，闭包全部保留） |
| `plugin` | 17.35 MB | 315 | 12.22 MB | 精简（仅 better-sqlite3 + node-addon-api，PRI-1037 遗留） |
| **runtime 合计** | **775.9 MB** | **132,172** | — | — |
| `~/.openclaw/extensions/principles-disciple` | 17.3 MB | — | 12.22 MB | 与 `runtime/plugin` 同构的第二份 plugin 载荷 |
| `~/.pd/backups/<backup>` | 775.2 MB | — | — | 一份完整 runtime 备份（回滚载体） |

布局来源（代码为证）：

- **A｜npm 独立发布包**：8 个发布包各自的 `package.json`；各包 `node_modules` 不随 npm 包发布（由消费者安装）。
- **B｜installer 内嵌组件**：`bundle-plugin.mjs` 在 `self-contained` 模式对每个组件执行
  `npm ci --omit=dev --ignore-scripts --legacy-peer-deps --install-links`（[bundle-plugin.mjs:796](file:///D:/Code/principles/packages/create-principles-disciple/scripts/bundle-plugin.mjs#L796) / [802](file:///D:/Code/principles/packages/create-principles-disciple/scripts/bundle-plugin.mjs#L802)），组件依赖来自各组件已提交的 `release-locks/<component>/package-lock.json`。
- **C｜`~/.pd/runtime` 组件**：installer 把组件整目录复制进 runtime（本机即为 self-contained 形态）。
- **D｜OpenClaw plugin extension**：`runtime/plugin` 与 `~/.openclaw/extensions/principles-disciple` **双份部署**。
- **E｜PD-CLI node_modules**：实体树（102.74 MB），外加 installer 补建的 `@principles/*` junction。
- **F｜Console node_modules**：实体树（187.41 MB）。
- **G｜Bootstrap Executor 依赖闭包**：`bootstrapExecutorDir` 自带 `dist` + 自身依赖，并单独做 `digestDirectory` 校验（[installer.ts:525](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L525)）。

`--install-links` 的语义是**物化**：`file:../core` 不会变成 symlink，而是复制成实体目录（`core` 副本 9.69 MB ×3，见 §4），并把它声明的依赖装入消费者自己的 `node_modules`。这是"每组件一棵完整依赖树"的生成机制，而不是有人手工拷了 7 份。

---

## 4. 依赖物理重复测量

### 4.1 关键依赖矩阵（实测，顶层物理副本）

| Package | 消费者 | 版本 | 每份 MB | 物理副本数 | Native | 解析归属 |
|---|---|---:|---:|---:|---|---|
| `better-sqlite3` | core/host-runtime/console/pd-cli/codex/workbuddy/release-manager/plugin | 13.0.3 | 11.82 | **8** | 是（单份 `prebuilds/win32-x64.node` 1.99 MB；`deps/sqlite3/sqlite3.c` 9.52 MB） | 各自 `node_modules` |
| `openai` | 除 plugin 外 7 个组件 | 7.19.0 | 17.62 | **7** | 否 | 各自 `node_modules` |
| `@google/genai` | 7 | 2.21.0 | 10.75 | 7 | 否 | 同上 |
| `@anthropic-ai/sdk` | 7 | 0.129.0 | 9.06 | 7 | 否 | 同上 |
| `web-streams-polyfill` | 7 | 3.3.3 | 8.62 | 7 | 否 | 同上 |
| `@earendil-works/pi-ai` | 7 | 1.2.0 | 5.42 | 7 | 否 | 同上 |
| `@principles/core`（**实体副本**） | host-runtime / console / pd-cli | 1.298.1 | 9.69 | **3**（+规范树 = 4 份） | 否 | `--install-links` 物化 |
| `@principles/core`（junction） | codex / workbuddy | 1.298.1 | 0 | 2 link | — | `ensureComponentFileDependencyLinks` |
| `@sinclair/typebox` | 7 | 0.34.52 | 1.82 | 7 | 否 | 各自 `node_modules` |
| `js-yaml` | 7 | 5.5.0 | 1.55 | 7 | 否 | 各自 `node_modules` |
| `undici` | 7 | 7.30.1 | 1.59 | 7 | 否 | 各自 `node_modules` |
| `commander` | console / release-manager / pd-cli | 14.0.3 / 14.0.3 / **12.1.0** | 0.20 / 0.18 | 3 | 否 | 各自 `node_modules` |
| `principles-disciple`（plugin 包副本） | console / pd-cli | 2.2.12 | 5.3 | 3（+runtime/plugin+ext） | 否 | `--install-links` 物化 |
| `create-principles-disciple`（installer 副本） | console | 1.146.2 | 1.35 | 2（+runtime/release-manager） | 否 | `--install-links` 物化 |

### 4.2 汇总（实测）

| 指标 | 数值 |
|---|---:|
| runtime 总大小 / 文件数 | 775.9 MB / 132,172 |
| 同包同版本冗余（共享后本可只留 1 份） | **509.7 MB** |
| 跨版本冲突冗余（必须嵌套保留） | **52.6 MB** |
| 重复合计 | **562.3 MB（72.5%）** |
| 去重后 `node_modules` 理论上限 | ≈213.6 MB |

冲突示例（同一包在不同组件锁定到不同版本）：`typebox 1.4.1/1.4.3`、`commander 14.0.3/12.1.0`、`tuf-js 3.1.0/6.0.0`、`@earendil-works/pi-telemetry 1.3.0/1.4.0`，以及 **AWS SDK 全家（`@aws-sdk/*`、`@smithy/*`）在两组版本间漂移**（例如 `@aws-sdk/core 3.978.3 / 3.979.1`）。这说明各组件 `release-locks` 是**在不同时间点生成**的，版本并未在发布列车内统一。

### 4.3 按"声明依赖闭包"重算可裁剪量（实测）

用各组件安装态 `node_modules/.package-lock.json` 求"直接三方依赖 + 其传递闭包"，把 `@principles/*`/本仓包视为兄弟链接（由 runtime 兄弟目录提供）：

| 组件 | 现有 nm | 闭包必需 | 可裁剪 | 裁剪后占比 |
|---|---:|---:|---:|---:|
| core | 86.4 MB | 86.4 MB | 0 | — |
| host-runtime | 96.1 MB | 13.9 MB | **82.2 MB** | −85.5% |
| console | 187.4 MB | 90.5 MB | **96.8 MB** | −51.7% |
| pd-cli | 102.7 MB | 14.1 MB | **88.6 MB** | −86.3% |
| codex-adapter | 86.4 MB | 0（仅链接） | **86.4 MB** | −100% |
| workbuddy-adapter | 86.4 MB | 0 + better-sqlite3 11.8* | **74.6 MB** | −86.3% |
| release-manager | 92.8 MB | 92.7 MB | 0 | — |
| **合计** | — | — | **428.6 MB** | **−55.2%** |

\* WorkBuddy 插件骨架运行在宿主进程内，宿主自带的 better-sqlite3 不可从外部 require（既有 P05/PR-1037 结论），必须保留自身副本，故按 11.8 MB 计。

**方法论边界（必须如实标注）**：以上只统计 `node_modules` 顶层条目（不含更深层嵌套副本），因此是**保守下界**；字节统计用 lstat、跳过 reparse point，避免把 junction 目标重复计数；文件数裁剪后的值未实测，属**估算**。

---

## 5. 模块解析实验（隔离目录实测）

环境：`.tmp/g3r4/lab`，每次场景独立 Node 进程，避免模块缓存污染。布局：`core/`（含 `dist/`）、`host-runtime/`（`@principles/core` 指向 `core` 的 Windows junction）、`shareddep` 分别置于不同 `node_modules`。

| 场景 | 布局 | 结果（原始输出） |
|---|---|---|
| S1 | core 自带 `shareddep` 副本 **且** 根目录也有 | `{"scenario":"S1","ok":true,"observed":"core-copy-from-core"}` → **解析命中自己最近的副本** |
| S2 | 仅根目录 `node_modules/shareddep` | `{"scenario":"S2","ok":true,"observed":"root-copy"}` → **共享根树可行** |
| S3 | 只有兄弟组件 `host-runtime/node_modules/shareddep` | `ERR_MODULE_NOT_FOUND Cannot find package 'shareddep' imported from ...\lab\core\dist\index.js` → **无"链接方 node_modules"回退** |
| S4 | CJS `require('shareddep')`，仅根目录有 | `{"scenario":"S4","ok":true,"observed":"root-copy"}` → CJS 同语义 |
| S5 | 两个组件各自持有不同版本副本 | `{"scenario":"S5","ok":true,"core":"v14","core2":"v13"}` → **版本天然隔离** |

**结论**：

1. Node 对 junction/symlink 走 **realpath** 解析，依赖从**真实路径**向上查找。因此 `@principles/core` 若是链接，其依赖由 `runtime/core/node_modules` 提供；若是实体副本，则消费者必须自带整棵依赖树——这正是 §4 的成因。
2. "共享一个 runtime 级 `node_modules`"在解析层面可行（S2）。
3. **installer.ts:2275-2277 的注释与真实运行路径不符**。原文声称 "host-runtime's own better-sqlite3 / js-yaml / @principles/core dependencies resolve through the plugin's `<ext>/node_modules/` (shared via Node's upward module resolution), so no separate npm install is needed"。真实情况：
   - `~/.pd/runtime/host-runtime` 是实体目录（非链接），其向上查找链为 `runtime/host-runtime → runtime → ~/.pd → $HOME`，**永远到不了** `~/.openclaw/extensions/principles-disciple`（它不是祖先目录）；
   - 实测 host-runtime 自带 **96.15 MB** 依赖树，且 installer 的 `prepareBundledComponentDependencies()`（[935](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L935)）会**强校验**组件声明依赖是否存在于自己的 `node_modules`。
   - S3 从解析语义上独立否证了该注释。
   
   该注释属"误导性维护指引"，任何据此注释做去重的人都会踩坑；本轮只记录，未修改（不在授权范围）。

---

## 6. Native ABI 与宿主隔离

### 6.1 better-sqlite3

| 项 | 实测/事实 |
|---|---|
| 版本 | 13.0.3，8 份物理副本，全部同版本 |
| ABI 形态 | N-API（依赖 `node-addon-api`，Windows 上单份 `prebuilds/win32-x64.node`）→ 对 Node 版本 ABI 稳定 |
| 包内构成 | 11.82 MB：`.node` 1.99 MB + `deps/sqlite3/sqlite3.c` 9.52 MB（源码，运行期不需要）+ 少量 src |
| 安装时机 | 发布构建侧 `--ignore-scripts` 直接使用预编译产物；安装侧不再编译，`verifyNativeModules()`（[775](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L775)）按组件加载探针 |
| 安全性结论 | 从 ABI 角度，**单份共享是可行的**；但共享会让"某组件 Node 运行时无法加载"变成全局失败，与当前"每组件独立探针"的故障隔离相违背 |
| 不可共享的特例 | `plugin`（OpenClaw 扩展目录，独立进程与独立 npm 更新线）、`workbuddy-adapter`（骨架在宿主进程内 require）必须各自保留 |

### 6.2 五个消费方的隔离现状

| 消费方 | 依赖来源 | 独立升级线 | 被一次升级影响 |
|---|---|---|---|
| OpenClaw plugin | `~/.openclaw/extensions/.../node_modules`（精简：仅 native） | 是（plugin npm 版本独立） | 否 |
| Codex adapter | `runtime/codex-adapter/node_modules` + junction 兄弟 | 随 runtime cohort | 随 cohort |
| WorkBuddy adapter | `runtime/workbuddy-adapter/node_modules`（含 native 副本） | 随 runtime cohort | 随 cohort |
| PD-CLI | `runtime/pd-cli/node_modules` + junction 兄弟 | 随 runtime cohort | 随 cohort |
| Console | `runtime/console/node_modules` | 随 runtime cohort | 随 cohort |

结论：**runtime 内 6 个组件本来就是"同一 cohort 同步升级"**，它们之间共享依赖不会新增"一个宿主升级影响另一个"的风险；真正的隔离要求来自 **plugin（宿主侧，独立 npm 更新线）** 与 **workbuddy 宿主进程**，这两处必须保持自足。本章节因此把任何"共享"限定在 runtime 内部，且明确排除 plugin。

---

## 7. 安装事务与回滚

| 环节 | 事实（代码/实测） | 对共享布局的约束 |
|---|---|---|
| 事务边界 | runtime 整目录 rename-aside 到 `~/.pd/backups/principles-disciple.backup.<ts>`（[installer.ts:1197](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L1197)），组件逐个部署；失败时 quarantine + 回滚 | 共享目录**必须位于 `~/.pd/runtime` 之内**才能被整体回滚 |
| 备份开销 | 实测 775.2 MB（≈ 一份完整 runtime） | 去重后备份同步缩小 → 磁盘从 ~1.55 GB 降到 ~0.7 GB |
| 完整性校验 | 发布资产身份由 `_release/manifest.json` digest 承担（[installer.ts:296](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L296)）；部署后按组件校验**声明依赖存在性 + native 可加载**（[935](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L935) / [996](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L996) / [775](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L775)）；bootstrap executor 另有整树 digest（[525](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L525)） | 逐组件裁剪**不破坏**该契约（裁剪的只是传递依赖，声明依赖仍在）；把依赖移到组件外则需要改这条契约 |
| 原子切换 | 组件复制 + 旧目录整体移入 backups；不含跨目录提交 | 任何落在 `~/.pd/runtime` 之外的共享目录都会成为**新的跨事务状态**，按 Owner 规则不接受 |
| 新旧并行 | 旧 runtime 仅作为备份存在，不再运行（服务在切换前后被停/起） | 共享树不改变这一点 |

**判定**：可选方案必须把依赖放在 runtime 槽内，或干脆不新增共享位置（逐组件裁剪方案即属后者）。任何"全局共享依赖目录"都越过了事务保护边界。

---

## 8. 方案对比

### A｜保持当前布局

- 现状：775.9 MB / 132k 文件；备份 775.2 MB；下载体积（发布资产 255.5 MiB gzip 的旧审计值，当前未实测）随载荷近似线性。
- 优点：零风险、零新契约；组件自足，故障隔离最好。
- 缺点：>55% 的字节是同一份三方依赖图的多份拷贝；每份 native 副本 9.5 MB C 源码常驻。

### B1｜runtime 级单一共享 `node_modules`

| 维度 | 设计 |
|---|---|
| 位置 | `~/.pd/runtime/node_modules`（槽内） |
| 归属 | 发布资产构建侧产出，installer 只消费 |
| 安装/升级 | 随 runtime 槽整体替换（不独立升级） |
| 解析 | Node 向上解析（S2 已验证） |
| 版本冲突 | 52.6 MB 冲突包需嵌套在组件内，或统一 bump 所有 release-locks（会改动发布语义） |
| native | 单份 N-API 二进制共享；需接受"单点 native 故障=全局失败" |
| 失败恢复 | 槽整体回滚可用；但**构建侧**需要新的 union lock 作为版本权威（第二真相风险，P4） |
| 独立升级能力 | 不受损（本已同 cohort） |
| 实测净收益 | 理论上限 ≈490 MB；因 plugin/workbuddy 必须自足，实际 ≈ 与 B2 相当（差异 ≈60 MB） |
| 代价 | installer 自足契约改写 + 资产 manifest 语义变化 + 发布侧新锁权威 + 全链路回归 |

### B2｜逐组件裁剪到"声明闭包" + 统一 `@principles` 链接（推荐候选）

| 维度 | 设计 |
|---|---|
| 位置 | 不新增共享目录；依赖留在各自组件内，仅裁掉"只经兄弟组件才可达"的部分 |
| 归属 | 各组件 `release-locks` 仍是版本权威（不新增锁） |
| 解析 | 兄弟链接已存在（`ensureComponentFileDependencyLinks`，[2619](file:///D:/Code/principles/packages/create-principles-disciple/src/installer.ts#L2619)）；把 pd-cli/console 也统一到该实现（§10 第 5 项） |
| 版本冲突 | 天然规避：每组件仍按自己的 lock 安装，冲突留在原处 |
| native | 每组件仍各留 1 份：不扩大单点故障 |
| 失败恢复 | 槽整体回滚不变；installer 的声明依赖校验仍然成立 |
| 独立升级能力 | 不受损 |
| 实测收益 | **428.6 MB（−55.2%）**；文件数约 132k → 6~7 万（估算） |
| 新增义务 | 需一条**解析审计门**：对每个组件 `dist` 的全部 bare import 做真实解析，缺失即 fail-closed（防止未声明直依赖被裁掉） |
| 前置 | §10 第 5 项完成；Owner 授权 |

---

## 9. 成本收益对照

| 指标 | 当前布局（实测） | B2 候选（实测/估算） | 净收益 |
|---|---|---|---|
| Runtime 字节 | 775.9 MB | ≈347.3 MB（实测闭包差） | **−428.6 MB（−55.2%）** |
| Runtime 文件数 | 132,172 | ≈6.4 万（**估算**） | ≈−6.8 万文件 |
| 重复依赖字节 | 562.3 MB（72.5%） | 冲突部分 ~52.6 MB 保留，其余消除 | −约 470 MB |
| 磁盘占用（含备份） | ~1.55 GB | ~0.7 GB（**估算**：备份同比缩小） | −约 0.85 GB |
| 下载体积 | 发布资产 gzip 未在本轮实测（旧审计 255.5 MiB） | 估算 −35%~−45% | **估算，不作确定收益** |
| 安装耗时 | 文件复制为主 | 复制量下降 → 缩短 | 未实测，估算同比例 |
| 升级复杂度 | 无额外机制 | 不变（槽整体替换） | 0 |
| 回滚复杂度 | 整目录备份 | 不变 | 0 |
| Host 隔离 | plugin/workbuddy 自足 | 不变（两者不参与裁剪） | 0 |
| Native ABI 风险 | 每组件独立探针 | 不变（每组件仍各一份） | 0（B1 才会恶化） |

> 说明：下载体积与安装耗时未在本轮取得可信 artifact 实测，按用户要求标记为**估算**，不写成确定收益。字节/文件/副本数是实测。

---

## 10. Complexity Delta（若后续实施 B2）

```text
New durable source of truth: NO      （release-locks 仍是唯一版本权威）
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: NO （复用既有 ensureComponentFileDependencyLinks）
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: NO
External/network capability: NO
```

新增的是一处**构建期校验**（解析审计）与一处**链接实现统一**，两者都在既有发布/安装链路内，可单提交 revert。

若改为实施 B1，则 `New durable source of truth: YES`（union lock 成为第二版本权威）——这是我不推荐 B1 的主要理由。

---

## 11. 最终裁定

**`TARGETED_CHANGE_CANDIDATE`**

- 重复是真实的、可量化的、可消除的（−428.6 MB，实测下界）；
- 消除方式应选 **B2（逐组件裁剪 + 统一链接）**，不是新建共享依赖树；
- **本轮不实施**：前置 §10 第 5 项未完成；且需要独立的解析审计门与 Owner 授权；
- 若 Owner 认为安装体积不是当前优先级，则等价于 `KEEP_CURRENT_LAYOUT` 的决策结果——但那是**优先级判断**，不是"布局已合理"的技术结论。

---

## 12. 三个值得 Owner 关注的问题

### 问题 1（最高优先，与去重无关）｜已发布 cohort 与仓库 pin 漂移

- `plugins/principles-disciple/runtime-version.json` 仍钉 **core `1.298.1` / hostRuntime `0.14.4` / codexAdapter `0.6.2`**（note 自述为 "PRI-1040 published target cohort"）。
- 而 registry 上 **`@principles/core@2.0.0`、`@principles/host-runtime@0.14.6` 已真实发布**（G3.2 报告 A3 已以 attestation 证明），本机装着的也是 1.298.1 这一代。
- 后果：packaged capability check 仍在一代**旧字节**上验证 Owner controls / Codex V2 suspension / DesignGate，无法证明 2.0.0 的同等行为；这也解释了"仓库 core 2.0.0 vs 安装态 1.298.1"的落差。
- 这比"去重"更要紧：它影响的是**发布验证的证据真实性**（本轮不处理，建议单独 issue）。

### 问题 2｜`~55%` 的安装载荷是同构依赖图的多份拷贝（系统性，非单点）

- 实测 562.3 MB 重复；成因是"每组件 `npm ci --install-links` + 各自 lock + 未裁剪传递依赖"，而不是代码冗余。
- 修复路径已具备（B2），但依赖 §10 第 5 项与一条解析审计门。

### 问题 3｜两个"零风险但未做"的载荷裁剪点（成本极低，可独立处理）

- `better-sqlite3` 每份含 `deps/sqlite3/sqlite3.c` **9.52 MB** 纯 C 源码，8 份共 ≈**76 MB**，运行期完全不用（`--ignore-scripts` 已不编译；只加载 `prebuilds/*.node`）。
- Console 把 UI 依赖与构建工具链当作 runtime `dependencies` 安装：`lucide-react` **34.45 MB**、`react-dom` **7.69 MB**、`@fontsource/*` 字体，以及 `tailwindcss / postcss / postcss-cli / autoprefixer / @tailwindcss/postcss / @tailwindcss/vite / semver`。
  - 静态证据：`dist/server/**` **零引用**上述任一包；`dist/web/index.html` 只加载 `/assets/app.js` 与 `/assets/app.css`（app.js 为 1.37 MB 的预打包产物）。
  - 因此 `tailwindcss / postcss / postcss-cli / autoprefixer / @tailwindcss/postcss / @tailwindcss/vite / semver` 是**纯构建期依赖**，被误列为 runtime 依赖；`lucide-react / react-dom` 仅出现在已打包的 `app.js` 模块表里，服务端不引用。
  - 唯一需在实施前确认的例外：`app.js` 内含 **1 处** `import(`（潜在懒加载 chunk），需逐一验证后再删。
- 两项合计 ≈**120 MB**（其中 better-sqlite3 源码 76 MB、Console UI/构建依赖 ≈45 MB），**不需要**任何解析语义或 lock 变更，属 G2 类载荷清理的遗漏项（不在本轮范围）。

---

## 13. 是否建议进入后续实施

**不建议立即进入实施。** 建议顺序：

1. 先完成 §10 第 5 项（依赖链接/状态逻辑合并），使"统一链接"成为既有能力而非新抽象；
2. 再为 B2 单独立项，包含：解析审计门（fail-closed）+ 裁剪脚本 + 8 包与打包安装冒烟回归；
3. 问题 1（cohort pin 漂移）应提升为**独立 issue**，与体积优化无耦合；
4. 问题 3 的两个裁剪点可作为低成本 follow-up 单独排期。

---

## 14. 证据与复现

| 证据 | 位置 |
|---|---|
| 隔离解析实验（S1–S5） | `.tmp/g3r4/scenario.mjs` + `.tmp/g3r4/lab` |
| 安装态逐组件/逐包测量 | `.tmp/g3r4/measure.mjs`（输出见 §3/§4.2） |
| 声明闭包与可裁剪量 | `.tmp/g3r4/closure-audit.mjs`（基于各组件的 `node_modules/.package-lock.json`） |
| dist 静态 import 审计 | `.tmp/g3r4/import-audit.mjs`（用于确认 console 的未引用依赖、适配器无未声明依赖） |
| 依赖矩阵原始数据 | `.tmp/g3r4/installed-nm.json` |
| 发布侧安装命令 | `bundle-plugin.mjs:796/802`（`npm ci --omit=dev --ignore-scripts --legacy-peer-deps --install-links`） |
| installer 校验契约 | `installer.ts:775 / 935 / 996` |
| 事务与备份 | `installer.ts:1197`、`~/.pd/backups` 实测 |
| 勘误对象 | `installer.ts:2275-2277`（注释与运行时事实不符） |

**未做（且本轮明确不做）**：不修改 `package.json` / `package-lock.json` / `runtime-version.json` / `release-locks` / 发布配置；不修改 installer 链接逻辑；不执行任何安装、去重、发布或部署动作。
