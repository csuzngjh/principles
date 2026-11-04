# PD-MCP-GATE3-LATEST-SOURCE-DELTA-AUDIT
# Gate 3 最新源码复核与 OD-A 冻结工件完整性验证

| 字段 | 内容 |
|---|---|
| 审计类型 | 只读源码增量复核 + 冻结工件哈希验证；不修改任何生产代码 |
| 审计基线 | origin/main `0d0ea7eb560af15729f2a7f81b4e8a11a1bb0e8e`（2026-11-01 09:34 +0800 fetch） |
| 对照基线 | 原 Proposal 基线 `796000a101fd93e5b74c9301e2cd41dfbb150313`（2026-10-31） |
| 审计 worktree | `D:\Code\_worktrees\principles\adhoc-20261101-mcp-gate3-audit2-7fd2e0`（@ `0d0ea7eb5`，writer=zcode 租约） |
| 上游输入 | `docs/archive/specs/PD-MCP-GATE3-PROPOSAL-001-OPTIMIZED.md`（974 行，Owner 提供的优化版提案） |
| 核心依据 SPEC | `docs/archive/specs/SPEC-PD-AGENT-CAPABILITY-API-001.md`（v0.4-draft，在 HEAD 未变，695 行） |
| 下游交付 | 本报告 + `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md` + `PD-MCP-GATE3-IMPLEMENTATION-READINESS-001.md` + `PD-MCP-GATE3-OWNER-DECISION-CARD.md` |
| 执行边界 | 只读审计/读历史 PR/写上述四份设计文档；零生产源码/测试/package.json/lockfile/Hook/CLI 改动；零 PR/push/merge |

> **后续状态注记（2026-11-02 文档收口追加，不改写本报告任何历史结论）**：本报告为 2026-11-01 基线 `0d0ea7eb5` 时点的审计快照。文中"READY_PENDING_OG2"等状态表述均为审计时点结论；此后 OG-1（SPEC v0.5 采信）与 OG-2（Gate 3 实施授权）已于 2026-11-01 确认，Gate 3 已实施并由 Owner 合并（PR #2270，merge `f15a5a6a6`）。当前权威决策状态见 `PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 与 `SPEC-PD-AGENT-CAPABILITY-API-001-v0.5.md` 状态行。

**结论标记约定**：每项结论标注 CONFIRMED（本轮在 `0d0ea7eb5` 直证）/ CHANGED（与对照基线相比有变化）/ OBSOLETE（前轮结论已失效）/ NOT_VERIFIED。所有行号为**本轮工作区现测**，未沿用旧报告行号。

**基线保护记录**：主 checkout 既有未提交修改（6 删除跟踪文件 + 多个未跟踪路径，含 `docs/archive/specs/PD-MCP-GATE3-PROPOSAL-001-OPTIMIZED.md`、`docs/archive/specs/SPEC-PD-AGENT-CAPABILITY-API-001-v0.2.md`、`docs/proposals/` 等）本轮零触碰；两个前置 worktree（gate2 / hook-verify）只读访问；%TEMP% 证据只读 + 哈希计算；代码调查全部在独立审计 worktree。

---

## A. Executive Summary

