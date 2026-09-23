# Installer Canonical Junction Pass SPEC（SPEC-P1′）

> 状态：**设计文档（SPEC）**。本任务不修改 installer / build script / manifest / package.json / lockfile，不建 PR。
> 上游：`docs/release/canonical-symlink-compatibility-audit.md`（SPEC-P1 审计，fbd6a871）——其结论"asset 内 symlink 与 archive dedup 均不可行，唯一路径 = 部署期 junction（B′）"是本 SPEC 的前提。
> 装机态取证：本机 `~/.pd/runtime`（core@1.287.3 世代）只读扫描，脚本 `D:/tmp/p1p-scan.mjs` → `D:/tmp/p1p-scan.json`（2026-09-23）。file:line 以 main@176a9a28 为基线。

## Problem

自包含资产为了在解包/校验层维持"纯文件 + 逐文件 sha256"信任模型，把 `file:../` 兄弟组件**物化**进每个组件的 `node_modules`（bundle-plugin + `npm ci --install-links`）。装机后 `~/.pd/runtime` 内同一内部组件存在多份物理拷贝；Phase 0 实测装机态 1112.3 MiB、node_modules 占 93%。

PRI-711 已证明"部署期把物化拷贝替换成 canonical junction"在生产可行（codex-adapter 三处链接、plugin shell `core` 链接均为此机制的产物，本机实测为活 junction）。本 SPEC 把该机制推广为一个**带内容等价门禁的通用 pass**：资产契约零改动、下载体积不变，省装机磁盘，且让 Node 的 ESM realpath 解析天然收敛到单一模块实例。

## Q1 / Current Runtime Topology（实测）

runtime 顶层组件：`core/ host-runtime/ codex-adapter/ console/ pd-cli/ plugin/ release-manager/ install-layout/ bin/`。@principles 家族重复矩阵（每拷贝 = lstat + 目录内容 digest，digest = sha256 over 排序的 `relpath+file-sha256` 行，不含 mtime/mode）：

| 包 | 物理拷贝 | 内容分组（digest 前 12 位） | 现状链接 |
| --- | --- | --- | --- |
| `@principles/core` | 6 处 | `bc10227f1ace` ×2：`core`(canonical, 119.4 MiB) ≡ `plugin/node_modules/@principles/core`(119.4 MiB)；`803323350cf5` ×3：console/host-runtime/pd-cli 内 **slim 拷贝**（各 8.0 MiB；实测为 canonical 去掉嵌套 node_modules 的严格子集，共有文件逐字节一致） | `codex-adapter/.../core` 已是 junction（PRI-711） |
| `@principles/host-runtime` | 4 处 | `84dc7532767a` ×1：`host-runtime`(canonical)；`44b8a6929da2` ×2：console/pd-cli 内 slim（0.4/0.45 MiB） | codex-adapter 已 junction |
| `@principles/install-layout` | 6 处 | root ×1；slim ×4 同 digest（各 ~9 KB） | codex-adapter 已 junction |
| `@principles/codex-adapter` | 2 处 | root 与 pd-cli 内拷贝 **digest 不同** | 无 |
| `@principles/pd-console` / `pd-cli` | 各 1（仅 root） | — | — |

**两类依赖的区分（任务 A/B 类）：**

* **B 类（本 SPEC 范围）= 内部组件拷贝**：上表全部。它们不是"依赖隔离"，是同一产品代码的重复分发；canonical root 就在同一 runtime 树内，天然有唯一指归。
* **A 类（本 SPEC 排除）= 第三方依赖图**：LLM 栈（openai/anthropic 等，Phase 0 估 ≈350 MiB ×6）、better-sqlite3 等。版本冲突语义（npm hoist 规则、嵌套覆盖）意味着"选一个 canonical"改变解析结果，且其收益属于共享 hoist 层（SPEC-P2 决策域），不属于单文件 pass。

关键实测事实：**只有 `plugin/node_modules/@principles/core` 与 canonical root 字节等价**（119.4 MiB 大拷贝，正是 Phase 0 指认的"含 nm 的整组件拷贝真浪费"）；各组件内 slim 拷贝与 root 内容不同（少嵌套 node_modules），strict 规则下不可互换。

