# PD Release G2 Payload Trim Delivery Report

- 日期：2026-11-02
- 阶段：G2 — 低风险发行载荷瘦身（SPEC-PD-RELEASE-DELIVERY-001 §8；SPEC-PD-RELEASE-FOOTPRINT-001）
- 授权：Owner G2 执行指令（SPEC v1.1 对齐版；仓库现行文本为 v1.2 —— v1.2 修订仅涉及可靠性条款，Footprint/载荷分类内容与 v1.1 一致，见 SPEC-V1.2-REVISION-NOTES §2）
- 前置：G1 已合并（PR #2282，merge `5b3ba04a4`）

## A. 执行基线

| 项 | 值 |
|---|---|
| 基线 SHA | `99b3a114327a7db9f51cada557ad7e8a45feae23` = origin/main（含 G1 + 2 个 dependabot 合并） |
| worktree | `D:\Code\_worktrees\principles\adhoc-20261102-pdrelg2-b645eb-g2-payload-trim`（分支 `ai/adhoc-20261102-pdrelg2-b645eb-g2-payload-trim`，dev:worktree 创建，bootstrap READY，writer claim = zcode） |
| 测量环境 | Windows 11 26200 / win32-x64 / Node v26.7.0 (abi147) / npm 随 Node / SOURCE_DATE_EPOCH=1700000000（与 release-asset-smoke 相同） |
| G1 交集 | G2 变更文件（bundle-plugin.mjs、smoke 测试、新 util/测试）与 G1 文件（installer.ts、console 路由等）零交集；G1 已在基线内 |
| Linear | 无既有工单描述 G2 载荷瘦身（检索 2026-11-02；PRI-971 "PL/G2" 属 Principle Learning 线，无关）→ adhoc 身份 |

## B. 消费者审计（先证明无消费者，再删除）

### B.1 候选一：`console/dist/ui/**`（tsc 编译的 UI 模块树）

审计范围 = 指令 §3 的 7 项检查，全部在基线 `99b3a1143` 上执行（独立审计 + 本会话对编译产物的复核交叉验证）：

| # | 检查 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | server 静态 import | NO CONSUMER | `dist/server.js` 为单行 re-export；`dist/server/**`、`dist/lib/**`、`dist/shared/**` 编译产物中 `../ui/`、`'ui/` 引用为 0（源码侧同样 0，仅注释命中） |
| 2 | 动态 import | NO CONSUMER | pd-console 全部 `import()`：lab 模块（`console/lab/lib`，独立载荷子集）、update seam（`create-principles-disciple/update-console`）、node 内建/包说明符；ui 为 0 |
| 3 | require.resolve | NO CONSUMER | 仅 `@principles/pd-cli/package.json`（CodexGovernanceHealthModel） |
| 4 | package exports / npm 消费者 | NO CONSUMER | pd-console `private: true`、无 exports/files/bin；无任何 workspace 包依赖它（installer 仅 spawn 其 `dist/server.js`） |
| 5 | 运行时文件读取 / i18n | NO CONSUMER | 静态服务根 = `dist/web`（server/index.ts WEB_ROOT）；i18n JSON 由 esbuild 构建期内联进 `dist/web/assets/app.js`（`import zhCN from './zh-CN.json'`），服务端零 fs 读取；`dist/ui/i18n/*.json` 是惰性副本 |
| 6 | 构建/启动脚本 | 无用户机重建链 | payload console 仅含 `dist/ + lab/ + package.json`——无 src/、无 build-ui.mjs、无 devDependencies、无 esbuild/vite；`build:ui` 脚本字符串在用户机不可执行（Footprint §6 默认成立） |
| 7 | 断言 payload 的测试/门禁 | 0 项 | installer form-gate 只要求 `dist/server.js`+`dist/web/index.html`；bundle 校验块只查 server.js/web/index.html/app.js；packaged/asset smoke、upgrade-gate、parity、topology、hygiene 均不断言 dist/ui（逐一核对 file:line） |

**结论：排除安全。** 体积 1,598,619 B / 180 文件（≈1.52 MiB）/载荷。

### B.2 候选二：`release-manager/` 载荷收窄（原 = 安装器 dist 全量副本）

完整调用链追踪（bootstrap executor → ReleaseManager.apply → install() → 下载/资产验证 → TUF → manifest → journal → rollback → recovery）：