1. **方案 C 在最新主干完全成立。** 增量区间 `796000a10..0d0ea7eb5`（42 提交）中，Gate 3 依赖的全部架构关键面——`pain-recall.ts`、CLI 外壳、两份测试、`hooks.json`、`io-seam-registry.json`、runtime-v2 barrel、eslint 守卫配置——**字节级零变化**（blob 哈希逐一比对）。变化仅为：5 个功能性 PR 全部落在安装器/文案/治理默认值域，与 MCP 架构零交集；两次版本发布（core 1.297.10→1.297.11 等）。
2. **OD-A 冻结工件完整可恢复，6 项哈希全部 MATCH。** 预注册 JSON/MD（v3）+ 版本链 v1/v2 + %TEMP% 原型三件套逐一重算 SHA-256 均与冻结清单一致。白名单以**可执行投影模块 `ALLOWED_PATHS`** 为逐字段依据恢复，与预注册文本交叉一致；唯一分歧是 `statusDetail`（文本列 ALLOW、可执行版未发射）——**保守方向**，可执行能力严格窄于授权上限。
3. **OPTIMIZED Proposal 无需重大修改**，仅需吸收 4 项实施级修正：① core 无 `capabilities/` 子目录惯例，Capability 文件应为平铺 `pain-recall-capability.ts`（先例 `diagnostician-capability.ts`）；② `pain-recall.ts` 实为 895 行（旧报 896 为计数误差，内容零变化）；③ Gate 2 "0/36 副作用"统计口径已闭环（工作区业务数据指纹；72 次正式运行未装 PD hooks，治理遥测由 Phase 3 单独矩阵覆盖且增量为 0）；④ `statusDetail` 按 v0.5 冻结为"不进 MCP data 输出、仅用于 error.code 派生"。
4. **十项重点调查全部 CONFIRMED**（§C 逐项）。两个此前仅"报告级"的事实升级为"守卫逻辑级"直证：专用子路径导出**不触碰任何 barrel fixture**（守卫只扫描 barrel 文件本身，`architecture-regression.test.ts:3586-3607` 读 `fixture.barrel` 指定的单一文件）；`crypto`/`os` 不在 eslint 受限组（`eslint.config.js:170-184`），迁移文件的 seam 注册只需覆盖 `fs`/`path`。
5. **一处迁移陷阱确认**：`PainChainReadModel.getStateManager()` 构造 `RuntimeStateManager` **不传 `readonly`**（`pain-chain-read-model.ts:123-125`），默认 bootstrap 开启。迁移后的 `pain-recall-read-model.ts` 必须保持显式 `readonly: true, bootstrapIfMissing: false`（现 `pain-recall.ts:548`），**不得**在"统一构造"名义下合并两者。
6. Gate 3 实施就绪 = READY_PENDING_OG2：机械步骤清单已穷举到行级（见 READINESS 文档），无技术阻塞项。

---

## B. 增量区间定性（796000a10 → 0d0ea7eb5）

### B.1 合并 PR 清单

| PR | 主题 | Merge 提交 | 对 Gate 3 架构的影响 |
|---|---|---|---|
| #2250 | PRI-1060 npm tarball resolution（安装器） | `670aade4e` | 无（安装器域） |
| #2251 | PRI-1062 WorkBuddy preflight（安装器） | `612b9bb31` | 无（安装器域） |
| #2252 | **PRI-1064 governance 默认开启**（installer+pd-cli+core） | `2c6346a84` | 间接：`core/src/host/host-installer.ts` +13 行（`HostInstallResult` 增可选 `governance` 字段，安装摘要显示治理开关状态）——安装器域新增字段，与 pain-recall/MCP 零交集 |
| #2253 | PRI-1063 flat-key YAML 文案（adapter/runtime/installer） | `760be2463` | 无语义：6 个 adapter/host-runtime 文件全部为 nextAction 诊断文案改写（单行 YAML 提示，兼容 `diagnostic()` 空白折叠），零控制流/状态/门禁变化 |
| #2254 | docs: PRI-1060..1064 评审发现的 5 项 err 记录 | `e9e5e47d3` | 无（文档） |
| #2256/#2258/#2259/#2260 等 | version packages ×5 | — | 版本推进（见 B.3） |

### B.2 架构关键面逐一比对（blob 级）

