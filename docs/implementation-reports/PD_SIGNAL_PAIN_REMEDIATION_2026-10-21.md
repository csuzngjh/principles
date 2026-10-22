# PD 痛苦感知机制专项整改报告（2026-10-21）

> 任务：PD_SIGNAL_PAIN_AUDIT_2026-10-21 全量整改（P2-01..P2-04、P3-01..P3-04）
> 执行基线：`origin/main@c754ef50e`（审计基线 `808278e8c`；已核实两基线间信号/痛苦感知相关文件零差异）
> 交付形态：4 个可独立审查的 PR（#2101/#2102/#2103/#2104），全部未合并、未自动审批、未绕过任何治理门禁
> 证据目录：`.tmp/pain-remediation/`（会话内原始输出，gitignored）

## 0. 审计报告文件的如实说明

任务引用的 `PD_SIGNAL_PAIN_AUDIT_2026-10-21.md` **在仓库、私有文档库（`D:\Code\principles-private`）、`.zcode/` 会话产物中均不存在**（多路径搜索确认）。本次整改以任务上下文中的逐项发现描述为意图真理（Intent Truth 第 1 优先级：当前 Owner 显式指令），并对每项声称做了仓库现实核实（§1）。`docs/architecture/PD_Pain_Signal_Audit.md` 为 2026-05 战略文档，与本审计无关。

## 1. 审计发现核实与最终状态

| 审计项 | 核实结论（对 c754ef50e 源码） | 最终状态 | 载体 |
| --- | --- | --- | --- |
| P2-01 降级分支同步健康写 | **属实**。`detectAsyncAndRoute` 分类器不可用分支无任何 await（async 体首 await 前同步执行）；且 `collectSync` 对零命中普通消息也返回 `needsLlmConfirmation=true`（漏词检测）→ **每条普通消息**在 before_prompt_build 同步栈上做一次健康文件读改写 | **已修复**（红→绿回归证明） | PR #2101 |
| P2-02 Stage2 成本/健康不可观测 | **属实**。无调用次数、无批量跳过计数 | **已修复**（stage2Invocations/stage2BatchSkipped + doctor 展示与分级） | PR #2101 + #2102 |
| P2-03 性能假设未实测 | **属实**（无基准） | **已交付基准**（可重复 perf 测试 + 前后 A/B）；历史卡顿归因标注 **NOT VERIFIED** | PR #2101 |
| P2-04 队列消费者耦合 correction_observer | **属实**。`CorrectionObserverService.start` 在 `correction_observer`（默认 OFF）关闭时直接 return → `batchConfirmPendingSignals` 唯一消费者停摆 → permanent-pending；分类器不可用时整批跳过无计数、不 bump attempts | **已修复**（消费者归属 signal_collector 能力域；跳过计数化；doctor 积压分级） | PR #2102 |
| P3-01 WorkBuddy 不读共享学习词库 | **属实**。`admitTrustedWorkbuddyLiveCorrection` 注入 `workbuddyP0KeywordStore()`（四词投影）**覆盖**了 `admitOne` 本可解析的共享 live store | **已实现**（SPEC v0.2 + 接线 + 契约测试） | PR #2103 |
| P3-02 限流桶内存边界未文档化 | **属实** | **已文档化**（含重启配额重置语义与不持久化理由） | PR #2101 |
| P3-03 跨宿主测试本地失败（dist 陈旧） | **属实且根因更深**：① 主 checkout host-runtime dist 落后 src 三天、4 个模块在 dist 完全缺失（静态比对）；② **根 build 链不含 pd-cli**——新 worktree 中 pd-cli dist 不存在导致 83 个测试失败（`Cannot find module`），构建后同套件 1976+/1976+ 全过（修复前后唯一变量=构建）；③ CI（ci.yml test-pd-cli）构建顺序完备，**无 CI 缺陷** | **已修复**（根 build 链补 pd-cli + `test:host-adapters` 入口） | PR #2104 |
| P3-04 WorkBuddy 关键词函数仅 adapter 间接覆盖 | **属实**（host-runtime 无直接单测） | **已补齐**（7 用例直接单测 + 真实 hook 集成测试） | PR #2103 + #2104 |

## 2. 交付物与文件映射

### PR #2101 — 同步路径修复 + 可观测性 + 基准 + 文档（P2-01/P2-02/P2-03/P3-02）

分支 `ai/adhoc-20261021-signal-sync-health-zcode-pain-remediation`（base main），提交 `013303c34` + `7eb6bcf4d`（changeset 补声明）。

