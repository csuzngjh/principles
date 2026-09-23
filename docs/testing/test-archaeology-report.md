# PD 测试资产考古调查报告（Test Archaeology Report）

> 日期：2026-09-21 · 基线 commit：`8dc4516e` · 性质：只读调查，未修改任何测试/源码/CI/Linear
> 目的：建立测试资产全景地图，为后续 Test Diet / Test Cleanup 提供依据。本报告不删除任何文件，仅给出候选与建议。

---

# 1. Executive Summary

1. **当前测试规模**：git 跟踪测试文件 **~1,045 个**（1,024 个 `*.test.*` / `*.spec.*` + 21 个 `.feature`），约 **15,700 个用例**、3,378 个 describe，测试源码合计 **~15 MB**。分布高度集中：principles-core 395、openclaw-plugin 206、pd-console 141、pd-cli 122、installer 61。
2. **最大污染来源**：`C:\Users\Administrator\AppData\Local\Temp` 实测 **20,362 个顶层条目，其中 ~17,900（88%）为 PD 测试产物（`pd-*`/`pri*` 前缀），约 18.9 GB**。三大来源：core runtime-v2 SQLite store 测试（Windows 下清理不可靠）、openclaw-plugin prompt-v2 测试（清理失败即泄漏）、两个**完全没有清理逻辑**的测试（`legacy-rule-preflight.test.ts`、`sync-plugin-installation-truth.test.js`——后者还在 verify:merge gate 里高频跑）。
3. **最大维护成本来源**：(a) CI 中 smoke/install 套件在 **3 处重复执行**、regression-e2e 与主 CI 逐字节重复；(b) `runtime-state-manager` 被 **75 个测试文件**引用的巨型测试面；(c) openclaw-plugin hooks 层 18 处 vi.mock 把自家 SQLite store 全部架空的"脱产测试"；(d) 发布 bundle 中泄漏 ~1,705 个上游编译测试产物（发布卫生问题，非假测试）。
4. **初步瘦身机会**：时间考古未发现"沉睡测试"（git 历史始于 2026-03，全部测试近 6 个月内有改动，历史死亡测试已在 #109/#119 等 PR 中同步删除，纪律良好）。真正的负担是 **~19 GB Temp 污染 + 仓库内 42 个 e2e-workspace 残留目录 + 已废弃 Nocturnal 整目录 + 6 处 skip/死亡信号 + 4 组重复覆盖**。
5. **必须澄清的数字假象**：磁盘/naive find 会扫出 1,900~3,000 个"测试文件"，其中绝大多数是 `packages/*/dist/` 构建副本与 `.kilo/worktrees/`（77 MB worktree 池）克隆。做 Test Diet 前必须先排除这两类，否则会误判规模 3 倍。

---

# 2. Test Inventory（测试资产全景）

## 2.1 总量统计

统计口径：`git ls-files` + 排除 `node_modules/`、`dist/`、`.kilo/`。

| Category | Files | Cases (it/test) | Size | 说明 |
|---|---|---|---|---|
| Unit（含包内 __tests__） | 974 | ~15,314 | ~14 MB | 绝对主体，集中在 principles-core runtime-v2 |
| Integration | 28 | ~304 | ~448 KB | `tests/integration`、`tests/ingestion` |
| E2E（playwright/CLI e2e） | 13 | — | — | pd-console `tests/e2e`、`tests/e2e-owner`，pd-cli `tests/e2e` |
| AI User QA | 5 | — | — | `packages/pd-console/tests/ai-user` |
| BDD `.feature` | 21 | — | — | 全部在 `docs/specs/features/**`，现役规格（最后改动 2026-09-18） |
| Fixtures（专用目录） | 44 | — | ~247 KB | 6 个 fixture/snapshot 目录（见 §6） |
| scripts 自测 | 35 | — | — | `scripts/__tests__/`，vitest |
| 根 `tests/` | 10 | — | — | 含 guard-contracts 与归档报告目录 |
| **合计（git 跟踪）** | **~1,045** | **~15,700** | **~15 MB** | |