| 文件 | 状态 | 证据 |
|---|---|---|
| `packages/pd-cli/src/services/pain-recall.ts` | **CONFIRMED 零变化** | blob `02e7fdab8b4d5eac0c1977548bc5164f30f32da7` 两基线一致；`git log 796000a10..HEAD -- <file>` 空 |
| `packages/pd-cli/src/commands/pain-recall.ts` | **CONFIRMED 零变化** | blob `18c4fb59b0cd…` 一致；174 行 |
| `packages/pd-cli/tests/commands/pain-recall.test.ts` / `pain-recall-readonly.test.ts` | **CONFIRMED 零变化** | `git diff --stat` 该路径空（771 / 830 行） |
| `plugins/principles-disciple/hooks/hooks.json` | **CONFIRMED 零变化** | diff 空；PreToolUse matcher 仍 `Bash|apply_patch`（:5）、PostToolUse `.*`（:18） |
| `packages/principles-core/io-seam-registry.json` | **CONFIRMED 零变化** | diff 空；9 seams，read-model seam 6 成员（:40-50） |
| `packages/principles-core/package.json` | **CHANGED（仅版本）** | 唯一 hunk：`1.297.10`→`1.297.11`（:3）；exports 24 键零变化（:8-102） |
| `packages/pd-cli/package.json` | **CHANGED（版本+core 范围）** | `1.162.4`→`1.162.5`（:3）；`@principles/core ^1.297.6`→`^1.297.11`（:24）；仍无 exports 字段 |
| `packages/principles-core/src/runtime-v2/index.ts`（barrel） | **CONFIRMED 零变化** | barrel fixture count 仍 1976 |
| `packages/principles-core/src/host/host-installer.ts` | **CHANGED（无关域）** | PRI-1064：+13 行可选 `governance` 字段（:104-117 区段），安装器摘要用 |
| adapter/host-runtime 其余 6 文件 | **CHANGED（纯文案）** | PRI-1063：`codex-adapter/{ingestion/catch-up.ts,worker/workspace-worker.ts}`、`workbuddy-adapter/worker/workspace-worker.ts`、`host-runtime/workbuddy-worker-status.ts`、两 `pd-hook.ts`——全部为 `*_disabled` 诊断 nextAction 单行化，+18/−5，零语义 |

### B.3 当前版本 cohort（@ `0d0ea7eb5`，CONFIRMED）

core **1.297.11** · pd-cli **1.162.5** · host-runtime **0.14.3** · codex-adapter **0.6.2** · workbuddy-adapter **0.2.16** · principles-disciple（openclaw-plugin）**2.2.10** · create-principles-disciple **1.145.42**。runtime pins（`plugins/principles-disciple/runtime-version.json`）= 0.6.1 / 0.14.2 / 1.297.10——落后一个已发布 cohort，属发布节奏正常现象（pin 由 publish train 自动维护，见 §C.9）。

---

## C. 十项重点调查（逐项结论，全部本轮行号）

### C.1 pain-recall.ts 当前实现与依赖 — CONFIRMED

- **895 行**（`wc -l` 实测；旧报 896 为计数误差，内容零变化），21 个导出：`PAIN_RECALL_SCHEMA_VERSION`(:67)、limit 三常量(:69-71)、状态/类型 15 个(:73-180 区段)、`painRecallSnapshotTestHooks`(:269)、`recallPains`(:490，签名 `recallPains(workspaceDir: string, query: PainRecallQuery): Promise<PainRecallResult>`，主体 :490-889)。
- **imports 精确清单（:59-65）**：`fs`(:59)、`crypto`(:60)、`os`(:61)、`path`(:62) 四个 node 内建 + 三个 core 子路径——`readLedgerFileState`←`@principles/core/principle-tree-ledger`(:63)、`openTrajectoryDbReadonly`←`@principles/core/trajectory-store`(:64)、`RuntimeStateManager`←`@principles/core/runtime-v2`(:65)。**零 pd-cli 本地导入、零 better-sqlite3 直接导入**（DB 访问全部经 core 入口）。
- 契约类型锚点：`PainRecallQuery`(:150-156，`limit` 注释"Validated upstream"——服务不重复校验)、`PainRecallResult`(:164-180；`principle.canonicalId` :171、`identityStatus` :172 三值联合、`text?` :173)。
- **死状态确认**：`'ambiguous_principle'` 在文件中仅出现于状态联合(:77)，零赋值点；`'ambiguous'` 仅出现于 identityStatus 联合(:172)，实际只产生 `'not_found'`(:206) 与 `'resolved'`(:864)。CONFIRMED——v0.5 将其标记 reserved。