## Q2 / Canonical Candidate Rules（Candidate Contract）

**禁止按名字放行。** 一个 `<component>/node_modules/@principles/<name>` 位置 L 被替换为 junction 的条件，全部满足才允许：

1. **canonical 存在**：`~/.pd/runtime/<D>/package.json` 的 `name` 字段（读自文件，rc-5：`Object.hasOwn`+类型校验）恰等于该位置包名，得 canonical 目录 C（一个 name 至多一个 root canonical；找不到 → 跳过该位置）。
2. **声明边存在**：所在组件的 `package.json.dependencies` 中该包声明为 `file:../<C的目录名>`（PRI-711 同款数据驱动，`installer.ts:2403-2404` 的 ref 解析 + `:2406-2410` 单段名 rc-1 守卫直接复用）。这保证链接方向与 npm 依赖语义一致，不凭目录名猜测。
3. **内容等价**：`digest(L) == digest(C)`。digest 定义即 Q1 扫描所用：文件树排序拼接逐文件 sha256；等价 ⇒ 可无损替换。不等 ⇒ **位置跳过，拷贝保留**（见 Q4 Case 4）。
4. **位置合法**：L 必须是 `node_modules/@principles/<name>` 一级（nested 传递图若与 root 等价同样按 1–3 处理，扫描为全树 walk，**遇 symlink 不穿越**，lstat 语义——与 `release-asset-manifest.ts` 枚举同纪律）。

版本判断不单独设规则：`package.json` 内容参与 digest，版本不同必然 digest 不同 → 自动落入拒绝。"同名不同内容"被第 3 条硬性挡下。

**Canonical Candidate Contract 输出示例（本机数据）：**

```
PASS  plugin/node_modules/@principles/core  → junction → runtime/core        (digest 相等, 省 119.4 MiB)
PASS  */node_modules/@principles/install-layout(×4 slim→root? 否: slim≠root)   SKIP (digest 不等, 各 9KB 无所谓)
SKIP  console|host-runtime|pd-cli/node_modules/@principles/core (slim≠root)   SKIP (digest 不等, 共 24 MiB 留待 P2)
SKIP  pd-cli/node_modules/@principles/codex-adapter                          SKIP (digest 不等)
NOOP  codex-adapter/node_modules/@principles/{core,host-runtime,install-layout} (已是正确 junction)
```

（install-layout 四份 slim 彼此同 digest 但与 root 不同：实测 root = slim + 一个额外 `package-lock.json`（5 文件 vs 4）。core 的 slim 组实测 = canonical 去掉嵌套 node_modules、其余 1477 个共有文件逐字节一致（本机 diff 验证）。这类"严格子集"关系是未来 `slim→canonical 超集替换`专项的有利前提，但仍需解析语义验证，v1 digest 门禁不放行。）

## Q3 / Canonical Map 来源（三案对比）

| 案 | 来源 | 优 | 劣 | 判定 |
| --- | --- | --- | --- | --- |
| **A** | **installer 部署后扫描 runtime 树**（walk + digest，本审计脚本即原型） | 零资产改动、零新信任输入、对任何 payload 形态成立（含 npm 分发版）、自包含可重入 | 装机时多一遍 IO（本机 ~880 MiB 读+hash 实测 <60s，一次性） | **采用** |
| B | 读 payload `_release/manifest.json` 的逐文件 sha256 推导目录等价 | 免重扫 | 需要新增"目录 digest 约定"并跨 build/verify/install 三方同步维护 → 新 durable source of truth（P4 违例），且 npm 分发形态无此文件 | 否 |
| C | 构建期生成 `_release/dedup-map.json` | 精确 | 资产内容变更 → 进 build-identity pin 清单、smoke、签名链路（P0 评审已证明该清单是隐藏消费者）；为一个 installer 侧优化扰动发布信任链，复杂度倒挂 | 否 |

P1 审计的教训在案：**不要污染 release asset**。A 案把全部复杂度关在 installer 一个函数里。

## Q4 / Replacement Algorithm

输入 = 组件根 runtimeDir；伪码（每个候选位置 L，canonical C）：