## 2.2 按包分布

| Package | 测试文件 | 主要目录 |
|---|---|---|
| principles-core | 395 | `src/runtime-v2/**/__tests__`（130+74+23+19+…）、`tests/` |
| openclaw-plugin | 206 | `tests/core` 89、`tests/hooks` 44、`tests/commands`、`tests/service` |
| pd-console | 141 | `tests/ui` 47、`tests/hooks` 44、`tests/server`、`tests/e2e*`、`tests/ai-user` |
| pd-cli | 122 | `tests/commands` 92、`tests/utils` 13 |
| create-principles-disciple | 61 | `tests/`（install/uninstall/update/trust-root/rollback 等） |
| host-runtime | 27 | `src/prompt-builder/__tests__`、`src/commands/__tests__` |
| codex-adapter | 19 | `tests/` + fixtures 137K |
| pd-companion | 10 | Electron verify + `tests/bdd`（supervisor.steps） |
| website / install-layout / scripts / tests/ | 50 | — |

## 2.3 时间分布（第三/九阶段合并）

git 历史始于 2026-03-07（`74b65f4a` 初始发布，疑似 squash），**不存在 2025 年记录**。

| 最后修改季度 | 文件数 |
|---|---|
| 2026Q1 | 22 |
| 2026Q2 | 431 |
| 2026Q3 | 834 |

历史上累计删除过 **241 个测试文件**——trust-engine 系、agent-spawn 等孤儿测试已随其保护的架构（#109、#119）同步删除。**结论：判定死亡不能靠时间，要靠 skip/孤儿/脱离执行体系这三类信号。**

## 2.4 规模假象警告（重要）

| 噪声源 | 量级 | 性质 |
|---|---|---|
| `packages/create-principles-disciple/**/dist/**/*.test.*` | ~1,705 文件 | 上游包测试被编译进发布 bundle（core/pd-cli 的 dist 拷贝）。**是发布卫生问题，不是 1,705 个假测试** |
| `.kilo/worktrees/` | 77 MB 全仓副本 | worktree 池，非仓库资产 |
| `packages/*/dist/` 其余副本 | ~850 文件 | 构建产物 |

---

# 3. 测试分类与价值（第二阶段 + 第三阶段）

## 3.1 分类判定汇总

| 组 | 代表 | 保护什么 | 分类 |
|---|---|---|---|
| runtime-v2 全链 store/activation/approval 测试（core，~300 文件） | `src/runtime-v2/__tests__`、`activation/__tests__` | 现役核心：Owner 审批、激活、证据、诊断——A 类（核心行为） | **KEEP** |
| openclaw-plugin 门控/injection/receipt/evolution 测试 | `tests/core/evolution-*`、`principle-injection` | 现役唯一门控机制（#119 后 EP 取代 trust）——A 类 | **KEEP** |
| installer trust-root/rollback/update-chain 测试 | `create-principles-disciple/tests/trust-root-*`、`rollback-policy` | 发版接缝（PRI-889 后产品生命线）——A 类 | **KEEP** |
| pd-console ui/hooks + e2e-owner | `tests/ui`、`tests/e2e-owner` | Owner 可见旅程——A 类 | **KEEP** |
| `legacy-*` 命名 8 个测试 | `legacy-rule-preflight`、`legacy-contract-parity` | 名字像遗产，实际保护**现役兼容契约**（迁移保护）——A 类 | **KEEP**（勿按名字误删） |
| BDD 21 features + steps | `docs/specs/features/**` | 现役可执行规格，被 `codex-owner-journey-e2e.mjs` 与 CI 消费 | **KEEP** |
| 2026-03-11 归档报告与手工 OKR 脚本 | `tests/archive/`、`tests/*-okr-test*.sh`、`test_event_bus.py` | 一次性历史验证——C/D 类 | **ARCHIVE** |
| Nocturnal 遗留测试与工具 | `scripts/nocturnal/`（314 KB，含 `benchmark.test.ts`、独立 package.json/vitest.config、Python evaluator） | AGENTS.md §8.3 明示已 retired；不在 root workspaces、CI 0 引用——C 类 | **DELETE_CANDIDATE** |
| cutover 完成后的 skip 测试 | `pd-cli/tests/commands/plugin-config-resolution-cutover.test.ts:157,187` | 保护已完成的迁移切换——B 类 | **DELETE_CANDIDATE** |
| 单工单一次性回归脚本 | `scripts/pri-815/targeted-regression.test.mjs`、`pipeline-closure-lab/scenarios/*/test/*.test.js` | 临时验证/夹具——D 类 | **REVIEW** |
| 最老的 commands/export·samples、init-refactor 验证测试（6 个月未动） | openclaw-plugin `tests/commands/export.test.ts` 等 5 个 | 重构验证/低活跃回归——B 类边界 | **REVIEW** |