### C.2 Core Read Model 最新架构 — CONFIRMED

- read-model seam 6 成员（`io-seam-registry.json:42-49`）：`operator-health-read-model.ts`（fs:9/path:10）、`pain-chain-read-model.ts`（仅 path:15）、`pruning-read-model.ts`（path:16/fs:17/better-sqlite3:18）、`schema-conformance-read-model.ts`（fs:1/path:2/better-sqlite3:3）、`internalization-chain-integrity-read-model.ts`（fs:1/path:2/better-sqlite3:3）、`activation-compatibility-read-model.ts`（fs:18/path:19）。**6 个中 5 个直接 import fs**——read model 直接文件 I/O 是该 seam 的既有常态。
- **PainChainReadModel 与 recallPains 独立非分层**（CONFIRMED）：前者 pain→forward 遍历，后者 principle→backward；前者的 `getStateManager()`(:123) 构造 `new RuntimeStateManager({ workspaceDir })`(:125) **不传 readonly** → `runtime-state-manager.ts:74-75,111-115,124` 语义下 = 可写 + bootstrap 缺省开。后者显式 `readonly: true, bootstrapIfMissing: false`（`pain-recall.ts:548`）。**迁移陷阱**：不得统一构造。
- core 已拥有迁移文件消费的全部原语（ledger 可用性三态 / 只读 trajectory 打开 / RuntimeStateManager），迁移后三条 import 改相对引用即可。

### C.3 io-seam-registry 规则 — CONFIRMED（守卫逻辑级直证）

- **eslint**（`eslint.config.js`）：:16-21 读 registry 构建 `coreIoExemptFiles`；:165-184 对 `packages/principles-core/src/**/*.ts` 施 `no-restricted-imports: error`，受限组精确为——组1(:170-175)：`fs`/`fs/*`/`node:fs*`/`path`/`path/*`/`node:path*`（严格，无 type 豁免）；组2(:179-184)：`child_process*`/`better-sqlite3`（type import 豁免）。**`crypto`/`os` 不在任何受限组**——迁移文件只需为 `fs`/`path` 注册 seam。:196-205 对 registry 文件自动关闭该规则。
- **架构回归测试**（`principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts:3742-3969`）：`importsNodeIo`(:3824-3835) 扫描 fs/path/child_process/better-sqlite3（覆盖 `import * as x` 与 `import {x}` 两种形态，自身断言 :3962-3969 证明）；registry 文件经 `ALLOWED_IO_FILES`(:3789-3793) 自动豁免(:3916)；未注册文件 import fs 即红(:3906)；反向守卫：registry 文件必须存在于盘(:3932-3942)——**注册与建文件须同一提交**。
- 结论：迁移文件加入 read-model seam `files[]`(:42-49) 后，两个守卫**自动**放行，零守卫配置改动。

### C.4 Core exports 与子路径导出 — CONFIRMED

- 24 个导出键（`package.json:8-102`），专用子路径先例 `./runtime-v2/internalization/tool-semantic-registry`(:89-92)；runtime-v2 系子路径共 21 个——"新文件 + 新 exports 键、不动 barrel"是成熟模式。
- **barrel 守卫扫描范围（关键直证）**：`architecture-regression.test.ts:3586-3607` 仅读取 fixture 声明的**单一 barrel 文件**（`fixture.barrel` :3591），断言增删为 0；fixture 为手工维护快照（:3601 提示语；PRI-1065 的 5ac3a8863 即手工编辑）。**新专用子路径只要不被 `src/index.ts` / `src/runtime-v2/index.ts` re-export，两个 fixture（1976/196）零触碰。**
- `REQUIRED_SOURCE_FILES`(:13-580，277 项)：仅存在性检查(:584-590)，头部(:1-6)明示"新 service/read-model 边界建立时添加"——按房例添加两个新文件名。