```
st = lstat(L)                              # 绝不 stat 跟随
switch:
  L 不存在:
    # 不是 pass 的职责 —— 缺依赖由组件自身安装步负责。跳过。
  st 是链接:
    realpath(L) == realpath(C) → NOOP      # Case 2
    否则                       → unlink; 重建 → junction/symlink(C)   # Case 3: repair
                                 （PRI-711 已验证语义, installer.ts:2422-2436）
  st 是目录:
    digest(L) 计算；
    == digest(C) → rmSync(L,{recursive:true}) ; 建链(L→C)             # 替换
    != digest(C) → 保留拷贝, 记 skipped_divergent{path,L,reason}       # Case 4: 禁止覆盖
```

要点：

* **Case 1（目标不存在）**：本 pass 不创建缺失依赖（与 PRI-711 不同——它修复声明缺失，本 pass 只去冗余），跳过即正确。
* **Case 3 选 repair 而非 fail**：错误 junction 与 PRI-711 面对的"stale copy/wrong-target link"同类，既有生产代码选择替换（`:2430-2436`），且 repair 后仍走 runtime 验证兜底；fail 会把一个可自愈状态升级成安装失败。
* **Case 4 绝不删除不重写**（任务红线）：不同内容物理拷贝是"资产就长这样"的证据（slim 拷贝），删除=改变行为。产结构化 skipped 清单进 install 结果与日志（rc-9：可观察降级 + nextAction=`'divergent copies remain; see SPEC-P2'`），安装继续。
* **顺序**：先算完全部位置的判定（只读），再统一执行替换（写）——两趟式，同 P0 剪枝模块的 `validate-all-then-delete` 纪律，避免中途抛错留下半决策状态。
* **原子性单位** = 单个位置：`rm` 与建链之间崩溃会留下"该位置缺失"的窗口；恢复方式 = 重跑（幂等）或整体 rename-swap 回滚（Q6），不需要 per-entry journal。
* **禁止穿越**：全树 walk 用 lstat Dirents，符号链接目录不进（`findSqlitePrebuildDirs` 同款，防环/防逃逸）。
* **链接形态**：win = `symlinkSync(absolute(C), L, 'junction')`；unix = `symlinkSync(relative(dirname(L), C), L, 'dir')`——仓库稳定惯例（`installer.ts:1465-1469/:2036-2042/:2433-2436`）。
* 输出汇总：`{linked:[...], noop:[...], repaired:[...], skippedDivergent:[...]}` 进 install result JSON（cli-6：给 nextAction 留材料）。

### 与既有 pass 的关系

`ensureCodexAdapterResolution`（PRI-711）**保留不动**：它语义更宽（声明缺失也建链、不等价也替换——面向"修复解析"），本 pass 面向"去冗余"，两者对 codex-adapter 位置幂等共存（后跑者 NOOP）。不合并，避免把 PRI-711 的事故修复语义改成带 digest 门禁后丢掉修复能力。

## Q5 / Installer Hook Point

现行时序（`install()` 主体）：

```
backup rename-swap (:3462)
→ 组件部署 ×N（core :3474 → console :3546-3555）
→ ensureCodexAdapterResolution (:3498)   ← 中途，只管 adapter 一家
→ journal 'staged' (:3558)
→ verifyConsole 探针 (:3561)             ← 运行时验证第一条
→ templates/config/runtime init
→ storyA demo（真实 pd-cli 子进程）(:3649)
→ host installers → trust root → commit (:3692+)
```

**推荐：B 案 —— 全部组件部署完成后、journal `'staged'` 之前（即 :3556 处）插入单一 `runCanonicalJunctionPass()`。**

* 必须在最晚：候选位置横跨 plugin(:3507)/pd-cli(:3522)/console(:3546) 部署之后，任何"install 后立即"的早点位（A 案变体，如贴 :3498）都会漏掉后部署组件。
* 必须在验证前（B 而非 C）：console 探针与 storyA 都以**子进程真实加载 installed 树**（:3616/:3649），放在验证前让"链接破坏解析"直接被现有 fail→rollback 通道捕获，而不是 commit 后才在生产暴露。这是本设计最重要的免费保险。
* 对回滚影响为零：'staged' 前任一 throw 都走 `restoreBackup` rename-swap（见 Q6），junction-safe 已由 P1 审计实验 E2/E3 证明。
* repair/升级复用同一函数：release-manager 的更新链最终调 `install()`（release-manager.ts:458），自动经过 hook；repair 模式（无 payload）在现有 repair 流程末尾追加同一调用（幂等）。

