# Runtime Topology Reality Audit（Phase 0，PRI-920 候选）

日期：2026-09-25 · 方法：只读源码取证（file:line 全部为当次 main checkout 实测）
范围：安装器 / 更新链 / CLI / Companion / plugin / workspace state 的 writer–reader 拓扑事实，
对照 ADR-0023（Accepted，amended 2026-09-05 §2.6.1）与 ADR-0024（Accepted，amended §6 2026-09-19）。

**本审计不做任何代码改动。** 结论区给出 invariant 判定与最小 guard 建议，是否实施由 Owner 决定。

---

## 1. 当前拓扑事实（current topology）

```
发布产物 (release asset, _release/product-identity.json 预哈希盖章)
   │  npx create-principles-disciple install          ← 唯一入口①
   │  Console POST /api/update/apply-full             ← 入口②（不直接写）
   │      └→ spawn detached bootstrap executor (~/.pd/bootstrap/executor)
   │            └→ ReleaseManager.apply()  ──动态 import──▶ install()   ← 汇聚到同一权威
   ▼
~/.pd/
 ├─ runtime/{core,console,pd-cli,plugin,host-runtime,install-layout,
 │           release-manager,codex-adapter,bin}      ← 组件目录 in-place rm+cp 交换（非版本副本切换）
 ├─ active.json        ← release 身份记录（generation 单调，journal-first 提交后才写）
 ├─ install.json       ← 布局指针（各 reader 用它解析组件目录）
 ├─ transactions/*.jsonl ← 每事务 journal（append+fsync）
 ├─ bootstrap/{executor,bootstrap.json(executorDigest tree-sha256)}
 ├─ trust/root.json · channels/ · releases/（仅元数据缓存）· staging/<txid>/ · logs/
 ├─ backups/runtime.backup.<ts> · enforcement-health/ · owner.json
 └─ ✗ 不存在 ~/.pd/state ——「state 分离」的实际不变量是 runtime 零数据（R3）+ 工作区状态根
~/.openclaw/extensions/principles-disciple/  ← plugin 物理副本（设计允许）；core 槽 junction→runtime core
<workspace>/.pd/  {state.db, config.yaml, telemetry/, logs/, update-history.json}  ← 可变状态根
```

关键事实修正（mission 措辞 vs 代码现实）：
- **runtime 不是版本目录树**：`~/.pd/runtime/<component>` 是稳定目录，更新=事务内换内容；
  `active.json` 在 `~/.pd/` 而非 runtime 下，指向的是身份记录不是路径（install-layout.ts:57）。
- **无 `~/.pd/state`**：任务书中该项是设计词汇，代码里不存在，无需审计其 writer。
- 无 `PD_HOME`/`PD_RUNTIME_DIR` 环境变量覆盖——home 恒为 HOME/USERPROFILE（mvp-config.ts:233-252），
  攻击面比通常假设小。

---

## 2. Writer 矩阵（谁在写安装面）