### C.5 CLI 命令实现与完整兼容契约 — CONFIRMED

- 注册：`src/index.ts`（1331 行，103 个 `.command(`）——import :13、父命令 `pain`(:118-120)、子命令 `recall`(:178-193，设计注释 :174-177：`.option()` 而非 `.requiredOption()`，使缺参错误走 handler 信封)。
- 选项集（:181-190）：`--principle-id`(:181)/`--pain-id`(:182)/`--context`(:183)/`-l,--limit`(:188，严格解析 `parsePainRecallLimit` 定义于 `commands/pain-recall.ts:51-54`，`/^\d+$/` 否则 NaN)/`-w,--workspace`(:189)/`--json`(:190)。
- 退出码（`commands/pain-recall.ts:169-173`）：仅 `ok`/`no_matches`/`partial` 返回 0，其余 `process.exit(1)`(:172)。`fail()` 信封(:33-42)：JSON 模式 `{status:'failed',reason,message,nextAction}`，五处 `return` 守卫(:95/:107/:122/:141/:160，cli-2)。
- 服务 import（:16-22）：`recallPains` + 三常量 + `PainRecallResult` 类型 ← `'../services/pain-recall.js'`(:22)；另 `resolveWorkspaceDir` ← `'../resolve-workspace.js'`(:15)。
- Skill↔CLI 合同：`tests/commands/cli-skill-contract.test.ts:124-131` 钉住四宿主 `pd-cli-operator` SKILL.md 必含 `pd pain recall`；:134-138 对 SKILL 引用的每个命令实测 built CLI `--help`——驱动二进制，不受服务迁移影响。
- pd-cli `package.json`（51 行全读）：仍**无 exports 字段**；bin `pd→dist/index.js`(:6-8)；依赖 core `^1.297.11`(:24)。

### C.6 painRecallSnapshotTestHooks 使用范围 — CONFIRMED

- 形状（:269-283）：4 个可选注入位——`statSync`(:271)/`mkdtempSync`(:273)/`afterCopyFile`(:275)/`afterT1MainFingerprint`(:282)。
- **全仓消费者恰一个测试文件**：`pain-recall-readonly.test.ts`——import :22；race-1..4(:474/:487/:499/:548)、inj-stat(:564/:570)、inj-mkdtemp-throw(:588/:591)、inj-mkdtemp-cleanup(:604/:608/:613)、aba-4(:702/:707)、interleave-1/2(:762/:809 经 :753 注入器)；`afterEach` 清理 :463-465/:749。服务内部使用点 :327/:444/:449/:452/:475。**非测试消费者：零**（rg 全仓；唯一文档提及为 backend-round1 报告 :112）。
- 结论：迁移时将钩子机制**收进 core 内部模块**（core 内测试相对引用即可触达），公共子路径不导出——满足"测试钩子不入稳定公共 API"（OPTIMIZED §5.2）。

### C.7 WAL 快照与严格只读保证 — CONFIRMED

- `planReadonlyOpen`(:368-387)：100 字节头直读（`fs.openSync/readSync/closeSync` :371-377）判定 `direct|stage|unverifiable`（fail-closed）。
- `stageWalSnapshot`(:432-486)：T0 指纹（`crypto.createHash('sha256')` :309 流式 128KiB）→ `fs.mkdtempSync(path.join(os.tmpdir(),'pd-pain-recall-stage-'))`(:444-445) → 仅复制 main 与非空 `-wal`(:447-451) → 校验哈希 → T1 顺序复检 main→wal→main(:474-477，ABA 安全)。**全部写操作限于系统临时目录**；失败清理 `finally`(:483-485)，验证后根由外层 `finally` 统一清除(:881-888)。RuntimeStateManager 显式只读构造(:548) + `SELECT 1` 活性探针(:554)。
- 证明载体：25 用例只读矩阵（ro-×11 / race-×4 / inj-×3 / aba-×5 / interleave-×2；`pain-recall-readonly.test.ts:155-809`）——**除服务 import 外零 pd-cli 本地依赖**（import 仅 vitest + fs/os/path/crypto + better-sqlite3 :15-22），可整体随迁。
- 术语对齐（OPTIMIZED §3.2-3 采纳）：应表述为"**对业务工作区与业务数据源严格只读，但执行受控的系统临时目录文件 I/O**"，不是无副作用纯函数。