## 3.2 skip / 死亡信号清单（全库仅 6 文件 10 处，总量健康）

| 位置 | 形态 | 判定 |
|---|---|---|
| `openclaw-plugin/tests/core/pain-score.property.test.ts:13` | describe.skip | REVIEW |
| `openclaw-plugin/tests/hooks/prompt-size-guard.test.ts:148,280` | 2× describe.skip | REVIEW |
| `openclaw-plugin/tests/hooks/gate-rule-host-pipeline.test.ts:86` | it.skip | REVIEW |
| `pd-cli/tests/commands/plugin-config-resolution-cutover.test.ts:157,187` | it.skip（cutover 已完成） | DELETE_CANDIDATE |
| `core runtime-v2 __tests__/cli-process-runner.test.ts:73` | describe.skip('Windows…') | REVIEW（环境性 skip） |
| `core .../mainline-product-path.test.ts:162-166` | 3× it.todo | KEEP（计划中占位） |

God class / scheduler 遗产测试：**已清理干净，零残留**。

---

# 4. Duplicate Test Candidates（第四阶段）

| 测试组 | 重叠内容 | 建议 |
|---|---|---|
| `openclaw-plugin/tests/hooks/pain.test.ts` vs `tests/commands/pain.test.ts` vs `pd-cli/tests/commands/pain-record、pain-retry.test.ts` | 三处覆盖同一 pain 录入路径，且 mock 同一批 `session-tracker/workspace-context/pd-config-loader` | 合并入口层，保留 1 条真实 SQLite 端到端 |
| `openclaw-plugin/tests/core/principle-injection.test.ts` vs 6 个 `prompt-*`（golden/characterization/size-guard/diet） | injection 断言在 core 单测与 prompt-* 系列重复，mock 脚手架 4 文件高度雷同 | prompt-* 收敛为 1–2 个 characterization |
| `runtime-state-manager` 被 **75 个测试文件**引用 | 同一巨型 store 的横切测试面 | 按职责拆分测试面；抽样合并（勿一刀切） |
| `core/tests/bdd/story-a.steps.ts` vs `pd-console/tests/bdd/focus-page.steps.ts` | 两套 steps 同时实现 `owner-approve-prompt(-ui).feature` | 明确各包 scenario 切片归属，去重 |
| receipt 行为：plugin `principle-receipt-metadata` + `principle-receipt-block-copy.steps.test.ts` + core `principle-receipt-block-copy-flag` + console `console-receipt-history.steps` | 跨 3 包覆盖 receipt | 部分属 P5 认可的 consumer 测试——标注 canonical 层即可，**不删** |
| CI 层面：regression-e2e.yml push main 全套 `npm test` 与 ci.yml 逐字节重复；installer smoke 三处跑；openclaw unit/integration/coverage 三 job 各自 install+build | 执行重复 | 见 §8 建议 |

结构性风险：`.feature` ↔ steps 靠**人工命名**配对（10 组名称不一致但确有实现，无孤儿），无 runner 校验映射 → 建议加一个 feature/steps 配对完整性 guard 测试。

---

# 5. Mock Risk Report（第六阶段）

按包分布（含 vi.mock 的测试文件数）：openclaw-plugin 67、pd-cli 53、core 25、installer 15、console 12。

