# Junction 生命周期回归审计 — PRI-913 Phase 0

- 日期：2026-09-24
- 基线：main @ 4726620e（PRI-912 canonical junction pass 已合并）
- 性质：只读现实审计。未修改任何代码。行号引用均指向基线提交。
- 范围：`reconcilePluginCoreCanonicalJunction`（installer.ts:2496）产出的 junction 在 install / upgrade / rollback / repair / uninstall 五个生命周期阶段的存活与安全性。
- 边界（ mission 强约束）：不改 topology、不扩 candidate 范围、不处理 slim core、不引入新 link 管理。本文只回答一个问题：**junction 能否安全存在于生产 runtime 生命周期中，现有测试证明了哪些、还缺哪些。**

---

## TL;DR

PRI-912 的 junction 只在**安装结束前的一个时点**被创建并被单测保护。生命周期五个阶段中：

- **install（首装）**：已被 smoke-packaged-install 真实覆盖（两目录槽位 lstat+require.resolve）。
- **upgrade**：真实链路存在（每次升级都重新物化 plugin → 重新 reconcile），但升级 gate 对 **plugin 的 `node_modules/@principles/core` 槽位零断言**——`expectCanonicalRuntimeLayout`（release-upgrade-gate.test.ts:470）刻意只断言 pd-cli 槽位内容新鲜度与 codex-adapter 链接，plugin core junction 完全在盲区。
- **rollback**：备份/恢复全部走整树 rename（installer.ts:1121/:1124、restoreBackup :1133），天然不 follow junction，但**没有任何测试**在 junction 已存在的事务上验证恢复后链接完好。
- **repair**：`repairUpdateChain`（installer.ts:569）**不部署 payload**（:626 注释明说），不触碰 reconcile——幂等风险为零，但同样无测试锁定这一"不触碰"承诺。
- **uninstall**：删除走 `fse.remove`（uninstaller.ts:373-377，lstat 语义不追链接），且 plugin 路径（:509）先于共享 runtime（:570）删除——顺序与语义都安全，但**无测试证明**删 link 不删 target。

---

## 1. 当前行为（按生命周期阶段）

### 1.1 创建时点与机制

- reconcile 唯一生产调用点：installer.ts:3817，位于**全部组件部署之后**、journal `'staged'`（:3821）与 console 探针（:3827）**之前**。
- 转换机制（:2637-2682）：物化拷贝先 `renameSync` 挪到 `<slot>.pri912-materialized` 侧位，再 `symlinkSync(type:'junction')`（Windows）/相对目录 symlink（Unix）指向 `~/.pd/runtime/core`，realpath 验证，失败即回滚侧位，成功 best-effort 删除侧备份。
- 三门禁（package identity / `file:` 声明解析到 canonical / digest 相等）不满足 → `skipped` 结构化上报，绝不按名字放行；已是 canonical 链接 → `alreadyCanonical` no-op。
- canonical 缺失时（runtimeCoreReal===null，:2509）全部 skip 为 `canonical_runtime_core_missing`，物理拷贝继续工作——**junction 是加速器不是依赖项**。

### 1.2 Install（首装）

全新安装：plugin 从 payload 整树物化（`installPluginToStaging` :1648-1661，含 `<plugin>/core` junction :1656-1661）→ reconcile 把 `<plugin>/node_modules/@principles/core` 物化拷贝换成链接。

### 1.3 Upgrade（升级）

升级 = **整树换血，不是原地改链**：

1. `backupExistingInstall` :1105-1131 对旧 extDir / runtimeDir 做**整树 rename**（:1121/:1124，renameSync 不 follow 树内 junction，链接随树整体移走）；备份放在 extensions/ 之外（getPdBackupsDir），避免 OpenClaw 重发现。
2. 新 payload 全新物化 plugin → **每次升级都会重新生成物化 core 拷贝，然后被 reconcile 重新换链**。
3. Console `/api/update/apply-full` → ReleaseManager.apply → release-manager.ts:458 **重新调用完整 install()**，reconcile 随之重跑。不存在"跳过 installer 主体"的升级捷径。
4. 成功确认时 `retainSupersededBackup`（:4011 调用，:1186 定义）保留当前+一份旧备份，多余的被裁。

### 1.4 Rollback（回滚）