### C.8 Core 与 pd-cli 依赖关系 — CONFIRMED

- 12 包 DAG；core 零工作区依赖（runtime+dev）；`rg "from '@principles/(pd-cli|host-runtime)'" packages/principles-core/src` 零命中（仅注释提及）。全仓恰好 **3 个代码文件** import `services/pain-recall`（commands/pain-recall.ts:22 + 两测试 :22/:25），其余命中全为文档。
- core 运行时依赖方及范围：codex-adapter `^1.297.5`、host-runtime `^1.297.5`、pd-cli `^1.297.11`、pd-console `*`、workbuddy-adapter `^1.297.5`——**全部 `^1.297.x` 范围已容纳 1.298.0 minor，零范围编辑需求**；changesets `updateInternalDependencies:"patch"`（`.changeset/config.json:9`）在 Version PR 自动 bump 运行时依赖方。

### C.9 架构测试、barrel 测试与发布机制 — CONFIRMED

- barrel fixture：`runtime-v2-barrel-surface.json`（1976）/ `core-barrel-surface.json`（196），守卫逻辑见 C.4。
- 发布链（全部实读）：`.changeset/`（config：commit:false、updateInternalDependencies:patch、access:restricted + core 经 `publishConfig.access:public` 覆盖 :139-141）→ `.github/workflows/version-packages.yml`（main push 触发 `changesets/action@v2.1.2` :64 创建/更新 Version PR）→ Version PR 合并 = cohort 定版 → `.github/workflows/publish-npm.yml`（exact-version 发布列车）→ pin 刷新由列车自动跑 `scripts/release/sync-codex-runtime-pins.mjs` 开维护 PR（**runtime-version.json 非手工维护**）。
- **C4 组装守卫**（`scripts/release/lib/workspace.mjs:21-27`）：`principles-disciple` 发布 ⇒ 必须 `create-principles-disciple` 同批——纯 core+pd-cli changeset 组可通过，但安装器 bundle 含 core 字节（release-locks 组件清单含 core：`create-principles-disciple/scripts/check-release-locks.mjs:17`）。
- **PRI-1065 先例**（`5ac3a8863`）：core 变更的 changeset 声明 core+plugin+installer 三包联动（"plugin bundle ships with the installer ⇒ 必须同批"）——本次迁移按此模式附加 plugin/installer patch 是保守正确做法（最终以实施 PR 评审为准）。
- **release-locks**：`packages/create-principles-disciple/release-locks/*/package-lock.json` 九包快照；**手工**经 `npm run generate:release-locks` 再生、`check:release-locks` 验证；ERR-068/ERR-131 要求 manifest bump 时再生（本迁移不改依赖图，exports map 不影响 lock 解析；按政策在 core manifest 变更时再生）。
- core 测试基建：vitest（`vitest.config.ts` include 含 `src/runtime-v2/__tests__/**/*.test.ts`）——**迁移测试必须落在该路径约定下**（pd-cli 现放 `tests/commands/`，需路径迁移）；真 sqlite 临时夹具模式在 core 已有先例（`activation-compatibility-read-model.test.ts:21,130`），better-sqlite3 是 core runtime 依赖——**迁移测试零新依赖**。

### C.10 Gate 2 OD-A 原始冻结工件恢复 — CONFIRMED（BLOCKED 解除）

**哈希验证（SHA-256，全部 MATCH）**：

