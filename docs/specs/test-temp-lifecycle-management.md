# SPEC：测试临时资源生命周期治理（Test Temp Lifecycle Management）

> 状态：草案（未实施）· 日期：2026-09-21 · 依据：`docs/testing/test-archaeology-report.md`
> 性质：设计 SPEC。本文件不修改任何代码/测试/CI；实施时按本 SPEC 逐项执行并另开 PR。

---

## 1. Problem（已验证的事实）

1. 系统 Temp 实测 **20,362 个顶层条目，其中 ~17,900（88%）为 PD 测试产物（`pd-*`/`pri*`），约 18.9 GB**（2026-09-21 单机快照）。
2. 三大泄漏源（详见考古报告 §7）：
   - core `runtime-v2/**/__tests__` SQLite store 测试（~5,900 条）：afterAll best-effort，Windows 下连接未关/worker 被杀 → 静默失败；
   - `openclaw-plugin/tests/hooks/runtime-v2-prompt-activation.test.ts`（3,652 条）：同上；
   - **完全无清理**：`create-principles-disciple/tests/legacy-rule-preflight.test.ts`（2,211 条）、根 `tests/sync-plugin-installation-truth.test.js`（1,428 条，且在 `verify:merge` 每次必跑）。
3. 仓库内同病灶：`tests/e2e-workspace/` 42 个 `e2e-<ts>` / `acceptance-l3*-<ts>` 残留（`scripts/e2e-story-a.mjs:91` 每次新 runId，从不扫旧）。
4. **单文件级 finally 在本平台被证明不可靠**（EBUSY、8.3 短路径、vitest worker kill）；431 个文件使用 `mkdtemp/os.tmpdir`，逐文件修复不可行。

结论：需要**集中式生命周期管理**，而非继续修补逐文件 cleanup。

## 2. 测试运行架构现状（要求 1–3 的调查结果）

### 2.1 vitest 配置入口

- **无根级 vitest 配置**；每个执行单元各自一份 config，共 **12 个**：
  `principles-core`、`openclaw-plugin`（另含 `vitest.unit.config.ts`、`vitest.parity.config.ts`）、`pd-console`、`pd-cli`、`pd-companion`、`host-runtime`、`codex-adapter`、`install-layout`、`create-principles-disciple`、`website`（relay/telemetry 用）、`scripts/vitest.config.ts`、`scripts/nocturnal/vitest.config.ts`（遗产，考古报告建议删除）。
- **全部 config 均无 globalSetup**（grep 证实 0 命中）。
- 全 workspace 统一 **vitest ^5.0.0**（root + 11 packages devDeps 一致）。

### 2.2 各包测试执行方式

| 入口 | 方式 | 是否走 vitest config |
|---|---|---|
| 各包 `npm test --workspace=…`（CI 9 个 per-package job） | `vitest run`，用各自 config | ✅ |
| 根 `test:guard-contracts`（verify:merge 环节） | `npx vitest run tests/sync-plugin-installation-truth.test.js`，**无 config** | ❌ |
| `check:pipeline-contract` | 主进程 spawn vitest，**传播用各包真实 config**（`scripts/check-pipeline-contract.mjs:142-197`），自身也在 tmpdir 建 `pd-pipeline-contract-` 报告目录 | 部分 |
| pd-console Playwright | `playwright.config.ts`，webServer = `scripts/e2e-start.mjs`（mkdtemp `pd-console-e2e-`，有 rmSync） | ❌（独立 runner） |
| AI User QA | `tsx tests/ai-user/run.ts` | ❌ |
| e2e-story-a（nightly） | `node scripts/e2e-story-a.mjs`，写 `tests/e2e-workspace/<runId>` | ❌ |
| website 契约 | `node --test` | ❌（不用 tmpdir，无需治理） |

### 2.3 临时目录创建方式（决定 TMPDIR 重定向可行性）

- 431 个文件全部经由 `fs.mkdtemp(path.join(os.tmpdir(), prefix))` 或等价路径构造——**无一处硬编码 `AppData` 绝对路径**。
- 少数测试直接读 `process.env.TMP`/`process.env.TEMP`（`bootstrap-rules.test.ts:31`、`signal-stage2-real-adapter.e2e.test.ts:44`、`sync-plugin.mjs:1032`）→ **三个变量（TMPDIR/TEMP/TMP）必须同时设置**。
- `os.tmpdir()` 每次调用动态读取 env（worker 内模块级常量如在 globalSetup/env 注入之后求值，均可捕获重定向值）。
- 全部 26 处测试内 spawn 均为 `env: { ...process.env, … }` 形态 → **子进程自动继承重定向**；个别同时隔离 `HOME/USERPROFILE`，与 TMP 重定向正交，不冲突。
- 已存在同构机制可对齐：`workspace-leak-guard.ts` 的 `.pd-test-quarantine` 也基于 `os.tmpdir()` 模块常量 → 重定向后自动迁入受管目录，由统一 sweep 回收。