| 文件 | 变更 |
| --- | --- |
| `packages/openclaw-plugin/src/core/signal-health.ts` | 新增 stage2Invocations/stage2BatchSkipped（当日计数、跨日归零、旧文件缺省读 0、类型错判损坏）；解析重构为逐字段收窄的 `parseSignalHealthState` |
| `packages/openclaw-plugin/src/core/signal-collector-host.ts` | 健康计数写入统一推迟微任务（countStage2Queued/countStage2Dropped/countStage2Invocation）；realtime+批量调用计数；队列 SQLite 写保持同步（明示） |
| `packages/openclaw-plugin/tests/core/signal-sync-path-regression.test.ts` | **新增**：调用顺序契约（detectSync 返回时未写盘→微任务后计数正确）、零命中/高精度/降级/写失败、invocations 语义、向后兼容、损坏判 null |
| `packages/openclaw-plugin/tests/core/signal-detect-sync.perf.test.ts` | **新增**：四场景同步窗口 p50/p95/p99 基准（记录型，无阈值断言） |
| `packages/pd-cli/src/services/config-doctor.ts`、`src/commands/config-doctor.ts` | counts 扩两字段 + `stage2 llm:` 展示行 |
| `packages/pd-cli/tests/services/config-doctor-signal-health.test.ts` | 新字段呈现/向后兼容用例 |
| `docs/architecture/SIGNAL_DETECTION_SYNC_PATH_BOUNDARIES.md` | **新增**：同步 I/O 清单、限流桶内存边界与重启语义、recordUserTurn 维持现状的分析理由、基准数据表 |
| `.changeset/audit-pain-signal-sync-health.md` | principles-disciple + pd-cli + create-principles-disciple patch |

### PR #2102 — 队列消费者解耦（P2-04；堆叠于 #2101）

分支 `ai/adhoc-20261021-queue-consumer-zcode-pain-remediation`（base = #2101 分支），提交 `2b5c79606` + `f1f34c6df`。

| 文件 | 变更 |
| --- | --- |
| `packages/openclaw-plugin/src/service/correction-observer-service.ts` | 启动门改为 correction_observer **或** signal_collector 任一开启；consumer-only 模式日志明示；批量跳过计数化（不 bump attempts、不终结） |
| `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` | signal_collector 描述更新（能力域扩展+成本边界落档；category/default 不变） |
| `packages/pd-cli/src/services/config-doctor.ts` | pendingCount>0 && batchSkipped>0 → degraded + nextAction |
| `packages/openclaw-plugin/tests/service/correction-observer-service.test.ts` | **新增 4 用例**：双关不启动 / consumer-only（零优化 dispatch）/ observer needs_setup 仍消费 / stop 无定时器残留 |
| `packages/openclaw-plugin/tests/service/correction-observer-batch-confirm.test.ts` | **新增 3 用例**：跳过计数、空队列零成本、classifier 恢复消费积压 |
| `packages/pd-cli/tests/services/config-doctor-signal-health.test.ts` | 积压分级 2 用例（含 PR1 用例组合按新分级调整的说明） |
| `.changeset/audit-pain-queue-consumer.md` | 四包 patch（含 installer） |

### PR #2103 — WorkBuddy 共享学习词库（P3-01/P3-04；独立 base main）

分支 `ai/adhoc-20261021-wb-shared-vocab-zcode-pain-remediation`，提交 `88b89702d`。

| 文件 | 变更 |
| --- | --- |
| `docs/specs/SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001-v0.2.md` | **新增**：Owner 授权链、词表规则（high 门槛=证据门槛）、误报边界分析、验收契约映射 |
| `packages/host-runtime/src/governance-signal-admission.ts` | `assessWorkbuddyLiveKeyword` 可选 store 参数（缺省四词，向后兼容）；新导出 `resolveSharedCorrectionKeywordStoreForDetection`；admit 预检与准入共用共享 live store |
| `packages/host-runtime/tests/governance-signal-admission.workbuddy-live.test.ts` | **新增 7 用例**：门槛矩阵（earned-high/未达/owner_promoted）、引用/内部续接/无效原生事件/显式前缀/双 flag、损坏降级 seed-only、幂等 |
| `packages/workbuddy-adapter/src/pd-hook.ts` | 预检传入同一共享 store（与准入零漂移） |
| `packages/workbuddy-adapter/tests/live-keyword-pain.test.ts` | **新增集成用例**：earned-high 词经真实 hook 产生一条 Pain；未达门槛/转述零新增；P0 四词不回归 |
| `.changeset/audit-pain-wb-shared-vocab.md` | host-runtime + workbuddy-adapter patch |

### PR #2104 — 跨宿主测试基础设施（P3-03/P3-04；独立 base main）

分支 `ai/adhoc-20261021-host-test-infra-zcode-pain-remediation`，提交 `35d04912c`。

| 文件 | 变更 |
| --- | --- |
| 根 `package.json` | `build` 链补 `@principles/pd-cli`（其六个 workspace 依赖之后）；新增 `test:host-adapters`（build → codex 全套 → workbuddy 全套） |