reconcile 在 `'staged'` **之前**运行（:3813 注释：转换失败落入**既有** fail→restoreBackup 通道，无新状态）。失败路径：:4084 `restoreBackup(backupDir, runtimeBackupDir)` → 把备份整树 rename 回来（同样不 follow junction）→ journal 依是否发生真实回滚记 `rolled_back`（:4091）或 `failed`。

### 1.5 Repair（修复更新链）

`repairUpdateChain` :569-626：只修信任链/事务元数据，**不部署 payload、不触碰 node_modules、不跑 reconcile**。已有 junction 原地不动，修复不会制造也不会销毁链接。

### 1.6 Uninstall（卸载）

uninstaller.ts：先停运行中的 console 进程（PRI-696 :490-500）→ 步骤 5 循环删 host/plugin 路径（:509 `removeWithRetry(p.path, p.type)`）→ **最后**（:568-571）按 `planSharedRuntimeUninstall`（:50-75）裁决才删 `~/.pd/runtime`。`removeWithRetry` :373-377 用 `fse.remove`——lstat 语义，删链接不删 target（PRI-912 评审轮已实验确认，见 canonical-symlink-compatibility-audit）。

> **本任务实测补充（2026-09-24，lifecycle 测试运行证据）：** `--host all` 卸载的全局 shim 清理腿（`removeGlobalPdShim` :536 → `getGlobalShimPaths` mvp-config.ts:619 → `getNpmGlobalBinDir` installer.ts:1685）会执行一次 `npm prefix -g` **位置查询**。这是设计内行为：免 npm 承诺覆盖的是 install/upgrade 的 payload 链路；shim 清理只删 PD 自有的 shim 文件（`isPdOwnedShim` 门禁），不做 registry 卸载。host 级卸载（仍有其他 host 时）不触碰此腿，实测无 npm 调用。

---

## 2. 已存在的保护

| 保护 | 位置 | 性质 |
| --- | --- | --- |
| 三门禁 + 结构化 skipped | installer.ts:2496-2682 | 误换链不可能按名字发生 |
| rename-aside + 失败回滚侧位 | installer.ts:2637-2682 | 转换中途失败不留悬空槽 |
| canonical 缺失 → 全 skip | installer.ts:2509 | junction 非运行依赖 |
| 备份/恢复整树 rename | installer.ts:1121/:1124/:1133 | 不经 junction follow |
| reconcile 先于 'staged'，复用既有回滚通道 | installer.ts:3813-3821 | 不新增生命周期状态 |
| repair 不部署 payload | installer.ts:569-626 | 链接零接触 |
| 卸载 lstat 删除 + plugin 先 runtime 后 | uninstaller.ts:373/:509/:570 | 删 link 不删 target |
| alreadyCanonical no-op | installer.ts reconcile 循环 | 重复运行不重建 |
| PRI-912 评审加固（guarded rmSync、无条件 restore 清理、悬空链接识别） | #1861 commit 529e8c61 | 单元级已锁 |

## 3. 已有测试覆盖

- **plugin-core-junction.test.ts**（15 例）：单元级真实 fs，含转换/幂等/skip 分类/E2E 失败注入/rmSync 不追链删 target（测试 D）。**缺口：全部作用于手工搭的 fixture 树，不进 install() 主流程。**
- **smoke-packaged-install.test.ts** :325-365：真实 CLI 首装，断言两 plugin 目录槽位 isSymbolicLink + bare require.resolve 落到 runtime/core。:585 有回滚注入但用**独立全新 backupHomeDir**，且**从未在同一 HOME 上跑第二次安装**。
- **release-upgrade-gate.test.ts**：真实 N-1→N 升级 + Windows CI job（release-reproducibility-full.yml `upgrade-gate-windows`）。但 `expectCanonicalRuntimeLayout`（:470-485）**刻意不断言 plugin 的 node_modules core 槽位**（注释口径：pd-cli 槽位不变量是内容新鲜度而非 link-ness）；:696 只断言 `<extPlugin>/core`（shell 链接），与 reconcile 产物是两回事。**PRI-912 junction 在升级后的真实链路上零断言。**
- **uninstaller.test.ts**：无 junction 场景。

## 4. 缺失测试（→ Phase 1-5 落点）