### 2.4 机制验证 PoC（要求 5 的直接证据）

在仓库外 scratch 目录用本机 vitest 5.0.0 实测（2026-09-21）：

1. `globalSetup` 上下文字段为 `{ name?, config, globalConfig, provide, vitest, … }`，**`typeof ctx.configure === 'undefined'`** —— Vitest 5 的 globalSetup 不提供 `configure()` 改写 project config；不能依赖该 API。
2. globalSetup 内修改 `process.env.TMPDIR/TEMP/TMP` 后：
   - **worker 内可见**（`process.env.TEMP` 与 `os.tmpdir()` 均返回重定向值；默认 forks pool 在 globalSetup 之后 spawn，继承主进程 env）；
   - **worker 再 spawn 的孙进程可见**（`execFileSync(process.execPath, …)` 输出同样的重定向值）；
   - teardown 正常执行。
3. （PoC 中重定向值出现 `C:edirected` 的转义损伤，系测试脚手架引号问题，不影响"传播成立"这一结论；实施时以 `path.join` 构造值规避。）

**判定：root-level 单一 globalSetup 无法覆盖全仓（因为根本没有根配置、各包独立起 vitest 进程），但"一个共享 globalSetup 模块 + 每包 config 一行注册"可以达成同等效果，且有 PoC 背书。**

## 3. Goals / Non-Goals

**Goals**
- G1：任何测试/脚本在受管目录内创建临时资源，系统 Temp 中 PD 条目停止增长。
- G2：清理契约从"每文件 finally 承诺"改为"**运行间异步回收**"：teardown 尽力而为，下一次运行启动 sweep 兜底，保留期有界（7 天）。
- G3：仓库内 `tests/e2e-workspace/` 同类残渣纳入同一 sweep。
- G4：机制可被 guard 测试保护，新包/新 config 漏接会被 CI 发现。

**Non-Goals**
- 不修复任何单文件 cleanup 逻辑（`legacy-rule-preflight`、`sync-plugin-installation-truth` 等仍应补，但降为 follow-up，不再被 G1 依赖）；
- 不动 SQLite 连接生命周期、不改测试断言、不引入 feature flag；
- Playwright 浏览器自身缓存（`playwright-*` 仅 3 条，实测非问题）。

## 4. Design

> **实施修订 2026-09-21（Phase 1 实证）**：受管根由 `<repoRoot>/.tmp-tests/` 改为**仓库同级目录**
> `<parent(repoRoot)>/.pd-test-temp/`（worktree 亦然）。原因：`packages/host-runtime/src/product-telemetry/eligibility.ts`
> 的 `isRepoCheckoutModuleDir()` 从 moduleDir 向上走 8 级查找 `packages/principles-core` 兄弟目录；
> 仓库内受管 temp 使测试模拟"安装态"的假 home（`pd-tel-svc-home-*`）被误判为 repo checkout，
> 遥测被抑制，host-runtime 套件 22 个用例失败（`attempted:false`）。`PD_TEST_TEMP_ROOT=system`
> 对照跑 28/28 过，确证因果。本节以下所有 `.tmp-tests` 路径按此修订阅读。

### 4.1 共享模块（唯一新增实现）

`scripts/test/temp-lifecycle.mjs`（dev-only，不属任何发布包）：

```
resolveRepoRoot()            // 从 import.meta.url 上溯两级（scripts/test/ → 仓库根），worktree 天然隔离
createRunDir(purpose)        // <repoRoot>/.tmp-tests/<purpose>-<ISO日期>-<rand6>，mkdir + 注册
sweepStale(rootDir, maxAge)  // 删 <repoRoot>/.tmp-tests/* 中 mtime>maxAge 的目录；rmSync(recursive, maxRetries:3, retryDelay:100)
sweepE2eWorkspace()          // 同策略处理 tests/e2e-workspace/*（保留 .gitkeep 与 fixture 子目录白名单：trap-03-missing-dep 等）
export default globalSetup   // vitest 入口：①置 env ②sweepStale+sweepE2eWorkspace ③返回 teardown（best-effort 删本次 runDir，失败仅打印保留路径，不 fail 测试）
```