## 3. 性能基准（P2-03，摘要）

方法：`signal-detect-sync.perf.test.ts`；隔离临时 workspace + 真实 trajectory SQLite + mock classifier；300 迭代 + 50 预热/场景；同机 A/B（stash 源码改动）正反两轮。环境 Windows / node v26.7.0。完整表见 `docs/architecture/SIGNAL_DETECTION_SYNC_PATH_BOUNDARIES.md` §4。

| 场景 | 修复前 p50/p95/p99 (ms) | 修复后 p50/p95/p99 (ms) | 归因 |
| --- | --- | --- | --- |
| S1 零命中+分类器不可用 | 10.97/14.28/15.54；11.36/13.73/15.20 | 8.00/9.09/10.25；11.92/12.46/13.93 | 方向一致，第二轮受噪声影响 |
| S2 高精度命中 | 10.31/13.56/18.35；11.50/16.53/19.35 | 8.03/10.06/12.11；11.12/12.30/13.27 | 噪声带内（本就无同步健康写） |
| S3 歧义命中+降级入队 | 10.82/13.84/19.76；13.34/20.07/22.52 | 8.04/10.04/11.96；10.17/12.72/14.25 | **两轮一致稳定改善（−2.8/−3.2ms p50）** |
| S4 歧义命中+realtime 前段 | 10.02/12.33/13.10；12.71/17.99/20.16 | 8.02/10.38/13.94；9.93/13.30/15.24 | 噪声带内 |

单次同步健康文件读改写实测约 1.5–3ms；本机 run-to-run 方差约 ±1.5ms。**历史生产卡顿根因 NOT VERIFIED**——基准仅陈述当前环境测量，不构成对历史事件的归因。

## 4. 三宿主测试状态（真实命令与结果）

| 套件 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 信号路径定向（openclaw-plugin 6 文件） | `npx vitest run tests/core/signal-* tests/service/correction-observer-*` | **121/121 PASS** | 基线 110 + 新增 11 |
| openclaw-plugin 全套 | `npx vitest run`（WT1/WT2） | 2406–2410 PASS / 2–4 FAIL | 失败三项均为预存环境问题（§6），pd-cli dist 构建后其中 2 项转绿 |
| pd-cli 全套 | `npx vitest run`（构建 pd-cli dist 后） | WT1 **1976/1976**（144 文件）；WT2 **1978/1978** | 构建前 83 FAIL（dist 缺失铁证） |
| host-runtime 全套 | `npx vitest run`（WT3） | **577/577 PASS**（49 文件） | 含新增 7 直接单测 |
| workbuddy-adapter 全套 | `npx vitest run`（WT3） | 161/162，1 FAIL | 唯一失败经 stash A/B 证明为环境性（§6）；WT4 干净树全过 |
| codex-adapter 全套 | `npm run test:host-adapters`（WT4） | **303 PASS + 1 skip**（31 文件） | 审计点名 3 文件 37/37 |
| workbuddy-adapter 全套 | 同上（WT4） | **161 PASS**（13 文件） | 审计点名 2 文件 33/33 |
| doctor/flag/安装器契约 | 定向 vitest | 31+280+20 全 PASS | flag 语义无漂移 |
| 类型检查 | `tsc -p tsconfig.build.json --noEmit` ×4 包 | 全部 exit 0 | |

**红→绿证明**（P2-01）：新回归测试在未修复代码上 9/11 失败（stash 复核），修复后 11/11 通过。

## 5. 运行时行为矩阵（整改后默认值）

| 机制 | 默认 | 行为 |
| --- | --- | --- |
| signal_collector | quiet / **ON** | 关键词检测恒开；LLM 深判 + **批量确认消费者**（≤20 条/15min，空队列/无 classifier 零调用）归属此 flag |
| correction_observer | quiet / **OFF** | 仅周期性词库优化；关闭时 consumer-only 周期照跑、优化 dispatch 零调用（测试断言） |
| 健康计数 | — | 全部微任务推迟；SQLite 队列写保持同步 |
| stage2Invocations | 当日计数 | 每次真实 classifier 调用 +1（realtime+批量）；未调用不增（测试锁定） |
| stage2BatchSkipped | 当日计数 | 仅「队列非空且 classifier 解析失败」+1；空队列不计数 |
| doctor 分级 | — | pending>0 && batchSkipped>0 → degraded（附 nextAction）；pending>0 && skip=0 → ok（等待下轮） |
| WorkBuddy live keyword | host.workbuddy + workbuddy_live_keyword_pain 双 **OFF** | 开启后触发面 = 共享 store 当下满足 high 门槛的 correction 词；startsWith/原生门/显式前缀/配额/幂等全保留；零 LLM、零 transcript |

## 6. 未解决风险 / 未验证事项 / 预存环境问题