| 工件 | 冻结摘要（前 16 hex） | 本轮实算 | 结果 |
|---|---|---|---|
| 预注册 JSON v3 | `ea5b4bde23ff36ec` | 一致 | **MATCH** |
| 预注册 MD v3 | `091c7fd48019f6e8` | 一致 | **MATCH** |
| 归档 v1 JSON | `009b0ace93dc691a` | 一致 | **MATCH** |
| 归档 v2 JSON | `aaffe6b34b189e1f` | 一致 | **MATCH** |
| %TEMP% server.mjs | `040d319c4cd3f778` | 一致 | **MATCH** |
| %TEMP% package.json / lock | `2034cd8192b64530` / `bf1d149554e32af` | 一致 | **MATCH** |

位置：`D:\Code\_worktrees\principles\adhoc-20261031-mcp-gate2-f505ca\docs\implementation-reports\`（发布副本）与同 worktree `.tmp/pd-mcp-gate2/`（工作副本，字节一致）；原型在 `%TEMP%\pd-mcp-gate2\gate2-20261031\server\`。v3 的 `supersedes` 链（:5-6）与 v1/v2 摘要吻合。

**白名单可执行清单**（`project.mjs` `ALLOWED_PATHS` :23-37，27 叶路径）与预注册 `fieldWhitelist`（JSON :55）逐项对应——**无过披露**。DENY 头注（:12-16）：canonicalId、painId、evidenceRefs（candidateId/taskId/decisionId/decidedAt）、pain.text/reason/rawStatement/occurredAt/source/host/score/severity、diagnoses.*（diagnosisId/taskId/category/rootCause/supportingEvidence.note）、correctionEvidence.*、lineage hops、trustedContextReceipt、session/turn ids。OUTER_STATUS（:39-43）：ok/no_matches/partial 透传；principle_not_found/pain_not_found→not_found；source_missing/source_unreadable→unavailable。函数锚点：`errorFor`(:45-64)、`projectEnvelope`(:67-114)、`collectPaths`(:117-128)、`assertDisclosure`(:134-141，哨兵 `/G2SENT-S\d{2}-[A-Z]+/g`)。

**唯一分歧（保守方向）**：预注册文本列 `statusDetail` 为 ALLOW，但 `ALLOWED_PATHS` 无此叶、`projectEnvelope` 不发射——`statusDetail` 仅在 `errorFor()`(:53) 参与 error.code 派生。**v0.5 冻结采用可执行真相**（更窄者）。

**Gate 2 "0/36 副作用"口径闭环**（回应 OPTIMIZED §2.2）：指标定义 = "workspace file-tree fingerprints identical before/after each run"（prereg :68）；测量面 = 运行工作区全树递归 SHA-256（`harness/common.mjs fingerprintTree` :22-34，仅排除 harness 注入的 AGENTS.md）；**72 次正式运行未安装 PD hooks**（prereg :40 明文——hooks 由 Phase 3 独立矩阵覆盖，两臂同构无差异信号）→ 治理遥测写入既不可能发生也不在统计内。Phase 3（hooks 在场）单独证明：工作区指纹与两库行数完全不变、pain_events 增量 0（报告 :118-119）。**结论：0/36 = 业务数据副作用口径，治理观测口径另证为净——两个口径都干净。**

---

## D. 对 OPTIMIZED Proposal 的修正清单（唯一发现的偏离项）

| # | OPTIMIZED 表述 | 最新事实 | 处置 |
|---|---|---|---|
| 1 | §5.1 逻辑结构 `capabilities/pain-recall-capability.ts` | core 无 `capabilities/` 目录惯例；先例为平铺 `src/runtime-v2/diagnostician-capability.ts` | **修正**：采用平铺 `src/runtime-v2/pain-recall-capability.ts`（P6/P7：不为一个文件建目录层） |
| 2 | §2.1 "约 896 行" | 895 行（blob 一致，纯计数误差） | **勘误** |
| 3 | §2.2 统计口径质疑（业务 vs 遥测未区分） | 已闭环（§C.10）：0/36=业务数据口径；遥测 Phase 3 净 | **关闭**，v0.5 引用时注明口径 |
| 4 | §6.1 白名单类别摘要（未含 statusDetail 处理） | 可执行清单无 statusDetail 叶（保守分歧） | **补冻结**：statusDetail 不进 MCP data，仅参与 error.code 派生 |

其余 OPTIMIZED 内容（职责拆分、OD-A MCP-only 定位、受限子路径依赖、Hook 边界、进程风险、状态映射、停止条件）与最新源码**零冲突**。

---

## E. 裁定

- **最新源码支持方案 C：CONFIRMED**（§B.2 全表 + §C 十项）。
- **OD-A 冻结工件：RECOVERED & VERIFIED**（6 哈希 MATCH；BLOCKED 状态解除）。
- **SPEC v0.5 冻结条件：READY**（事实基础齐备；见 v0.5 文档）。
- **Gate 3 实施条件：READY_PENDING_OG2**（机械清单就绪；OG-1 采信 v0.5 后即可申请 OG-2）。

**本轮零改动声明**：未修改任何生产源码/测试/package.json/lockfile/Hook/CLI/宿主配置；未创建 PR/push/merge；审计 worktree 零自产工件；主 checkout 唯一新增物为四份设计文档（未跟踪）。

---

## F. 证据索引

| # | 主题 | 位置（本轮实测） |
|---|---|---|
| 1 | 服务文件零变化 + blob | `packages/pd-cli/src/services/pain-recall.ts`（895 行，blob `02e7fdab…`）；`git log 796000a10..HEAD` 空 |
| 2 | 21 导出/imports/WAL/readonly 构造 | 同文件 :59-65,:67-71,:269-283,:368-387,:432-486,:490,:548,:554,:77,:172,:206,:864 |
| 3 | CLI 外壳与注册 | `packages/pd-cli/src/commands/pain-recall.ts:33-54,:169-173`；`src/index.ts:13,:118-120,:178-193`（103 命令/1331 行） |
| 4 | 测试拆分面 | `pain-recall.test.ts`（771 行：cli-A/parse/cli-B 组留 :263-438；assoc/avail/sem/rank 组迁 :450-765；B5 双依赖 :422）；`pain-recall-readonly.test.ts`（830 行 25 用例整体迁，import 仅 :15-22） |
| 5 | 守卫机制 | `eslint.config.js:16-21,:165-205`；`architecture-regression.test.ts:3586-3620（barrel）,:3742-3969（IO seam）,:13-580（REQUIRED_SOURCE_FILES）` |
| 6 | seam/exports/barrel | `io-seam-registry.json:40-50`（read-model）；`principles-core/package.json:8-102`（24 键）；barrel fixtures 1976/196 |
| 7 | bootstrap 陷阱 | `pain-chain-read-model.ts:123-125` vs `pain-recall.ts:548`；`runtime-state-manager.ts:74-75,:111-115,:124` |
| 8 | DAG/依赖范围 | 12 包 package.json；core 反向依赖 rg 零命中；依赖方范围全 `^1.297.x` |
| 9 | 发布机制 | `.changeset/config.json:9`；`version-packages.yml:64`；`publish-npm.yml`；`scripts/release/lib/workspace.mjs:21-27`（C4）；`release-locks` 九包；`5ac3a8863`（PRI-1065 先例） |
| 10 | OD-A 冻结工件 | gate2 worktree `docs/implementation-reports/PD-MCP-GATE2-PREREGISTRATION-20261031.{json,md,.sha256}` + `.tmp/pd-mcp-gate2/proto/project.mjs`（:6-16,:23-37,:39-43,:45-141）+ `%TEMP%` 原型三件套；6 项 SHA-256 MATCH |
| 11 | 0/36 口径 | prereg :40（无 hooks）、:68（指纹定义）；`harness/common.mjs:22-42`；实验报告 :54,:86,:118-119 |
| 12 | 增量区间 | `git log 796000a10..0d0ea7eb5`（42 提交）；§B.2 blob 比对表；`host-installer.ts` PRI-1064 +13 |