规则：
- env 三件套同时设置：`TMPDIR = TEMP = TMP = <repoRoot>/.tmp-tests/<runId>`；不覆盖调用方已显式设置的 `PD_TEST_TEMP_ROOT=system`（逃生阀，见 §7）。
- 每个 vitest 进程一个 runId 目录（`<包名>-<日期>-<rand6>`）；同仓多 worktree、CI 并行 job 各自隔离，互不 sweep。
- sweep 只删**本 worktree 受管目录内**超过保留期的条目 → 永不触碰系统 Temp 里其它程序的文件。
- Windows EBUSY 语义：teardown 删除失败**不是错误**（这正是本设计的核心让步：可靠性交给 sweep，不交给 finally）。

### 4.2 vitest 接入（每 config 一行）

11 个 vitest config（`scripts/nocturnal` 除外——考古报告已判 DELETE_CANDIDATE，若先删则天然出局）各加：

```ts
globalSetup: ['../../scripts/test/temp-lifecycle.mjs']   // 路径以各包相对位置写全（fileURLToPath 拼接，勿用跨包裸相对串）
```

- openclaw-plugin 的 `vitest.unit.config.ts`、`vitest.parity.config.ts` 同样接入（它们绕过主 config 的 globalSetup）。
- `check:pipeline-contract` 用各包真实 config spawn，**自动继承**，无需改 `check-pipeline-contract.mjs` 的测试子进程路径；其自身报告目录改调 `createRunDir('pipeline-contract')`（一行）。

### 4.3 根 `test:guard-contracts` 覆盖

新增**最小**根 `vitest.config.mjs`：`include: ['tests/**/*.test.js']` + 上述 globalSetup。
风险评估：根目录当前无 config，`npx vitest run <file>` 走默认发现规则；新 config 会改变未来任何"在根目录直接跑 vitest"的默认 include——这是本设计唯一可能引入行为漂移的点，验收 A4 专门覆盖。
备选（若 A4 失败）：把 `sync-plugin-installation-truth.test.js` 移入有 config 的执行单元或在该文件内直接 import helper 自管——列为降级路径，不阻塞主方案。

### 4.4 非 vitest 入口

| 入口 | 改动 |
|---|---|
| `scripts/e2e-story-a.mjs` | workspace 基路径默认改为 `createRunDir('e2e-story')`；`tests/e2e-workspace` 由 `sweepE2eWorkspace()` 兜底；CLI `--workspace` 覆盖保持不变 |
| `packages/pd-console/scripts/e2e-start.mjs` | `mkdtempSync(join(tmpdir(),…))` → `createRunDir('console-e2e')`（其现有 rmSync 保留为快速回收） |
| pd-console Playwright | `playwright.config.ts` 加 `globalSetup` 指向同一模块的 playwright 适配导出（只设 env + sweep，无 teardown 承诺）；`test-results/`、`playwright-report/` 维持现状 |
| `tests/ai-user/run.ts` | runDir 经 helper 创建 |
| 一次性存量 18.9 GB | 提供 `npm run test:temp:sweep -- --legacy`：只删**系统 Temp** 中匹配 `pd-*`/`pri*`/`.pd-test-quarantine` 且 mtime > 7 天的条目，dry-run 默认、`--apply` 才删。复用 `scripts/dev/lib/residue-delete.mjs` 的 junction 安全语义 |

### 4.5 防回归 guard（§20：保护不变量而非文件清单）

`scripts/__tests__/temp-lifecycle-wiring.test.ts`：扫描仓库内所有 `vitest*.config.*`（排除已退役清单），断言每个都注册了 `scripts/test/temp-lifecycle.mjs`；断言 `.gitignore` 含 `.tmp-tests/`。新包漏接 → CI 红，而不是 Temp 又涨。

## 5. Complexity Delta（§13）

```
New durable source of truth: NO（运行期临时目录，非状态权威）
New persisted schema/state: NO
New subsystem/service/background process: NO（一个 dev-only helper 模块，无进程）
New public abstraction: NO（scripts/test/ 不进任何发布包；对外仅 config 一行）
New runtime feature flag: NO
New cross-package dependency: NO（仅 dev 工具路径引用，不新增 package.json 依赖边）
New host/platform-specific behavior: YES（Windows EBUSY retry 语义 + 三 env 变量；已有 workspace-leak-guard 同类先例）
New external/network capability: NO
```

唯一 YES 的理由：问题的本质就是 Windows 文件锁语义下 finally 不可靠；不处理它就只能回到逐文件修补。更小方案（每文件 finally）已被 431 文件 × 已证不可靠所否定。移除路径：删各 config 的一行注册即完全回滚。

## 6. MVP Contract（§4）