**运行时真实消费者（3 个入口）：**
1. 已安装 Console：`create-principles-disciple/update-console`（exports map → `dist/update/console-surface.js`），经 installer 创建的 junction（installer.ts:2522）解析；`update-history.js` 路由为静态导入（boot 时加载）。
2. 部署的 Bootstrap Executor：`~/.pd/bootstrap/executor/dist/bootstrap-entry.js` → `update/bootstrap-executor.js`；其 dist 从本 payload 组件整树复制（installer.ts:544）。
3. 安装期权威探针：installer.ts:2461 动态 import console-surface（带回退 authority）。

**关键约束（CONFIRMED_IN_CHECKOUT）**：`dist/update/release-manager.js:355` 与 `dist/update/apply-payload.js:384` **动态 `import('../installer.js')`** 执行安装事务 → `installer.js` 及其全部静态闭包（installers/* 三宿主安装器、mvp-config、i18n、utils/*）必须保留。

**证明无消费者的部分**（对 dist 全部 JS 的穷举 grep，零入边）：
- CLI 专用：`index.js`、`uninstaller.js`、`prompts.js`（仅 npm CLI 入口引用）；
- 测试/工具专用：`update/update-history.js`、`update/rollback-policy.js`、`update/channel-promotion.js`、`update/data-compatibility.js`、`update/release-metadata-publisher.js`（仅 publish-release-metadata.mjs 构建期引用）；
- 全部 `.d.ts` / `.d.ts.map` / `.js.map`（编译期/调试期；npm CLI 自身 dist 完整保留这些）。

**keep-list = 31 个运行时 JS 模块（622 KB）**，与 G0 估算 ~0.9 MiB 同量级（实际更大因为 installer.js 闭包必须保留）。

## C. 裁剪实施（Connection Before Creation：全部落在既有机制上）

### C.1 console/dist/ui 排除
- `bundle-plugin.mjs`：`copyPayloadTree` 增加可选 filter 参数（默认仍为 skipTestArtifacts，其他组件零变化）；console 复制循环传入 `skipConsoleUiTree`（相对 CONSOLE_SRC 判 `dist/ui` 前缀，与测试产物过滤复合）。
- fail-loud 构建门：console 校验块新增"payload 中 `dist/ui` 必须不存在"，违反即 exit 1（与既有 server.js/web/prod-build 检查同款风格）。
- 契约测试：`smoke-packaged-install.test.ts` 新增 tarball 级断言（`package/console/dist/ui/` 不出现；keep 侧 server.js/server/index.js/web/index.html 必须出现）。

### C.2 release-manager 闭包收窄
- 新增 `scripts/release-manager-payload.mjs`（lab-payload.mjs 同款单一事实源模式）：从**编译产物**计算 3 入口的相对 import 传递闭包（正则同时覆盖静态 `from` 与动态 `import()`；相对说明符带显式扩展；逃逸 dist/ 即 fail-loud；已知孤儿获得消费者即 fail-loud）。
- `bundle-plugin.mjs`：release-manager 复制循环改为"闭包文件 + package.json"；`CREATE_PRINCIPLES_DISCIPLE_REQUIRED` 保留为构建产物存在性门（注释更新）；复制后就地校验（入口在、孤儿不在）。
- 自包含资产与 npm 嵌入载荷走同一 bundle 代码路径 → 两渠道一致收窄，无需第二处修改。
- guard 测试 `release-manager-payload-closure.test.ts`（5 项）：入口/关键模块在列（含 installer.js 动态导入约束钉住）、孤儿不在列、闭包仅 JS、**新 import 自动跟踪证明**（临时 dist 副本注入新导入 → 闭包自动扩大）、**孤儿复活即拒证明**（注入 rollback-policy 导入 → fail-loud）。

### C.3 npm tarball 与内部 runtime 的文件集合关系
- npm 包自身 `dist/`（CLI + 类型 + publisher）**不变**；对外 API（exports `.`, `./update-console`, `./package.json`）不变。
- 收窄仅作用于**内嵌 payload 组件**（release-manager/），其 package.json 原样随附（exports map 不变——运行时 Node 只走 default 条件；`.d.ts` 类型条件在用户机无消费者）。

## D. 体积测量（同环境同参数 A/B；Footprint §11 口径）

npm tarball（`npm pack --dry-run --ignore-scripts --json`，改前后同 worktree 同 Node）：

| 指标 | Baseline | Candidate | Δ |
|---|---|---|---|
| unpacked bytes | 25.98 MiB | 23.67 MiB | **−2.31 MiB** |
| 文件数 | 3,149 | 2,844 | **−305** |
| packed bytes | 5.81 MiB | 5.35 MiB | −0.46 MiB |

win32-x64-abi147 自包含资产（build-self-contained-release.mjs，SOURCE_DATE_EPOCH 固定）：

| 指标 | Baseline | Candidate | Δ |
|---|---|---|---|
| payload unpacked | 824.46 MiB / 135,600 f | 821.29 MiB / 135,170 f | **−3.17 MiB / −430 f** |
| asset.tar | 978,398,720 B | 974,728,192 B | −3.50 MiB |
| console 组件 | 192.41 MiB / 27,758 f | 190.11 MiB / 27,453 f | −2.30 MiB / −305 f |
| release-manager 组件 | 94.30 MiB / 17,475 f | 93.51 MiB / 17,350 f | −0.79 MiB / −125 f |
| 原生模块 | sqlite 裁剪 8 站点/删除 119,256,064 B | 同 | 不变 |

资产侧裁剪落地两次：组件本体（−125f）+ console 物化的 `node_modules/create-principles-disciple` 副本（−125f）+ console dist/ui（−180f）。相对 824 MiB 总量占比 0.4% —— 主体体积在 G3 级 node_modules×9 物化重复中，本轮按 SPEC 不触碰，如实报告。

未测量口径说明：clean install time / upgrade time / 峰值磁盘的相对变化 <1%（文件数 −0.3%），本轮以文件数字节差异为准，不宣称耗时收益；历史压缩率不作承诺。

## E. 测试结果

| 套件 | 结果 |
|---|---|
| installer `test:fast`（含 BDD update-system + 新 guard 测试） | **982 passed / 5 skipped / 0 failed**（84 文件，673s） |
| pd-console `npm test` | **3077 passed / 1 expected-fail / 0 failed**（168 文件） |
| release-manager 相关定向套件（closure/install-smoke/payload-resolution/bootstrap-executor-source） | **18 passed / 0 failed** |
| payload 形态门（payload-form-gate / installed-topology / delivery-surface-parity） | **16 passed / 0 failed** |
| eslint（create-principles-disciple 全目录） | 0 问题 |
| smoke-packaged-install（真实 npm pack→install→console health + 新契约测试） | **14 passed / 1 failed**——唯一失败为 pre-existing 测试 "bundled plugin PROFILE templates carry no retired PLAN-gate keys"，与本次裁剪无关（见下方环境性归因）；新增 dist/ui 契约测试 **通过**（15 项中唯一失败即该项，其余全绿含 console 启动 health、回滚注入、hermetic 契约、registry 依赖解析、bundled pd-cli） |
| release-asset-smoke（真实资产构建→解包→install） | **4 passed / 0 failed**（393s：digest 校验、篡改归档提取前拒绝（fail-closed 负向）、构建后零 symlink、无 npm 调用直接安装成功——收窄后 keep-list 在真实安装路径完整） |
| release-upgrade-gate（N-1→N 真实更新事务端到端） | **3 passed / 0 failed**（1000s：官方事务安装 N-1；真实 Console /apply-full 经收窄后 ReleaseManager 升级到候选 N 且 runtime 健康；损坏候选资产响亮失败且不产生半更新状态——更新链负向） |

验收分层映射（Acceptance Plan §3）：本机 win32-x64-abi147 Tier A 全项（下载/校验/解包、原生模块真实加载、全新安装 smoke、Console+CLI 启动、更新成功 smoke、安装后文件基线）；Tier C 逻辑故障注入经 G1 场景集仍在 test:fast 全绿 + upgrade-gate/asset-smoke 负向项；本轮无平台特有文件行为变化（纯文件集裁剪），Tier B 无新增项。浏览器级 Console 验收不触发：本轮零 Owner 可见行为变化（无服务端/UI 代码改动），Console 启动与 health 由 packaged smoke 真实证明。

**环境性失败归因（AGENTS §25 证据）**：失败机制被确定性复现——`execFileSync('tar', ['-xzf', …, '-C', '<Windows 绝对路径>', …])` 从原生 Node 进程调用本机 Git GNU tar 1.34 时，`-C` 的反斜杠路径被 MSYS 改写为 `D\:\Code\…` → `Cannot open: No such file or directory` → `Error is not recoverable`。失败发生在 tar 打开目标目录时，**先于任何归档成员访问，与 tarball 内容完全无关**；同一提取用 bash 内 GNU tar 或对任意成员均同样失败。该测试只在本机（pwsh/MSYS PATH 差异）失败，CI（ubuntu 原生 GNU tar）为此套件的权威门禁——与 G1 期间本机 3 项 pwsh 类失败同机同类。受影响测试的修复（如改用正斜杠/`tar.exe` 显式解析）记为 follow-up，不属本 PR 范围。

## F. 安全与复杂度

- **零触碰**：TUF trust root/metadata/签名、asset SHA256、payload manifest（按新文件集重新生成，生成与验证机制不变）、platform/arch/ABI 匹配、路径安全、provenance stamping、sqlite-prebuild-pruning、可复现性双构建。
- 消费者验收（指令 §1 退出标准）：运行（smoke 真实启动 console/CLI）、类型（npm 包类型面不变；payload 组件类型无运行时消费者）、诊断（保留所有运行时 JS 本体；仅去除编译期 map/dts——tsc 产物非压缩，堆栈可读；web bundle 本就无 map 的先例 OPT-001）、原生模块（sqlite 站点与 .node 分布不变，smoke 真实加载）。
- Complexity Delta：新公共抽象 NO（copyPayloadTree filter 参数为参数化既有函数；闭包 util 为脚本层单一事实源，模式复用 lab-payload）；新事实源 NO（闭包即 payload 文件集的唯一权威，bundle 与测试共享）；新状态/子系统/flag/依赖/宿主行为/网络能力 全 NO。新增构建期 fail-loud 门 3 处 + 测试 6 项。
- 回滚：revert 即恢复全量复制；无 schema/状态/flag/数据迁移。

## G. 剩余风险

1. 闭包正则不识别**计算路径**的动态 import（模板字符串）——当前 dist 无此形态（动态导入共 2 处均为字面量相对说明符）；若未来出现，由 release-upgrade-gate / packaged smoke 的真实加载兜底，闭包工具的孤儿门也会在多数情况下拦截。
2. payload release-manager 不再含 `.d.ts`/`.js.map`：用户机更新事务堆栈无源映射（tsc 产物未压缩，行号可读）；npm 包与仓库 dist 完整保留诊断面。
3. 存量安装更新到新版本时，executor dist 摘要不匹配 → 触发既有重投递路径（installer.ts:513-519 明确支持），非错误。
4. 相对总资产 0.4% 的减量是 G2 定位（可证明无用内容）；主量级重复（node_modules×9、build+bundle×4）属 G3。

## H. 最终裁定

**READY_FOR_OWNER_REVIEW**

- 有证据支持的载荷减量已完成（两项候选，−2.31 MiB npm unpacked / −3.17 MiB 资产 payload）；
- 运行、类型、诊断、原生模块消费者验收全部通过（B.1/B.2 审计 + E 测试矩阵）；
- 正式支持平台的本机 Tier A 安装测试通过，CI（ubuntu 及全矩阵 required 检查）为发布前权威门禁；
- 安全机制（TUF/签名/manifest/ABI/路径/provenance/sqlite 裁剪/可复现双构建）零触碰且负向测试仍 fail-closed；
- 体积收益可复现（同环境同参数 A/B，D 节）；
- PR 独立，未混入 G1（已在基线内）、G3（构建去重/依赖布局，未触碰）或治理事项（pd-assets/备份清理，未触碰）。

已知限制：本机 packaged smoke 1 项环境性 pre-existing 失败（E 节归因，与内容无关，CI 权威）；资产总量占比 0.4%（主体在 G3 范围）。

## I. 提交清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `packages/create-principles-disciple/scripts/bundle-plugin.mjs` | 修改 | copyPayloadTree filter 参数 + skipConsoleUiTree + console dist/ui fail-loud 门 + release-manager 闭包复制与就地校验 |
| `packages/create-principles-disciple/scripts/release-manager-payload.mjs` | 新增 | 闭包单一事实源（入口/孤儿/收集器） |
| `packages/create-principles-disciple/tests/release-manager-payload-closure.test.ts` | 新增 | 5 项 guard（含自动跟踪与孤儿复活即拒两个负向证明） |
| `packages/create-principles-disciple/tests/smoke-packaged-install.test.ts` | 修改 | tarball 级 dist/ui 排除契约 + keep 侧断言 |
| `.changeset/g2-payload-trim.md` | 新增 | create-principles-disciple patch 意图 |
| `docs/implementation-reports/PD_RELEASE_G2_PAYLOAD_TRIM_DELIVERY_REPORT.md` | 新增 | 本报告 |

不随提交：bundle 运行对本包/payload 各 package.json 与根 lock 的版本同步副作用（已还原——发布链 prepack 每次自行重算）；`.tmp/g2/` 测量脚本与 A/B 数据（gitignored）。