| # | 缺口 | Phase | 载体 |
| --- | --- | --- | --- |
| G1 | 真实 upgrade 后 plugin core 槽位：链接存在、指向本次部署的 canonical、内容新鲜、digest 与 asset manifest 一致、旧备份正确收纳 | 1 | upgrade-gate 扩展（真实 installer 事务）|
| G2 | 同一 HOME 第二次 install（模拟 update 重入）后 junction 重新成立且无漂移 | 1/3 | 真实 install() 连跑 |
| G3 | 生命周期级回滚：junction 已建后事务失败 → restoreBackup 把旧树 rename 回来，**回滚后的树里旧链接（若有）完好、无悬空、runtime 可启动**；Windows reparse 语义 | 2 | 真实 install() 失败注入 + 现有 backup 机制 |
| G4 | repair 幂等承诺：repairUpdateChain 前后 junction 树 digest/lstat 逐字节不变 | 3 | 真实 repair 调用 |
| G5 | 真实 uninstaller 跑在含 converted junction 的树上：link 消失、`~/.pd/runtime/core` 存活 | 4 | uninstaller 真实流程测试 |
| G6 | 混合树（A 组件 junction + B 组件物化拷贝）：reconcile 状态识别正确、诊断结构化输出、无 silent corruption、**不自动扩修复** | 5 | 真实 install() + 手工注入混合态 |
| G7 | Windows 专属：G1-G5 的 junction 语义（reparse point）须在 windows runner 上至少各过一次 | 全部 | upgrade-gate-windows 同款 job |

## 5. 生命周期风险矩阵

| 阶段 | 风险 | 现有缓解 | 剩余风险（本任务目标） | 等级 |
| --- | --- | --- | --- | --- |
| install 首装 | 换错/换坏 | 三门禁 + 侧位回滚 + smoke 断言 | 低——已真实覆盖 | 低 |
| upgrade | 升级后 plugin 槽位静默回到物化态/悬空链/指向旧 canonical | 每次升级重跑 reconcile（结构性保证）| **G1/G2：结构性保证无断言背书**；若 reconcile 在新部署树上被跳过，无测试会失败 | **高** |
| rollback | restore rename 与树内 junction 交互出错（Windows reparse）| 整树 rename 不 follow | **G3：无一条真实回滚测试观察过 junction 树**；理论安全≠实测安全 | **高** |
| repair | 修复动作意外触碰链接 | 代码层面零接触（:626） | **G4："零接触"仅靠读代码保证，无回归锁** | 中 |
| uninstall | 删 link 追删 target（灾难级：毁共享 runtime） | fse.remove 语义 + 单元实验 | **G5：真实卸载器从未跑在含 junction 的树上**；语义变了不会有任何测试变红 | **高** |
| 混合树 | 部分链接部分物化时误判/静默半修复 | skipped 分类结构化 | **G6：识别正确性无真实流程验证** | 中 |
| 重复运行 | 二跑重建链接造成抖动/digest 漂移 | alreadyCanonical no-op（单元级） | **G2/G4：主流程级幂等未证** | 中 |

## 6. 结论与 Phase 落点

junction 的**创建端**安全（三门禁+单测+首装 smoke），**生命周期端**基本裸奔：upgrade/rollback/uninstall 三个真实链路各有一个零断言缺口（G1/G3/G5），是 Phase 1/2/4 的核心；Phase 3（G4/G2）、Phase 5（G6）锁住"不触碰"与"识别"承诺。全部新测试遵循 mission 约束：**走真实 installer/uninstaller/repair 流程，不 mock fs 链接语义，Windows 覆盖挂在既有 upgrade-gate-windows 同类 job，不改任何生产 topology。**

实施顺序建议：G5（uninstall，纯本地快）→ G2/G4（同 HOME 重入 + repair 幂等，快）→ G6（混合树诊断）→ G3（回滚注入）→ G1（upgrade-gate 扩展，最慢、放最后并复用 gate 已建的 publication 前置）。

> 实施后对账（PR #1865）：本审计各行的落点已实现。G4 的回归锁不是只靠 reconcile 幂等——`release-junction-lifecycle.test.ts` Phase 3 在 reconcile no-op 断言之外，真实调用生产修复入口 `repairUpdateChain`（PRI-850，与 `repair-update-chain` CLI 同一 package-root 调用形状），断言其部署 bootstrap/注册更新源后双 canonical 链接、canonical 字节与 journal 集合零变化，即上表"代码层面零接触"由读码保证升级为回归锁保证。