| 文件 | mock 对象 | 风险 | 对照 AGENTS.md |
|---|---|---|---|
| `openclaw-plugin/tests/hooks/prompt-intent-injection.test.ts`（18× vi.mock） | 自家全部 core store（diagnostician-task-store、event-log、workspace-context、session-tracker…） | **高**：hook 集成测试与生产 SQLite 路径完全脱节 | 违背 P5"host integration → production-path" |
| `openclaw-plugin/tests/hooks/pain.test.ts` | `vi.mock('fs')` + 全 store mock | **高**：文件 IO 全假 | 违背 P5 |
| `prompt-golden / characterization / size-guard / diet.test.ts`（各 10–14 mock） | 同一批 store 重复 mock | 中：脚手架 4 份雷同 | 与 §4 合并建议联动 |
| `pd-cli/tests/commands/diagnose.test.ts`（144× mockReturnValue） | core services | 中：改生产签名测试不会红 | 违背 cli-7"测实际 wiring" |
| `openclaw-plugin/tests/commands/pain.test.ts` | `@principles/core/runtime-v2` barrel（注释自述 transitive imports 太多） | 中：共享 ingress 路径被部分架空 | — |
| `sqlite-connection-readonly.test.ts` 等 vi.mock('better-sqlite3') | 只读连接边界 | **低——合理边界 mock，勿误伤** | — |

---

# 6. Fixture Cleanup Candidates（第五阶段）

fixture 体系总体干净（6 目录 ~247KB，无 final2/backup/copy 命名污染；`golden-*` 是产品术语）。候选：

| 文件/目录 | 原因 | 风险 |
|---|---|---|
| `create-principles-disciple/{core,pd-cli,...}/dist/**/*.test.*`（~1,705 个） | 上游编译测试泄漏进发布 bundle | 低（构建排除 test 产物即可，属发布卫生） |
| `openclaw-plugin/tests/fixtures/legacy-queue-v1.json` | 全仓 grep 0 引用 | 低，可删 |
| `codex-adapter/tests/fixtures/**/sess_b0387c26*.json`（2 个） | 无静态引用 | 中：g1 测试可能 readdir 动态加载，需先确认 |
| `openclaw-plugin/tests/fixtures/production-compatibility.test.ts` | 测试文件放错进 fixtures 目录 | 低：迁移位置 |
| `core-barrel-surface.json` + `runtime-v2-barrel-surface.json`（48 KB） | 两份 barrel 快照疑似重叠 | 中：人工比对后合并 |
| 根目录散落：`tests/final-okr-test.sh`、`bash.exe.stackdump`、`nul`、`trajectory.db`、`tmp/`（1.2 MB 一次性 check-*.cjs 诊断脚本） | 崩溃转储/一次性脚本 | 低 |

---

# 7. Temporary Artifact Analysis（第七阶段）

## 7.1 Temp 实测

`C:\Users\Administrator\AppData\Local\Temp`：**20,362 个顶层条目；`pd-*`/`pri*` 前缀 ~17,868 个（88%），约 18.9 GB**。示例：`pd-prompt-v2-8GriR6`、`pd-pri435-1789977532760-ot3rgo`。playwright-*（3）与 vitest-*（2）几乎不贡献——**污染是 PD 测试自建临时目录，不是框架缓存**。

## 7.2 来源归因表

| Source | Creates | Cleanup | Risk |
|---|---|---|---|
| `core/src/runtime-v2/**/__tests__`（intent/pending/locator/approval/dead/agent/create 系列 sqlite store 测试） | `pd-test-*` ~5,900 | afterAll try/catch best-effort；Windows 上连接未 close 即 EBUSY 泄漏、worker 被杀即失败 → **partial** | **高** |
| `openclaw-plugin/tests/hooks/runtime-v2-prompt-activation.test.ts` | `pd-prompt-v2-*` 3,652 | afterEach 有 rmSync 但失败静默 → **partial** | **高** |
| `create-principles-disciple/tests/legacy-rule-preflight.test.ts` | `pd-preflight-pkg-/ws-` 2,211 | beforeEach 建 2 目录，workspaceDir **missing**（已核实：文件仅 3 个用例内删 pkgDir） | **高** |
| `tests/sync-plugin-installation-truth.test.js`（= `test:guard-contracts`，**在 verify:merge 每次跑**） | `pri868-home-/help-` 1,428 | **missing**（已核实：全文件 0 处 rmSync/afterAll） | **高** |
| pd-cli runtime-* 命令测试（runonce/rulehost/pain） | 各 280–306 | 部分 afterAll → partial | 中 |
| core atomic-write `.pd-write-*`；pd-companion Electron verify | 少量 | 有/同目录 | 低 |