## Q6 / Rollback & Repair

* **Upgrade**：旧 runtime 整体 rename 为 `runtime.backup.<ts>`（:1120-1123）→ 新 payload 物理拷贝部署 → pass 重新收敛。旧树内既有 junction 随树 rename，指向 live 路径悬空属冷备（P1 审计 E8：不毁数据；rename-back 即复原）。
* **Pass 中途失败**：任一 throw → 既有失败路径 `restoreBackup`：`rmSync` 半成品新树（**不追链**，E2/E3 实测 + uninstaller 同款 `fse.remove` 亦不追链）→ rename 回旧树。结果**不留 mixed tree**：要么新树完整（含 pass 完整或记录在案的 skipped），要么回到旧树。per-entry 崩溃窗口（进程被杀）由"重跑 install/repair 幂等收敛"覆盖——重跑时正确链接 NOOP、缺失位置重建、半删拷贝重走 digest 判定。
* **Repair（重复运行）**：幂等是硬要求，由 Case 表穷尽保证（NOOP/repair/skip 均为纯函数 of 树状态）。验收含"连跑两次 install，第二次 linked=[] noop=all"断言。
* **Uninstall**：`fse.remove`（uninstaller.ts:373-376）实测不追链删 target；验收把该实测升级为回归测试（Q8-4）。
* **Journal**：pass 不新增状态机；结果摘要作为 `'staged'` transition 的 note 写入现有 transaction journal（可事后诊断哪些位置被 skipped）。

## Q7 / Platform Strategy

| 平台 | 形态 | 依据 |
| --- | --- | --- |
| win32 | **junction，绝对 target**（`symlinkSync(C_abs, L, 'junction')`） | 免管理员免 Developer Mode：生产代码注释 `installer.ts:2037` + 全链无降级兜底 + 本机装机态活 junction + P1 审计 E1。不用 'dir' symlink：bsdtar 实验证明原生 symlink 在 Windows 不可依赖 |
| unix | **相对 'dir' symlink**（`symlinkSync(relative(dirname(L),C), L, 'dir')`） | 仓库既有双侧惯例（:2041/:2436）；相对 target 随树 rename **自包含**（冷备树可独立解析，优于 win junction 的绝对 target 冷备悬空）；无需特权 |
| 明确不做 | Windows 原生 symlink；构建期/资产期任何链接；tar 携带任何条目类型 | P1 审计 Q1–Q3 全部实证拒绝 |

不对称（win 备份悬空 / unix 备份自洽）是 Windows junction 存储绝对 target 的既成事实，P1 审计已判定对 rename-swap 模型无实际影响；不为此引入 win 相对链接（'junction' 的相对 target 语义跨 Windows 版本不稳定，属未验证域）。

## Q8 / Verification Plan（实施 PR 的验收，本 SPEC 不含实施）

1. **Install（真实资产端到端）**：扩展 `release-asset-smoke.test.ts` 谱系——真实 asset 装机后：lstat 断言 plugin 的 core 位置为链接且 realpath==runtime/core；**全树 digest 不变式**：pass 前后"链接展开后的逻辑内容树"逐字节等价（把 skipped 位置计入）；storyA/console 探针在链接后拓扑上 PASS（生产路径，非 helper 单测）。
2. **Upgrade（迁移）**：旧版本物理拷贝树 → smart 更新 → 断言收敛到链接拓扑 + `pd --version`、demo 全绿；冷备树 rename-back 复原演练。
3. **Rollback**：构造 pass 后验证失败（注入坏 canonical）→ 断言 restoreBackup 后旧 runtime 完好、canonical target 无损（rename-swap 全程无追链删除）。Windows CI 必须真跑，不允许 only-linux 豁免。
4. **Uninstall**：fse.remove 删树后断言 canonical target 完整 + 链接位置消失（把 P1 审计 E2/E3 固化为回归测试）。
5. **负向/对抗**：slim≠root 位置必须被 skip 且出现在 skippedDivergent 清单（本机即有 3 例活数据）；wrong-target junction → repaired；错误 digest 注入（篡改一份拷贝 1 字节）→ 两侧都不动。
6. **幂等**：连跑两遍 pass 的第二次输出 linked=0、树 digest 不变。
7. **守卫同步**：新模块若入构建期路径需进 `compute-build-identity.mjs` pin 清单——本 pass 是 installer src（进 bundle），不改 build script，确认无需入 pin；PR 评审按 N-3 changeset 规则走 patch bump。