| Writer | 入口 | 写什么 | 权威性 | 冲突风险 |
|---|---|---|---|---|
| installer `install()` | npx / **ReleaseManager 动态 import**（release-manager.ts:437,458-471，已实测） | runtime/* 全部、plugin shell、shim、host 配置、active.json、install.json、trust、bootstrap | **唯一部署权威**（ADR-0024 §2.1 原文注释 installer.ts:4） | 两次 install 并发无互斥锁；防线=gateway-stop preflight+原子记录+单事务 journal |
| bootstrap executor | Console apply-full → detached 进程 | 自身不部署，只驱动 install()；写 caches/journal | 受控触发器（D-1：console 零直写，update.ts:107） | executor 崩溃留非终态 journal → 启动时 reconcile（transaction-journal.ts:254） |
| ReleaseManager | apply/check | 仅 `channels/*.json`、`releases/<id>/metadata.json` 缓存 | 缓存写者，非 runtime | 低 |
| repair | `npx … repair-update-chain`（installer.ts:569-640） | layout mkdir + bootstrap executor 重投；**明确不部署、不碰 active.json**（:543-548） | 受 ADR-0024 §2.3/D-4 约束 | 低 |
| `pd runtime artifact-repair` | CLI | **dry-run only**，只写 plan 文件，--confirm 被拒（runtime-artifact-repair.ts:479-491） | 无部署权 | 无 |
| 旧开发链 install.mjs / sync-plugin.mjs | 任意调用 | **无条件拒绝**（PRI-868 守卫，实测存在） | 已停用 | ERR-137 类已封死 |
| 状态写者（合法） | pd-cli/Console/host-runtime/plugin/codex-hook | `<ws>/.pd/*`（state.db via SqliteConnection、config.yaml 原子写、telemetry jsonl） | 状态根 owner 各就其位 | 并发控制仅 SQLite 层，跨进程无锁（状态类，非制品类） |
| 零星 ~/.pd 写者（合法但需知晓） | Console owner-identity→`owner.json`；RuleHost→`enforcement-health/`；Console→`~/.pd-console/workspaces.json` | 非 runtime 目录 | 各自 SSoT | `install.json` 双写者（installer+merge-preserving 契约，PRI-709） |
| `previous.json`（layout 里声明） | — | **有 reader 路径、无生产 writer** | 幽灵槽位 | 见风险 R-4 |

**判定：writer 唯一性在当前代码中成立**——所有部署写路径汇聚到 `install()` 一函数；其余 ~/.pd 写者
只写缓存/状态/标记，不碰 runtime 制品。

## 3. Reader 矩阵（谁在读、读到的能不能是旧的）

| Reader | 解析链 | 落点 | 可读到陈旧副本？ | 现有钉定测试 |
|---|---|---|---|---|
| `pd` bin + CLI 全部命令 | 全局 shim→`~/.pd/runtime/bin/pd.cmd`→`runtime/pd-cli`；依赖经 junction→runtime 组件 | canonical | 仅 junction 断链时（启动有检查） | console.ts 依赖槽预检；smoke-packaged-install |
| `pd version` | active.json + install.json + runtime/ + **per-component 回落 releases/ 缓存** + legacy overlay | canonical 优先 | **可以（诊断性混合读，by design，`componentsSource` 显性报告）** | version.test.ts:121-152 |
| `pd console open` | install.json→resolveInstallLayout→console 入口 live resolve | canonical；legacy 模式回 ext 目录 | legacy 分支（可见） | installed-layout.test.ts:135,182「canonical wins」 |
| Companion | install.json+存在性→`resolveInstalledRuntime`→spawn 系统 node 跑 `pd-cli console open`（locate.ts:22-40） | canonical，**不自带副本、不读 active.json**（§2.7 不变量实测成立） | 仅 legacy 模式 | pd-companion/tests locate/launch-result |
| OpenClaw plugin 运行时 | `dist/bundle.js`＝**构建期内联 core+host-runtime 的第二代码副本**（esbuild.config.js:35-62）；`node_modules/@principles/core` junction→runtime core（PRI-912） | bundle=自隔离 adapter 层（ADR-0023 §2.3 设计允许）；node_modules 副本被 canonical junction 化 | **半程更新/手改 ext 目录时 bundle 与 runtime 分层分裂** | release-junction-lifecycle（重，仅 full workflow）；plugin-core-junction（轻，包 CI） |
| Console server | install.json 同链；依赖经 console/node_modules junction | canonical | legacy 分支读整份 ext 副本 | installed-layout.test.ts |
| Codex hook | 生成的 wrapper 烘焙 pd-hook.js 路径 | canonical（由 installer 再生成） | wrapper 未随更新再生成则陈旧 | codex-adapter-resolution.test.ts |

## 4. ADR 对照：已实现 / 仅机制缺失

| 不变量（出处） | 状态 |
|---|---|
| installer single hub（0024 §2.1） | ✅ 已实现且被 delegation 实测（§2 表行 1/2） |
| journal-first 事务 + 失败不半写（0024 §2.2/§2.4） | ✅ 实现 + installer-journal/active-record/transaction-recovery 测试 |
| runtime canonical = `~/.pd/runtime/*` 稳定组件目录（0023 §2.1） | ✅ 实现 + 测试（全部 temp-HOME） |
| runtime 零数据 R3（0023 §2.1 / v2 §R3） | ⚠️ **纯约定**：无任何断言 runtime 里不出现 .db/config/用户数据 |
| 版本身份取自 active record（0023 §2.5） | ✅ 实现（strict reader fail-loud，corrupt→throw） |
| Companion 不拥有 runtime（0023 §2.7） | ✅ 实测成立 + 测试钉定 |
| pd 单一 PATH 源（0023 §2.8） | ◐ installer 管理 shim；legacy shim 清理=ADR 自认的后续任务 |
| Adapter bundle isolation 须登记内联 digest（0023 §2.3/§3.3） | ⚠️ payload 级 provenance 已有（product-identity 预哈希→active.json，embedded-product-identity 测试）；**plugin bundle 级 digest 登记未实现**（openclaw-plugin 全 grep 无 sourceCommit/bundleDigest 登记） |
| 完整性 Phase 1 warn-only 扫描（0023 §2.9） | ⚠️ **未实施**（`pd doctor` 不存在，ADR §3.3 自证）；属计划内 runtime 功能，非本任务 |
| 部署副本可溯源 I4（payload stamp + refuse-unstamped） | ✅ installer.ts:3340-3388 拒无戳 payload；active.json 记 releaseMetadataDigest/sourceCommit |

## 5. 风险与真实缺口（按可机械化程度排序）

- **G1（合并期，静态可守）writer 边界无 merge-time 防线。** writer 唯一性是*当前代码事实*，
  不是*受保护不变量*：下一个 PR 在 installer 包之外新增一处 `cpSync(rmSync|writeFile)` 指向
  runtime 路径，没有任何 guard/测试会红。AGENTS §1.1 是 policy-only；ERR-137 正是"约定正确被
  一条旧链击穿"的实例（旧链今天靠自身拒绝守卫——同样依赖它还在被调用）。
- **G2（安装态，确定性可测）零数据 + canonical 拓扑无 settled 断言。** 现有拓扑测试全部在
  install 事务内或 temp-HOME 合成 payload 中；没有一个断言"一次干净安装完成后":
  runtime 树内零 .db/.sqlite/config 痕迹；每个 `@principles/*` junction 都指向 canonical；
  active.json 身份 == payload 身份。三类模拟失败（stale copy / wrong writer 落点 / missing
  canonical）当前**都不能在落盘态被静态发现**，只能等下一次 install 的 reconcile 顺带处理。
- G3（运行期）settled 安装两版 release 之间的带外漂移（手改 junction、复制旧 core 进 runtime）
  → 0023 §2.9 Phase-1 warn-only 扫描的正当范围，属**规划中的 runtime 功能**（pd doctor），
  不应塞进本 guard 任务（会引入 runtime 行为面，违反"最小"）。
- G4 plugin bundle 级 digest 登记（§2.3/§3.3 欠账）→ 触及 release pipeline 与 bundle 架构，
  属独立 SPEC。
- R-4（观察）`previous.json` 声明于 install-layout 但无生产 writer → 文档/布局漂移，记 follow-up。

## 6. Invariant 判定 + 最小 guard 建议（Phase 1/2 决策材料，未实施）

| Invariant | 现状 | 是否已有机保 | 建议 |
|---|---|---|---|
| I1 canonical 解析 | 代码成立，temp-HOME 测试钉定优先级 | ✅（测试级）+ 落盘态缺断言 | 并入 G2 settled 断言 |
| I2 writer 唯一 | 代码成立，**merge 期无防线** | ❌ | **Guard A**（见下） |
| I3 制品/状态生命周期分离（R3） | 纯约定 | ❌ | 并入 **Guard B** |
| I4 provenance | payload 级已闭环 | ✅（bundle 级=SPEC，排除） | 不动 |

**Guard A — runtime-writer 边界（merge-time 静态，verify:merge 尾棒，零新 job）**
仿 `check-satellite-purity` / io-seam-registry 先例：一个 SSoT 白名单（允许对 `~/.pd` runtime
面执行部署写作的模块集合：installer.ts、bootstrap-executor、transaction-journal/atomic-file
等）+ 对 `packages/*/src/**` 的确定性扫描（写原语 × runtime 目标词汇共现即违规，越界即 fail
loud，报文件:行）。保护的是**依赖方向/写权限不变量**而非文件布局（§20 guard 哲学）。
弱点：词法扫描≠语义分析，须用 3 个失败模拟（新包写 runtime / installer 内新增第二写者文件 /
干净基线）校准，防 ERR-146（声明覆盖≠实际执行）。

**Guard B — settled-install 拓扑断言（确定性测试，挂在 create-principles-disciple 包测试套，
复用现有 temp-HOME + 合成 payload 框架，零新 CI job）**
一次最小 install 完成后静态断言：R3 零数据（runtime 树无 `*.db|*.sqlite|config.yaml|.state`）；
plugin/console/pd-cli 的每个依赖 junction realpath == canonical 组件目录；active.json 身份字段
与合成 payload 的 product-identity 一致。三个失败模拟：stale copy（预放旧 core 文件，断言被
拒或可检出）、wrong-writer mutation（事务外直写 runtime 文件，断言不破坏 junction/身份链）、
missing canonical（删 junction 目标，断言 reader fail-loud 不猜）。

**Complexity Delta（若两 guard 都批）：全 NO** —— 无新 source of truth（白名单唯一权威在 guard
文件内，同 SIZE_BUDGETS 先例）、无持久状态、无子系统、无公开 API、无 flag、无跨包新依赖、
无新平台行为、无网络能力。

## 7. 明确排除（不在本任务做）

- `pd doctor` / warn-only 完整性扫描（0023 §2.9 Phase 1——runtime 功能，独立票）
- plugin bundle 级 digest 登记（0023 §2.3 后半——release pipeline，独立 SPEC）
- shared node_modules / bundle 架构 / installer 重构 / 任何 topology 改动（mission 禁区）
- legacy shim 迁移（§2.8 后续任务）、`previous.json` 幽灵槽清理

---

## 8. 实际交付（Phase 2，Owner 批准 Guard A + Guard B 后）

**Guard A — `scripts/check-runtime-writers.mjs`**（verify:merge 尾棒 + `scripts/__tests__/check-runtime-writers.test.ts` 10 测）
- 谓词：runtime 路径 token（`runtimeDir|getInstallLayoutPaths|resolveInstallLayout|active\.json|install\.json|\.pd/runtime|".pd","runtime"`）× 写原语（`cpSync|rmSync|writeFileSync|…`）**同文件共现**即触发。
- 校准教训：单独 `\.pd\b` 会命中 49 处**工作区状态**写者（I3 明确 state 与 runtime 分离，状态写不在射程）→ 收窄到 runtime 树专有 token。
- SSoT 白名单 9 条（`ALLOWED_RUNTIME_WRITERS`），双向核查：越界触发 = FAIL；白名单陈旧条目 = FAIL（ERR-146）。权威豁免目录：`packages/create-principles-disciple/src/`（唯一部署写者，installer.ts / bootstrap-executor / atomic-file 等全在此）。
- 基线实测：944 文件、9 触发、全部登记在册 → PASS。

**Guard B — `packages/create-principles-disciple/tests/installed-topology-invariants.test.ts`**（4 测）
- 真实 `install()` 落进沙箱 HOME（复用 global-shim-lifecycle + installer-gateway-notice 两套件的合成 harness：真 fs 委托 + spawn/http mock + `PD_SKIP_CONSOLE_AUTOLAUNCH`），8 组件合成 payload（版本戳须严格 `x.y.z`）。
- 断言即 §6 提议的落盘不变量，经**生产 reader API**（`resolveInstallLayout`/`getInstallLayoutPaths`/`getPdCliEntry` + installer 自身 `readActiveRecord`）：canonical 解析成立（I1）、active.json 身份 == payload 身份（I4）、runtime 树零数据 + 无 `~/.pd/state`（I3/R3）、部署组件 digest == payload digest（stale-copy 防线）。
- junction realpath 断言被 digest 断言取代：沙箱 install 走 copy 语义，digest 对"部署字节 ≠ 载荷字节"的判别力覆盖 junction 漂移情形。
- 三失败模拟各自独立成立：S1 stale copy（篡改 console/dist/server.js → digest 断言炸）；S2 wrong-writer（事务外直写 runtime/core/state.db → 零数据扫描炸）；S3 missing canonical（删 console 目录 → 生产 reader 显式 mode='missing' + reason='install_runtime_missing' + nextAction 指回 installer，不静默回退）。

**harness 坑（记录以防复发）**：只钉 `HOME` 不够——deliverBootstrapExecutor 探测步会动态 import 暂存 executor 模块，该模块经 `os.homedir()` 解析 home，Windows 下走 `USERPROFILE`。一次 HOME-only 的运行把 `executor.staging/` 与一条沙箱 workspace 注册写进了**真实** `~/.pd`（install.json mtime 01:07:49 取证；真实 `runtime/`、`active.json`、活动 `bootstrap/executor` 未受影响）。修正 = HOME+USERPROFILE 双钉（测试内已注释），并以"复跑后真实 `~/.pd` mtime 不变"为遏制证据。残留（install.json 中一条指向已删沙箱的陈旧 workspace 条目 + `~/.pd/bootstrap/executor.staging/`）不手改——手写安装面违反本 PR 自己守护的 I2；留给下一次合法 install/repair 覆盖，已在 PR/交接中如实报告。