## 7.3 为什么没清理（根因）

1. 两类是**纯欠账**：根本没有 afterAll（§7.2 第 3、4 行）。
2. 两类是**Windows 语义**：best-effort rmSync 在 SQLite 句柄未关、进程被 vitest worker kill 时必然失败且静默——单文件级 finally 在此平台上不可靠。
3. **无集中回收机制**：所有临时目录名自发起前缀、散在系统 Temp，没有任何 sweep/cron 兜底。
4. **仓库内同病灶**：`tests/e2e-workspace/` 下 42 个 `e2e-<ts>-<hash>` / `acceptance-l3*-<ts>` 残留目录（11 MB，仅 `.gitkeep` 被跟踪）——同一开发模式在 repo 内的镜像。

## 7.4 可行 cleanup 方案

1. **TMPDIR 重定向（推荐）**：root vitest globalSetup 设 `TMPDIR/TEMP/TMP = <repo>/.tmp-tests/<runId>` + gitignore；跑完整目录删除；pre-run 顺带扫 7 天前旧目录。一处改动覆盖全部来源，绕开逐文件修 finally。
2. **统一 `tempWorkspace()` helper**：注册到 `__pdTempRoots`，root afterAll 用 `rmSync(maxRetries:3)` 集中清；SQLite 测试先 `connection.close()`。
3. 立即可做：给 §7.2 两个 missing 文件补清理；复用已有 `scripts/dev/lib/residue-delete.mjs`（junction 安全删除器）加一条 `--temp` 路径。

---

# 8. Test Cost Analysis（第八阶段）

## 8.1 Workflow 负载

| Workflow | 触发 | 负载 | Timeout |
|---|---|---|---|
| ci.yml | push main/develop + PR | 15 job：verify:merge + 9 per-package + 3 OpenClaw + 2 smoke 拆分 | **verify-merge 35m 最重**；smoke 各 30m |
| regression-e2e.yml | push main + manual | regression 单文件 + **全套 npm test（与 CI 完全重复）** | 20m |
| pd-console-e2e.yml | PR（路径过滤） | Playwright 双配置，workers=1、CI retries=2、多 spec describe.serial | 20m |
| e2e-nightly.yml | cron 02:00 | 真实 gateway + LLM e2e-story-a | 30m |
| release-reproducibility(-full).yml | PR 路径过滤 / publish | full：15 腿矩阵（5 OS × 3 Node）双构建+smoke | 60m×15 + **Windows upgrade-gate 120m** |

## 8.2 Top 5 最贵套件

1. **release-upgrade-gate**（Windows 实测 50–60min，`release-reproducibility-full.yml:130-141`）
2. **smoke-packaged-install**（单测 timeout 1800s + `fileParallelism:false` 全串行）
3. **release-asset-smoke**（1800s/600s；ci.yml:330 注释：两个 smoke 占 installer 包 **97% wall time**）
4. **verify:merge 35m**——其中真测试只占小部分，大头是 2 次全量 build + lint + 9 个 check 脚本
5. **pd-console Playwright**（workers=1 串行 + retries=2 + 跨文件状态依赖）

## 8.3 高成本信号：conditional skip 清单

- ci.yml:551-556（`df953fd8`）：changesets Version PR 分支跳过 published-bundle registry-install；
- installer `test:fast` 用 `--exclude` 排除 3 个 smoke；
- pr-checks.yml:84：`npm audit || true`。

## 8.4 瘦身建议（低成本 → 高价值）