## Q9 / Size Benefit（实测口径，非理论）

本机装机态（1112.3 MiB 世代）：

| 口径 | Before | After（v1 strict） | 节省 |
| --- | --- | --- | --- |
| `@principles/core` | 2×119.4（root+plugin）+ 3×8.0（slim）+1 junction | 1×119.4 + 3×8.0 | **119.4 MiB** |
| 其余 @principles | （见 Q1 表） | 不动（digest 不等） | ≈0.04 MiB |
| **合计** | 1112.3 MiB | **≈993 MiB（−10.7%）** | **≈119.5 MiB** |
| **download size** | 资产 tar 不变 | **不变**（本 pass 零资产字节影响） | 0 |

上限参照：若未来（P2 或验证过的"slim→root 解析等价"专项）解锁 slim 三件套 + codex-adapter 拷贝 + 第三方 hoist，Phase 0 口径总冗余 656 MiB。**v1 诚实数字就是 ~120 MiB**，剩余收益属于拓扑级工程（P2），不为凑数并入。随 P0 剪枝资产铺开后，plugin 全量拷贝本身会变小（其嵌套 better-sqlite3 只剩单平台），绝对节省额随之下降、比例近似——发布时以 payload 重测为准。

## Risks

1. **混合树语义漂移（中）**：slim 拷贝继续存在 → 同一逻辑包两种形态并存，诊断噪音；缓解：skipped 清单结构化上报 + doctor 可日后读取。
2. **解析行为变化（中→低）**：plugin 位置从物理拷贝换成指回 root 的 junction 后，ESM realpath 归一使**全 runtime 共享同一 core 实例**。当前"两份实例、各自闭包"从未被任何测试要求过（复制是资产分发副产物），共享实例方向与 PRI-711 已上线行为一致；但若存在依赖双实例隔离的隐式状态（module-level cache），需在 e2e（Q8-1/2）暴露。这是 v1 最需要真实验证的一条。
3. **冷备树悬空（低）**：win junction 绝对 target 在 backup 中悬空——rename-back 复原，冷备从不被并发执行（P1 审计 §Q4 结论）。
4. **装机时长（低）**：全树 digest ~1 min 级，在 rename-swap 保护窗口内，失败可回滚。
5. **fs 兼容（低）**：极少数文件系统禁用 reparse point（exFAT U盘家目录等）→ 建链 EPERM fail；v1 不静默降级回拷贝（会掩盖拓扑分裂），fail loud 进既有 rollback，nextAction 提示。

## Not Included（有意排除）

* 第三方依赖去重（LLM 栈 ≈350 MiB、hoist 层、共享 node_modules）→ SPEC-P2 决策域；
* slim/root 内容归一（让 bundle 停止物化 slim 拷贝）——那是**资产侧**改动，本 SPEC 边界外；
* `_release/dedup-map.json` 类构建元数据（污染资产信任链，Q3 已否）；
* download/asset 体积（明确不变）；
* syncPdCli `!existsSync` 绕过的修复（属 PRI-711 机制自身推广，独立小票更合适，不与本 pass 捆绑）；
* 任何代码实施与 PR。

## Appendix — 取证复跑

* 扫描器：`D:/tmp/p1p-scan.mjs`（只读、lstat、不穿越链接）→ `D:/tmp/p1p-scan.json`；
* 平台实验 E1–E9 与全部 file:line：见 `canonical-symlink-compatibility-audit.md`（同分支上一 commit）。