- `mvp-q-1-what-if-skip`：不做的后果已量化——18.9 GB/单机、~6 GB/3 天峰值增速，CI 自托管/本地磁盘迟早爆；且 verify:merge 自身（guard-contracts）是第 4 大泄漏源，每天都在生产垃圾。
- `mvp-q-2-how-observed`：①连跑两轮 `npm test`（含 verify:merge）后系统 Temp 中 `pd-*`/`pri*` 条目数零增长；②`.tmp-tests/` 在 sweep 前有界（≤ 活跃 run 数 + 7 天残留）；③guard 测试上 CI；④`dev:workspace:snapshot` 可见 e2e-workspace 不再累积。
- `mvp-q-3-how-disabled`：无需新 flag。回滚 = revert 注册行（本地行为退回现状）；单进程逃生阀 `PD_TEST_TEMP_ROOT=system` 沿用环境变量惯例，非 feature flag。
- `mvp-q-4-emotional-value`：N/A — no direct Owner-facing behavior（内部工程）。

## 7. 验收标准（Verification Plan, §P5）

| # | 证据 | 方法 |
|---|---|---|
| A1 | Windows 本地：core runtime-v2 全量 + openclaw hooks 全量跑完后，`<repo>/.tmp-tests/<runId>` 存在且系统 Temp 无新增 `pd-test-*`/`pd-prompt-v2-*` | 手工 before/after 计数（脚本化：`ls $TMP | grep -cE '^(pd-\|pri)'`） |
| A2 | Linux CI：既有 verify:merge 与各 job 全绿，无因 TMP 重定向引发的新失败 | CI 运行证据 |
| A3 | worker→孙进程继承：任一 CLI spawn 测试断言子进程 `os.tmpdir()` 落在受管目录（临时加日志验证后移除） | PoC 已过，实施时复验一次 |
| A4 | 根 vitest.config.mjs 引入后 `npx vitest run tests/sync-plugin-installation-truth.test.js` 行为不变（选择同一文件、同结果） | guard-contracts 本地 + CI |
| A5 | sweep 正确性：伪造 mtime>7d 与 <7d 目录各一，跑任一 vitest 包，旧的被回收、新存活；fixture 白名单（`trap-03-missing-dep`、`.gitkeep`）不被删 | 单元 + 集成测试（helper 自身，TDD 适配） |
| A6 | guard 测试：临时注释某 config 的注册行 → `check:` 或 `test:scripts` 失败 | 负向测试 |
| A7 | `test:temp:sweep --legacy` dry-run 输出清单与误伤为零（含非 PD 条目不匹配） | 手工 |

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 某测试快照/比对了 `os.tmpdir()` 原值前缀 | 全库 grep `tmpdir()` 用于断言的场景（实施首步）；`PD_TEST_TEMP_ROOT=system` 单点逃生 |
| 8.3 短路径（`ADMINI~1`）与长 SQLite 路径组合的 MAX_PATH | 受管目录 `<repo>/.tmp-tests/` 比 `C:\Users\Administrator\AppData\Local\Temp\` **更短**，方向为降险 |
| watch 模式 / Ctrl-C 强杀无 teardown | 本就是设计前提：sweep 在下次启动兜底，保留期有界 |
| 同仓多 worktree 并发误删 | runId 随机后缀 + 只 sweep 超过保留期的兄弟目录（活跃目录 mtime 新） |
| 根 config 改变 vitest 默认发现（§4.3） | A4 专项验证；降级路径已备 |
| sweep 误删开发者手工产物 | `.tmp-tests/` 为本方案专有；`tests/e2e-workspace` 白名单 + 只删时间戳命名模式 |

## 9. 实施顺序（未来 PR，每步独立可验证）

1. `scripts/test/temp-lifecycle.mjs` + 其自身单测（TDD：A5 先行）。
2. 接入 11 个 vitest config + openclaw 两份额外 config；接入 `check-pipeline-contract.mjs` 报告目录。
3. 根 `vitest.config.mjs`（A4 验证）。
4. 非 vitest 入口：e2e-story-a、e2e-start、playwright globalSetup、ai-user。
5. `.gitignore` + guard 测试（§4.5）+ `test:temp:sweep` 脚本。
6. 存量清理 runbook（Owner 在无反射测试进程时执行一次）。
7. （独立 follow-up，考古报告 Phase 1）两个零 cleanup 测试补 finally、Nocturnal 目录删除。

## 10. Follow-ups（本 SPEC 故意不做）

- 逐文件 cleanup 缺陷修复（降级为卫生改进，不再承载 G1）；
- SQLite 句柄生命周期治理（EBUSY 根因层，改动面大，与本治理正交）；
- Playwright `test-results/`、npm cache 等其它缓存策略；
- CI Temp 相关 job 的 timeout 缩短（Temp 治理生效后重测再调）。