1. 删除 regression-e2e 的"full suite sanity"——与 CI 逐字节重复；
2. OpenClaw coverage job 并入 unit/integration（`--coverage` 一次跑完），省一套 install+build；
3. full 矩阵仅每 OS 的 Node 22 腿跑 smoke/install（15 → 5 次）；
4. ci.yml 各 job 用 build artifact 上传/下载替代 8 处重复全量 build + better-sqlite3 rebuild；
5. package-lock-only 变更跳过 installer smoke。

---

# 9. Keep Candidates（必须保留）

| 资产 | 理由 |
|---|---|
| core runtime-v2 全链测试（~300 文件） | 现役唯一核心引擎：审批/激活/证据/诊断，A 类 |
| installer trust-root/rollback/update-chain/changesets 套件 | PRI-889 发版接缝是产品生命线；负面对抗测试 |
| openclaw-plugin evolution/gate/injection/receipt 测试 | #119 后 EP 是现役门控机制 |
| 21 个 `.feature` + steps | Owner 可读的现役可执行规格（9/18 仍在更新） |
| `legacy-*` 8 个兼容契约测试 | 名字误导但保护现役迁移 |
| `test:guard-contracts`（sync-plugin-installation-truth） | verify:merge 的架构 guard；**保留测试本体，只补 Temp 清理** |
| scripts/__tests__ 35 个 | 仓库工程自身（worktree 工具链等）的保护 |
| `mainline-product-path.test.ts` 的 it.todo | 计划占位，非死亡 |
| `vi.mock('better-sqlite3')` 只读连接测试 | 合理边界 mock |
| 根 `tests/` 下活 guard 测试、`trap-03-missing-dep/src/utils.test.js`（fixture，勿删） | 执行体系内 |

---

# 10. Cleanup Candidates（候选清单：文件 / 原因 / 风险 / 建议动作）

| # | 目标 | 原因 | 风险 | 建议动作 |
|---|---|---|---|---|
| 1 | `scripts/nocturnal/` 整目录（314 KB，含 benchmark.test.ts、独立 package.json、Python evaluator） | AGENTS.md §8.3 已 retired；不在 workspaces；CI/runner 0 引用 | 低（先 git 归档记录来源 #114） | Phase 1 删除 |
| 2 | `pd-cli/tests/commands/plugin-config-resolution-cutover.test.ts` 2 个 it.skip | cutover 已完成，保护对象消失 | 低 | Phase 1 删 skip 用例或整文件 |
| 3 | `tests/*-okr-test*.sh`、`test_event_bus.py`、`compare-reports.sh` 等 ~10 个手工脚本 | 一次性 OKR 验证，无 runner 集成 | 低 | Phase 1 移 archive 或删除 |
| 4 | `tests/archive/`（2026-03-11 报告）+ 根 `tmp/` 一次性 check-*.cjs、`bash.exe.stackdump`、`nul`、`trajectory.db` | 历史调试遗留 | 低 | Phase 1 归档清理（走 DATA_CLEANUP_GUIDELINES） |
| 5 | `tests/e2e-workspace/e2e-*`、`acceptance-l3*` 42 个残留目录（11 MB） | 本地未 ignore 的执行残渣 | 低（仅 .gitkeep 被跟踪） | Phase 1：清残骸 + `.gitignore` 补规则 + 修 e2e 脚本清理 |
| 6 | 4 个 describe.skip/it.skip（pain-score.property、prompt-size-guard ×2、gate-rule-host-pipeline） | 死亡信号，原因未明 | 中：需先查 skip 原因（flaky? 废弃?） | Phase 1 REVIEW：恢复、删或记 ERR |
| 7 | `openclaw-plugin/tests/fixtures/legacy-queue-v1.json` | 0 引用孤儿 fixture | 低 | Phase 1 删 |
| 8 | installer dist 中 ~1,705 个编译测试产物 | 发布 bundle 卫生 | 中：改动影响发布内容，需 PRI-878 依赖模型核对 | Phase 3：构建排除 test 产物 + 发布 gate 校验 |
| 9 | 两个 Temp-missing 测试（legacy-rule-preflight、sync-plugin-installation-truth） | 无任何清理逻辑 | 低 | Phase 1 补 afterAll（不动断言） |
| 10 | pain 路径 3 处重复、injection prompt-* 8 文件、story-a/focus-page 双 steps | §4 重叠组 | 中：跨包行为契约 | Phase 2 合并去重 |
| 11 | barrel-surface 双快照 JSON | 疑似重叠 48 KB | 中：动态引用可能 | Phase 2 比对合并 |
| 12 | `scripts/pri-815/`、`pipeline-closure-lab/*/test/` | 工单一次性/lab 夹具 | 中：lab 可能仍用 | Phase 2 REVIEW |
| 13 | CI：regression-e2e full-suite、coverage job、smoke 三处、矩阵 15 腿 | §8 重复与超时 | 中：改 CI 需 Owner 批准（constitution 变更边界） | Phase 3（见 §12 约束） |