1. **CI 状态（终态）**：四个 PR 全部绿——#2101 **32 SUCCESS**（含 Verify Merge Gate 2m37s PASS）、#2102 7 SUCCESS、#2103 33 SUCCESS + 1 SKIPPED、#2104 31 SUCCESS + 1 SKIPPED（GitHub statusCheckRollup 权威口径，2026-10-21 23:5x 本地时间核查）。首跑中 PR #2101 的 Verify Merge Gate 曾因 changeset 未声明 installer 失败（N-5/C4：插件发版须连带 create-principles-disciple），已补声明并推送（`7eb6bcf4d`/`f1f34c6df`），重跑全绿。
2. **预存环境失败**（均有基线复现证据，与本次改动无关）：
   - `principle-application-ledger.steps.test.ts` EPERM×2：Windows 临时目录清理 flake（未改动基线同失败）。
   - `template-anti-regression.test.ts`：Windows GNU tar 对 worktree 路径双转义（tar 在 PD 逻辑前失败）——建议另立 issue。
   - WT3 `workbuddy-bdd.test.ts`「Real tool failure」场景深链失败：**stash A/B 证明与 PR3 无关**（基线同失败）；WT4 干净 bootstrap 树全过；根因未深挖（有界投入），疑与 WT3 分段构建的树状态有关。
3. **主 checkout 陈旧 dist 未处置**（刻意的）：主工作区只读（git-3/git-4），其 host-runtime dist 落后 src 的状态原样保留；修复途径即 PR #2104 的 `npm run build`，由维护者执行。
4. **Pass 1（计划态）error:context 路由未单独执行**：整改上下文自带风险清单，Pass 2（diff 态）已全部执行并在各 PR 的 Task Risk Contract 中逐条对账——流程偏差，如实披露。
5. **审计报告原件缺失**（§0）——若 Owner 有该文件，建议入库以对齐编号。

## 7. PR 链接、依赖与推荐合并顺序

| PR | 内容 | base | 依赖 |
| --- | --- | --- | --- |
| [#2104](https://github.com/csuzngjh/principles/pull/2104) | 构建链 + 跨宿主测试入口 | main | 无 |
| [#2101](https://github.com/csuzngjh/principles/pull/2101) | 同步路径 + 指标 + 基准 + 文档（含本报告） | main | 无 |
| [#2102](https://github.com/csuzngjh/principles/pull/2102) | 队列消费者解耦 | **#2101 分支**（堆叠） | 须在 #2101 后合并（squash 后 GitHub 自动重定 base） |
| [#2103](https://github.com/csuzngjh/principles/pull/2103) | WorkBuddy 共享词库 + SPEC v0.2 | main | 无（若 #2104 先合，其 worktree 验证更顺） |

推荐顺序：**#2104 → #2101 → #2102 → #2103**（或 #2101/#2104 互换；#2103 任意时点）。全部合并由 Owner 决定，AI 未合并任何 PR。

## 8. 工作区保护与写操作记录

- **主 checkout（D:\Code\principles）**：全程只读；结束后 `git status` 与开始时逐项一致（14 项他人未跟踪资产原样）。本机产生的会话工件仅写入 gitignored 的 `.tmp/pain-remediation/`。
- **任务 worktree**（均经 `create-task-worktree.mjs` 创建于统一池、`worktree-claim --writer zcode` 认领、各自 bootstrap 并验证 readiness/LEAKAGE=0）：
  1. `adhoc-20261021-signal-sync-health-zcode-pain-remediation`（#2101）
  2. `adhoc-20261021-queue-consumer-zcode-pain-remediation`（#2102，堆叠于 1）
  3. `adhoc-20261021-wb-shared-vocab-zcode-pain-remediation`（#2103）
  4. `adhoc-20261021-host-test-infra-zcode-pain-remediation`（#2104）
- 写操作仅限：上述四 worktree 内的源码/测试/文档/changeset 提交与推送（各分支均推至 origin，未推 main、未 force、未合并）；主 checkout 零 git 写操作。
- 破坏性命令：零使用（无 reset --hard / clean -fdx / checkout -- . / restore .）。stash 仅用于红绿验证与基线对照，全部已 pop 并复检工作树干净。

## 9. 遗留 Owner 决策点

1. **PR #2102 的默认行为变化**：signal_collector 默认 ON 意味着存量积压在 classifier 可用时开始消费（有界 LLM 成本）——这正是修复目的，但请 Owner 知悉；不接受时 `signal_collector.enabled=false` 即回旧行为。
2. **PR #2103 的触发面扩大**：WorkBuddy（显式开启后）从 4 词到「共享 high 门槛词全集」——SPEC v0.2 §3 已给误报分析，请 Owner 复核。
3. 审计报告原件（若存在）入库对齐编号。
4. `template-anti-regression` Windows tar 环境问题建议立单。