**总计可立即行动项 ~3.5 MB 仓库残渣 + ~19 GB Temp + 一个整遗产目录；真正"删测试"只有 #1、#2、#6、#7 四处需要逐一确认。**

---

# 11. Recommended Test Diet Plan

## Phase 1 — 低风险删除/清理（不动任何断言）

1. 删 `scripts/nocturnal/`（先 PR 描述记录 #114 来源与 retired 依据）。
2. 补两个 Temp-missing 测试的 afterAll；给 §7.2 partial 泄漏源实施 **TMPDIR 重定向**（单点改动，覆盖 88% 污染）。
3. 清 `tests/e2e-workspace/` 42 残骸 + gitignore；清根 `tmp/`、stackdump、`nul`、`trajectory.db`；归档 OKR shell 脚本与 `tests/archive/`（遵守 §18 数据清理守则）。
4. 删 cutover it.skip、孤儿 `legacy-queue-v1.json`；逐一裁决 4 个 REVIEW skip。
5. 手工清一次系统 Temp 存量（18.9 GB，`rm -rf` 前先确认无活动进程占用）。

## Phase 2 — fixture/mock/重复收敛

1. pain 录入 3 组 → 保留 1 条真实 SQLite 端到端 + 合并入口层。
2. prompt-* injection 8 文件收敛为 1–2 个 characterization（同时消 4 份 mock 脚手架）。
3. story-a/focus-page steps 归属切片；receipt 标注 canonical 层（不删 consumer 测试）。
4. barrel-surface 双快照、codex-adapter 动态加载 fixture 比对。
5. 高 mock 风险文件（prompt-intent-injection、hooks/pain）按 P5 改为 production-path 集成测试。

## Phase 3 — 测试架构治理

1. `runtime-state-manager` 75-引用测试面按职责拆分（配合 codebase-design 的 interface-as-test-surface）。
2. CI：删 regression-e2e full-suite、合并 OpenClaw coverage、矩阵 15→5 smoke、共享 build artifact。
3. installer 构建排除 test 产物 + 发布 bundle gate 校验（关联 PRI-878 依赖模型）。
4. 新增 feature↔steps 配对完整性 guard。
5. 统一 `tempWorkspace()` helper 进 test utils，新测试强制使用。

**边界约束**：Phase 3 的 CI 与构建改动触及验证策略，按 AGENTS.md 需 Owner 批准并走独立 SPEC/PR；本调查未做任何修改。

---

# 12. 方法学与限制声明

- 统计基于 `git ls-files` + find 排除 `node_modules/dist/.kilo`；case 数为 `it(/test(` 正则近似值。
- Temp 与泄漏数字为 2026-09-21 单机快照，会随本机继续跑测试增长——这正说明需要 TMPDIR 集中回收而非逐文件 finally。
- 引用测试的 `.claude/worktrees/`、`.kilo/worktrees/`、`.workbuddy/`、`.trae/` 属其它 agent 工具残留，未计入仓库资产，但 Phase 1 可一并审视。
- 未运行任何测试套件；未执行任何写操作（本报告除外）。
